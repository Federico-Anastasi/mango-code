//! The PC's hardware: graphics cards of every brand, CPU, RAM. From here the engine build is chosen
//! (`choose_build`) and it is decided whether an optimized profile applies (`profiles.rs`).
//!
//! Where each thing is read from:
//! - **NVIDIA** from NVML (`nvml.dll`, the driver's library): name, memory, compute capability and the maximum
//!   CUDA version the driver supports. No process to launch (so no console window), no text to interpret, and the
//!   errors have a type. The index is that of `CUDA_DEVICE_ORDER=PCI_BUS_ID`, the same that `CUDA_VISIBLE_DEVICES`
//!   needs.
//! - **all the others** from DXGI (Windows' graphics system): brand from the vendor id, dedicated memory, and the PC's
//!   memory the adapter may borrow (what the integrated graphics runs on, when the user lets it). DXGI
//!   sees the NVIDIA cards too, but doesn't give the CUDA version and for NVIDIA ones NVML rules; DXGI's NVIDIA
//!   cards are only used if NVML doesn't answer (broken driver): they stay in the list, without CUDA version, and
//!   the build will be Vulkan.
//! - **the memory in use** on each card (`gpu_memory`): NVML for the NVIDIA cards, which is what the reserve of the
//!   plans was measured with; for every other card Windows' counters of the memory dedicated to each adapter
//!   («GPU Adapter Memory», the ones Task Manager shows), matched to the DXGI adapter by its LUID. DXGI's own
//!   `QueryVideoMemoryInfo` is not used: it counts only the calling process. The engine's `--list-devices`, which
//!   gives the free memory of every brand, costs a process to start (and the card's driver loaded in it) at every
//!   reading, and the reading is made whenever the state of the engine is asked.

use crate::user;
use anyhow::{Context, Result};
use mango_common::{tr, Build, Paths};
use nvml_wrapper::error::NvmlError;
use nvml_wrapper::Nvml;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use windows::core::{w, PCWSTR};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_LARGE,
    PDH_MORE_DATA,
};
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GlobalMemoryStatusEx, RelationProcessorCore, MEMORYSTATUSEX,
    SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gpu {
    /// NVIDIA: position in PCI order (that of `CUDA_VISIBLE_DEVICES`). The others: the position after the NVIDIA ones.
    pub index: u32,
    pub name: String,
    pub vendor: Vendor,
    /// Dedicated memory.
    pub memory_mib: u64,
    /// Memory of the PC that Windows lets the adapter borrow; 0 for the cards read from NVML. Only the integrated graphics
    /// is planned on it (`Hardware::borrows_ram`).
    pub shared_mib: u64,
    /// Maximum CUDA version the NVIDIA driver supports, e.g. (12, 6). `None` if it isn't an NVIDIA or NVML doesn't answer.
    pub cuda_driver: Option<(u32, u32)>,
    /// CUDA compute capability, e.g. (8, 6). NVIDIA with NVML only.
    pub cc: Option<(u32, u32)>,
}

impl Gpu {
    /// The graphics built into the processor. The BIOS gives it part of the PC's own memory, and whether it counts as a
    /// card depends on how much (`Hardware::counts`). Windows does not say it in the adapter's description, so the name tells, and
    /// only a name that says it for certain is taken as integrated: any other is a card. Intel's integrated graphics are
    /// the HD, UHD and Iris ones, «Graphics» alone, «Arc Graphics» and the Arc 100V and 100T series; its discrete cards
    /// are the Arc A and B series (also the M ones of laptops), Iris Xe MAX and the Data Center GPUs. AMD's integrated
    /// ones end in «Graphics» (Radeon Graphics, Vega 8 Graphics, 780M Graphics) or are a number with an M and no RX; the
    /// cards named «RX <number>» and the professional ones (Pro, FirePro, WX) are discrete whatever the driver adds to
    /// the name.
    pub fn is_integrated(&self) -> bool {
        let name = self.name.replace("(TM)", "").replace("(tm)", "").replace("(R)", "").replace("(r)", "");
        let words: Vec<&str> = name.split_whitespace().collect();
        let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
        match self.vendor {
            Vendor::Intel => {
                let arc_card = |w: &&str| {
                    let number = w.strip_suffix('M').unwrap_or(*w);
                    number.starts_with(['A', 'B']) && (3..=4).contains(&number.len()) && digits(&number[1..])
                };
                let discrete = words.iter().any(|w| w.eq_ignore_ascii_case("MAX") || matches!(*w, "Data" | "Flex") || arc_card(w));
                let rest = &words[words.len().min(1)..];
                let integrated = words.iter().any(|w| matches!(*w, "HD" | "UHD" | "Iris"))
                    || rest == ["Graphics"]
                    || rest == ["Arc", "Graphics"]
                    || (rest.first() == Some(&"Arc") && words.iter().any(|w| w.strip_suffix(['V', 'T']).is_some_and(|n| n.len() == 3 && digits(n))));
                integrated && !discrete
            }
            Vendor::Amd => {
                let discrete_rx = words.windows(2).any(|w| w[0] == "RX" && w[1].starts_with(|c: char| c.is_ascii_digit()));
                let professional = words.iter().any(|w| matches!(*w, "Pro" | "FirePro" | "WX"));
                let mobile_number = words.iter().any(|w| w.strip_suffix('M').is_some_and(|n| n.len() == 3 && digits(n))) && !words.contains(&"RX");
                !discrete_rx && !professional && (words.last() == Some(&"Graphics") || mobile_number)
            }
            Vendor::Nvidia | Vendor::Other => false,
        }
    }

    /// Something is left on the card's own memory after the reserve; integrated graphics needs the memory of a card.
    pub(crate) fn holds_a_model(&self) -> bool {
        self.memory_mib >= if self.is_integrated() { MIN_INTEGRATED_GPU_MEMORY_MIB } else { MIN_GPU_MEMORY_MIB }
    }

    /// Integrated graphics without the memory of a card: the models can use it only on the PC's memory, when the user
    /// lets them (`Hardware::borrows_ram`).
    pub fn needs_ram(&self) -> bool {
        self.is_integrated() && !self.holds_a_model()
    }

