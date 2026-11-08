use super::*;
use crate::hardware::fixture::*;
use crate::fixtures::Fake;
use crate::split::fixture::*;
use std::collections::BTreeMap;

/// The real command line captured from the PowerShell launcher on 30/10, with neutral paths (`C:\Test\...`): in the
/// app the engine, models, template change, and so do the slots, which live in `paths.data`.
const PS_COMMAND_LINE: &str = r#""C:\Test\dist\engine\toq\llama-server.exe" -m C:\Test\models\Qwen3.8-27B-TOQ-v1.gguf -c 122880 --jinja --host 127.0.0.1 --port 8080 --slot-save-path C:\Test\dist\runtime\slots -np 1 --no-warmup --metrics --cache-ram 1024 -ngl 999 -fa 1 -wgt 1 -sm layer -ctk q8_0 -ctv q8_0 --chat-template-file C:\Test\dist\chat-templates\qwen3.8-mango.jinja -ub 512"#;

fn make_plan(t: &Fake, hw: &Hardware) -> Result<EnginePlan> {
    let f = t.save();
    build_plan(&t.paths, &f, None, 8080, hw, &[], |_, _, _| Ok(qwen38_27b()))
}

fn env_of(p: &EnginePlan) -> BTreeMap<&str, &str> {
    p.spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// A check that must give zero (2): the command line matches the launcher's.
#[test]
fn command_line_identical_to_the_powershell_launcher() {
    // Both with the explicit override and with the automatic split.
    for without_env in [false, true] {
        let t = if without_env { Fake::new().without_gpu_env() } else { Fake::new() };
        let paths = &t.paths;
        let expected = PS_COMMAND_LINE
            .replace(r"C:\Test\dist\runtime\slots", &paths.data.join("slots").display().to_string())
            .replace(r"C:\Test\dist\engine", &paths.engines.display().to_string())
            .replace(r"C:\Test\models", &paths.models.display().to_string())
            .replace(r"C:\Test\dist\chat-templates", &paths.dist.join("chat-templates").display().to_string())
            // the app keeps each model's on-disk memory, instead of the launcher's RAM cache
            .replace(
                "--cache-ram 1024",
                &format!("--cache-disk {} --cache-disk-mib 6144 --cache-disk-hours 24", paths.data.join("memory").join("toq").display()),
            )
            .replace('"', "");
        let expected: Vec<&str> = expected.split_whitespace().collect();
        let plan = make_plan(&t, &three_gpus()).unwrap();
        assert_eq!(plan.spec.exe.display().to_string(), expected[0]);
        assert_eq!(plan.spec.args, expected[1..], "without_env={without_env}");
        assert_eq!(plan.ctx, 122_880);
        assert_eq!(plan.gguf, t.paths.models.join("Qwen3.8-27B-TOQ-v1.gguf"));
    }
}

/// Every profile engine has on-disk memory, in its own folder, and saves the conversation before stopping: with the
/// automatic split (TOQ), with the measured `-ts` (the prism models) and with MTP.
#[test]
fn disk_memory_for_every_model() {
    let mut prism = Fake::new().without_gpu_env();
    prism.profile.as_object_mut().unwrap().remove("split");
    prism.profile["ts"] = "16,16,10".into();
    let mut mtp = Fake::new();
    mtp.profile["mtp"] = 2.into();
    for t in [Fake::new(), prism, mtp] {
        let plan = make_plan(&t, &three_gpus()).unwrap();
        let a = &plan.spec.args;
        let dir = t.paths.data.join("memory").join("toq").display().to_string();
        assert!(a.windows(2).any(|w| w == ["--cache-disk", dir.as_str()]), "{a:?}");
        assert!(a.windows(2).any(|w| w == ["--cache-disk-mib", "6144"]), "{a:?}");
        assert!(a.windows(2).any(|w| w == ["--cache-disk-hours", "24"]), "{a:?}");
        assert!(!a.iter().any(|x| x == "--cache-ram"), "{a:?}");
        assert_eq!(
            plan.spec.shutdown_post,
            Some(mango_common::PostCall { url: "http://127.0.0.1:8080/slots/0?action=persist".into(), body: String::new(), timeout_s: 60 })
        );
        assert_eq!(plan.spec.startup_post, None, "the on-disk memory restores itself");
        assert!(t.paths.data.join("memory").join("toq").is_dir());
    }
}

/// A check that must give zero (1), end to end: without the GPUs' env in the profile the automatic plan rebuilds the
/// same environment as the override.
#[test]
fn automatic_environment_equals_the_explicit_one() {
    let explicit = make_plan(&Fake::new(), &three_gpus()).unwrap();
    let auto = make_plan(&Fake::new().without_gpu_env(), &three_gpus()).unwrap();
    assert_eq!(env_of(&auto), env_of(&explicit));
    let e = env_of(&auto);
    assert_eq!(e["CUDA_DEVICE_ORDER"], "PCI_BUS_ID");
    assert_eq!(e["GGML_CUDA_GRAPHS_ANY_ARCH"], "1");
    assert_eq!(e["CUDA_VISIBLE_DEVICES"], "0,2");
    assert_eq!(e["LLAMA_LAYER_DEVICES"], MAP_A);
    assert_eq!(e["GGML_CUDA_GRAPHS_PRE_AMPERE"], "1");
    assert_eq!(auto.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(), [0, 2]);
    assert_eq!(auto.spec.health_url.as_deref(), Some("http://127.0.0.1:8080/health"));
    assert_eq!(auto.spec.name, "engine");
    assert!(!auto.images);
}

#[test]
fn the_explicit_override_wins_over_the_automatic_one() {
    let mut t = Fake::new();
    t.profile["env"]["CUDA_VISIBLE_DEVICES"] = "0,1".into();
    let f = t.save();
    // Reading the GGUF must not even be needed in manual mode.
    let p = build_plan(&t.paths, &f, None, 8080, &three_gpus(), &[], |_, _, _| panic!("GGUF read")).unwrap();
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "0,1");
    assert_eq!(p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(), [0, 1]);
    assert_eq!(p.ctx, 122_880);
}

#[test]
fn plan_with_a_24gb_card_without_a_map() {
    let mut t = Fake::new().without_gpu_env();
    t.profile["hardware"]["gpus"] = serde_json::json!(["NVIDIA GeForce RTX 4090"]);
    t.profile["ctx"] = 131_072.into();
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (12, 6))], 65_536);
    let p = make_plan(&t, &hw).unwrap();
    let e = env_of(&p);
    assert_eq!(e["CUDA_VISIBLE_DEVICES"], "0");
    assert!(!e.contains_key("LLAMA_LAYER_DEVICES"));
    assert_eq!(p.ctx, 131_072);
    assert_eq!(p.spec.args[3], "131072");
}

#[test]
fn readable_error_if_the_cards_are_not_enough() {
    let mut t = Fake::new().without_gpu_env();
    t.profile["hardware"]["gpus"] = serde_json::json!(["NVIDIA GeForce RTX 3060 Ti"]);
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6))], 65_536);
    let e = make_plan(&t, &hw).unwrap_err().to_string();
    assert!(e.contains(&tr!("non basta", "is not enough")), "{e}");
}

