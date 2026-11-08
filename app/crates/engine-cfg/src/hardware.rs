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
use serde::{Deserialize, Serialize};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
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
    /// Maximum CUDA version the NVIDIA driver supports, e.g. (12, 6). `None` if it isn't an NVIDIA or NVML doesn't answer.
    pub cuda_driver: Option<(u32, u32)>,
    /// CUDA compute capability, e.g. (8, 6). NVIDIA with NVML only.
    pub cc: Option<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cpu {
    pub name: String,
    /// Physical cores (not threads).
    pub cores: u32,
    pub avx2: bool,
    pub avx512: bool,
}

/// Also as a JSON file: `mango-launch --hardware` reads it to show the plan of a PC that isn't this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hardware {
    pub gpus: Vec<Gpu>,
    pub cpu: Cpu,
    pub ram_mib: u64,
}

/// Below this dedicated memory a card doesn't count: integrated graphics have a few hundred MiB and a model doesn't
/// fit, not even the smallest one with a useful context.
pub const MIN_GPU_MEMORY_MIB: u64 = 2048;

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
}

/// Reads this PC's hardware.
pub fn detect() -> Result<Hardware> {
    let nvidia = nvidia_gpus()?;
    let dxgi = dxgi_gpus()?;
    Ok(Hardware { gpus: merge(nvidia, dxgi), cpu: cpu()?, ram_mib: ram_mib()? })
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

/// The NVIDIA cards in PCI order. Empty if the PC doesn't have the NVIDIA driver.
fn nvidia_gpus() -> Result<Vec<Gpu>> {
    let nvml = match Nvml::init() {
        Ok(n) => n,
        Err(NvmlError::DriverNotLoaded | NvmlError::LibraryNotFound | NvmlError::LibloadingError(_)) => return Ok(Vec::new()),
        Err(e) => return Err(user(&tr!("Non riesco a interrogare la scheda video NVIDIA.", "I can't query the NVIDIA graphics card."), e)),
    };
    let err = |e: NvmlError| {
        user(&tr!("Non riesco a leggere le caratteristiche della scheda video NVIDIA.", "I can't read the NVIDIA graphics card's characteristics."), e)
    };
    let version = nvml.sys_cuda_driver_version().map_err(err)?;
    let cuda_driver = ((version / 1000) as u32, ((version % 1000) / 10) as u32);
    let mut found = Vec::new();
    for i in 0..nvml.device_count().map_err(err)? {
        let d = nvml.device_by_index(i).map_err(err)?;
        let pci = d.pci_info().map_err(err)?;
        let cc = d.cuda_compute_capability().map_err(err)?;
        found.push((
            (pci.domain, pci.bus, pci.device),
            d.name().map_err(err)?,
            d.memory_info().map_err(err)?.total / (1 << 20),
            (cc.major as u32, cc.minor as u32),
        ));
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
        .map(|b| b.as_str().trim().to_string())
        .with_context(|| tr!("la CPU non dice il suo nome", "the CPU doesn't say its name"))?;
    Ok(Cpu {
        name,
        cores: physical_cores()?,
        avx2: std::is_x86_feature_detected!("avx2"),
        avx512: std::is_x86_feature_detected!("avx512f"),
    })
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
        Hardware { gpus, cpu: fake_cpu(), ram_mib }
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
