//! The PC's hardware: graphics cards of every brand, CPU, RAM. From here the engine build is chosen
//! (`choose_build`) and it is decided whether an optimized profile applies (`profiles.rs`).
//!
//! Where each thing is read from:
//! - **NVIDIA** from NVML (`nvml.dll`, the driver's library): name, memory, compute capability and the maximum
//!   CUDA version the driver supports. No process to launch (so no console window), no text to interpret, and the
//!   errors have a type. The index is that of `CUDA_DEVICE_ORDER=PCI_BUS_ID`, the same that `CUDA_VISIBLE_DEVICES`
//!   needs.
//! - **all the others** from DXGI (Windows' graphics system): brand from the vendor id, dedicated memory. DXGI
//!   sees the NVIDIA cards too, but doesn't give the CUDA version and for NVIDIA ones NVML rules; DXGI's NVIDIA
//!   cards are only used if NVML doesn't answer (broken driver): they stay in the list, without CUDA version, and
//!   the build will be Vulkan.

use crate::user;
use anyhow::{Context, Result};
use mango_common::{tr, Build};
use nvml_wrapper::error::NvmlError;
use nvml_wrapper::Nvml;
use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GlobalMemoryStatusEx, RelationProcessorCore, MEMORYSTATUSEX,
    SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gpu {
    /// NVIDIA: position in PCI order (that of `CUDA_VISIBLE_DEVICES`). The others: the position after the NVIDIA ones.
    pub index: u32,
    pub name: String,
    pub vendor: Vendor,
    /// Dedicated memory.
    pub memory_mib: u64,
    /// Maximum CUDA version the NVIDIA driver supports, e.g. (12, 6). `None` if it isn't an NVIDIA or NVML doesn't answer.
    pub cuda_driver: Option<(u32, u32)>,
    /// CUDA compute capability, e.g. (8, 6). NVIDIA with NVML only.
    pub cc: Option<(u32, u32)>,
}