#[test]
fn errors_for_missing_files() {
    let t = Fake::new();
    for (rel, expected) in [
        ("models/Qwen3.8-27B-TOQ-v1.gguf", tr!("non è sul disco", "is not on disk")),
        ("engines/toq/llama-server.exe", tr!("Manca il motore", "The engine that runs the model is missing")),
        ("dist/chat-templates/qwen3.8-mango.jinja", tr!("Manca un file", "A Mango Code file is missing")),
    ] {
        let p = t._dir.path().join(rel);
        let bytes = std::fs::read(&p).unwrap();
        std::fs::remove_file(&p).unwrap();
        let e = make_plan(&t, &three_gpus()).unwrap_err().to_string();
        let name = std::path::Path::new(rel).file_name().unwrap().to_str().unwrap();
        // The missing engine says it with the name of the folder where it looks for it.
        let name = if name == "llama-server.exe" { "toq" } else { name };
        assert!(e.contains(&expected) && e.contains(&tr!("dettaglio tecnico", "technical detail")) && e.contains(name), "{e}");
        std::fs::write(&p, bytes).unwrap();
    }
}

#[test]
fn unknown_model() {
    let t = Fake::new();
    let f = t.save();
    let e = build_plan(&t.paths, &f, Some("xyz"), 8080, &three_gpus(), &[], |_, _, _| unreachable!()).unwrap_err().to_string();
    assert!(e.contains("xyz") && e.contains("toq"), "{e}");
}

#[test]
fn mmproj_turns_on_images() {
    let mut t = Fake::new();
    std::fs::write(t.paths.models.join("mm.gguf"), b"").unwrap();
    t.toq()["mmproj"] = "mm.gguf".into();
    let p = make_plan(&t, &three_gpus()).unwrap();
    assert!(p.images);
    let i = p.spec.args.iter().position(|a| a == "--mmproj").unwrap();
    assert!(p.spec.args[i + 1].ends_with("mm.gguf"));
}

/// A profile without `split` (the prism and mainline models, tuned with their `-ts`) uses all the cards as they are:
/// no layer map, no GGUF reading.
#[test]
fn without_a_split_all_the_cards_and_its_ts() {
    let mut t = Fake::new().without_gpu_env();
    t.profile.as_object_mut().unwrap().remove("split");
    t.profile["ts"] = "16,16,10".into();
    let f = t.save();
    let p = build_plan(&t.paths, &f, None, 8080, &three_gpus(), &[], |_, _, _| panic!("GGUF read")).unwrap();
    let e = env_of(&p);
    assert!(!e.contains_key("CUDA_VISIBLE_DEVICES") && !e.contains_key("LLAMA_LAYER_DEVICES"), "{e:?}");
    assert_eq!(p.gpus_used.len(), 3);
    assert!(p.spec.args.windows(2).any(|w| w == ["-ts", "16,16,10"]), "{:?}", p.spec.args);
}

/// Released cards: a model that doesn't use them starts as before, one that does doesn't.
#[test]
fn excluded_cards() {
    let t = Fake::new(); // toq by hand on 0 and 2
    let f = t.save();
    let hw = three_gpus();
    let p = build_plan(&t.paths, &f, None, 8080, &hw, &[1], |_, _, _| unreachable!()).unwrap();
    assert_eq!(p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(), [0, 2]);
    let e = build_plan(&t.paths, &f, None, 8080, &hw, &[2], |_, _, _| unreachable!()).unwrap_err().to_string();
    assert!(e.contains(&tr!("liberata", "released")) && e.contains(&tr!("scheda 2", "card 2")), "{e}");
    // With the automatic split, room is looked for on the remaining cards.
    let t = Fake::new().without_gpu_env();
    let f = t.save();
    match build_plan(&t.paths, &f, None, 8080, &hw, &[2], |_, _, _| Ok(qwen38_27b())) {
        Ok(p) => assert!(p.gpus_used.iter().all(|g| g.index != 2)),
        Err(e) => assert!(e.to_string().contains(&tr!("non basta", "is not enough")), "{e}"),
    }
}

#[test]
fn catalog_of_local_models() {
    let mut t = Fake::new();
    t.llamacpp_installed();
    t.catalog = serde_json::json!({ "ctx": 131072, "default": "a", "order": ["b", "a"], "models": {
        "a": { "label": "A", "gguf": "Qwen3.8-27B-TOQ-v1.gguf", "requires_engine": "toq", "ctx": 262144 },
        "b": { "label": "B", "gguf": "b.gguf", "mmproj": "b-mm.gguf", "ctx": 81920,
               "files": [ { "path": "b.gguf", "size": 2_000_000_000u64 } ], "memory": { "kv_kib_token": 32, "state_mib": 50 } },
        "c": { "label": "C", "cloud": { "provider": "openrouter" } } } });
    t.profile["model"] = "a".into();
    t.save();
    let (entries, default) = catalog_on_three_gpus(&t);
    assert_eq!(default, "a");
    assert_eq!(entries.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), ["b", "a"], "the order is the catalog's, not alphabetical");
    assert!(entries.iter().all(|v| v.origin == Origin::Recommended));
    assert_eq!(entries[1].missing, None);
    assert_eq!(entries[1].ctx, 122_880, "with the profile the profile's context holds");
    assert!(entries[0].images);
    assert!(entries[0].missing.as_deref().unwrap().contains("b.gguf"), "{:?}", entries[0].missing);
    assert_eq!(entries[0].ctx, 81_920, "without a profile, the general plan: the model's target if it fits");
}

const LOCAL_ORDER: [&str; 6] = ["3.6", "3.8", "bonsai2", "toq", "lfm", "3.5-4b"];

fn real_paths() -> Paths {
    Paths {
        dist: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap(),
        engines: "e".into(),
        models: "m".into(),
        opencode: "o".into(),
        data: "d".into(),
    }
}

/// The default is 3.6 and the local models come in the catalog's order, in every list.
#[test]
fn the_real_catalog_has_the_wanted_default_and_order() {
    let (entries, default) = catalog::catalog_for(&real_paths(), &three_gpus()).unwrap();
    assert_eq!(default, "3.6");
    assert_eq!(entries.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), LOCAL_ORDER);
    let c = recommended(&real_paths(), &three_gpus()).unwrap();
    assert_eq!(c.iter().map(|c| c.model.as_str()).collect::<Vec<_>>(), LOCAL_ORDER);
}

/// The weights and image encoder the catalog names (`gguf`, `mmproj`) are among the files to download, with their
/// path: what is downloaded is what the engine opens.
#[test]
fn in_the_real_catalog_the_model_files_are_the_ones_downloaded() {
    let file = load_models(&real_paths()).unwrap();
    for key in file.local() {
        let cfg = model_cfg(&file, key).unwrap();
        let path: Vec<&str> = file.models[key]["files"].as_array().into_iter().flatten().map(|f| f["path"].as_str().unwrap()).collect();
        for rel in [cfg.gguf.as_deref(), cfg.mmproj.as_deref()].into_iter().flatten() {
            assert!(path.contains(&rel), "«{key}»: {rel} is not among the files to download {path:?}");
        }
    }
}

/// The 3.8 is the official unsloth Qwen3.8-27B, at a fixed revision, open and with the weights in the repo's folder.
#[test]
fn the_3_8_is_the_official_unsloth_qwen3_8() {
    let file = load_models(&real_paths()).unwrap();
    let m = &file.models["3.8"];
    assert_eq!(m["label"], "Qwen3.8-27B");
    assert_eq!((m["repo"].as_str(), m["revision"].as_str()), (Some("unsloth/Qwen3.8-27B-GGUF"), Some("4ca720788d1e01f1bff70c033e0d0028fd02e502")));
    assert!(m.get("_gated").is_none(), "the repo is open");
    assert_eq!((m["gguf"].as_str(), m["mmproj"].as_str()), (Some("Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-IQ4_XS.gguf"), Some("Qwen3.8-27B-GGUF/mmproj-F16.gguf")));
    let f: Vec<(u64, &str)> = m["files"].as_array().unwrap().iter().map(|f| (f["size"].as_u64().unwrap(), f["sha256"].as_str().unwrap())).collect();
    assert_eq!(f, [
        (14_252_845_984, "40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199"),
        (927_607_488, "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e"),
    ]);
}