    /// The card has tensor cores, which llama.cpp's fast paths for reading the prompt count on. Volta and Ampere and
    /// later have them; Turing (compute capability 7.5) has them in the RTX, TITAN RTX, Quadro RTX and T4 cards, not in
    /// the GTX 16 family or the other small ones, which declare 7.5 all the same (a GTX 1660 SUPER reads the prompt at
    /// 264 tokens/s, a GTX 1080 at 1383).
    pub fn has_tensor_cores(&self) -> bool {
        match self.cc {
            Some((7, 5)) => self.name.contains("RTX") || self.name.split_whitespace().any(|w| w == "T4"),
            Some(cc) => cc >= (7, 0),
            None => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cpu {
    pub name: String,
    /// Physical cores (not threads).
    pub cores: u32,
    pub avx2: bool,
    pub avx512: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hardware {
    pub gpus: Vec<Gpu>,
    pub cpu: Cpu,
    pub ram_mib: u64,
    /// The user lets the models use the integrated graphics on the PC's memory (Settings › Computer); off at first.
    #[serde(default)]
    pub integrated: bool,
    /// Why NVML didn't answer although the NVIDIA driver is there (an old card with a legacy driver, a broken
    /// installation). The NVIDIA cards then come from DXGI, without CUDA. For the startup log.
    pub nvml_error: Option<String>,
}

/// Margin for the engine's compute buffers: what `-fit` would leave free by default.
const COMPUTE_MARGIN_MIB: u64 = 1024;

/// Memory that Windows (screen, DWM) and the CUDA context take from each card (measured, see `split.rs`) plus the
/// margin for the engine's compute buffers.
pub(crate) const GPU_RESERVE_MIB: u64 = 1100 + COMPUTE_MARGIN_MIB;

/// RAM left to Windows and the other programs when a model takes the PC's memory: on the processor, or on the
/// integrated graphics that borrows it.
pub(crate) const RAM_RESERVE_MIB: u64 = 4096;

/// A card counts only if something is left on it after the reserve. On a 2 GiB card (a GT 710) no model fits:
/// counting it would pick an engine build for a card no model uses.
const MIN_GPU_MEMORY_MIB: u64 = GPU_RESERVE_MIB + 1;

/// Integrated graphics counts when the BIOS gives it 8 GB or more: a Ryzen AI Max, or a mini PC set that way. What a laptop gives
/// by default (512 MiB to 4 GiB) is taken from the processor's memory without leaving room for a model and its
/// context. Windows reports a setting some MiB short (8176 for 8 GB), hence the margin.
const MIN_INTEGRATED_GPU_MEMORY_MIB: u64 = 7 * 1024;

/// CUDA version of the official llama.cpp builds: the driver must support it, and for 13 the cards must be Turing
/// or later (CUDA 13 dropped the earlier architectures).
const CUDA_12_BUILD: (u32, u32) = (12, 4);
const CUDA_13_BUILD: (u32, u32) = (13, 4);
const CC_MIN_CUDA_13: (u32, u32) = (7, 5);

impl Hardware {
    /// What tells a card apart in the choices and on screen: its name, and with other cards of the same name `#1`, `#2`…
    /// in their order (for NVIDIA the PCI one, which does not change while the cards stay in their slots).
    pub fn card_id(&self, g: &Gpu) -> String {
        let twins: Vec<u32> = self.gpus.iter().filter(|o| o.name == g.name).map(|o| o.index).collect();
        if twins.len() < 2 {
            return g.name.clone();
        }
        format!("{} #{}", g.name, twins.iter().filter(|&&i| i < g.index).count() + 1)
    }

    /// Whether `entry` of a choice names `g`: its id, or its name, which names every card that has it.
    pub fn names(&self, entry: &str, g: &Gpu) -> bool {
        entry == g.name || entry == self.card_id(g)
    }

    /// The cards that count (`counts`); software adapters are not in the list at all.
    pub fn usable(&self) -> impl Iterator<Item = &Gpu> {
        self.gpus.iter().filter(|g| self.counts(g))
    }

    /// The card can hold a model. The integrated graphics never counts beside a dedicated card that does: a model takes
    /// one kind of memory, and with Vulkan the engine leaves it out by itself there. Alone, it counts with the memory of a
    /// card from the BIOS, or on the PC's memory when the user lets it (`borrows_ram`).
    pub fn counts(&self, g: &Gpu) -> bool {
        if !g.is_integrated() {
            return g.holds_a_model();
        }
        !self.dedicated_counts() && (g.holds_a_model() || self.borrows_ram(g))
    }

    /// A dedicated card of the PC can hold a model.
    pub(crate) fn dedicated_counts(&self) -> bool {
        self.gpus.iter().any(|d| !d.is_integrated() && d.holds_a_model())
    }

    /// The integrated graphics runs the models on the PC's memory: the user lets it, its own memory is not a card's, no
    /// dedicated card counts and some memory is left to borrow.
    pub fn borrows_ram(&self, g: &Gpu) -> bool {
        self.integrated && g.needs_ram() && !self.dedicated_counts() && self.borrowable_mib(g) > 0
    }

    /// The PC's memory the integrated graphics can take for a model: what Windows lets it borrow, never more than the RAM
    /// left to Windows and the other programs, less the engine's margin. Whether it really holds is seen at the start
    /// (`taken_before_start`), where the processor takes over if it does not.
    pub(crate) fn borrowable_mib(&self, g: &Gpu) -> u64 {
        g.shared_mib.min(self.ram_mib.saturating_sub(RAM_RESERVE_MIB)).saturating_sub(COMPUTE_MARGIN_MIB)
    }

    /// The memory of `g` a model can count on for its weights and cache.
    pub fn model_memory_mib(&self, g: &Gpu) -> u64 {
        if self.borrows_ram(g) { self.borrowable_mib(g) } else { g.memory_mib.saturating_sub(GPU_RESERVE_MIB) }
    }

    /// The PC has Turing cards (compute capability 7.5) and none of them has tensor cores: the GTX 16 family. An engine
    /// built without the tensor-core kernels for that capability reads the prompt about twice as fast there (measured
    /// with an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER: 538 tokens/s against 315). The choice is made when the engine
    /// is built and holds for every card of that capability, so with an RTX 20 in the PC the plain build stays.
    pub fn turing_without_tensor_cores(&self) -> bool {
        let mut turing = self.usable().filter(|g| g.vendor == Vendor::Nvidia && g.cc == Some((7, 5))).peekable();
        turing.peek().is_some() && turing.all(|g| !g.has_tensor_cores())
    }
}

/// This PC's hardware with the user's choice on the integrated graphics: what every plan and every verdict reads.
pub fn detect(paths: &Paths) -> Result<Hardware> {
    Ok(Hardware { integrated: crate::choices::read(paths)?.computer.integrated, ..detect_bare()? })
}

/// This PC's hardware as it is, without the user's choices. Development builds read it from the JSON file `MANGO_HARDWARE`
/// names, when set: the integration tests give the app a computer other than the one they run on.
pub fn detect_bare() -> Result<Hardware> {
    if cfg!(debug_assertions) {
        if let Some(file) = std::env::var_os("MANGO_HARDWARE") {
            let text = std::fs::read_to_string(&file).with_context(|| format!("MANGO_HARDWARE {}", file.to_string_lossy()))?;
            return serde_json::from_str(&text).with_context(|| format!("MANGO_HARDWARE {}", file.to_string_lossy()));
        }
    }
    let (nvidia, nvml_error) = match nvidia_gpus() {
        Ok(gpus) => (gpus.into_iter().map(|(gpu, _)| gpu).collect(), None),
        // No NVIDIA driver on this PC: nothing to report.
        Err(NvmlError::DriverNotLoaded | NvmlError::LibraryNotFound | NvmlError::LibloadingError(_)) => (Vec::new(), None),
        // A driver that doesn't answer as asked (a GT 710's legacy driver lacks functions of today's NVML) must not
        // keep the app from starting: DXGI's cards stand in (`merge`) and at worst the model runs on the processor.
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(Hardware { gpus: merge(nvidia, dxgi_gpus()?), cpu: cpu()?, ram_mib: ram_mib()?, integrated: false, nvml_error })
}

/// Which llama.cpp build suits this hardware.
pub fn choose_build(hw: &Hardware) -> Build {
    let gpus: Vec<&Gpu> = hw.usable().collect();
    if gpus.is_empty() {
        return Build::Cpu;
    }
    let nvidia: Vec<&Gpu> = gpus.iter().copied().filter(|s| s.vendor == Vendor::Nvidia).collect();
    // CUDA only if all the NVIDIA cards have a driver that says its version: a single one without, and the driver
    // isn't reliable.
    let driver = nvidia.iter().map(|s| s.cuda_driver).collect::<Option<Vec<_>>>().and_then(|v| v.into_iter().min());
    if let Some(driver) = driver {
        let turing_or_later = nvidia.iter().all(|s| s.cc.is_some_and(|cc| cc >= CC_MIN_CUDA_13));
        if driver >= CUDA_13_BUILD && turing_or_later {
            return Build::Cuda13;
        }
        if driver >= CUDA_12_BUILD {
            return Build::Cuda12;
        }
    }
    Build::Vulkan
}

// --- NVIDIA (NVML) ---------------------------------------------------------------------------

/// The NVIDIA cards in PCI order, as NVML gives them, each with the MiB in use on it. What an error means is decided by
/// `detect`.
fn nvidia_gpus() -> Result<Vec<(Gpu, u64)>, NvmlError> {
    let nvml = Nvml::init()?;
    let version = nvml.sys_cuda_driver_version()?;
    let cuda_driver = ((version / 1000) as u32, ((version % 1000) / 10) as u32);
    let mut found = Vec::new();
    for i in 0..nvml.device_count()? {
        let d = nvml.device_by_index(i)?;
        let pci = d.pci_info()?;
        let cc = d.cuda_compute_capability()?;
        let memory = d.memory_info()?;
        found.push(((pci.domain, pci.bus, pci.device), d.name()?, memory.total >> 20, memory.used >> 20, (cc.major as u32, cc.minor as u32)));
    }
    // CUDA_DEVICE_ORDER=PCI_BUS_ID numbers the cards by PCI address: they are ordered explicitly, without trusting
    // NVML's order.
    found.sort_by_key(|t| t.0);
    Ok(found
        .into_iter()
        .enumerate()
        .map(|(i, (_, name, memory_mib, used_mib, cc))| {
            (Gpu { index: i as u32, name, vendor: Vendor::Nvidia, memory_mib, shared_mib: 0, cuda_driver: Some(cuda_driver), cc: Some(cc) }, used_mib)
        })
        .collect())
}

/// Memory in use right now on each card, numbered as `detect` numbers them: (index, MiB used, MiB total). A card that cannot
/// be read is not in the list: whoever needs it says so, it is not a card with nothing in use.
pub fn gpu_memory() -> Vec<(u32, u64, u64)> {
    let nvidia = nvidia_gpus().unwrap_or_default();
    match dxgi_gpus() {
        Ok(dxgi) => memory_of(&nvidia, &dxgi, &adapter_memory()),
        Err(_) => memory_of(&nvidia, &[], &HashMap::new()),
    }
}

/// `gpu_memory` from its three sources: the NVML cards with what is in use on them, the DXGI adapters, and the bytes of
/// dedicated memory in use by LUID. The cards are numbered as `merge` numbers them.
fn memory_of(nvidia: &[(Gpu, u64)], dxgi: &[DxgiGpu], in_use: &HashMap<u64, u64>) -> Vec<(u32, u64, u64)> {
    let mut cards: Vec<(u32, u64, u64)> = nvidia.iter().map(|(gpu, used)| (gpu.index, *used, gpu.memory_mib)).collect();
    for (i, (_, adapter)) in beside_nvml(nvidia.is_empty(), dxgi).enumerate() {
        if let Some(bytes) = in_use.get(&adapter.luid) {
            cards.push(((nvidia.len() + i) as u32, bytes >> 20, adapter.memory_mib));
        }
    }
    cards
}

// --- memory in use of every card (Windows' counters) -----------------------------------------

/// Bytes of dedicated memory in use on each graphics adapter by all the programs together, by the adapter's LUID. An adapter
/// that does not answer is not in the map.
fn adapter_memory() -> HashMap<u64, u64> {
    let mut in_use = HashMap::new();
    let (mut query, mut counter) = (0isize, 0isize);
    // SAFETY: the query and the counter are handles of this function, closed before it returns. The buffer has the size the
    // counters ask for, in u64 units for the alignment of the items, and is read only up to the count they give.
    unsafe {
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return in_use;
        }
        if PdhAddEnglishCounterW(query, w!(r"\GPU Adapter Memory(*)\Dedicated Usage"), 0, &mut counter) == 0 && PdhCollectQueryData(query) == 0 {
            let (mut size, mut count) = (0u32, 0u32);
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, &mut size, &mut count, None) == PDH_MORE_DATA {
                let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
                let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
                if PdhGetFormattedCounterArrayW(counter, PDH_FMT_LARGE, &mut size, &mut count, Some(items)) == 0 {
                    for item in std::slice::from_raw_parts(items, count as usize) {
                        let luid = item.szName.to_string().ok().and_then(|name| luid_of(&name));
                        if let (Some(luid), 0) = (luid, item.FmtValue.CStatus) {
                            *in_use.entry(luid).or_insert(0) += item.FmtValue.Anonymous.largeValue.max(0) as u64;
                        }
                    }
                }
            }
        }
        PdhCloseQuery(query);
    }
    in_use
}

/// The LUID an instance of the adapter counters names: `luid_0x00000000_0x00011920_phys_0` is `0x11920`.
fn luid_of(instance: &str) -> Option<u64> {
    let mut parts = instance.strip_prefix("luid_")?.split('_').map(|p| u64::from_str_radix(p.strip_prefix("0x")?, 16).ok());
    let (high, low) = (parts.next()??, parts.next()??);
    Some(high << 32 | low)
}

// --- all the cards (DXGI) --------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct DxgiGpu {
    name: String,
    vendor_id: u32,
    memory_mib: u64,
    shared_mib: u64,
    /// What Windows' counters name the adapter by.
    luid: u64,
}

/// Windows' graphics adapters, without the software ones (Microsoft Basic Render Driver).
fn dxgi_gpus() -> Result<Vec<DxgiGpu>> {
    let err = |e: windows::core::Error| user(&tr!("Non riesco a leggere le schede video del computer.", "I can't read the computer's graphics cards."), e);
    // SAFETY: read-only COM calls on the graphics system, no pointer passed by us.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(err)?;
        let mut v = Vec::new();
        // `EnumAdapters1` ends with DXGI_ERROR_NOT_FOUND: it's the end of the list, not a failure.
        let mut i = 0;
        while let Ok(a) = factory.EnumAdapters1(i) {
            i += 1;
            let d = a.GetDesc1().map_err(err)?;
            if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let end = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            v.push(DxgiGpu {
                name: String::from_utf16_lossy(&d.Description[..end]),
                vendor_id: d.VendorId,
                memory_mib: d.DedicatedVideoMemory as u64 / (1 << 20),
                shared_mib: d.SharedSystemMemory as u64 / (1 << 20),
                luid: u64::from(d.AdapterLuid.HighPart as u32) << 32 | u64::from(d.AdapterLuid.LowPart),
            });
        }
        Ok(v)
    }
}

fn vendor_from_id(id: u32) -> Vendor {
    match id {
        0x10DE => Vendor::Nvidia,
        0x1002 | 0x1022 => Vendor::Amd,
        0x8086 => Vendor::Intel,
        _ => Vendor::Other,
    }
}

/// The DXGI adapters that are cards of the list after the NVML ones, with their brand: the NVIDIA ones only if NVML sees no
/// NVIDIA card (`nvml_empty`).
fn beside_nvml(nvml_empty: bool, dxgi: &[DxgiGpu]) -> impl Iterator<Item = (Vendor, &DxgiGpu)> {
    dxgi.iter().map(|d| (vendor_from_id(d.vendor_id), d)).filter(move |(vendor, _)| *vendor != Vendor::Nvidia || nvml_empty)
}

/// The NVIDIA cards come from NVML; DXGI adds the others. If NVML sees no NVIDIA but DXGI does, it keeps them
/// (without CUDA version).
fn merge(nvidia: Vec<Gpu>, dxgi: Vec<DxgiGpu>) -> Vec<Gpu> {
    let mut gpus = nvidia;
    for (vendor, d) in beside_nvml(gpus.is_empty(), &dxgi) {
        let index = gpus.len() as u32;
        gpus.push(Gpu { index, name: d.name.clone(), vendor, memory_mib: d.memory_mib, shared_mib: d.shared_mib, cuda_driver: None, cc: None });
    }
    gpus
}

// --- CPU and RAM -----------------------------------------------------------------------------

fn cpu() -> Result<Cpu> {
    let name = raw_cpuid::CpuId::new()
        .get_processor_brand_string()
        .map(|b| plain_cpu_name(b.as_str()))
        .with_context(|| tr!("la CPU non dice il suo nome", "the CPU doesn't say its name"))?;
    Ok(Cpu {
        name,
        cores: physical_cores()?,
        avx2: std::is_x86_feature_detected!("avx2"),
        avx512: std::is_x86_feature_detected!("avx512f"),
    })
}

/// The processor's name as a person writes it: «Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz» is «Intel Core i7-10700K»,
/// «AMD Ryzen 9 5900X 12-Core Processor» is «AMD Ryzen 9 5900X». Without the trademarks, the word «CPU», the clock after
/// «@», the graphics after «with» and the count of cores; the name is only shown, nothing is matched on it.
fn plain_cpu_name(brand: &str) -> String {
    let name = brand.split(" @ ").next().unwrap_or(brand);
    let name = name.split(" with ").next().unwrap_or(name);
    let words: Vec<&str> = name.split_whitespace().collect();
    let cores = |w: &str| w.strip_suffix("-Core").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    let cut = words.iter().position(|w| cores(w)).filter(|&i| words[i + 1..] == ["Processor"]).unwrap_or(words.len());
    words[..cut]
        .iter()
        .map(|w| w.replace("(R)", "").replace("(r)", "").replace("(TM)", "").replace("(tm)", ""))
        .filter(|w| !w.is_empty() && w != "CPU")
        .collect::<Vec<_>>()
        .join(" ")
}

/// Physical cores: `std::thread::available_parallelism` counts threads, and llama.cpp is slower with the twin
/// hyper-threading threads.
fn physical_cores() -> Result<u32> {
    // SAFETY: two calls to the same Windows function: the first says how many bytes are needed, the second fills a
    // buffer of that size. Each element declares its length (`Size`).
    unsafe {
        let mut bytes = 0u32;
        let _ = GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut bytes);
        let mut buf = vec![0u8; bytes as usize];
        GetLogicalProcessorInformationEx(RelationProcessorCore, Some(buf.as_mut_ptr().cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>()), &mut bytes)
            .with_context(|| tr!("Non riesco a contare i core della CPU.", "I can't count the CPU cores."))?;
        let (mut core, mut pos) = (0, 0usize);
        while pos < bytes as usize {
            let e = &*buf.as_ptr().add(pos).cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
            core += 1;
            pos += e.Size as usize;
        }
        Ok(core)
    }
}

