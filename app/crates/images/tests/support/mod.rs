//! What the tests of the manager and of the routes share: the plan that starts the fake engine.

use anyhow::Result;
use engine_cfg::{Gpu, ImagePlan, Vendor};
use mango_common::ProcSpec;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-sd");

/// The plan of the fake models «img» and «other» on card 1: 6 steps, `step_ms` each, with the fake engine in `mode`.
pub fn planner(mode: &'static str, step_ms: u64) -> Box<images::Planner> {
    Box::new(move |key: &str, port: u16| -> Result<ImagePlan> {
        if !["img", "other"].contains(&key) {
            anyhow::bail!("«{key}» does not make images");
        }
        let url = format!("http://127.0.0.1:{port}");
        Ok(ImagePlan {
            key: key.into(),
            label: "Img".into(),
            spec: ProcSpec {
                name: "image".into(),
                exe: FAKE.into(),
                args: vec!["--diffusion-model".into(), r"C:\fake\d.gguf".into(), "--listen-port".into(), port.to_string()],
                env: vec![("FAKE_SD_MODE".into(), mode.into()), ("FAKE_SD_STEP_MS".into(), step_ms.to_string()), ("CUDA_VISIBLE_DEVICES".into(), "1".into())],
                env_remove: vec![],
                cwd: None,
                health_url: Some(format!("{url}/sdcpp/v1/models/status")),
                ready_timeout_s: 2,
                shutdown_post: None,
                startup_post: None,
            },
            url,
            gpus: vec![Gpu { index: 1, name: "GPU 1".into(), vendor: Vendor::Nvidia, memory_mib: 8192, shared_mib: 0, cuda_driver: Some((12, 6)), cc: Some((8, 6)) }],
            steps: 6,
            cfg_scale: 1.0,
        })
    })
}