/// A local model outside `order`, or an `order` that names a model that isn't there, is a wrong catalog.
#[test]
fn the_order_must_name_all_the_local_models_and_only_those() {
    let mut t = Fake::new();
    t.catalog["order"] = serde_json::json!([]);
    let e = t.write_and_load().unwrap_err().to_string();
    assert!(e.contains("toq") && e.contains("order"), "{e}");
    t.catalog["order"] = serde_json::json!(["toq", "ghost"]);
    let e = t.write_and_load().unwrap_err().to_string();
    assert!(e.contains("ghost") && e.contains("order"), "{e}");
    t.catalog["order"] = serde_json::json!(["toq", "toq"]);
    let e = t.write_and_load().unwrap_err().to_string();
    assert!(e.contains("toq") && e.contains("twice"), "{e}");
}

fn catalog_on_three_gpus(t: &Fake) -> (Vec<ModelEntry>, String) {
    catalog::catalog_for(&t.paths, &three_gpus()).unwrap()
}

/// A model that requires an engine of its own doesn't run with the general one: a clear error, no fallbacks.
#[test]
fn a_model_that_requires_an_engine_does_not_run_without_its_profile() {
    let mut t = Fake::new();
    t.profile["hardware"]["gpus"] = serde_json::json!(["NVIDIA GeForce RTX 4090"]);
    let e = make_plan(&t, &three_gpus()).unwrap_err().to_string();
    assert!(e.contains(&tr!("solo sul motore «toq»", "only runs on the engine «toq»")), "{e}");
}

// --- the user's models -------------------------------------------------------------------------------

fn local_entry(label: &str, gguf: &str) -> serde_json::Value {
    serde_json::json!({ "label": label, "gguf": gguf, "ctx": 81920,
        "files": [ { "path": gguf, "size": 2_000_000_000u64 } ], "memory": { "kv_kib_token": 32, "state_mib": 50 } })
}

/// A catalog with two recommended models (`b`, `a`) and a cloud one, plus the user's list with `models`.
fn with_user_models(models: serde_json::Value) -> Fake {
    let mut t = Fake::new();
    t.llamacpp_installed();
    t.catalog = serde_json::json!({ "ctx": 131072, "default": "a", "order": ["b", "a"], "models": {
        "a": local_entry("A", "a.gguf"), "b": local_entry("B", "b.gguf"),
        "c": { "label": "C", "cloud": { "provider": "openrouter" } } } });
    t.profile = serde_json::Value::Null;
    std::fs::create_dir_all(&t.paths.data).unwrap();
    std::fs::write(t.paths.data.join("user-models.json"), serde_json::json!({ "models": models }).to_string()).unwrap();
    t
}

/// The user's models are added to the catalog: after the recommended ones, by key, with the origin that tells them
/// apart; the selector, the first run and the plan treat them like the others.
#[test]
fn the_users_models_follow_the_recommended_ones_and_start_like_the_others() {
    let t = with_user_models(serde_json::json!({ "zeta": local_entry("Z", "z.gguf"), "alpha": local_entry("Alpha", "alpha.gguf") }));
    std::fs::write(t.paths.models.join("alpha.gguf"), b"").unwrap();
    let f = t.save();
    let (entries, default) = catalog_on_three_gpus(&t);
    assert_eq!(default, "a");
    assert_eq!(entries.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), ["b", "a", "alpha", "zeta"]);
    assert_eq!(entries.iter().map(|v| v.origin).collect::<Vec<_>>(), [Origin::Recommended, Origin::Recommended, Origin::User, Origin::User]);
    assert_eq!(entries[2].missing.as_deref().filter(|m| m.contains("alpha.gguf")), None, "the file is there: at most the engine is missing");
    assert!(entries[3].missing.as_deref().unwrap().contains("z.gguf"));

    let c = recommended(&t.paths, &three_gpus()).unwrap();
    assert_eq!(c.iter().map(|c| (c.model.as_str(), c.origin)).collect::<Vec<_>>(), [
        ("b", Origin::Recommended), ("a", Origin::Recommended), ("alpha", Origin::User), ("zeta", Origin::User)]);

    let p = build_plan(&t.paths, &f, Some("alpha"), 8080, &three_gpus(), &[], |_, _, _| panic!("GGUF read")).unwrap();
    assert_eq!((p.key.as_str(), p.label.as_str(), p.gguf), ("alpha", "Alpha", t.paths.models.join("alpha.gguf")));
}

#[test]
fn a_user_model_with_the_key_of_a_recommended_one_is_an_error() {
    let t = with_user_models(serde_json::json!({ "a": local_entry("Mine", "mine.gguf") }));
    let e = t.write_and_load().unwrap_err().to_string();
    assert!(e.contains("«a»") && e.contains(&tr!("stesso nome", "same name")), "{e}");
}

#[test]
fn a_user_model_without_a_name_is_an_error_that_names_it() {
    let t = with_user_models(serde_json::json!({ "mine": { "gguf": "mine.gguf" } }));
    let e = t.write_and_load().unwrap_err().to_string();
    assert!(e.contains("«mine»") && e.contains("user-models.json") && e.contains("label"), "{e}");
}

// --- the general plan --------------------------------------------------------------------------------

fn general_plan(hw: &Hardware, excluded: &[u32]) -> Result<EnginePlan> {
    let t = Fake::small();
    let f = t.save();
    build_plan(&t.paths, &f, None, 8080, hw, excluded, |_, _, _| panic!("GGUF read"))
}

fn has(args: &[String], pair: [&str; 2]) -> bool {
    args.windows(2).any(|w| w == pair)
}

/// On the cards the model sits entirely there: `-fit` off (on, it would move layers or experts to RAM if memory isn't
/// enough), every layer on the cards, no option that keeps weights on the processor.
fn all_on_gpus(a: &[String]) {
    assert!(has(a, ["-fit", "off"]) && has(a, ["-ngl", "all"]), "{a:?}");
    let to_cpu = ["-dev", "--device", "-ot", "--override-tensor", "-cmoe", "--cpu-moe", "-ncmoe", "--n-cpu-moe", "--n-cpu-ffn"];
    assert!(!a.iter().any(|x| to_cpu.contains(&x.as_str())), "{a:?}");
}

/// On the processor the model sits entirely in RAM: nothing on the cards, not even the image encoder.
fn all_on_cpu(p: &EnginePlan) {
    let a = &p.spec.args;
    assert!(has(a, ["-fit", "off"]) && has(a, ["-dev", "none"]) && has(a, ["-t", "8"]), "{a:?}");
    assert!(!a.iter().any(|x| x == "-ngl") && p.gpus_used.is_empty() && !env_of(p).contains_key("CUDA_VISIBLE_DEVICES"), "{a:?} {:?}", p.spec.env);
}