/// The RAM the programs leave free right now.
pub fn free_ram_mib() -> Result<u64> {
    Ok(memory_status()?.ullAvailPhys / (1 << 20))
}

fn ram_mib() -> Result<u64> {
    Ok(memory_status()?.ullTotalPhys / (1 << 20))
}

fn memory_status() -> Result<MEMORYSTATUSEX> {
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `m` is initialized with its length, as the function requires.
    unsafe { GlobalMemoryStatusEx(&mut m) }.with_context(|| tr!("Non riesco a leggere la memoria del computer.", "I can't read the computer's memory."))?;
    Ok(m)
}

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;

    pub fn nvidia(index: u32, name: &str, memory_mib: u64, cc: (u32, u32), cuda_driver: (u32, u32)) -> Gpu {
        Gpu { index, name: name.into(), vendor: Vendor::Nvidia, memory_mib, shared_mib: 0, cuda_driver: Some(cuda_driver), cc: Some(cc) }
    }

    pub fn other(index: u32, name: &str, vendor: Vendor, memory_mib: u64) -> Gpu {
        Gpu { index, name: name.into(), vendor, memory_mib, shared_mib: 0, cuda_driver: None, cc: None }
    }

    /// The processor's graphics, with the memory the BIOS gives it and the memory of the PC it may borrow.
    pub fn integrated(index: u32, name: &str, memory_mib: u64, shared_mib: u64) -> Gpu {
        let vendor = if name.starts_with("Intel") { Vendor::Intel } else { Vendor::Amd };
        Gpu { index, name: name.into(), vendor, memory_mib, shared_mib, cuda_driver: None, cc: None }
    }

    pub fn fake_cpu() -> Cpu {
        Cpu { name: "Fake CPU".into(), cores: 8, avx2: true, avx512: false }
    }

    pub fn pc(gpus: Vec<Gpu>, ram_mib: u64) -> Hardware {
        Hardware { gpus, cpu: fake_cpu(), ram_mib, integrated: false, nvml_error: None }
    }

    /// Two identical cards, RTX 3060 12 GB, and a GTX 1080, in PCI order.
    pub fn twin_gpus() -> Hardware {
        pc(
            vec![
                nvidia(0, "NVIDIA GeForce RTX 3060", 12288, (8, 6), (12, 6)),
                nvidia(1, "NVIDIA GeForce GTX 1080", 8192, (6, 1), (12, 6)),
                nvidia(2, "NVIDIA GeForce RTX 3060", 12288, (8, 6), (12, 6)),
            ],
            65_536,
        )
    }

    /// Three cards, RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (driver 560.94: CUDA 12.6), in PCI order.
    pub fn three_gpus() -> Hardware {
        pc(
            vec![
                nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6)),
                nvidia(1, "NVIDIA GeForce GTX 1080", 8192, (6, 1), (12, 6)),
                nvidia(2, "NVIDIA GeForce GTX 1660 SUPER", 6144, (7, 5), (12, 6)),
            ],
            65_536,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    #[test]
    fn identical_cards_are_told_apart_by_their_order_and_a_name_alone_names_them_all() {
        let hw = twin_gpus();
        let ids: Vec<String> = hw.gpus.iter().map(|g| hw.card_id(g)).collect();
        assert_eq!(ids, ["NVIDIA GeForce RTX 3060 #1", "NVIDIA GeForce GTX 1080", "NVIDIA GeForce RTX 3060 #2"]);
        let named = |entry: &str| hw.gpus.iter().filter(|g| hw.names(entry, g)).map(|g| g.index).collect::<Vec<_>>();
        assert_eq!(named("NVIDIA GeForce RTX 3060 #2"), [2]);
        assert_eq!(named("NVIDIA GeForce RTX 3060"), [0, 2]);
        assert_eq!(named("NVIDIA GeForce GTX 1080"), [1]);
        assert_eq!(named("NVIDIA GeForce RTX 3060 #3"), Vec::<u32>::new());
        let three = three_gpus();
        assert!(three.gpus.iter().all(|g| three.card_id(g) == g.name), "a card without a twin keeps its name");
    }

    /// Real brand strings of Intel and AMD processors, as the CPU gives them.
    #[test]
    fn the_processor_is_named_as_a_person_writes_it() {
        for (brand, name) in [
            ("Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz", "Intel Core i7-10700K"),
            ("Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz  ", "Intel Core i5-8250U"),
            ("12th Gen Intel(R) Core(TM) i7-12700K", "12th Gen Intel Core i7-12700K"),
            ("Intel(R) Core(TM) Ultra 7 155H", "Intel Core Ultra 7 155H"),
            ("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz", "Intel Xeon E5-2680 v4"),
            ("AMD Ryzen 7 5825U with Radeon Graphics         ", "AMD Ryzen 7 5825U"),
            ("AMD Ryzen 5 2500U with Radeon Vega Mobile Gfx  ", "AMD Ryzen 5 2500U"),
            ("AMD Ryzen 9 5900X 12-Core Processor            ", "AMD Ryzen 9 5900X"),
            ("AMD Ryzen Threadripper 3970X 32-Core Processor", "AMD Ryzen Threadripper 3970X"),
            ("AMD Ryzen 7 7800X3D 8-Core Processor", "AMD Ryzen 7 7800X3D"),
            ("AMD Athlon(tm) II X2 250 Processor", "AMD Athlon II X2 250 Processor"),
        ] {
            assert_eq!(plain_cpu_name(brand), name, "{brand}");
        }
    }

    #[test]
    fn without_cards_the_cpu_is_used() {
        assert_eq!(choose_build(&pc(vec![], 16_384)), Build::Cpu);
    }

    #[test]
    fn integrated_graphics_does_not_count() {
        let hw = pc(vec![other(0, "Intel(R) UHD Graphics 770", Vendor::Intel, 128)], 16_384);
        assert_eq!(choose_build(&hw), Build::Cpu);
        assert_eq!(hw.usable().count(), 0);
    }

    /// The BIOS of a laptop gives the integrated graphics up to 4 GiB of the PC's own memory: no model fits there with
    /// its context, and the processor has the rest.
    #[test]
    fn integrated_graphics_does_not_count_with_the_memory_a_laptop_gives_it() {
        for (name, vendor) in [
            ("AMD Radeon(TM) Graphics", Vendor::Amd),
            ("AMD Radeon(TM) Vega 8 Graphics", Vendor::Amd),
            ("AMD Radeon RX Vega 11 Graphics", Vendor::Amd),
            ("AMD Radeon 780M Graphics", Vendor::Amd),
            ("Intel(R) UHD Graphics 770", Vendor::Intel),
            ("Intel(R) Iris(R) Xe Graphics", Vendor::Intel),
            ("Intel(R) Arc(TM) Graphics", Vendor::Intel),
            ("Intel(R) HD Graphics 620", Vendor::Intel),
            ("Intel(R) Graphics", Vendor::Intel),
            ("Intel(R) Arc(TM) 140V GPU (16GB)", Vendor::Intel),
            ("Intel(R) Arc(TM) 140T GPU (16GB)", Vendor::Intel),
            ("Intel(R) Arc(TM) 130T GPU", Vendor::Intel),
            ("AMD Radeon(TM) 610M", Vendor::Amd),
            ("AMD Radeon(TM) R5 Graphics", Vendor::Amd),
            ("AMD Radeon 8060S Graphics", Vendor::Amd),
        ] {
            let hw = pc(vec![other(0, name, vendor, 4096)], 16_384);
            assert_eq!(hw.usable().count(), 0, "{name}");
            assert_eq!(choose_build(&hw), Build::Cpu, "{name}");
        }
    }

    /// Integrated graphics that was given 8 GB or more (a Ryzen AI Max, a mini PC set that way) is the card of that PC:
    /// the memory is taken from the processor's and the models run on Vulkan. Windows reports a setting some MiB short.
    #[test]
    fn integrated_graphics_given_8_gb_or_more_is_a_card() {
        for (name, vendor, memory_mib, ram_mib) in [
            ("AMD Radeon(TM) 8060S Graphics", Vendor::Amd, 98_304, 32_000),
            ("AMD Radeon(TM) 8060S Graphics", Vendor::Amd, 32_768, 32_000),
            ("AMD Radeon(TM) 8050S Graphics", Vendor::Amd, 8176, 24_000),
            ("AMD Radeon 780M Graphics", Vendor::Amd, 16_384, 16_000),
            ("Intel(R) Arc(TM) Graphics", Vendor::Intel, 8192, 24_000),
        ] {
            let hw = pc(vec![other(0, name, vendor, memory_mib)], ram_mib);
            assert_eq!(hw.usable().map(|g| g.name.as_str()).collect::<Vec<_>>(), [name], "{memory_mib} MiB");
            assert_eq!(choose_build(&hw), Build::Vulkan, "{name}, {memory_mib} MiB");
        }
        let below = pc(vec![other(0, "AMD Radeon(TM) 8060S Graphics", Vendor::Amd, 6144)], 58_000);
        assert_eq!((below.usable().count(), choose_build(&below)), (0, Build::Cpu));
    }

    /// A laptop with only the processor's graphics (values as Windows gives them for a Ryzen 7 5825U with 16 GB): off at
    /// first; with the user's switch on it is the card of the plan, with the PC's memory it may borrow, less what Windows
    /// and the other programs keep and the engine's margin.
    #[test]
    fn integrated_graphics_borrows_the_ram_when_the_user_lets_it() {
        let mut hw = pc(vec![integrated(0, "AMD Radeon(TM) Graphics", 512, 7_700)], 15_700);
        assert_eq!((hw.usable().count(), choose_build(&hw)), (0, Build::Cpu), "off at first");

        hw.integrated = true;
        assert_eq!(hw.usable().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["AMD Radeon(TM) Graphics"]);
        assert_eq!(choose_build(&hw), Build::Vulkan);
        assert!(hw.borrows_ram(&hw.gpus[0]));
        assert_eq!(hw.model_memory_mib(&hw.gpus[0]), 7_700 - 1024, "the memory it may borrow, less the engine's margin");

        hw.ram_mib = 8_000;
        assert_eq!(hw.model_memory_mib(&hw.gpus[0]), 8_000 - 4096 - 1024, "never more than the RAM Windows and the programs leave");
        hw.ram_mib = 5_000;
        assert_eq!((hw.usable().count(), choose_build(&hw)), (0, Build::Cpu), "nothing left to borrow");
    }

    /// The integrated graphics is never added to a dedicated card that counts, whatever memory it has: a model runs on one
    /// kind of memory, and the engine with Vulkan leaves the integrated one out by itself when there is a dedicated card.
    #[test]
    fn with_a_dedicated_card_the_integrated_graphics_does_not_count() {
        let mut hw = three_gpus();
        hw.gpus.push(integrated(3, "Intel(R) UHD Graphics 630", 128, 32_000));
        hw.integrated = true;
        assert_eq!(hw.usable().count(), 3);
        assert_eq!(choose_build(&hw), Build::Cuda12);

        let mut amd = pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368), integrated(1, "AMD Radeon(TM) 8060S Graphics", 32_768, 16_000)], 64_000);
        assert_eq!(amd.usable().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["AMD Radeon RX 7800 XT"]);
        amd.integrated = true;
        assert_eq!(amd.usable().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["AMD Radeon RX 7800 XT"]);
        assert!(!amd.borrows_ram(&amd.gpus[1]));
    }

    /// Integrated graphics given the memory of a card by the BIOS counts on that memory, switch or not: it does not borrow.
    #[test]
    fn integrated_graphics_with_a_card_of_memory_does_not_borrow() {
        let mut hw = pc(vec![integrated(0, "AMD Radeon(TM) 8060S Graphics", 65_536, 31_000)], 64_000);
        for on in [false, true] {
            hw.integrated = on;
            assert_eq!(hw.usable().count(), 1);
            assert!(!hw.borrows_ram(&hw.gpus[0]));
            assert_eq!(hw.model_memory_mib(&hw.gpus[0]), 65_536 - GPU_RESERVE_MIB);
        }
    }

    #[test]
    fn dxgi_gives_the_memory_an_adapter_may_borrow() {
        let dxgi = vec![DxgiGpu { name: "AMD Radeon(TM) Graphics".into(), vendor_id: 0x1002, memory_mib: 512, shared_mib: 7_700, luid: 0x200 }];
        assert_eq!(merge(vec![], dxgi)[0].shared_mib, 7_700);
    }

    /// Next to an NVIDIA card with CUDA the engine uses only that one, as with any card of another brand.
    #[test]
    fn integrated_graphics_with_much_memory_does_not_take_cuda_away() {
        let mut hw = three_gpus();
        hw.gpus.push(other(3, "AMD Radeon(TM) 8060S Graphics", Vendor::Amd, 32_768));
        assert_eq!(choose_build(&hw), Build::Cuda12);
    }

    #[test]
    fn a_discrete_card_counts_whoever_makes_it() {
        for (name, vendor, memory_mib) in [
            ("AMD Radeon RX 7800 XT", Vendor::Amd, 16_368),
            ("AMD Radeon RX 6800M", Vendor::Amd, 12_272),
            ("AMD Radeon RX Vega 64", Vendor::Amd, 8176),
            ("AMD Radeon Pro W7800", Vendor::Amd, 32_752),
            ("Intel(R) Arc(TM) A770 Graphics", Vendor::Intel, 16_256),
            ("Intel(R) Arc(TM) B580 Graphics", Vendor::Intel, 12_272),
            ("Intel(R) Iris(R) Xe MAX Graphics", Vendor::Intel, 4096),
            ("Intel(R) Arc(TM) A370M Graphics", Vendor::Intel, 4096),
            ("Intel(R) Arc(TM) A550M Graphics", Vendor::Intel, 8192),
            ("Intel(R) Arc(TM) A730M Graphics", Vendor::Intel, 12_288),
            ("Intel(R) Arc(TM) A770M Graphics", Vendor::Intel, 16_256),
            ("Intel(R) Arc(TM) Pro A60 Graphics", Vendor::Intel, 12_288),
            ("Intel(R) Data Center GPU Max 1100", Vendor::Intel, 49_152),
            ("AMD Radeon Pro WX 7100", Vendor::Amd, 8176),
            ("AMD Radeon Pro WX 7100 Graphics", Vendor::Amd, 8176),
            ("AMD Radeon(TM) Pro W6600 Graphics", Vendor::Amd, 8176),
            ("AMD FirePro W5100", Vendor::Amd, 4096),
            ("AMD FirePro W5100 Graphics", Vendor::Amd, 4096),
        ] {
            let hw = pc(vec![other(0, name, vendor, memory_mib)], 16_384);
            assert_eq!(hw.usable().count(), 1, "{name}");
            assert_eq!(choose_build(&hw), Build::Vulkan, "{name}");
        }
    }

    #[test]
    fn amd_and_intel_go_on_vulkan() {
        assert_eq!(choose_build(&pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768)), Build::Vulkan);
        assert_eq!(choose_build(&pc(vec![other(0, "Intel(R) Arc(TM) A770", Vendor::Intel, 16_256)], 32_768)), Build::Vulkan);
    }

    #[test]
    fn nvidia_with_a_cuda_13_driver_and_recent_cards_uses_cuda_13() {
        let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 5070", 12_227, (12, 0), (13, 4))], 32_768);
        assert_eq!(choose_build(&hw), Build::Cuda13);
    }

    #[test]
    fn nvidia_with_a_cuda_12_driver_uses_cuda_12() {
        assert_eq!(choose_build(&three_gpus()), Build::Cuda12);
        let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4070", 12_282, (8, 9), (12, 4))], 32_768);
        assert_eq!(choose_build(&hw), Build::Cuda12);
    }

    /// CUDA 13 dropped Pascal: with a GTX 10 in the PC the build is 12 even if the driver supports 13.
    #[test]
    fn a_pascal_card_stays_on_cuda_12_even_with_a_13_driver() {
        let hw = pc(
            vec![
                nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (13, 4)),
                nvidia(1, "NVIDIA GeForce GTX 1080", 8192, (6, 1), (13, 4)),
            ],
            65_536,
        );
        assert_eq!(choose_build(&hw), Build::Cuda12);
    }

    /// A CUDA 13.0-13.3 driver isn't enough for build 13.4 but supports 12.
    #[test]
    fn an_old_13_driver_uses_cuda_12() {
        let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (13, 0))], 65_536);
        assert_eq!(choose_build(&hw), Build::Cuda12);
    }

    #[test]
    fn nvidia_with_an_old_or_mute_driver_goes_on_vulkan() {
        let old = pc(vec![nvidia(0, "NVIDIA GeForce GTX 1060", 6144, (6, 1), (11, 4))], 16_384);
        assert_eq!(choose_build(&old), Build::Vulkan);
        let mute = pc(vec![other(0, "NVIDIA GeForce GTX 1060", Vendor::Nvidia, 6144)], 16_384);
        assert_eq!(choose_build(&mute), Build::Vulkan);
    }

    #[test]
    fn nvidia_with_cuda_beats_amd_in_the_same_pc() {
        let hw = pc(
            vec![nvidia(0, "NVIDIA GeForce RTX 3060", 12_288, (8, 6), (12, 6)), other(1, "AMD Radeon RX 6600", Vendor::Amd, 8176)],
            32_768,
        );
        assert_eq!(choose_build(&hw), Build::Cuda12);
    }

    #[test]
    fn the_vendor_id_gives_the_brand() {
        assert_eq!(vendor_from_id(0x10DE), Vendor::Nvidia);
        assert_eq!(vendor_from_id(0x1002), Vendor::Amd);
        assert_eq!(vendor_from_id(0x8086), Vendor::Intel);
        assert_eq!(vendor_from_id(0x1414), Vendor::Other);
    }

    #[test]
    fn merging_nvml_and_dxgi_does_not_duplicate_the_nvidia_cards() {
        let nvml = vec![nvidia(0, "NVIDIA GeForce RTX 3060", 12_288, (8, 6), (12, 6))];
        let dxgi = vec![
            DxgiGpu { name: "NVIDIA GeForce RTX 3060".into(), vendor_id: 0x10DE, memory_mib: 12_090, shared_mib: 0, luid: 0x100 },
            DxgiGpu { name: "AMD Radeon(TM) Graphics".into(), vendor_id: 0x1002, memory_mib: 512, shared_mib: 0, luid: 0x200 },
        ];
        let v = merge(nvml, dxgi);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].memory_mib, 12_288, "for NVIDIA cards NVML rules");
        assert_eq!((v[1].vendor, v[1].index, v[1].cuda_driver), (Vendor::Amd, 1, None));
    }

    /// The memory in use of every brand: NVML's for the NVIDIA cards, Windows' counters by LUID for the others, numbered as the
    /// list of `detect`. An adapter the counters do not give is not in the reading, and the cards after it keep their numbers.
    #[test]
    fn the_memory_in_use_is_read_for_every_brand_with_the_numbers_of_the_list() {
        let dxgi = |luid: u64, vendor_id: u32, memory_mib: u64| DxgiGpu { name: String::new(), vendor_id, memory_mib, shared_mib: 0, luid };
        let adapters = [dxgi(0x100, 0x10DE, 12_090), dxgi(0x200, 0x1002, 16_368), dxgi(0x300, 0x8086, 128), dxgi(0x400, 0x1002, 8_176)];
        let gib = |n: u64| n << 30;
        let in_use = HashMap::from([(0x100, gib(1)), (0x200, gib(15)), (0x300, 5 << 20), (0x999, gib(3))]);

        let nvml = vec![(nvidia(0, "NVIDIA GeForce RTX 3060", 12_288, (8, 6), (12, 6)), 700)];
        assert_eq!(memory_of(&nvml, &adapters, &in_use), [(0, 700, 12_288), (1, 15_360, 16_368), (2, 5, 128)], "NVML rules for the NVIDIA card; the fourth adapter has no counter");

        let radeon = [adapters[1].clone()];
        assert_eq!(memory_of(&[], &radeon, &in_use), [(0, 15_360, 16_368)], "a PC without NVIDIA: the Radeon is card 0, as in `detect`");
        assert_eq!(memory_of(&[], &adapters, &in_use), [(0, 1_024, 12_090), (1, 15_360, 16_368), (2, 5, 128)], "NVML silent: DXGI's NVIDIA card is read from the counters");
        assert_eq!(memory_of(&[], &radeon, &HashMap::new()), [], "counters that do not answer: nothing is read");
    }

    /// The instances of «GPU Adapter Memory» as Windows names them (two of them as read on a PC of the tests).
    #[test]
    fn an_adapter_counter_is_named_by_its_luid() {
        assert_eq!(luid_of("luid_0x00000000_0x00011920_phys_0"), Some(0x11920));
        assert_eq!(luid_of("luid_0x00000001_0x000118f3_phys_1"), Some(0x1_000118f3));
        assert_eq!(luid_of("_Total"), None);
        assert_eq!(luid_of("luid_0x00000000_phys_0"), None);
    }

    #[test]
    fn if_nvml_is_silent_dxgis_nvidia_cards_stay_without_cuda() {
        let dxgi = vec![DxgiGpu { name: "NVIDIA GeForce GTX 1650".into(), vendor_id: 0x10DE, memory_mib: 4096, shared_mib: 0, luid: 0x100 }];
        let v = merge(vec![], dxgi);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].vendor, v[0].cuda_driver, v[0].cc), (Vendor::Nvidia, None, None));
        assert_eq!(choose_build(&pc(v, 16_384)), Build::Vulkan);
    }

    /// Issue #2: a GT 710 has a legacy driver whose NVML lacks functions, so it comes from DXGI. It is sold with 1 or
    /// 2 GiB: either way no model fits on it and it doesn't count, like the processor's integrated graphics next to
    /// it. The build is the processor's.
    #[test]
    fn an_old_small_nvidia_card_read_from_dxgi_leaves_the_processor() {
        for memory_mib in [1024, 2048] {
            let dxgi = vec![
                DxgiGpu { name: "NVIDIA GeForce GT 710".into(), vendor_id: 0x10DE, memory_mib, shared_mib: 0, luid: 0x100 },
                DxgiGpu { name: "Intel(R) Graphics".into(), vendor_id: 0x8086, memory_mib: 128, shared_mib: 0, luid: 0x200 },
            ];
            let hw = pc(merge(vec![], dxgi), 16_384);
            assert_eq!(hw.usable().count(), 0, "{memory_mib} MiB");
            assert_eq!(choose_build(&hw), Build::Cpu, "{memory_mib} MiB");
        }
    }

    /// Test on a real PC with RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER, in PCI order, with driver 560.94 (CUDA 12.6).
    #[test]
    #[ignore = "requires an RTX 3060 Ti, a GTX 1080 and a GTX 1660 SUPER"]
    fn detects_the_three_real_gpus() {
        let hw = detect_bare().unwrap();
        println!("{hw:#?}");
        // The three NVIDIA cards, and the CPU's integrated graphics (Intel UHD 630, 128 MiB) which doesn't count.
        let names: Vec<&str> = hw.usable().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce GTX 1080", "NVIDIA GeForce GTX 1660 SUPER"]);
        assert!(hw.usable().all(|s| s.vendor == Vendor::Nvidia && s.cuda_driver == Some((12, 6))));
        assert_eq!(hw.usable().map(|s| s.cc).collect::<Vec<_>>(), [Some((8, 6)), Some((6, 1)), Some((7, 5))]);
        assert!(hw.gpus.iter().any(|s| s.vendor == Vendor::Intel && s.memory_mib < MIN_GPU_MEMORY_MIB));
        assert_eq!(choose_build(&hw), Build::Cuda12);
        assert!(hw.cpu.cores >= 1 && hw.cpu.avx2 && !hw.cpu.name.is_empty());
        assert!(hw.ram_mib > 4096);
    }
}
