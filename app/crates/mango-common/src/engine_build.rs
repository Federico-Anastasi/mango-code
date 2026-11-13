//! The builds of an engine for Windows x64: one per kind of GPU (or none).

use serde::{Deserialize, Serialize};
use std::fmt;

/// Which hardware the engine is compiled for. In the catalog and in profiles it is written
/// `"cpu"`, `"vulkan"`, `"cuda-12"`, `"cuda-12-gtx16"`, `"cuda-13"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Build {
    #[serde(rename = "cpu")]
    Cpu,
    #[serde(rename = "vulkan")]
    Vulkan,
    #[serde(rename = "cuda-12")]
    Cuda12,
    /// CUDA 12 for a PC whose Turing cards are of the GTX 16 family: they declare the compute capability of the RTX 20
    /// without having their tensor cores, and this build does not use the tensor-core kernels there. Only the engines
    /// of our forks have it, and only a profile asks for it (`engine-cfg`, `profiles.rs`).
    #[serde(rename = "cuda-12-gtx16")]
    Cuda12Gtx16,
    #[serde(rename = "cuda-13")]
    Cuda13,
}

impl Build {
    pub const ALL: [Build; 5] = [Build::Cpu, Build::Vulkan, Build::Cuda12, Build::Cuda12Gtx16, Build::Cuda13];

    /// The name it has in the catalog and in the names of installed folders.
    pub fn as_str(self) -> &'static str {
        match self {
            Build::Cpu => "cpu",
            Build::Vulkan => "vulkan",
            Build::Cuda12 => "cuda-12",
            Build::Cuda12Gtx16 => "cuda-12-gtx16",
            Build::Cuda13 => "cuda-13",
        }
    }

    /// The CUDA major version the build requires; `None` if it doesn't use CUDA.
    pub fn cuda_major(self) -> Option<u32> {
        match self {
            Build::Cuda12 | Build::Cuda12Gtx16 => Some(12),
            Build::Cuda13 => Some(13),
            Build::Cpu | Build::Vulkan => None,
        }
    }
}

impl fmt::Display for Build {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_names_are_the_catalog_ones() {
        for b in Build::ALL {
            assert_eq!(serde_json::to_string(&b).unwrap(), format!("\"{}\"", b.as_str()));
            assert_eq!(serde_json::from_str::<Build>(&format!("\"{b}\"")).unwrap(), b);
        }
        assert!(serde_json::from_str::<Build>("\"cuda\"").is_err());
    }

    /// The folder of an installed engine ends with its build's name: no name may end with another's after a dash, or
    /// a folder would be read as two builds.
    #[test]
    fn no_build_name_is_the_tail_of_another() {
        for a in Build::ALL {
            for b in Build::ALL {
                assert!(a == b || !a.as_str().ends_with(&format!("-{b}")), "{a} ends with {b}");
            }
        }
    }
}