#[test]
fn without_cards_the_general_plan_runs_on_the_cpu() {
    let p = general_plan(&pc(vec![], 16_384), &[]).unwrap();
    let a = &p.spec.args;
    assert!(p.spec.exe.ends_with(std::path::Path::new("engines").join("llamacpp").join("b12110-cpu").join("llama-server.exe")), "{:?}", p.spec.exe);
    assert!(has(a, ["-t", "8"]) && has(a, ["-c", "131072"]) && has(a, ["-fit", "off"]) && has(a, ["-dev", "none"]), "{a:?}");
    assert!(!a.iter().any(|x| x == "--cache-disk" || x == "-ngl"), "{a:?}");
    assert!(p.spec.env.is_empty() && p.gpus_used.is_empty());
    assert_eq!(p.ctx, 131_072);
}

/// Official llama.cpp has no on-disk memory: the conversation is saved in the slot before stopping and, if the file
/// is there, restored as soon as the engine is ready.
#[test]
fn the_general_plan_saves_the_conversation_and_restores_it_if_there() {
    let t = Fake::small();
    let f = t.save();
    let hw = pc(vec![], 16_384);
    let p = build_plan(&t.paths, &f, None, 8080, &hw, &[], |_, _, _| panic!("GGUF read")).unwrap();
    let save = p.spec.shutdown_post.as_ref().unwrap();
    assert_eq!(save.url, "http://127.0.0.1:8080/slots/0?action=save");
    assert_eq!(save.body, r#"{"filename":"4b.bin"}"#);
    assert_eq!(p.spec.startup_post, None, "nothing to restore the first time");
    std::fs::write(t.paths.data.join("slots").join("4b.bin"), b"state").unwrap();
    let p = build_plan(&t.paths, &f, None, 8080, &hw, &[], |_, _, _| panic!("GGUF read")).unwrap();
    let restore = p.spec.startup_post.unwrap();
    assert_eq!((restore.url.as_str(), restore.body.as_str()), ("http://127.0.0.1:8080/slots/0?action=restore", r#"{"filename":"4b.bin"}"#));
}

#[test]
fn an_nvidia_card_runs_on_cuda_entirely_on_the_card() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4070", 12_282, (8, 9), (12, 6))], 32_768);
    let p = general_plan(&hw, &[]).unwrap();
    all_on_gpus(&p.spec.args);
    assert!(!p.spec.args.iter().any(|x| x == "-ctk"), "with enough memory the cache stays f16");
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "0");
    assert_eq!(env_of(&p)["CUDA_DEVICE_ORDER"], "PCI_BUS_ID");
    assert_eq!(p.gpus_used.len(), 1);
}

/// 8 GB: with the f16 cache the target context doesn't fit, with q8_0 it does.
#[test]
fn with_little_memory_the_cache_goes_down_to_q8() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060", 8192, (8, 6), (12, 6))], 32_768);
    let p = general_plan(&hw, &[]).unwrap();
    let a = &p.spec.args;
    assert!(has(a, ["-ctk", "q8_0"]) && has(a, ["-ctv", "q8_0"]) && has(a, ["-fa", "on"]), "{a:?}");
    assert_eq!(p.ctx, 131_072);
}

#[test]
fn with_several_nvidia_cards_all_are_used() {
    let hw = pc(
        vec![nvidia(0, "NVIDIA GeForce RTX 3060", 8192, (8, 6), (12, 6)), nvidia(1, "NVIDIA GeForce RTX 3060", 8192, (8, 6), (12, 6))],
        32_768,
    );
    let p = general_plan(&hw, &[]).unwrap();
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "0,1");
    let p = general_plan(&hw, &[0]).unwrap();
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "1");
    assert_eq!(p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(), [1]);
    let e = general_plan(&hw, &[0, 1]).unwrap_err().to_string();
    assert!(e.contains(&tr!("liberate", "released")), "{e}");
}

/// A target context below the agent's minimum (the integration tests use 16384) stays as it is.
#[test]
fn a_target_below_the_minimum_stays_its_own() {
    let mut t = Fake::small();
    t.catalog["ctx"] = 16_384.into();
    let f = t.save();
    let p = build_plan(&t.paths, &f, None, 8080, &pc(vec![], 16_384), &[], |_, _, _| unreachable!()).unwrap();
    assert_eq!(p.ctx, 16_384);
}

#[test]
fn on_vulkan_a_single_card_is_not_released() {
    let hw = pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768);
    let p = general_plan(&hw, &[]).unwrap();
    all_on_gpus(&p.spec.args);
    assert!(p.spec.env.is_empty());
    assert_eq!(p.gpus_used.len(), 1);
    let e = general_plan(&hw, &[0]).unwrap_err().to_string();
    assert!(e.contains("Vulkan"), "{e}");
}

#[test]
fn if_it_does_not_fit_the_error_says_how_much_is_missing_and_what_to_do() {
    let e = general_plan(&pc(vec![], 6144), &[]).unwrap_err().to_string();
    assert_eq!(
        e,
        tr!(
            "Il modello «Qwen3.5-4B» non ci sta in questo computer: servono almeno 3,1 GB (pesi e cache per 32768 token) e la RAM ne ha 2,0. Scegli un modello più piccolo.",
            "The model «Qwen3.5-4B» doesn't fit on this computer: at least 3.1 GB are needed (weights and cache for 32768 tokens) and the RAM has 2.0. Choose a smaller model."
        )
    );
    let e = general_plan(&pc(vec![nvidia(0, "NVIDIA GeForce GT 1030", 2048, (6, 1), (12, 6))], 6144), &[]).unwrap_err().to_string();
    assert!(e.contains(&tr!("le schede video ne hanno 0,0 e la RAM 2,0", "the graphics cards have 0.0 and the RAM 2.0")), "{e}");
}

/// The card is too small for the model: it runs entirely on the processor, with the cards' build (already on disk) and
/// the cards empty. Never a part here and a part there.
#[test]
fn when_the_card_is_not_enough_it_runs_entirely_on_the_processor() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce GTX 1650", 4096, (7, 5), (12, 6))], 16_384);
    let p = general_plan(&hw, &[]).unwrap();
    all_on_cpu(&p);
    assert!(p.spec.exe.parent().unwrap().ends_with("b12110-cuda-12"), "{:?}", p.spec.exe);
    assert_eq!(p.ctx, 131_072);
    // Cards lent to another job don't touch a model that runs on the processor.
    let p = general_plan(&hw, &[0]).unwrap();
    all_on_cpu(&p);
}

/// A model that fits only on the two cards together, with one lent to another job, stays on the cards: it doesn't fit
/// on the one left, and says so, instead of ending up on the processor.
#[test]
fn with_a_card_lent_the_gpu_model_does_not_go_to_the_processor() {
    let mut t = Fake::small();
    t.catalog["models"]["4b"]["files"][0]["size"] = (8u64 << 30).into();
    let f = t.save();
    let two = pc(vec![nvidia(0, "A", 8192, (8, 6), (12, 6)), nvidia(1, "B", 8192, (8, 6), (12, 6))], 32_768);
    let p = build_plan(&t.paths, &f, None, 8080, &two, &[], |_, _, _| unreachable!()).unwrap();
    all_on_gpus(&p.spec.args);
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "0,1");
    let e = build_plan(&t.paths, &f, None, 8080, &two, &[0], |_, _, _| unreachable!()).unwrap_err().to_string();
    assert!(
        e.contains(&tr!("non ci sta nelle schede video rimaste", "doesn't fit in the remaining graphics cards")) && e.contains(&tr!("prestate", "lent")),
        "{e}"
    );
}