impl Gpu {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cpu {
    pub name: String,
    /// Physical cores (not threads).
    pub cores: u32,
    pub avx2: bool,
    pub avx512: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hardware {
    pub gpus: Vec<Gpu>,
    pub cpu: Cpu,
    pub ram_mib: u64,
    /// Why NVML didn't answer although the NVIDIA driver is there (an old card with a legacy driver, a broken
    /// installation). The NVIDIA cards then come from DXGI, without CUDA. For the startup log.
    pub nvml_error: Option<String>,
}

/// Memory that Windows (screen, DWM) and the CUDA context take from each card (measured, see `split.rs`) plus a
/// margin for the engine's compute buffers (1024 MiB, what `-fit` would leave free by default).
pub(crate) const GPU_RESERVE_MIB: u64 = 1100 + 1024;

/// A card counts only if something is left on it after the reserve. Integrated graphics have a few hundred MiB, and
/// on a 2 GiB card (a GT 710) no model fits: counting it would pick an engine build for a card no model uses.
pub const MIN_GPU_MEMORY_MIB: u64 = GPU_RESERVE_MIB + 1;

/// CUDA version of the official llama.cpp builds: the driver must support it, and for 13 the cards must be Turing
/// or later (CUDA 13 dropped the earlier architectures).
const CUDA_12_BUILD: (u32, u32) = (12, 4);
const CUDA_13_BUILD: (u32, u32) = (13, 4);
const CC_MIN_CUDA_13: (u32, u32) = (7, 5);

impl Hardware {
    /// The cards that count: those with enough memory (integrated graphics and software adapters stay out).
    pub fn usable(&self) -> impl Iterator<Item = &Gpu> {
        self.gpus.iter().filter(|s| s.memory_mib >= MIN_GPU_MEMORY_MIB)
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

/// Reads this PC's hardware.
pub fn detect() -> Result<Hardware> {
    let (nvidia, nvml_error) = match nvidia_gpus() {
        Ok(gpus) => (gpus, None),
        // No NVIDIA driver on this PC: nothing to report.
        Err(NvmlError::DriverNotLoaded | NvmlError::LibraryNotFound | NvmlError::LibloadingError(_)) => (Vec::new(), None),
        // A driver that doesn't answer as asked (a GT 710's legacy driver lacks functions of today's NVML) must not
        // keep the app from starting: DXGI's cards stand in (`merge`) and at worst the model runs on the processor.
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(Hardware { gpus: merge(nvidia, dxgi_gpus()?), cpu: cpu()?, ram_mib: ram_mib()?, nvml_error })
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

/// The NVIDIA cards in PCI order, as NVML gives them. What an error means is decided by `detect`.
fn nvidia_gpus() -> Result<Vec<Gpu>, NvmlError> {
    let nvml = Nvml::init()?;
    let version = nvml.sys_cuda_driver_version()?;
    let cuda_driver = ((version / 1000) as u32, ((version % 1000) / 10) as u32);
    let mut found = Vec::new();
    for i in 0..nvml.device_count()? {
        let d = nvml.device_by_index(i)?;
        let pci = d.pci_info()?;
        let cc = d.cuda_compute_capability()?;
        found.push(((pci.domain, pci.bus, pci.device), d.name()?, d.memory_info()?.total / (1 << 20), (cc.major as u32, cc.minor as u32)));
    }
    // CUDA_DEVICE_ORDER=PCI_BUS_ID numbers the cards by PCI address: they are ordered explicitly, without trusting
    // NVML's order.
    found.sort_by_key(|t| t.0);
    Ok(found
        .into_iter()
        .enumerate()
        .map(|(i, (_, name, memory_mib, cc))| Gpu {
            index: i as u32,
            name,
            vendor: Vendor::Nvidia,
            memory_mib,
            cuda_driver: Some(cuda_driver),
            cc: Some(cc),
        })
        .collect())
}

/// Memory in use right now on each NVIDIA card, in PCI order: (index, MiB used, MiB total). Empty if the driver
/// doesn't answer (it's information to show, not a check).
pub fn gpu_memory() -> Vec<(u32, u64, u64)> {
    let Ok(nvml) = Nvml::init() else { return Vec::new() };
    let Ok(n) = nvml.device_count() else { return Vec::new() };
    let mut v: Vec<((u32, u32, u32), u64, u64)> = (0..n)
        .filter_map(|i| {
            let d = nvml.device_by_index(i).ok()?;
            let pci = d.pci_info().ok()?;
            let m = d.memory_info().ok()?;
            Some(((pci.domain, pci.bus, pci.device), m.used >> 20, m.total >> 20))
        })
        .collect();
    v.sort_by_key(|x| x.0);
    v.into_iter().enumerate().map(|(i, (_, u, t))| (i as u32, u, t)).collect()
}

// --- all the cards (DXGI) --------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct DxgiGpu {
    name: String,
    vendor_id: u32,
    memory_mib: u64,
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

/// The NVIDIA cards come from NVML; DXGI adds the others. If NVML sees no NVIDIA but DXGI does, it keeps them
/// (without CUDA version).
fn merge(nvidia: Vec<Gpu>, dxgi: Vec<DxgiGpu>) -> Vec<Gpu> {
    let mut gpus = nvidia;
    let nvml_empty = gpus.is_empty();
    for d in dxgi {
        let vendor = vendor_from_id(d.vendor_id);
        if vendor == Vendor::Nvidia && !nvml_empty {
            continue;
        }
        gpus.push(Gpu { index: gpus.len() as u32, name: d.name, vendor, memory_mib: d.memory_mib, cuda_driver: None, cc: None });
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

fn ram_mib() -> Result<u64> {
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `m` is initialized with its length, as the function requires.
    unsafe { GlobalMemoryStatusEx(&mut m) }.with_context(|| tr!("Non riesco a leggere la memoria del computer.", "I can't read the computer's memory."))?;
    Ok(m.ullTotalPhys / (1 << 20))
}

/// Free bytes on the disk that holds `dir` (that the user can use), also if the folder isn't there yet.
pub(crate) fn free_space(dir: &std::path::Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let cannot = |e: &dyn std::fmt::Display| user(&tr!("Non riesco a leggere lo spazio libero sul disco.", "I can't read the free space on the disk."), format!("{}: {e}", dir.display()));
    let full = std::path::absolute(dir).map_err(|e| cannot(&e))?;
    let existing = full.ancestors().find(|p| p.is_dir()).ok_or_else(|| cannot(&"no folder of the path exists"))?;
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    // SAFETY: `wide` ends with 0 and `free` is a valid pointer for the call.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.map_err(|e| cannot(&e))?;
    Ok(free)
}

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;

    pub fn nvidia(index: u32, name: &str, memory_mib: u64, cc: (u32, u32), cuda_driver: (u32, u32)) -> Gpu {
        Gpu { index, name: name.into(), vendor: Vendor::Nvidia, memory_mib, cuda_driver: Some(cuda_driver), cc: Some(cc) }
    }

    pub fn other(index: u32, name: &str, vendor: Vendor, memory_mib: u64) -> Gpu {
        Gpu { index, name: name.into(), vendor, memory_mib, cuda_driver: None, cc: None }
    }

    pub fn fake_cpu() -> Cpu {
        Cpu { name: "Fake CPU".into(), cores: 8, avx2: true, avx512: false }
    }

    pub fn pc(gpus: Vec<Gpu>, ram_mib: u64) -> Hardware {
        Hardware { gpus, cpu: fake_cpu(), ram_mib, nvml_error: None }
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
            DxgiGpu { name: "NVIDIA GeForce RTX 3060".into(), vendor_id: 0x10DE, memory_mib: 12_090 },
            DxgiGpu { name: "AMD Radeon(TM) Graphics".into(), vendor_id: 0x1002, memory_mib: 512 },
        ];
        let v = merge(nvml, dxgi);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].memory_mib, 12_288, "for NVIDIA cards NVML rules");
        assert_eq!((v[1].vendor, v[1].index, v[1].cuda_driver), (Vendor::Amd, 1, None));
    }

    #[test]
    fn if_nvml_is_silent_dxgis_nvidia_cards_stay_without_cuda() {
        let dxgi = vec![DxgiGpu { name: "NVIDIA GeForce GTX 1650".into(), vendor_id: 0x10DE, memory_mib: 4096 }];
        let v = merge(vec![], dxgi);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].vendor, v[0].cuda_driver, v[0].cc), (Vendor::Nvidia, None, None));
        assert_eq!(choose_build(&pc(v, 16_384)), Build::Vulkan);
    }

    /// Issue 2: a GT 710 has a legacy driver whose NVML lacks functions, so it comes from DXGI. It is sold with 1 or
    /// 2 GiB: either way no model fits on it and it doesn't count, like the processor's integrated graphics next to
    /// it. The build is the processor's.
    #[test]
    fn an_old_small_nvidia_card_read_from_dxgi_leaves_the_processor() {
        for memory_mib in [1024, 2048] {
            let dxgi = vec![
                DxgiGpu { name: "NVIDIA GeForce GT 710".into(), vendor_id: 0x10DE, memory_mib },
                DxgiGpu { name: "Intel(R) Graphics".into(), vendor_id: 0x8086, memory_mib: 128 },
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
        let hw = detect().unwrap();
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
