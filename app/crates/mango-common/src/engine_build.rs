//! The builds of an engine for Windows x64: one per kind of GPU (or none).

use serde::{Deserialize, Serialize};
use std::fmt;

/// Which hardware the engine is compiled for. In the catalog and in profiles it is written
/// `"cpu"`, `"vulkan"`, `"cuda-12"`, `"cuda-13"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Build {
    #[serde(rename = "cpu")]
    Cpu,
    #[serde(rename = "vulkan")]
    Vulkan,
    #[serde(rename = "cuda-12")]
    Cuda12,
    #[serde(rename = "cuda-13")]
    Cuda13,
}

impl Build {
    /// The name it has in the catalog and in the names of installed folders.
    pub fn as_str(self) -> &'static str {
        match self {
            Build::Cpu => "cpu",
            Build::Vulkan => "vulkan",
            Build::Cuda12 => "cuda-12",
            Build::Cuda13 => "cuda-13",
        }
    }

    /// The CUDA major version the build requires; `None` if it doesn't use CUDA.
    pub fn cuda_major(self) -> Option<u32> {
        match self {
            Build::Cuda12 => Some(12),
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
        for b in [Build::Cpu, Build::Vulkan, Build::Cuda12, Build::Cuda13] {
            assert_eq!(serde_json::to_string(&b).unwrap(), format!("\"{}\"", b.as_str()));
            assert_eq!(serde_json::from_str::<Build>(&format!("\"{b}\"")).unwrap(), b);
        }
        assert!(serde_json::from_str::<Build>("\"cuda\"").is_err());
    }
}