#[test]
fn the_general_engine_missing_gives_a_clear_error() {
    let t = Fake::small();
    std::fs::remove_dir_all(t.paths.engines.join("llamacpp")).unwrap();
    let f = t.save();
    let e = build_plan(&t.paths, &f, None, 8080, &pc(vec![], 16_384), &[], |_, _, _| unreachable!()).unwrap_err().to_string();
    assert!(e.contains(&tr!("Manca il motore", "The engine that runs the model is missing")) && e.contains("llamacpp") && e.contains("cpu"), "{e}");
}

/// A downloaded engine lives in `<engines>/<engine>/<version>-<build>/`, with the version from the engine catalog.
#[test]
fn the_downloaded_engine_is_found_by_build() {
    let t = Fake::small();
    std::fs::remove_dir_all(t.paths.engines.join("llamacpp").join("b12110-cuda-12")).unwrap();
    let d = installed_engine(&t.paths, "llamacpp", mango_common::Build::Vulkan).unwrap();
    assert!(d.ends_with("b12110-vulkan"), "{d:?}");
    assert!(installed_engine(&t.paths, "llamacpp", mango_common::Build::Cuda12).is_none());
}

// --- the recommended models ------------------------------------------------------------------------

fn recommendations(hw: &Hardware) -> BTreeMap<String, Recommendation> {
    recommended(&real_paths(), hw).unwrap().into_iter().map(|c| (c.model.clone(), c)).collect()
}

/// The bytes of Bonsai 2's files for official llama.cpp: the `Q2_0` weights and the image encoder.
const BONSAI_Q2_0: u64 = 7_626_008_928 + 629_246_976;

/// On 16 GB of RAM the small model and Bonsai 2 fit; without the three-GPU profile Bonsai 2 downloads only the `Q2_0` weights.
#[test]
fn on_a_cpu_with_16gb_the_small_model_and_bonsai_fit() {
    let c = recommendations(&pc(vec![], 16_384));
    for k in ["3.5-4b", "bonsai2"] {
        assert!(c[k].placement == Some(Placement::Cpu) && c[k].context >= 32_768 && c[k].reason.contains(&tr!("nella RAM", "in RAM")), "{k}: {:?}", c[k]);
    }
    assert_eq!(c["bonsai2"].bytes, BONSAI_Q2_0);
    for k in ["3.6", "3.8", "lfm", "toq"] {
        assert!(c[k].placement.is_none() && c[k].context == 0 && !c[k].reason.is_empty(), "{k}: {:?}", c[k]);
    }
    assert!(
        c["3.6"].reason.contains(&tr!("non ci sta in questo computer", "doesn't fit on this computer")) && c["3.6"].reason.contains(&tr!("la RAM ne ha", "the RAM has")),
        "{}",
        c["3.6"].reason
    );
    assert!(c["toq"].reason.contains(&tr!("solo sul motore «toq»", "only runs on the engine «toq»")), "{}", c["toq"].reason);
}

#[test]
fn with_a_24gb_card_all_the_models_fit() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (12, 6))], 65_536);
    let c = recommendations(&hw);
    for k in LOCAL_ORDER {
        assert!(c[k].placement == Some(Placement::Gpu) && c[k].context == 131_072 && !c[k].profile, "{k}: {:?}", c[k]);
    }
    assert!(c["toq"].reason.contains(&tr!("motore «toq»", "engine «toq»")), "{}", c["toq"].reason);
    assert_eq!(c["bonsai2"].bytes, BONSAI_Q2_0);
}

/// An 8 GB card and 32 GB of RAM: Bonsai 2 (7.6 GB) and Qwen3.6 (17 GB) don't fit on the card and run on the
/// processor; the 4B fits on the card with the image encoder, which takes some context from it, and is the fastest;
/// TOQ, which only has the cards' engine, doesn't fit.
#[test]
fn an_8gb_card_and_32gb_of_ram() {
    let c = recommendations(&pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6))], 32_768));
    for k in ["bonsai2", "3.6", "3.8", "lfm"] {
        assert!(c[k].placement == Some(Placement::Cpu) && c[k].reason.contains(&tr!("gira sul processore", "runs on the processor")), "{k}: {:?}", c[k]);
    }
    assert_eq!((c["3.5-4b"].placement, c["3.5-4b"].context), (Some(Placement::Gpu), 126_976), "{:?}", c["3.5-4b"]);
    assert!(c["toq"].placement.is_none(), "{:?}", c["toq"]);
    assert_eq!(c.values().filter(|c| c.fastest).map(|c| c.model.as_str()).collect::<Vec<_>>(), ["3.5-4b"]);

    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6))], 32_768);
    for k in ["bonsai2", "3.6"] {
        all_on_cpu(&real_plan(k, &hw).0);
    }
    all_on_gpus(&real_plan("3.5-4b", &hw).0.spec.args);
}

/// Three cards (22 GB in all) without a profile: those that fit go on the cards, Qwen3.6 and Qwen3.8 on
/// the processor. The fastest is LFM, on the cards and with fewer weights read per token (a MoE with 2 billion
/// active parameters).
#[test]
fn three_cards_without_a_profile() {
    let hw = pc(vec![nvidia(0, "A", 8192, (8, 6), (12, 6)), nvidia(1, "B", 8192, (6, 1), (12, 6)), nvidia(2, "C", 6144, (7, 5), (12, 6))], 65_536);
    let c = recommendations(&hw);
    for k in ["3.6", "3.8"] {
        assert_eq!(c[k].placement, Some(Placement::Cpu), "{k}: {:?}", c[k]);
    }
    for k in ["bonsai2", "toq", "lfm", "3.5-4b"] {
        assert_eq!(c[k].placement, Some(Placement::Gpu), "{k}: {:?}", c[k]);
    }
    assert_eq!(c.values().filter(|c| c.fastest).map(|c| c.model.as_str()).collect::<Vec<_>>(), ["lfm"]);
    let (p, _, _d) = real_plan("bonsai2", &hw);
    all_on_gpus(&p.spec.args);
    assert_eq!(env_of(&p)["CUDA_VISIBLE_DEVICES"], "0,1,2");
}

/// Without cards and without enough RAM there is no fastest to propose.
#[test]
fn if_nothing_fits_there_is_no_fastest() {
    assert!(recommendations(&pc(vec![], 4096)).values().all(|c| c.placement.is_none() && !c.fastest));
}

/// The cards' profiles start the model entirely on the cards: explicit `-ngl` (which also turns off the `-fit` of the
/// engines that have it) and no option that brings weights to RAM.
#[test]
fn the_cards_profiles_keep_everything_on_the_cards() {
    let mut seen = 0;
    let mut folders = vec![real_paths().dist.join("profiles")];
    while let Some(d) = folders.pop() {
        for e in std::fs::read_dir(&d).unwrap().map(Result::unwrap) {
            let f = e.path();
            if f.is_dir() {
                folders.push(f);
                continue;
            }
            if f.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let p: Profile = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
            assert_eq!(p.placement(), Placement::Gpu, "{}", p.id);
            assert!(has(&p.args, ["-ngl", "999"]), "{}: {:?}", p.id, p.args);
            let to_cpu = ["-dev", "--device", "-ot", "--override-tensor", "-cmoe", "--cpu-moe", "-ncmoe", "--n-cpu-moe", "--n-cpu-ffn"];
            assert!(!p.args.iter().any(|x| to_cpu.contains(&x.as_str())), "{}: {:?}", p.id, p.args);
            seen += 1;
        }
    }
    assert!(seen >= 6, "{seen}");
}

/// TOQ without a profile: on every NVIDIA PC that supports it with its engine, with the context memory leaves (image
/// encoder included); on CPU, Vulkan and small cards no, with the reason.
#[test]
fn toq_on_every_nvidia_pc_that_supports_it() {
    let n = |i, name, mib, cc| nvidia(i, name, mib, cc, (12, 6));
    let c = recommendations(&pc(vec![n(0, "NVIDIA GeForce RTX 3060", 12_288, (8, 6))], 32_768));
    assert!(c["toq"].placement == Some(Placement::Gpu) && (32_768..131_072).contains(&c["toq"].context), "{:?}", c["toq"]);
    // Two 8 GB cards hold 120k without images (`split.rs`); the encoder on the main one takes context away, on the
    // third card it doesn't.
    let c = recommendations(&pc(vec![n(0, "A", 8192, (8, 6)), n(1, "B", 8192, (8, 6))], 32_768));
    assert!(c["toq"].placement.is_some() && (32_768..122_880).contains(&c["toq"].context), "{:?}", c["toq"]);
    let c = recommendations(&pc(vec![n(0, "A", 8192, (8, 6)), n(1, "B", 8192, (8, 6)), n(2, "C", 8192, (8, 6))], 32_768));
    assert_eq!((c["toq"].placement, c["toq"].context), (Some(Placement::Gpu), 122_880), "{:?}", c["toq"]);
    assert_eq!(c["toq"].bytes, 9_489_952_128 + 927_607_488);

    let c = recommendations(&pc(vec![n(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6))], 32_768));
    assert!(c["toq"].placement.is_none() && c["toq"].reason.contains(&tr!("non basta", "is not enough")), "{:?}", c["toq"]);
    let old = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (11, 8))], 65_536);
    let amd = pc(vec![other(0, "AMD Radeon RX 7900 XTX", Vendor::Amd, 24_560)], 65_536);
    for hw in [pc(vec![], 65_536), old, amd] {
        let c = recommendations(&hw);
        assert!(c["toq"].placement.is_none() && c["toq"].reason.contains(&tr!("solo sul motore «toq»", "only runs on the engine «toq»")), "{:?}", c["toq"]);
    }
}

/// A profile without a measurement date (a tune put together, not yet measured) says so, without inventing a date.
#[test]
fn a_profile_not_yet_measured_says_so() {
    let mut t = Fake::new();
    t.profile["measurements"] = serde_json::json!({ "note": "to be measured" });
    t.save();
    let c = recommended(&t.paths, &three_gpus()).unwrap();
    assert!(c[0].placement.is_some() && c[0].reason.contains("test/toq") && c[0].reason.contains(&tr!("non ancora misurato", "not measured yet")), "{}", c[0].reason);
    assert!(!c[0].reason.contains(&tr!("misurato il", "measured on")), "{}", c[0].reason);
}

#[test]
fn on_three_gpus_every_local_model_has_its_profile() {
    let c = recommendations(&three_gpus());
    assert_eq!(c["toq"].context, 122_880);
    assert_eq!(c["3.8"].context, 92_160);
    for k in ["toq", "3.6", "3.8", "lfm", "bonsai2"] {
        assert!(c[k].placement == Some(Placement::Gpu) && c[k].reason.contains(&format!("3060ti-1080-1660s/{k}")), "{k}: {:?}", c[k]);
    }
    // The small model has no profile: on the three GPUs the general plan applies.
    assert!(c["3.5-4b"].placement == Some(Placement::Gpu) && c["3.5-4b"].reason.starts_with(&tr!("Ci sta", "It fits")), "{:?}", c["3.5-4b"]);
}

/// The behavior on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER doesn't change: for every local model of the real catalog and profiles (`launcher/`),
/// `plan()` gives the same arguments, environment and cards as before moving the tune into the profiles
/// (`3060ti-1080-1660s-expected.json`, derived from the earlier code).
#[test]
fn three_gpus_have_the_same_plan_as_before() {
    let launcher = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher");
    let expected: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/3060ti-1080-1660s-expected.json")).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths { dist: launcher.canonicalize().unwrap(), engines: r.join("engines"), models: r.join("models"), opencode: r.join("opencode"), data: r.join("data") };
    let file = load_models(&paths).unwrap();
    let hw = three_gpus();
    let mut seen = 0;
    for key in file.models.keys() {
        let cfg = model_cfg(&file, key).unwrap();
        if cfg.cloud.is_some() {
            continue;
        }
        // Only the models that have a three-GPU profile: the others have the general plan, tested separately.
        let Setup::Profile(a) = setup_for(&paths, key, &cfg, &hw).unwrap() else { continue };
        for f in [cfg.gguf.as_deref(), cfg.mmproj.as_deref()].into_iter().flatten() {
            let p = paths.models.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let exe = paths.engines.join(&a.engine);
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join("llama-server.exe"), b"").unwrap();
        // The models of the three-GPU profiles have the cards written by hand or `-ts`: the GGUF isn't read.
        let plan = build_plan(&paths, &file, Some(key), 8080, &hw, &[], |_, _, _| panic!("GGUF read")).unwrap();
        let subst = |s: String| {
            s.replace(&paths.models.display().to_string(), "<models>")
                .replace(&paths.engines.display().to_string(), "<engines>")
                .replace(&paths.data.display().to_string(), "<data>")
                .replace(&paths.dist.display().to_string(), "<dist>")
                .replace('\\', "/")
        };
        let env: BTreeMap<String, String> = plan.spec.env.iter().map(|(k, v)| (k.clone(), subst(v.clone()))).collect();
        let today = serde_json::json!({
            "exe": subst(plan.spec.exe.display().to_string()),
            "args": plan.spec.args.iter().map(|a| subst(a.clone())).collect::<Vec<_>>(),
            "env": env,
            "ctx": plan.ctx,
            "label": plan.label,
            "images": plan.images,
            "gpus": plan.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(),
            "gguf": subst(plan.gguf.display().to_string()),
            "shutdown_post": plan.spec.shutdown_post.as_ref().map(|c| serde_json::json!([c.url, c.timeout_s])),
        });
        assert_eq!(today, expected[key], "model «{key}»");
        seen += 1;
    }
    assert_eq!(seen, expected.as_object().unwrap().len(), "every expected model has its profile");
}

// --- without a three-GPU profile, with the real catalog and profiles -----------------------------------------------

/// The plan of `key` on `hw` with the real catalog and profiles (`launcher/`): the files its engine opens (empty) and
/// the engine installed as the download puts it. The GGUF's shape is TOQ's.
fn real_plan(key: &str, hw: &Hardware) -> (EnginePlan, Paths, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths { dist: real_paths().dist, engines: r.join("engines"), models: r.join("models"), opencode: r.join("o"), data: r.join("data") };
    let file = load_models(&paths).unwrap();
    let cfg = model_cfg(&file, key).unwrap();
    let a = setup_for(&paths, key, &cfg, hw).unwrap();
    for f in [cfg.gguf_for(a.engine()), cfg.mmproj.as_deref()].into_iter().flatten() {
        let p = paths.models.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }
    let version = if a.engine() == "toq" { "35e7256" } else { "b12110" };
    let exe = paths.engines.join(a.engine()).join(format!("{version}-{}", a.build().as_str()));
    std::fs::create_dir_all(&exe).unwrap();
    std::fs::write(exe.join("llama-server.exe"), b"").unwrap();
    let plan = build_plan(&paths, &file, Some(key), 8080, hw, &[], |_, _, _| Ok(qwen38_27b())).unwrap();
    (plan, paths, dir)
}

/// Bonsai 2 without a profile runs with official llama.cpp and the `Q2_0` weights, on CPU, CUDA and Vulkan.
#[test]
fn bonsai_without_a_profile_uses_q2_0_with_the_official_engine() {
    let cpu = pc(vec![], 32_768);
    let cuda = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4070 Ti SUPER", 16_376, (8, 9), (12, 6))], 32_768);
    let vulkan = pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768);
    for (hw, build) in [(cpu, "cpu"), (cuda, "cuda-12"), (vulkan, "vulkan")] {
        let (p, paths, _d) = real_plan("bonsai2", &hw);
        assert_eq!(p.gguf, paths.models.join("Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-Q2_0.gguf"), "{build}");
        assert!(p.spec.exe.parent().unwrap().ends_with(std::path::Path::new("llamacpp").join(format!("b12110-{build}"))), "{:?}", p.spec.exe);
        assert!(p.images && p.ctx >= 32_768, "{build}: ctx {}", p.ctx);
    }
    // On the three GPUs the profile stays, with the prism engine's `PQ2_0` weights (`three_gpus_have_the_same_plan_as_before`).
}

/// TOQ without a profile on a single card: `toq` engine, layers and context from memory, encoder on the same card.
#[test]
fn toq_on_a_single_card() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (13, 4))], 65_536);
    let (p, paths, _d) = real_plan("toq", &hw);
    let e = env_of(&p);
    assert!(p.spec.exe.starts_with(paths.engines.join("toq").join("35e7256-cuda-12")), "{:?}", p.spec.exe);
    assert_eq!((e["CUDA_VISIBLE_DEVICES"], e["MTMD_BACKEND_DEVICE"]), ("0", "CUDA0"));
    assert!(!e.contains_key("LLAMA_LAYER_DEVICES"), "{e:?}");
    assert_eq!(p.ctx, 131_072);
    let a = &p.spec.args;
    for pair in [["-wgt", "1"], ["-sm", "layer"], ["-ctk", "q8_0"], ["-ctv", "q8_0"], ["-ub", "512"], ["--image-min-tokens", "1024"]] {
        assert!(has(a, pair), "{pair:?} in {a:?}");
    }
    assert!(a.iter().any(|x| x == "--mmproj") && a.iter().any(|x| x == "--cache-disk"), "{a:?}");
    assert!(!a.iter().any(|x| x == "--spec-type"), "MTP off: {a:?}");
}

/// Three equal cards (not the three-GPU profile's): the model on two, the encoder on the third, like that profile.
#[test]
fn toq_on_three_cards_puts_the_encoder_on_the_third() {
    let n = |i, name| nvidia(i, name, 8192, (8, 6), (12, 6));
    let hw = pc(vec![n(0, "NVIDIA GeForce RTX 3070"), n(1, "NVIDIA GeForce RTX 3070"), n(2, "NVIDIA GeForce RTX 3070")], 65_536);
    let (p, _paths, _d) = real_plan("toq", &hw);
    let e = env_of(&p);
    assert_eq!((e["CUDA_VISIBLE_DEVICES"], e["MTMD_BACKEND_DEVICE"], e["LLAMA_LAYER_DEVICES"]), ("0,1,2", "CUDA2", MAP_A));
    assert_eq!(p.ctx, 122_880);
    assert_eq!(p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>(), [0, 1, 2]);
}

/// A check that must give zero: on the three GPUs of the profile the automatic split with images rebuilds the profile's measured
/// environment for TOQ (model on the 3060 Ti and the 1660 SUPER, encoder on the 1080).
#[test]
fn on_the_three_gpus_the_automatic_encoder_is_the_profiles() {
    let mut t = Fake::new().without_gpu_env();
    std::fs::write(t.paths.models.join("mm.gguf"), b"").unwrap();
    t.toq()["mmproj"] = "mm.gguf".into();
    let e = env_of(&make_plan(&t, &three_gpus()).unwrap()).into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
    let profile: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(real_paths().dist.join("profiles/3060ti-1080-1660s/toq.json")).unwrap()).unwrap();
    for k in ["CUDA_VISIBLE_DEVICES", "MTMD_BACKEND_DEVICE", "LLAMA_LAYER_DEVICES"] {
        assert_eq!(e[k], profile["env"][k].as_str().unwrap(), "{k}");
    }
}

/// TOQ's shape in the catalog splits like the one read from the GGUF (the fixture): the verdict before downloading is
/// the plan's.
#[test]
fn the_catalog_shape_splits_like_the_gguf() {
    let file = load_models(&real_paths()).unwrap();
    let cfg = model_cfg(&file, "toq").unwrap();
    let estimated = cfg.shape("q8_0", "q8_0").unwrap().unwrap();
    let real = qwen38_27b();
    assert_eq!(estimated.layers.iter().map(|l| (l.kind, l.weight_bytes, l.cache_bytes_per_token)).collect::<Vec<_>>(),
        real.layers.iter().map(|l| (l.kind, l.weight_bytes, l.cache_bytes_per_token)).collect::<Vec<_>>());
    assert_eq!((estimated.output_bytes, estimated.mtp.clone()), (real.output_bytes, real.mtp.clone()));
    let n = |i, mib, cc| nvidia(i, "S", mib, cc, (12, 6));
    let test_pcs = [
        vec![n(0, 24_564, (8, 9))],
        vec![n(0, 12_288, (8, 6))],
        vec![n(0, 8192, (8, 6)), n(1, 8192, (8, 6))],
        vec![n(0, 6144, (7, 5)), n(1, 6144, (7, 5)), n(2, 6144, (7, 5))],
        three_gpus().gpus,
    ];
    for gpus in test_pcs {
        for enc in [0, cfg.encoder_bytes()] {
            let a = split::partition(&gpus, &estimated, 131_072, false, enc).map(|p| (p.gpus, p.ctx, p.encoder)).map_err(|e| e.to_string());
            let b = split::partition(&gpus, &real, 131_072, false, enc).map(|p| (p.gpus, p.ctx, p.encoder)).map_err(|e| e.to_string());
            assert_eq!(a, b, "{gpus:?}");
        }
    }
}

/// For every model, with every engine that can start it, the weights the engine opens and the encoder are among the
/// files downloaded for that engine; and Bonsai 2 downloads a single weights file.
#[test]
fn every_engine_downloads_the_files_it_opens() {
    let paths = real_paths();
    let file = load_models(&paths).unwrap();
    for key in file.local() {
        let cfg = model_cfg(&file, key).unwrap();
        let profiles = std::fs::read_dir(paths.dist.join("profiles")).unwrap().flatten().filter(|d| d.path().is_dir()).flat_map(|d| std::fs::read_dir(d.path()).unwrap().flatten());
        let mut engines: Vec<String> = profiles
            .filter_map(|f| serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(f.path()).unwrap()).ok())
            .filter(|p| p["model"] == key)
            .map(|p| p["engine"].as_str().unwrap().to_string())
            .collect();
        if cfg.requires_engine.is_none() {
            engines.push(catalog::GENERAL_ENGINE.into());
        }
        assert!(!engines.is_empty(), "«{key}» has no engine");
        for m in &engines {
            let downloaded: Vec<&str> = cfg.files_for(m).map(|f| f.path.as_str()).collect();
            for rel in [cfg.gguf_for(m), cfg.mmproj.as_deref()].into_iter().flatten() {
                assert!(downloaded.contains(&rel), "«{key}» with {m}: {rel} is not among {downloaded:?}");
            }
        }
    }
    let b = model_cfg(&file, "bonsai2").unwrap();
    let weights = |m| b.files_for(m).filter(|f| Some(f.path.as_str()) != b.mmproj.as_deref()).map(|f| (f.path.clone(), f.size)).collect::<Vec<_>>();
    assert_eq!(weights("llamacpp"), [("Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-Q2_0.gguf".to_string(), 7_626_008_928)]);
    assert_eq!(weights("prism"), [("Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PQ2_0.gguf".to_string(), 7_206_168_928)]);
    assert_eq!(file.models["bonsai2"]["files"][0]["sha256"], "4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e");
}

/// Tests on the real machine (real cards and files): not part of the normal `cargo test`.
/// `MANGO_DIST=<dist> cargo test -p engine-cfg -- --ignored --nocapture`
mod real {
    use super::*;

    /// An HTTP/1.1 request on the local port; returns (status, body).
    fn http(port: u16, method: &str, path: &str, body: &str) -> std::io::Result<(u16, String)> {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port))?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(300)))?;
        write!(
            s,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )?;
        let mut r = String::new();
        s.read_to_string(&mut r)?;
        let (head, rest) = r.split_once("\r\n\r\n").unwrap_or((&r, ""));
        let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        Ok((status, rest.to_string()))
    }

    /// Base64 of `data`, to send an image to the engine in a `data:` URL.
    fn base64(data: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        data.chunks(3)
            .flat_map(|c| {
                let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
                (0..4).map(move |i| if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' })
            })
            .collect()
    }

    #[test]
    fn the_images_base64() {
        assert_eq!([base64(b"Man"), base64(b"Ma"), base64(b"M"), base64(b"")], ["TWFu", "TWE=", "TQ==", ""]);
    }

    /// A model of the real catalog started without a profile, with the plan the app would make on any PC:
    /// starts the real engine and answers (with a system message in the middle, like the agent), and if there is an
    /// image it reads it.
    /// - `MANGO_TEST_ENGINES`: engines folder (`llamacpp/b12110-<build>/`, `toq/`...);
    /// - `MANGO_TEST_MODELS`: models folder;
    /// - `MANGO_TEST_MODEL`: the model key (`3.5-4b` if missing);
    /// - `MANGO_TEST_GPUS`: `no` = the PC without cards (CPU build); otherwise the real cards, with a name no
    ///   profile recognizes;
    /// - `MANGO_TEST_EXCLUDED`: cards to leave out (PCI indexes separated by commas, like a `release`);
    /// - `MANGO_TEST_IMAGE`, `MANGO_TEST_EXPECTED`: an image with a text, and the text the answer must contain.
    #[test]
    #[ignore = "starts a real model (MANGO_TEST_* variables)"]
    fn outside_the_profile_a_model_starts_and_answers() {
        let var = |n: &str| std::path::PathBuf::from(std::env::var(n).unwrap_or_else(|_| panic!("{n} is missing")));
        let data = tempfile::tempdir().unwrap();
        let paths = Paths {
            dist: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap(),
            engines: var("MANGO_TEST_ENGINES"),
            models: var("MANGO_TEST_MODELS"),
            opencode: "o".into(),
            data: data.path().to_path_buf(),
        };
        let key = std::env::var("MANGO_TEST_MODEL").unwrap_or_else(|_| "3.5-4b".into());
        let mut hw = detect().unwrap();
        match std::env::var("MANGO_TEST_GPUS").as_deref() {
            Ok("no") => hw.gpus.clear(),
            _ => hw.gpus.iter_mut().for_each(|g| g.name.push_str(" (test)")),
        }
        let excluded: Vec<u32> = std::env::var("MANGO_TEST_EXCLUDED").unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(|s| s.trim().parse().unwrap()).collect();
        let image = std::env::var("MANGO_TEST_IMAGE").ok().map(|f| (base64(&std::fs::read(&f).unwrap()), std::env::var("MANGO_TEST_EXPECTED").expect("MANGO_TEST_EXPECTED is missing")));
        let port = mango_common::free_port(18_080).unwrap();
        let file = load_models(&paths).unwrap();
        let p = build_plan(&paths, &file, Some(&key), port, &hw, &excluded, gguf::read_shape).unwrap();
        println!("{} {}", p.spec.exe.display(), p.spec.args.join(" "));
        for (k, v) in &p.spec.env {
            println!("  {k}={v}");
        }
        println!("ctx {}  cards: {:?}", p.ctx, p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>());

        let log = std::fs::File::create(paths.data.join("engine.log")).unwrap();
        let mut child = std::process::Command::new(&p.spec.exe)
            .args(&p.spec.args)
            .envs(p.spec.env.iter().cloned())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let outcome = std::panic::catch_unwind(|| {
            let start = std::time::Instant::now();
            loop {
                if http(port, "GET", "/health", "").is_ok_and(|(s, _)| s == 200) {
                    break;
                }
                assert!(start.elapsed().as_secs() < 300, "the engine is not ready in 300 s");
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            let (status, body) = http(
                port,
                "POST",
                "/v1/chat/completions",
                // A system message in the middle, as the agent sends it: the catalog's template must hold it.
                r#"{"messages":[{"role":"system","content":"Answer with a single word."},{"role":"user","content":"Say hello."},{"role":"assistant","content":"Hello"},{"role":"system","content":"Service block."},{"role":"user","content":"Say goodbye."}],"max_tokens":16,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}"#,
            )
            .unwrap();
            assert_eq!(status, 200, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{e}: {body}"));
            let text = v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string();
            println!("answer: {text:?}");
            assert!(!text.trim().is_empty(), "{body}");
            if let Some((b64, expected)) = &image {
                let request = serde_json::json!({
                    "messages": [{ "role": "user", "content": [
                        { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{b64}") } },
                        { "type": "text", "text": "What text is in the image? Answer with the text only." } ] }],
                    "max_tokens": 32, "temperature": 0, "chat_template_kwargs": { "enable_thinking": false } });
                let (status, body) = http(port, "POST", "/v1/chat/completions", &request.to_string()).unwrap();
                assert_eq!(status, 200, "{body}");
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{e}: {body}"));
                let text = v["choices"][0]["message"]["content"].as_str().unwrap_or_default();
                println!("image: {text:?}");
                assert!(text.contains(expected.as_str()), "expected {expected:?}: {body}");
            }
        });
        child.kill().unwrap();
        child.wait().unwrap();
        if let Err(e) = outcome {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    #[ignore = "requires three NVIDIA cards (RTX 3060 Ti, GTX 1080, GTX 1660 SUPER) and a built distribution"]
    fn real_cards_and_plan() {
        let hw = detect().unwrap();
        for g in &hw.gpus {
            println!("card {}: {} {} MiB {:?} cuda {:?}", g.index, g.name, g.memory_mib, g.cc, g.cuda_driver);
        }
        let paths = Paths::discover().unwrap();
        let file = load_models(&paths).unwrap();
        let p = build_plan(&paths, &file, Some("toq"), 8080, &hw, &[], gguf::read_shape).unwrap();
        println!("{} {}", p.spec.exe.display(), p.spec.args.join(" "));
        for (k, v) in &p.spec.env {
            println!("  {k}={v}");
        }
        println!("ctx {}  cards used: {:?}", p.ctx, p.gpus_used.iter().map(|g| &g.name).collect::<Vec<_>>());
        // The shape read from the real file matches the one used in the tests.
        let shape = gguf::read_shape(&p.gguf, "q8_0", "q8_0").unwrap();
        assert!(shape == qwen38_27b(), "the shape read from the GGUF doesn't match the fixture");
    }
}
