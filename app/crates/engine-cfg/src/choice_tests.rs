//! The user's choices in the plan and in the verdict (`choices.rs`, `general.rs`, `view.rs`), on the real catalog and
//! the real profiles with the fake hardware of `mango_common`'s fixtures: the three-card PC of the tests (RTX 3060 Ti,
//! GTX 1080, GTX 1660 SUPER), Vulkan cards, and the PC of issue 2.

use super::*;
use crate::choices::{Choices, SmallModels, WhereChoice};
use crate::hardware::fixture::*;
use crate::view::models_view;
use mango_common::catalog::Sampling;
use mango_common::i18n::{lang, Lang};
use std::path::PathBuf;

const RTX_3060_TI: &str = "NVIDIA GeForce RTX 3060 Ti";
const GTX_1080: &str = "NVIDIA GeForce GTX 1080";
const GTX_1660_SUPER: &str = "NVIDIA GeForce GTX 1660 SUPER";

fn real_dist() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap()
}

/// The real catalog on a temporary disk, with the files of every model and the engines (all empty), so a plan can be
/// built for any of them. With the real profiles, or without any.
struct World {
    _dir: tempfile::TempDir,
    paths: Paths,
}

fn touch(file: &Path) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, b"").unwrap();
}

fn world(with_profiles: bool) -> World {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths {
        dist: if with_profiles { real_dist() } else { r.join("dist") },
        engines: r.join("engines"),
        models: r.join("models"),
        opencode: r.join("o"),
        data: r.join("data"),
    };
    if !with_profiles {
        std::fs::create_dir_all(paths.dist.join("chat-templates")).unwrap();
        for f in ["mango-models.json", "mango-engines.json"] {
            std::fs::copy(real_dist().join(f), paths.dist.join(f)).unwrap();
        }
        for e in std::fs::read_dir(real_dist().join("chat-templates")).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), paths.dist.join("chat-templates").join(e.file_name())).unwrap();
        }
    }
    let file = load_models(&paths).unwrap();
    for key in file.local() {
        let cfg = model_cfg(&file, key).unwrap();
        for f in cfg.files.iter().map(|f| f.path.as_str()).chain(cfg.gguf.as_deref()).chain(cfg.mmproj.as_deref()) {
            touch(&paths.models.join(f));
        }
    }
    // The engines in the flat layout, which serves the CUDA 12 build; official llama.cpp has a folder for each of the others.
    for engine in ["llamacpp", "prism", "toq"] {
        touch(&paths.engines.join(engine).join("llama-server.exe"));
    }
    for build in ["cpu", "vulkan", "cuda-13"] {
        touch(&paths.engines.join("llamacpp").join(format!("b12110-{build}")).join("llama-server.exe"));
    }
    World { _dir: dir, paths }
}

/// Writes the file of the choices by hand, as a user or a later version would.
fn write_choices(w: &World, text: &str) {
    std::fs::create_dir_all(&w.paths.data).unwrap();
    std::fs::write(w.paths.data.join(choices::FILE), text).unwrap();
}

fn choose(w: &World, key: &str, place: WhereChoice) {
    choices::set_model(&w.paths, key, Choices { place, ..Choices::default() }).unwrap();
}

fn plan(w: &World, key: &str, hw: &Hardware) -> Result<EnginePlan> {
    plan_for(&w.paths, Some(key), 8080, hw, &[])
}

fn cards(p: &EnginePlan) -> Vec<&str> {
    p.gpus_used.iter().map(|g| g.name.as_str()).collect()
}

fn visible_cards(p: &EnginePlan) -> &str {
    p.spec.env.iter().find(|(k, _)| k == "CUDA_VISIBLE_DEVICES").map_or("", |(_, v)| v.as_str())
}

fn view_of(w: &World, key: &str, hw: &Hardware) -> view::ModelView {
    models_view(&w.paths, hw).unwrap().into_iter().find(|v| v.key == key).unwrap()
}

fn is_on_cpu(p: &EnginePlan) -> bool {
    has(&p.spec.args, ["-dev", "none"]) && p.gpus_used.is_empty() && visible_cards(p).is_empty()
}

fn has(args: &[String], pair: [&str; 2]) -> bool {
    args.windows(2).any(|w| w == pair)
}

fn with_unused(w: &World, names: &[&str]) {
    for n in names {
        choices::set_gpu_used(&w.paths, n, false).unwrap();
    }
}

// --- the order of the cards -------------------------------------------------------------------------------

/// Tensor cores first; then the cards without them, the GTX 16 family (and the like) last, which declare compute
/// capability 7.5 and read the prompt several times slower than a Pascal; at equal footing more memory, then compute
/// capability, then PCI order.
#[test]
fn the_cards_are_ranked_by_speed() {
    let n = |i, name, mib, cc| nvidia(i, name, mib, cc, (12, 6));
    let gpus = vec![
        n(0, "NVIDIA GeForce GTX 1650", 4096, (7, 5)),
        n(1, "NVIDIA GeForce GTX 1060 6GB", 6144, (6, 1)),
        n(2, GTX_1660_SUPER, 6144, (7, 5)),
        n(3, "NVIDIA GeForce GTX 1070", 8192, (6, 1)),
        n(4, "NVIDIA GeForce RTX 2060", 6144, (7, 5)),
        n(5, GTX_1080, 8192, (6, 1)),
        n(6, "Tesla T4", 15_360, (7, 5)),
        n(7, RTX_3060_TI, 8192, (8, 6)),
        n(8, "NVIDIA GeForce RTX 4090", 24_564, (8, 9)),
        n(9, "NVIDIA TITAN V", 12_288, (7, 0)),
    ];
    let mut ranked: Vec<&Gpu> = gpus.iter().collect();
    ranked.sort_by_key(|g| general::by_speed(g));
    let names: Vec<&str> = ranked.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "NVIDIA GeForce RTX 4090",
            "Tesla T4",
            "NVIDIA TITAN V",
            RTX_3060_TI,
            "NVIDIA GeForce RTX 2060",
            GTX_1070,
            GTX_1080,
            "NVIDIA GeForce GTX 1060 6GB",
            GTX_1660_SUPER,
            "NVIDIA GeForce GTX 1650",
        ]
    );
}

const GTX_1070: &str = "NVIDIA GeForce GTX 1070";

// --- auto -----------------------------------------------------------------------------------------------------

/// On the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER, without a profile, the small models stay on the 3060 Ti alone: the
/// speed of one card wins over the extra thousands of tokens of context of two. A model that doesn't reach 64,000
/// tokens on one takes two, and the second is the 1080.
#[test]
fn auto_on_the_three_cards_the_small_models_take_one_and_the_others_two() {
    let w = world(false);
    for key in ["3.5-4b", "ling", "3.5-2b"] {
        let p = plan(&w, key, &three_gpus()).unwrap();
        assert_eq!((cards(&p), visible_cards(&p)), (vec![RTX_3060_TI], "0"), "{key}");
        assert!(p.ctx >= 64_000, "{key}: {}", p.ctx);
    }
    let p = plan(&w, "bonsai2", &three_gpus()).unwrap();
    assert_eq!((cards(&p), visible_cards(&p)), (vec![RTX_3060_TI, GTX_1080], "0,1"));
    assert!(p.ctx >= 64_000, "{}", p.ctx);
}

/// `small_models: all` makes the models that would fit one card take all the cards; the others are not changed.
#[test]
fn small_models_on_all_the_cards() {
    let w = world(false);
    choices::set_small_models(&w.paths, SmallModels::All).unwrap();
    assert_eq!(visible_cards(&plan(&w, "ling", &three_gpus()).unwrap()), "0,1,2");
    assert_eq!(visible_cards(&plan(&w, "bonsai2", &three_gpus()).unwrap()), "0,1");
    let v = view_of(&w, "ling", &three_gpus());
    assert_eq!(v.verdict.place.unwrap().gpus.len(), 3, "the verdict is the plan's");
}

// --- the five choices ---------------------------------------------------------------------------------------

#[test]
fn each_choice_of_where_uses_exactly_the_cards_it_names() {
    let w = world(false);
    let hw = three_gpus();
    choose(&w, "3.5-4b", WhereChoice::Auto);
    assert_eq!(visible_cards(&plan(&w, "3.5-4b", &hw).unwrap()), "0", "a small model takes one card, as `one` does");
    // With small models on all the cards `auto` takes them all and `one` still takes the fastest only.
    choices::set_small_models(&w.paths, SmallModels::All).unwrap();
    let expected = [
        (WhereChoice::Auto, "0,1,2"),
        (WhereChoice::One, "0"),
        (WhereChoice::All, "0,1,2"),
    ];
    for (place, visible) in expected {
        choose(&w, "3.5-4b", place);
        let p = plan(&w, "3.5-4b", &hw).unwrap();
        assert_eq!(visible_cards(&p), visible, "{place:?}");
        assert!(has(&p.spec.args, ["-ngl", "all"]) && has(&p.spec.args, ["-fit", "off"]), "{place:?}: {:?}", p.spec.args);
        assert!(p.spec.env.iter().any(|(k, v)| k == "CUDA_DEVICE_ORDER" && v == "PCI_BUS_ID"));
    }
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![GTX_1080.into(), GTX_1660_SUPER.into()], ..Choices::default() }).unwrap();
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert_eq!((cards(&p), visible_cards(&p)), (vec![GTX_1080, GTX_1660_SUPER], "1,2"));
    choose(&w, "3.5-4b", WhereChoice::Cpu);
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert!(is_on_cpu(&p) && has(&p.spec.args, ["-t", "8"]), "{:?}", p.spec.args);
    assert!(!p.spec.args.iter().any(|a| a == "-ngl"), "{:?}", p.spec.args);
}

/// `one` is the fastest card in use; `all` and `pick` don't count the cards left out.
#[test]
fn the_choices_count_only_the_cards_in_use() {
    let w = world(false);
    let hw = three_gpus();
    with_unused(&w, &[RTX_3060_TI]);
    choose(&w, "3.5-4b", WhereChoice::One);
    assert_eq!(cards(&plan(&w, "3.5-4b", &hw).unwrap()), [GTX_1080], "the fastest of the others");
    choose(&w, "3.5-4b", WhereChoice::All);
    assert_eq!(visible_cards(&plan(&w, "3.5-4b", &hw).unwrap()), "1,2");
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![RTX_3060_TI.into()], ..Choices::default() }).unwrap();
    let e = plan(&w, "3.5-4b", &hw).unwrap_err().to_string();
    assert!(e.contains(RTX_3060_TI) && e.contains(&tr!("segnata come non usata", "marked as not used")), "{e}");
}

/// A card that is not there any more, one the engine can't use, a choice of cards without cards: clear errors, never
/// another card in its place.
#[test]
fn a_card_that_is_missing_is_an_error_that_names_it() {
    let w = world(false);
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec!["NVIDIA GeForce RTX 4090".into()], ..Choices::default() }).unwrap();
    let e = plan(&w, "3.5-4b", &three_gpus()).unwrap_err().to_string();
    assert!(e.contains("RTX 4090") && e.contains(&tr!("non c'è più", "no longer in this computer")), "{e}");
    // The verdict says it too.
    let v = view_of(&w, "3.5-4b", &three_gpus());
    assert!(!v.verdict.fits && v.verdict.reason.contains("RTX 4090"), "{:?}", v.verdict);

    let mut hw = three_gpus();
    hw.gpus.push(other(3, "AMD Radeon RX 6600", Vendor::Amd, 8176));
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec!["AMD Radeon RX 6600".into()], ..Choices::default() }).unwrap();
    let e = plan(&w, "3.5-4b", &hw).unwrap_err().to_string();
    assert!(e.contains("RX 6600") && e.contains(&tr!("non può essere usata", "can't be used")), "{e}");

    // The choice of cards with no card named is refused when it is saved.
    let e = choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, ..Choices::default() }).unwrap_err().to_string();
    assert!(e.contains(&tr!("non ne hai indicata nessuna", "named none")), "{e}");
}

/// The explicit choices don't fall back on the processor: if the model doesn't fit, the plan says so.
#[test]
fn an_explicit_choice_does_not_fall_back_on_the_processor() {
    let w = world(false);
    choose(&w, "bonsai2", WhereChoice::One);
    let e = plan(&w, "bonsai2", &three_gpus()).unwrap_err().to_string();
    assert!(e.contains(&tr!("non ci sta nelle schede indicate", "doesn't fit in the cards indicated")) && e.contains(RTX_3060_TI), "{e}");
    let v = view_of(&w, "bonsai2", &three_gpus());
    assert!(!v.verdict.fits && v.verdict.place.is_none() && v.verdict.reason == e.split(" (dettaglio").next().unwrap(), "{:?}", v.verdict);
    assert!(v.limits.context.is_empty());
    // Automatic does fall back: bonsai2 on a single small card runs on the processor.
    choose(&w, "bonsai2", WhereChoice::Auto);
    let small = pc(vec![nvidia(0, "NVIDIA GeForce GTX 1650", 4096, (7, 5), (12, 6))], 32_768);
    assert!(is_on_cpu(&plan(&w, "bonsai2", &small).unwrap()));
}

// --- cards left out -------------------------------------------------------------------------------------------

/// A card left out is gone from the plan, from the verdict and from the context shown: what is shown is what the plan
/// does.
#[test]
fn a_card_left_out_disappears_from_plan_verdict_and_context() {
    let w = world(false);
    let hw = three_gpus();
    let all_three = plan(&w, "bonsai2", &hw).unwrap();
    assert_eq!(visible_cards(&all_three), "0,1");

    // Without the 1080 the second card is the 1660 SUPER, and the context is that of those two.
    with_unused(&w, &[GTX_1080]);
    let p = plan(&w, "bonsai2", &hw).unwrap();
    assert_eq!(cards(&p), [RTX_3060_TI, GTX_1660_SUPER]);
    assert!(p.ctx < all_three.ctx, "{} against {}", p.ctx, all_three.ctx);
    let v = view_of(&w, "bonsai2", &hw);
    let place = v.verdict.place.unwrap();
    assert_eq!((place.placement, place.gpus, place.context), (Placement::Gpu, vec![RTX_3060_TI.to_string(), GTX_1660_SUPER.to_string()], p.ctx));
    assert_eq!(v.limits.context.last(), Some(&p.ctx), "the largest context offered is the one that fits");

    // Without the 3060 Ti either only the 1660 SUPER is left, and it doesn't hold the model: the processor.
    with_unused(&w, &[RTX_3060_TI]);
    let p = plan(&w, "bonsai2", &hw).unwrap();
    assert!(is_on_cpu(&p));
    let place = view_of(&w, "bonsai2", &hw).verdict.place.unwrap();
    assert_eq!((place.placement, place.gpus.len(), place.context), (Placement::Cpu, 0, p.ctx));

    // And if the card is used again, as at the start.
    choices::set_gpu_used(&w.paths, GTX_1080, true).unwrap();
    choices::set_gpu_used(&w.paths, RTX_3060_TI, true).unwrap();
    assert_eq!(visible_cards(&plan(&w, "bonsai2", &hw).unwrap()), "0,1");
    assert!(choices::read(&w.paths).unwrap().computer.unused_gpus.is_empty());
}

/// A card left out and a card lent to another job both stay out of the plan; when a setup tailored to the PC needs
/// the card, the sentence says which of the two it is.
#[test]
fn a_tailored_setup_that_needs_a_card_left_out_says_so() {
    let w = world(true);
    let hw = three_gpus();
    assert!(plan(&w, "3.6", &hw).is_ok());
    with_unused(&w, &[GTX_1660_SUPER]);
    let e = plan(&w, "3.6", &hw).unwrap_err().to_string();
    assert!(e.contains(GTX_1660_SUPER) && e.contains(&tr!("che hai segnato come non usata", "which you marked as not used")), "{e}");
    let v = view_of(&w, "3.6", &hw);
    assert!(!v.verdict.fits && v.verdict.reason.contains(&tr!("che hai segnato come non usata", "which you marked as not used")), "{:?}", v.verdict);
    assert!(v.tailored, "the setup is still there for the card to come back");
    // The card lent to another job keeps its sentence.
    let w = world(true);
    let e = plan_for(&w.paths, Some("3.6"), 8080, &hw, &[2]).unwrap_err().to_string();
    assert!(e.contains(&tr!("liberata per un altro lavoro", "released for another job")), "{e}");
}

// --- the context ----------------------------------------------------------------------------------------------

#[test]
fn the_chosen_context_is_used_if_it_fits_and_never_goes_over_what_fits() {
    let w = world(false);
    let hw = three_gpus();
    let largest = plan(&w, "3.5-4b", &hw).unwrap().ctx;
    assert_eq!(largest, 126_976, "the 4B on the 3060 Ti with the image encoder");
    let with_context = |context| choices::set_model(&w.paths, "3.5-4b", Choices { context, ..Choices::default() }).unwrap();

    with_context(Some(65_536));
    assert_eq!(plan(&w, "3.5-4b", &hw).unwrap().ctx, 65_536);
    let v = view_of(&w, "3.5-4b", &hw);
    assert_eq!(v.verdict.place.unwrap().context, 65_536);
    assert_eq!(v.limits.context, [32_768, 65_536, largest], "the choices offered don't shrink with the choice made");

    // More than fits, or more than the model's target: the most that fits.
    for asked in [200_000, 262_144, 1_000_000] {
        with_context(Some(asked));
        assert_eq!(plan(&w, "3.5-4b", &hw).unwrap().ctx, largest, "{asked}");
    }
    with_context(None);
    assert_eq!(plan(&w, "3.5-4b", &hw).unwrap().ctx, largest);

    // On a single chosen card the context goes down to what it holds, down to the minimum.
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::One, context: Some(131_072), ..Choices::default() }).unwrap();
    assert_eq!(plan(&w, "3.5-4b", &hw).unwrap().ctx, largest);
    let p = plan(&w, "3.5-4b", &pc(vec![nvidia(0, "NVIDIA GeForce RTX 3050", 7000, (8, 6), (12, 6))], 16_384)).unwrap();
    assert!((32_768..131_072).contains(&p.ctx), "{}", p.ctx);
}

/// The contexts offered are 32k, 64k, 128k... up to the largest that fits, which is the last.
#[test]
fn the_contexts_offered_end_with_the_largest_that_fits() {
    let w = world(false);
    let v = view_of(&w, "ling", &three_gpus());
    assert_eq!(v.limits.context, [32_768, 65_536, 131_072]);
    let v = view_of(&w, "3.5-4b", &three_gpus());
    assert_eq!(v.limits.context, [32_768, 65_536, 126_976]);
    // A model with a tailored setup: the profile's context.
    let w = world(true);
    assert_eq!(view_of(&w, "3.8", &three_gpus()).limits.context, [32_768, 65_536, 92_160]);
    // That doesn't fit: nothing to offer.
    assert!(view_of(&w, "toq", &pc(vec![], 8192)).limits.context.is_empty());
}

// --- the PC of issue 2 ----------------------------------------------------------------------------------------

/// Issue 2: a GeForce GT 710 of 2 GB (read from DXGI, without CUDA), Core Ultra 5 245K with 14 cores and 16 GB of RAM:
/// the models that fit go on the processor and the card doesn't count, also for the list of cards.
#[test]
fn the_pc_of_issue_2_runs_its_models_on_the_processor() {
    let mut hw = pc(vec![other(0, "NVIDIA GeForce GT 710", Vendor::Nvidia, 2048)], 16_384);
    hw.cpu = Cpu { name: "Intel(R) Core(TM) Ultra 5 245K".into(), cores: 14, avx2: true, avx512: false };
    let w = world(false);
    let views = models_view(&w.paths, &hw).unwrap();
    assert!(views.iter().all(|v| v.verdict.place.as_ref().is_none_or(|p| p.placement == Placement::Cpu && p.gpus.is_empty())), "{views:#?}");
    let ling = views.iter().find(|v| v.key == "ling").unwrap();
    assert_eq!((ling.verdict.fits, ling.verdict.speed, ling.verdict.fastest), (true, Some(Speed::Quick), true));
    assert_eq!(ling.limits.places, [WhereChoice::Auto, WhereChoice::Cpu], "no card to choose among");
    let p = plan(&w, "ling", &hw).unwrap();
    assert!(is_on_cpu(&p) && has(&p.spec.args, ["-t", "14"]), "{:?}", p.spec.args);
    // The card is in the list but is not used, and says why.
    let c = computer_view(&w.paths, &hw).unwrap();
    assert_eq!(c.gpus.len(), 1);
    assert!(!c.gpus[0].used && c.gpus[0].note.contains(&tr!("troppa poca memoria", "too little memory")), "{:?}", c.gpus[0]);
    assert_eq!((c.cpu.as_str(), c.cores, c.ram_mib), ("Intel(R) Core(TM) Ultra 5 245K", 14, 16_384));
}

// --- the tailored setups -------------------------------------------------------------------------------------

/// With «auto» the setup tailored to the PC applies, with any other choice it is ignored for that model and the
/// general plan applies; the tailored setup stays known for when the choice goes back to «auto».
#[test]
fn a_tailored_setup_applies_only_with_auto() {
    let w = world(true);
    let hw = three_gpus();

    let v = view_of(&w, "3.6", &hw);
    assert!(v.tailored && v.verdict.reason.contains(&tr!("assetto su misura", "setup tailored")), "{:?}", v.verdict);
    assert!(!v.verdict.reason.contains("3060ti-1080-1660s"), "the profile's name is not for the user: {:?}", v.verdict);
    let auto = plan(&w, "3.6", &hw).unwrap();
    assert!(auto.spec.exe.starts_with(w.paths.engines.join("prism")) && auto.spec.args.iter().any(|a| a == "--spec-type"), "{:?}", auto.spec);
    assert_eq!(v.verdict.place.as_ref().map(|p| (p.placement, p.context)), Some((Placement::Gpu, auto.ctx)));
    assert_eq!(v.verdict.place.unwrap().gpus.len(), 3);
    assert_eq!(v.limits.places, [WhereChoice::Auto, WhereChoice::One, WhereChoice::All, WhereChoice::Cpu, WhereChoice::Pick]);
    assert!(profile_for(&w.paths, "3.6", &hw).unwrap().is_some());

    // The processor: the general plan, with official llama.cpp and without the profile's arguments.
    choose(&w, "3.6", WhereChoice::Cpu);
    let p = plan(&w, "3.6", &hw).unwrap();
    assert!(p.spec.exe.starts_with(w.paths.engines.join("llamacpp")) && is_on_cpu(&p) && !p.spec.args.iter().any(|a| a == "--spec-type"), "{:?}", p.spec);
    let v = view_of(&w, "3.6", &hw);
    assert!(v.tailored, "it is still there");
    assert!(!v.verdict.reason.contains("3060ti-1080-1660s") && v.verdict.place.as_ref().is_some_and(|p| p.placement == Placement::Cpu), "{:?}", v.verdict);
    assert!(profile_for(&w.paths, "3.6", &hw).unwrap().is_none(), "who asks for the profile gets the choice's answer");

    // All the cards, with the general plan: Qwen3.6 doesn't hold in them and says so, no processor in its place.
    choose(&w, "3.6", WhereChoice::All);
    let e = plan(&w, "3.6", &hw).unwrap_err().to_string();
    assert!(e.contains(&tr!("non ci sta nelle schede indicate", "doesn't fit in the cards indicated")), "{e}");
    assert!(!view_of(&w, "3.6", &hw).verdict.fits);

    // Back to automatic.
    choose(&w, "3.6", WhereChoice::Auto);
    assert!(plan(&w, "3.6", &hw).unwrap().spec.args.iter().any(|a| a == "--spec-type"));
}

/// Bonsai 2 has two files, one for each engine: leaving the tailored setup, the general engine opens its own.
#[test]
fn leaving_the_tailored_setup_changes_the_files_of_the_model_that_have_one_per_engine() {
    let w = world(true);
    let hw = three_gpus();
    assert!(plan(&w, "bonsai2", &hw).unwrap().gguf.ends_with("Ternary-Bonsai-2-27B-PQ2_0.gguf"));
    choose(&w, "bonsai2", WhereChoice::All);
    assert!(plan(&w, "bonsai2", &hw).unwrap().gguf.ends_with("Ternary-Bonsai-2-27B-Q2_0.gguf"));
    // The catalog says what is missing for the choice made.
    std::fs::remove_file(w.paths.models.join("Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-Q2_0.gguf")).unwrap();
    let (entries, _) = catalog::catalog_for(&w.paths, &hw).unwrap();
    let bonsai = entries.iter().find(|e| e.key == "bonsai2").unwrap();
    assert!(!bonsai.weights && bonsai.missing.as_deref().is_some_and(|m| m.contains("Q2_0")), "{bonsai:?}");
}

/// A model that needs its own engine only has «auto»: the engine exists only with the tailored setup.
#[test]
fn a_model_with_its_own_engine_only_has_auto() {
    let w = world(true);
    let hw = three_gpus();
    assert_eq!(view_of(&w, "toq", &hw).limits.places, [WhereChoice::Auto]);
    let e = choices::set_model(&w.paths, "toq", Choices { place: WhereChoice::Cpu, ..Choices::default() }).unwrap_err().to_string();
    assert!(e.contains(&tr!("solo Automatico", "can only be Automatic")), "{e}");
    // A file edited by hand to say otherwise doesn't make the model start elsewhere, and says why.
    write_choices(&w, r#"{ "models": { "toq": { "where": "cpu" } } }"#);
    let v = view_of(&w, "toq", &hw);
    assert!(!v.verdict.fits && v.verdict.reason.contains(&tr!("solo Automatico", "can only be Automatic")), "{:?}", v.verdict);
    let technical = tr!("dettaglio tecnico", "technical detail");
    assert!(!v.verdict.reason.contains(&technical), "one sentence for the user: {}", v.verdict.reason);
    let e = plan(&w, "toq", &hw).unwrap_err().to_string();
    assert!(e.contains(&tr!("solo Automatico", "can only be Automatic")) && !e.contains(&technical), "{e}");
}

// --- the order of the cards on real plans -----------------------------------------------------------------------

/// A PC whose PCI order is not its speed order: the GTX 1660 SUPER at index 0, the GTX 1080 at 1, the RTX at 2, all
/// with the same memory, so that only the speed tells them apart.
fn slow_card_first() -> Hardware {
    let n = |i, name, cc| nvidia(i, name, 8192, cc, (12, 6));
    pc(vec![n(0, GTX_1660_SUPER, (7, 5)), n(1, GTX_1080, (6, 1)), n(2, RTX_3060_TI, (8, 6))], 65_536)
}

#[test]
fn the_fastest_card_is_not_the_first_in_pci_order() {
    let w = world(false);
    let hw = slow_card_first();
    choose(&w, "3.5-4b", WhereChoice::One);
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert_eq!((cards(&p), visible_cards(&p)), (vec![RTX_3060_TI], "2"));
    // `auto` on a model that needs two cards: the RTX and the 1080, not the 1660 SUPER that comes first in PCI order.
    let p = plan(&w, "bonsai2", &hw).unwrap();
    assert_eq!((cards(&p), visible_cards(&p)), (vec![GTX_1080, RTX_3060_TI], "1,2"));
    // Without the RTX the 1080 is the fastest, at index 1.
    let n = |i, name, cc| nvidia(i, name, 8192, cc, (12, 6));
    let two = pc(vec![n(0, GTX_1660_SUPER, (7, 5)), n(1, GTX_1080, (6, 1))], 65_536);
    assert_eq!(cards(&plan(&w, "3.5-4b", &two).unwrap()), [GTX_1080]);
}

// --- combinations ---------------------------------------------------------------------------------------------

/// A card lent to another job (by index) and another left out by the user (by name) are both out of the same plan.
#[test]
fn a_lent_card_and_a_card_left_out_are_out_of_the_same_plan() {
    let w = world(false);
    let hw = three_gpus();
    with_unused(&w, &[GTX_1660_SUPER]);
    let p = plan_for(&w.paths, Some("3.5-4b"), 8080, &hw, &[0]).unwrap();
    assert_eq!((cards(&p), visible_cards(&p)), (vec![GTX_1080], "1"));
    choose(&w, "3.5-4b", WhereChoice::All);
    assert_eq!(cards(&plan_for(&w.paths, Some("3.5-4b"), 8080, &hw, &[0]).unwrap()), [GTX_1080]);
    // Bonsai 2 needs two cards: with these two out only one is left and the plan says the others are lent.
    let e = plan_for(&w.paths, Some("bonsai2"), 8080, &hw, &[0]).unwrap_err().to_string();
    assert!(e.contains(&tr!("non ci sta nelle schede video rimaste", "doesn't fit in the remaining graphics cards")), "{e}");
}

/// A choice of cards that names a lent card: the plan says it is lent.
#[test]
fn a_choice_of_cards_naming_a_lent_card_says_so() {
    let w = world(false);
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![RTX_3060_TI.into()], ..Choices::default() }).unwrap();
    assert_eq!(cards(&plan(&w, "3.5-4b", &three_gpus()).unwrap()), [RTX_3060_TI]);
    let e = plan_for(&w.paths, Some("3.5-4b"), 8080, &three_gpus(), &[0]).unwrap_err().to_string();
    assert!(e.contains(RTX_3060_TI) && e.contains(&tr!("prestata a un altro lavoro", "lent to another job")), "{e}");
}

/// Cards are told apart by name: two cards with the same name are used or left out together, and a choice of cards
/// that names them takes both.
#[test]
fn two_cards_with_the_same_name_are_used_and_chosen_together() {
    let w = world(false);
    let name = "NVIDIA GeForce RTX 3060";
    let hw = pc(vec![nvidia(0, name, 8192, (8, 6), (12, 6)), nvidia(1, name, 8192, (8, 6), (12, 6))], 65_536);
    assert_eq!(visible_cards(&plan(&w, "ling", &hw).unwrap()), "0");
    choices::set_model(&w.paths, "ling", Choices { place: WhereChoice::Pick, gpus: vec![name.into()], ..Choices::default() }).unwrap();
    assert_eq!(visible_cards(&plan(&w, "ling", &hw).unwrap()), "0,1");
    choose(&w, "ling", WhereChoice::Auto);
    with_unused(&w, &[name]);
    assert!(computer_view(&w.paths, &hw).unwrap().gpus.iter().all(|g| !g.used));
    assert!(is_on_cpu(&plan(&w, "ling", &hw).unwrap()), "both are out");
}

/// With Vulkan the engine cannot tell the cards apart: `one` and `pick` are refused by the plan and the verdict.
#[test]
fn with_vulkan_one_and_pick_are_refused() {
    let w = world(false);
    let hw = two_radeons();
    let sentence = tr!("non si può scegliere una scheda", "a card can't be chosen");
    choose(&w, "3.5-4b", WhereChoice::One);
    let e = plan(&w, "3.5-4b", &hw).unwrap_err().to_string();
    assert!(e.contains(&sentence) && !e.contains("Vulkan"), "{e}");
    assert!(!view_of(&w, "3.5-4b", &hw).verdict.fits);
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec!["AMD Radeon RX 6800".into()], ..Choices::default() }).unwrap();
    let e = plan(&w, "3.5-4b", &hw).unwrap_err().to_string();
    assert!(e.contains(&sentence) && !e.contains("Vulkan"), "{e}");
    let v = view_of(&w, "3.5-4b", &hw);
    assert!(!v.verdict.fits && v.verdict.reason.contains(&sentence), "{:?}", v.verdict);
    assert_eq!(v.limits.places, [WhereChoice::Auto, WhereChoice::All, WhereChoice::Cpu]);
}

/// The context chosen with a tailored setup is in the real plan's arguments, not only in the choices offered.
#[test]
fn the_chosen_context_reaches_the_arguments_of_a_tailored_setup() {
    let w = world(true);
    let hw = three_gpus();
    let context = |p: &EnginePlan| p.spec.args.windows(2).find(|a| a[0] == "-c").map(|a| a[1].clone());
    let p = plan(&w, "3.6", &hw).unwrap();
    assert_eq!((context(&p), p.ctx), (Some("131072".into()), 131_072));
    let with_context = |context| choices::set_model(&w.paths, "3.6", Choices { context, ..Choices::default() }).unwrap();
    with_context(Some(65_536));
    let p = plan(&w, "3.6", &hw).unwrap();
    assert!(p.spec.args.iter().any(|a| a == "--spec-type"), "still the tailored setup");
    assert_eq!((context(&p), p.ctx), (Some("65536".into()), 65_536));
    assert_eq!(view_of(&w, "3.6", &hw).verdict.place.unwrap().context, 65_536);
    // More than the setup holds: the setup's.
    with_context(Some(262_144));
    assert_eq!(context(&plan(&w, "3.6", &hw).unwrap()), Some("131072".into()));
}

/// A setup that splits the layers by itself (TOQ's) takes the cards left, and the verdict is the plan's.
#[test]
fn an_automatic_split_leaves_out_the_card_left_out() {
    let w = world(true);
    let n = |i, name| nvidia(i, name, 8192, (8, 6), (12, 6));
    let (a, b, c) = ("NVIDIA GeForce RTX 3070", "NVIDIA GeForce RTX 3070 Ti", "NVIDIA GeForce RTX 3080");
    let hw = pc(vec![n(0, a), n(1, b), n(2, c)], 65_536);
    let file = load_models(&w.paths).unwrap();
    let toq_plan = |hw: &Hardware| build_plan(&w.paths, &file, Some("toq"), 8080, hw, &[], |_, _, _| Ok(crate::split::fixture::qwen38_27b())).unwrap();
    let all = toq_plan(&hw);
    assert_eq!((visible_cards(&all), all.ctx), ("0,1,2", 122_880));

    with_unused(&w, &[c]);
    let p = toq_plan(&hw);
    assert_eq!(cards(&p), [a, b]);
    assert!(p.ctx < all.ctx, "{} against {}", p.ctx, all.ctx);
    let place = view_of(&w, "toq", &hw).verdict.place.unwrap();
    assert_eq!((place.gpus, place.context), (cards(&p).into_iter().map(String::from).collect::<Vec<_>>(), p.ctx));
}

// --- two commands at the same time ------------------------------------------------------------------------------

/// Commands that change the file at the same time lose none of the changes.
#[test]
fn commands_in_parallel_lose_no_change() {
    let w = world(false);
    let keys: Vec<String> = load_models(&w.paths).unwrap().local().map(String::from).collect();
    std::thread::scope(|scope| {
        for (i, key) in keys.iter().enumerate() {
            let paths = &w.paths;
            scope.spawn(move || {
                for round in 0..20 {
                    choices::set_model(paths, key, Choices { context: Some(32_768 + 4096 * (round + 1)), ..Choices::default() }).unwrap();
                    choices::set_gpu_used(paths, &format!("card {i}"), i % 2 == 1).unwrap();
                }
            });
        }
    });
    let c = choices::read(&w.paths).unwrap();
    assert_eq!(c.models.len(), keys.len());
    for key in &keys {
        assert_eq!(c.models[key].context, Some(32_768 + 4096 * 20), "{key}");
    }
    // The cards of even number were left out, the others used.
    let mut unused = c.computer.unused_gpus.clone();
    unused.sort();
    let mut even: Vec<String> = (0..keys.len()).filter(|i| i % 2 == 0).map(|i| format!("card {i}")).collect();
    even.sort();
    assert_eq!(unused, even);
}

// --- Vulkan ---------------------------------------------------------------------------------------------------

fn two_radeons() -> Hardware {
    pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368), other(1, "AMD Radeon RX 6800", Vendor::Amd, 16_368)], 32_768)
}

/// With Vulkan a single card can't be left out: the plan, the verdict and the choices offered say so, none pretends.
#[test]
fn with_vulkan_a_single_card_cannot_be_left_out() {
    let w = world(false);
    let hw = two_radeons();
    let ok = plan(&w, "3.5-4b", &hw).unwrap();
    assert_eq!(ok.gpus_used.len(), 2);
    with_unused(&w, &["AMD Radeon RX 6800"]);
    let sentence = tr!("non si può escludere una scheda singola", "a single card can't be left out");
    let e = plan(&w, "3.5-4b", &hw).unwrap_err().to_string();
    assert!(e.contains(&sentence) && !e.contains("Vulkan"), "{e}");
    let v = view_of(&w, "3.5-4b", &hw);
    assert!(!v.verdict.fits && v.verdict.reason.contains(&sentence), "{:?}", v.verdict);
    assert_eq!(v.limits.places, [WhereChoice::Cpu]);
    let c = computer_view(&w.paths, &hw).unwrap();
    let note = tr!("Con il motore di questo computer non si può escludere una scheda sola.", "With this computer's engine a single card can't be left out.");
    assert!(c.gpus.iter().all(|g| g.note == note), "{:?}", c.gpus);
    assert_eq!(c.gpus.iter().map(|g| g.used).collect::<Vec<_>>(), [true, false]);

    // The processor works: it hides all the cards.
    choose(&w, "3.5-4b", WhereChoice::Cpu);
    assert!(is_on_cpu(&plan(&w, "3.5-4b", &hw).unwrap()));
    assert!(view_of(&w, "3.5-4b", &hw).verdict.fits);

    // Leaving out all of them is the processor too.
    choose(&w, "3.5-4b", WhereChoice::Auto);
    with_unused(&w, &["AMD Radeon RX 7800 XT"]);
    assert!(is_on_cpu(&plan(&w, "3.5-4b", &hw).unwrap()));
    assert_eq!(view_of(&w, "3.5-4b", &hw).verdict.place.unwrap().placement, Placement::Cpu);

    // A single card with Vulkan: nothing to choose among, and it can be left out.
    let one = pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768);
    let c = computer_view(&w.paths, &one).unwrap();
    assert!(!c.gpus[0].used && c.gpus[0].note.is_empty(), "{:?}", c.gpus[0]);
    assert_eq!(view_of(&w, "3.5-4b", &one).limits.places, [WhereChoice::Auto, WhereChoice::Cpu]);
}

// --- the file of the choices ----------------------------------------------------------------------------------

fn data_only() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths { dist: real_dist(), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("data") };
    (dir, paths)
}

#[test]
fn without_the_file_everything_has_its_standard_value() {
    let (_d, paths) = data_only();
    let c = choices::read(&paths).unwrap();
    assert_eq!(c, choices::ChoicesFile::default());
    assert!(c.default.is_none() && c.models.is_empty() && c.computer.unused_gpus.is_empty());
    assert_eq!(c.computer.small_models, SmallModels::One);
    assert!(c.update.automatic, "automatic updates are on by default");
    assert_eq!(c.scope("3.6").choices, Choices::default());
}

#[test]
fn unknown_entries_are_ignored() {
    let (_d, paths) = data_only();
    std::fs::create_dir_all(&paths.data).unwrap();
    std::fs::write(
        paths.data.join(choices::FILE),
        r#"{ "future": 1, "default": "ling",
             "models": { "gone-model": { "where": "cpu", "newer": true }, "ling": { "where": "one", "style": "precise", "sparkle": 3 } },
             "computer": { "unused_gpus": ["A"], "extra": [] }, "update": { "automatic": false, "channel": "x" } }"#,
    )
    .unwrap();
    let c = choices::read(&paths).unwrap();
    assert_eq!(c.default.as_deref(), Some("ling"));
    assert_eq!((c.models["ling"].place, c.models["ling"].style), (WhereChoice::One, choices::Style::Precise));
    assert_eq!(c.computer.unused_gpus, ["A"]);
    assert!(!c.update.automatic);
    // The plan of a model reads its own and the PC's, the unknown model is left alone.
    let w = world(false);
    write_choices(&w, r#"{ "models": { "gone-model": { "where": "cpu" } } }"#);
    assert_eq!(visible_cards(&plan(&w, "ling", &three_gpus()).unwrap()), "0");
}

/// A file that can't be read or understood is an error with a sentence, not the standard values; and it is not
/// overwritten by a change.
#[test]
fn an_unreadable_file_is_an_error_and_is_not_overwritten() {
    let (_d, paths) = data_only();
    std::fs::create_dir_all(&paths.data).unwrap();
    let f = paths.data.join(choices::FILE);
    for broken in ["{ not json", r#"{ "models": { "ling": { "where": "turbo" } } }"#, r#"{ "models": { "ling": { "context": 0 } } }"#, r#"{ "computer": { "small_models": 3 } }"#] {
        std::fs::write(&f, broken).unwrap();
        let e = choices::read(&paths).unwrap_err().to_string();
        assert!(e.contains(&tr!("non sono valide", "are not valid")) && e.contains(choices::FILE), "{broken}: {e}");
        assert!(choices::set_gpu_used(&paths, "A", false).is_err() && choices::set_default(&paths, Some("ling")).is_err());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), broken, "the file stays as it was");
    }
    // A plan or a verdict with such a file doesn't go on as if nothing was chosen.
    let w = world(false);
    write_choices(&w, "{ not json");
    assert!(plan(&w, "ling", &three_gpus()).is_err());
    assert!(models_view(&w.paths, &three_gpus()).is_err() && recommended(&w.paths, &three_gpus()).is_err() && catalog::catalog_for(&w.paths, &three_gpus()).is_err());
    // A file that can't even be opened as a file (a folder in its place).
    std::fs::remove_file(w.paths.data.join(choices::FILE)).unwrap();
    std::fs::create_dir(w.paths.data.join(choices::FILE)).unwrap();
    assert!(choices::read(&w.paths).unwrap_err().to_string().contains(&tr!("Non riesco a leggere", "I can't read")));
}

/// What is written is read back, and only the models whose choices differ from the standard ones are in the file.
#[test]
fn what_is_written_is_read_back_and_only_the_differences_are_kept() {
    let w = world(false);
    let mut mine = Choices { place: WhereChoice::Pick, gpus: vec![GTX_1080.into()], context: Some(65_536), style: choices::Style::Creative, reasoning: Some(false) };
    choices::set_model(&w.paths, "ling", mine.clone()).unwrap();
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Cpu, ..Choices::default() }).unwrap();
    choices::set_default(&w.paths, Some("ling")).unwrap();
    choices::set_gpu_used(&w.paths, GTX_1660_SUPER, false).unwrap();
    choices::set_gpu_used(&w.paths, GTX_1660_SUPER, false).unwrap();
    choices::set_gpu_used(&w.paths, GTX_1080, false).unwrap();
    choices::set_gpu_used(&w.paths, GTX_1080, true).unwrap();
    choices::set_small_models(&w.paths, SmallModels::All).unwrap();
    choices::set_update_automatic(&w.paths, false).unwrap();
    let c = choices::read(&w.paths).unwrap();
    assert_eq!(c.models["ling"], mine);
    assert_eq!((c.default.as_deref(), c.computer.unused_gpus.as_slice(), c.computer.small_models, c.update.automatic), (Some("ling"), [GTX_1660_SUPER.to_string()].as_slice(), SmallModels::All, false));
    // A model back at its standard values leaves the file; the card list of a choice that isn't `pick` is cleared.
    choices::set_model(&w.paths, "3.5-4b", Choices::default()).unwrap();
    mine.place = WhereChoice::One;
    choices::set_model(&w.paths, "ling", mine).unwrap();
    let c = choices::read(&w.paths).unwrap();
    assert_eq!(c.models.keys().collect::<Vec<_>>(), ["ling"]);
    assert!(c.models["ling"].gpus.is_empty(), "the cards only count with «pick»");
    let text = std::fs::read_to_string(w.paths.data.join(choices::FILE)).unwrap();
    assert!(text.contains(r#""where": "one""#) && !text.contains("3.5-4b"), "{text}");
    assert!(!w.paths.data.join("choices.json.tmp").exists(), "written whole, no temporary left");
    choices::set_default(&w.paths, None).unwrap();
    assert_eq!(choices::read(&w.paths).unwrap().default, None);
}

/// A model taken off the list loses its choices and, if it was the default, the default.
#[test]
fn a_forgotten_model_leaves_the_choices() {
    let w = world(false);
    choices::set_default(&w.paths, Some("ling")).unwrap();
    choose(&w, "ling", WhereChoice::Cpu);
    choose(&w, "3.5-4b", WhereChoice::Cpu);
    choices::forget_model(&w.paths, "ling").unwrap();
    let c = choices::read(&w.paths).unwrap();
    assert_eq!((c.default, c.models.keys().map(String::as_str).collect::<Vec<_>>()), (None, vec!["3.5-4b"]));
    choices::set_default(&w.paths, Some("3.5-4b")).unwrap();
    choices::forget_model(&w.paths, "ling").unwrap();
    assert_eq!(choices::read(&w.paths).unwrap().default.as_deref(), Some("3.5-4b"), "another model's default stays");
}

/// The model the app loads becomes the default only while the user has none: the first one stays.
#[test]
fn a_default_is_saved_only_when_there_is_none() {
    let w = world(false);
    choices::set_default_if_none(&w.paths, "ling").unwrap();
    choices::set_default_if_none(&w.paths, "3.6").unwrap();
    assert_eq!(choices::read(&w.paths).unwrap().default.as_deref(), Some("ling"), "the first one stays");
}

/// A model of the user's from a file on the computer names that file among its own: «Togli» leaves it. The files Mango
/// Code downloads are not among them.
#[test]
fn the_files_of_the_user_are_named_and_the_downloaded_ones_are_not() {
    let w = world(false);
    let mine = w._dir.path().join("elsewhere").join("mine.gguf");
    touch(&mine);
    let file = |path: &str, sha: Option<&str>| match sha {
        Some(sha) => serde_json::json!({ "path": path, "size": 1_000_000_000u64, "sha256": sha }),
        None => serde_json::json!({ "path": path, "size": 1_000_000_000u64 }),
    };
    let entry = |gguf: &str, sha: Option<&str>| {
        serde_json::json!({ "label": gguf, "gguf": gguf, "ctx": 32768, "files": [file(gguf, sha)], "memory": { "kv_kib_token": 32, "state_mib": 50 } })
    };
    let local = mine.display().to_string();
    let hash = "0".repeat(64);
    std::fs::create_dir_all(&w.paths.data).unwrap();
    let list = serde_json::json!({ "models": { "local-mine": entry(&local, None), "hf-mine": entry("owner/repo/hf.gguf", Some(&hash)) } });
    std::fs::write(w.paths.data.join(mango_common::catalog::USER_FILE), list.to_string()).unwrap();

    let views = models_view(&w.paths, &three_gpus()).unwrap();
    let own = |key: &str| views.iter().find(|v| v.key == key).unwrap().own_files.clone();
    assert_eq!(own("local-mine"), [local]);
    assert!(own("hf-mine").is_empty() && own("ling").is_empty(), "Mango Code downloads them");
}

#[test]
fn a_choice_that_cannot_work_is_refused_when_saved() {
    let w = world(false);
    let e = choices::set_model(&w.paths, "ling", Choices { context: Some(0), ..Choices::default() }).unwrap_err().to_string();
    // the model is named as the user knows it, not by its key
    assert!(e.contains("«Ling-3.0-tiny»"), "{e}");
    assert!(choices::set_model(&w.paths, "no-such-model", Choices::default()).is_err());
    assert!(!w.paths.data.join(choices::FILE).exists(), "nothing was written");
}

// --- the computer ---------------------------------------------------------------------------------------------

#[test]
fn the_computer_lists_the_cards_the_disk_and_the_tailored_models() {
    let w = world(true);
    let hw = three_gpus();
    std::fs::write(w.paths.models.join("bytes.bin"), vec![0u8; 1234]).unwrap();
    with_unused(&w, &[GTX_1660_SUPER]);
    choices::set_small_models(&w.paths, SmallModels::All).unwrap();
    let c = computer_view(&w.paths, &hw).unwrap();
    assert_eq!(c.gpus.iter().map(|g| (g.name.as_str(), g.memory_mib, g.used, g.note.is_empty())).collect::<Vec<_>>(), [(RTX_3060_TI, 8192, true, true), (GTX_1080, 8192, true, true), (GTX_1660_SUPER, 6144, false, true)]);
    assert_eq!(c.small_models, SmallModels::All);
    assert_eq!((c.disk.path.as_path(), c.disk.used_bytes), (w.paths.models.as_path(), 1234));
    assert!(c.disk.free_bytes > 0, "free space of the disk read from Windows");
    assert_eq!(c.tailored.map(|t| t.models), Some(5), "3.6, 3.8, Bonsai 2, LFM and TOQ have a profile for these cards");
    // A folder that isn't there yet holds nothing and the disk is the one it will be on.
    let (_d, paths) = data_only();
    let c = computer_view(&paths, &hw).unwrap();
    assert_eq!(c.disk.used_bytes, 0);
    assert!(c.disk.free_bytes > 0);
    // A card the engine doesn't use (NVIDIA only with CUDA) says why and doesn't count as used.
    let mut hw = three_gpus();
    hw.gpus.push(other(3, "AMD Radeon RX 6600", Vendor::Amd, 8176));
    let c = computer_view(&paths, &hw).unwrap();
    assert!(!c.gpus[3].used && c.gpus[3].note.contains("NVIDIA"), "{:?}", c.gpus[3]);
}

/// The verdicts of the catalog's models in `recommended` follow the choices too: the fastest is not a model sent to
/// the processor.
#[test]
fn the_recommendations_follow_the_choices() {
    let w = world(false);
    let hw = three_gpus();
    let fastest = |w: &World| recommended(&w.paths, &hw).unwrap().into_iter().filter(|r| r.fastest).map(|r| r.model).collect::<Vec<_>>();
    assert_eq!(fastest(&w), ["ling"]);
    choose(&w, "ling", WhereChoice::Cpu);
    let r = recommended(&w.paths, &hw).unwrap();
    let ling = r.iter().find(|r| r.model == "ling").unwrap();
    assert_eq!(ling.placement, Some(Placement::Cpu));
    assert_ne!(fastest(&w), ["ling"], "on the processor it is no longer the fastest");
}

/// The models' lines and sampling values: the real catalog says what the app promises, and no line that depends on
/// the computer.
#[test]
fn the_catalog_lines_and_sampling_are_the_ones_approved() {
    let w = world(false);
    let views = models_view(&w.paths, &three_gpus()).unwrap();
    let about = |k: &str| views.iter().find(|v| v.key == k).unwrap().about.clone();
    let line = |it: &str, en: &str| (if lang() == Lang::It { it } else { en }).to_string();
    assert_eq!(about("3.6"), line("Il più capace. Legge anche le immagini.", "The most capable. Also reads images."));
    assert_eq!(about("3.8"), line("Denso, forte sul codice. Legge anche le immagini.", "Dense, strong at coding. Also reads images."));
    assert_eq!(about("bonsai2"), line("Pesi a tre valori: poca memoria, tanto contesto.", "Three-value weights: little memory, lots of context."));
    assert_eq!(about("ling"), line("Piccolo e veloce. Regge bene gli strumenti.", "Small and fast. Handles tools well."));
    assert_eq!(about("3.5-4b"), line("Leggero. Per domande semplici.", "Light. For simple questions."));
    assert_eq!(about("lfm"), line("Grande ma svelto.", "Large but quick."));
    assert_eq!(about("toq"), line("Sperimentale, solo su richiesta.", "Experimental, only on request."));
    assert_eq!(about("3.5-2b"), line("Il più piccolo. Per schede con poca memoria.", "The smallest. For cards with little memory."));
    let sampling = |temperature, top_p, top_k, min_p, presence_penalty, repeat_penalty| {
        Some(Sampling { temperature, top_p, top_k, min_p, presence_penalty, repeat_penalty })
    };
    let expected = [
        ("3.6", sampling(Some(1.0), Some(0.95), Some(20), Some(0.0), Some(1.5), Some(1.0))),
        ("3.8", sampling(Some(1.0), Some(0.95), Some(20), Some(0.0), Some(0.0), Some(1.0))),
        ("bonsai2", sampling(Some(1.0), Some(0.95), Some(20), Some(0.05), Some(0.0), Some(1.0))),
        ("toq", sampling(Some(1.0), Some(0.95), Some(20), Some(0.0), Some(0.0), Some(1.0))),
        ("lfm", sampling(Some(0.1), None, Some(50), None, None, Some(1.05))),
        ("ling", sampling(Some(1.0), Some(0.95), Some(20), None, None, None)),
        ("3.5-4b", sampling(Some(0.7), Some(0.8), Some(20), Some(0.0), Some(1.5), Some(1.0))),
        ("3.5-2b", sampling(Some(1.0), Some(1.0), Some(20), Some(0.0), Some(2.0), Some(1.0))),
    ];
    assert_eq!(views.len(), expected.len());
    for (key, sampling) in expected {
        assert_eq!(views.iter().find(|v| v.key == key).unwrap().sampling, sampling, "{key}");
    }
}

/// The style of the answers and the reasoning become fields of the requests: the catalog's own values, another
/// temperature for «precise» and «creative», nothing for a model the catalog says nothing about.
#[test]
fn the_style_and_the_reasoning_are_what_a_request_gets_when_it_does_not_say() {
    let w = world(false);
    let defaults = |key: &str| serde_json::Value::Object(choices::request_defaults(&w.paths, key).unwrap());
    assert_eq!(defaults("ling"), serde_json::json!({ "temperature": 1.0, "top_p": 0.95, "top_k": 20 }));
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Precise, reasoning: Some(false), ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling"), serde_json::json!({ "temperature": 0.3, "top_p": 0.95, "top_k": 20, "chat_template_kwargs": { "enable_thinking": false } }));
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Creative, reasoning: Some(true), ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling")["temperature"], serde_json::json!(1.1));
    assert_eq!(defaults("ling")["chat_template_kwargs"], serde_json::json!({ "enable_thinking": true }));
    // the choices of a model are its own
    assert_eq!(defaults("lfm"), serde_json::json!({ "temperature": 0.1, "top_k": 50, "repeat_penalty": 1.05 }));
    assert!(choices::request_defaults(&w.paths, "ghost").is_err());
}

/// «Precise» is 0.3, but never warmer than the catalog: a model made to answer at 0.1 stays at 0.1.
#[test]
fn precise_is_never_above_the_temperature_of_the_catalog() {
    let w = world(false);
    choices::set_model(&w.paths, "lfm", Choices { style: choices::Style::Precise, ..Choices::default() }).unwrap();
    assert_eq!(choices::request_defaults(&w.paths, "lfm").unwrap()["temperature"], serde_json::json!(0.1));
    choices::set_model(&w.paths, "lfm", Choices { style: choices::Style::Creative, ..Choices::default() }).unwrap();
    assert_eq!(choices::request_defaults(&w.paths, "lfm").unwrap()["temperature"], serde_json::json!(1.1));
}

/// A model of the user's has no values in the catalog: the recommended style adds nothing, the others their temperature.
#[test]
fn a_model_without_values_in_the_catalog_gets_only_what_the_user_chose() {
    // A catalog of its own, in a temporary folder: `data_only` reads the real one.
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("data") };
    std::fs::create_dir_all(&paths.dist).unwrap();
    std::fs::write(paths.dist.join("mango-models.json"), r#"{ "ctx": 8192, "default": "m", "order": ["m"], "models": { "m": { "label": "M", "gguf": "m.gguf" } } }"#).unwrap();
    assert!(choices::request_defaults(&paths, "m").unwrap().is_empty());
    choices::set_model(&paths, "m", Choices { style: choices::Style::Creative, ..Choices::default() }).unwrap();
    assert_eq!(serde_json::Value::Object(choices::request_defaults(&paths, "m").unwrap()), serde_json::json!({ "temperature": 1.1 }));
    // the catalog does not say it reasons: a reasoning chosen for it (left from an older catalog) adds nothing
    choices::set_model(&paths, "m", Choices { style: choices::Style::Precise, reasoning: Some(true), ..Choices::default() }).unwrap();
    assert_eq!(serde_json::Value::Object(choices::request_defaults(&paths, "m").unwrap()), serde_json::json!({ "temperature": 0.3 }));
}

// --- what the app tells about each model ----------------------------------------------------------------------

/// A model as the app lists it: its name, what a download brings, whether it is on disk and can be used, whether it
/// can reason; the computer names its engine.
#[test]
fn the_models_view_says_what_is_on_disk_and_what_a_download_brings() {
    let w = world(false);
    let hw = three_gpus();
    let v = view_of(&w, "3.6", &hw);
    assert_eq!((v.label.as_str(), v.images, v.user, v.present, v.on_request), ("Qwen3.6-35B-A3B", true, false, true, false));
    assert!(v.bytes > 10_000_000_000 && v.limits.reasoning, "{v:?}");
    assert!(view_of(&w, "toq", &hw).on_request);
    // Without its weights it is not there; without its engine neither.
    let file = load_models(&w.paths).unwrap();
    std::fs::remove_file(w.paths.models.join(model_cfg(&file, "ling").unwrap().gguf.unwrap())).unwrap();
    assert!(!view_of(&w, "ling", &hw).present);
    std::fs::remove_file(w.paths.engines.join("llamacpp").join("llama-server.exe")).unwrap();
    assert!(!view_of(&w, "3.5-4b", &hw).present);
    let c = computer_view(&w.paths, &hw).unwrap();
    assert_eq!((c.engine.label, c.engine.installed), (tr!("llama.cpp per le schede video", "llama.cpp for the graphics cards"), false));
}

/// A model whose weights are on the disk but whose engine is not: a download brings only the engine, and the size says
/// so. Without the weights it brings both.
#[test]
fn the_size_of_a_model_not_there_is_what_its_download_brings() {
    let w = world(false);
    let hw = three_gpus();
    std::fs::remove_file(w.paths.engines.join("llamacpp").join("llama-server.exe")).unwrap();
    let engine = mango_common::download::engine_size(&w.paths, "llamacpp", mango_common::Build::Cuda12).unwrap();
    assert!(engine > 0);
    let v = view_of(&w, "3.5-4b", &hw);
    assert_eq!((v.present, v.bytes), (false, engine), "the weights are there: only the engine arrives");

    let file = load_models(&w.paths).unwrap();
    std::fs::remove_file(w.paths.models.join(model_cfg(&file, "3.5-4b").unwrap().gguf.unwrap())).unwrap();
    let weights = view_of(&w, "3.5-4b", &hw).bytes - engine;
    assert!(weights > 1_000_000_000, "{weights}");
}

fn listed(key: &str, placement: Option<Placement>, present: bool) -> view::ModelView {
    view::ModelView {
        key: key.into(),
        label: key.into(),
        about: String::new(),
        images: false,
        user: false,
        own_files: vec![],
        present,
        waits_engine: false,
        bytes: 1,
        sampling: None,
        verdict: Verdict { fits: placement.is_some(), place: placement.map(|placement| Where { placement, gpus: vec![], context: 4096 }), reason: String::new(), speed: None, fastest: false, estimated: false },
        recommended: false,
        on_request: false,
        limits: Limits { places: vec![], context: vec![], reasoning: false },
        tailored: false,
        choices: Choices::default(),
    }
}

fn proposed(mut views: Vec<view::ModelView>, fallback: &[bool]) -> Vec<String> {
    view::mark_recommended(&mut views, fallback);
    views.into_iter().filter(|v| v.recommended).map(|v| v.key).collect()
}

/// The model to propose to whoever has none: the first of ours that fits and is not on disk yet, on the cards if one
/// fits there; never a model of the user's or one on request; the one for small cards only when nothing else fits on
/// the cards.
#[test]
fn the_model_to_propose_is_the_first_that_fits_and_is_not_on_disk_on_the_cards_if_it_can() {
    use Placement::{Cpu, Gpu};
    let none = [false; 4];
    assert_eq!(proposed(vec![listed("huge", None, false), listed("a", Some(Gpu), false), listed("b", Some(Gpu), false)], &none), ["a"]);
    assert_eq!(proposed(vec![listed("a", Some(Gpu), true), listed("b", Some(Gpu), false)], &none), ["b"], "the one on disk is not proposed again");
    assert_eq!(proposed(vec![listed("slow", Some(Cpu), false), listed("b", Some(Gpu), false)], &none), ["b"], "on the cards before the processor");
    assert_eq!(proposed(vec![listed("slow", Some(Cpu), false), listed("huge", None, false)], &none), ["slow"]);
    assert!(proposed(vec![listed("a", Some(Gpu), true), listed("huge", None, false)], &none).is_empty());

    let mut user = listed("mine", Some(Gpu), false);
    user.user = true;
    let mut asked = listed("toq", Some(Gpu), false);
    asked.on_request = true;
    assert_eq!(proposed(vec![user, asked, listed("b", Some(Gpu), false)], &none), ["b"]);

    // The model for small cards: not while another fits on the cards (even one already on disk), yes when none does.
    let small = [true, false, false, false];
    assert_eq!(proposed(vec![listed("tiny", Some(Gpu), false), listed("big", Some(Gpu), true), listed("slow", Some(Cpu), false)], &small), ["slow"]);
    assert_eq!(proposed(vec![listed("tiny", Some(Gpu), false), listed("big", None, false), listed("slow", Some(Cpu), false)], &small), ["tiny"]);
}

/// After a start that failed: the model to propose is one on the disk that fits now, the default first, never the one that
/// failed, the one in use, one only on request or one for small cards.
#[test]
fn after_a_failed_start_a_model_that_fits_now_is_proposed() {
    let w = world(false);
    let hw = three_gpus();
    let proposed = |failed: &str, default: &str, in_use: Option<&str>| {
        view::after_failure(&w.paths, &hw, &[], failed, Some(default), in_use).unwrap().proposal.map(|p| p.key)
    };
    assert_eq!(proposed("3.5-4b", "3.6", None).as_deref(), Some("3.6"), "the default fits");
    assert_eq!(proposed("3.6", "3.6", None).as_deref(), Some("3.8"), "never the model that failed: the first in the catalog");
    assert_eq!(proposed("ling", "3.6", Some("3.6")).as_deref(), Some("3.8"), "never the model already in use");
    assert_eq!(proposed("3.5-4b", "toq", None).as_deref(), Some("3.6"), "never one only on request, also as the default");
    assert_eq!(proposed("3.5-4b", "3.5-2b", None).as_deref(), Some("3.6"), "never the one for small cards");

    // Only a model on the disk is proposed.
    let file = load_models(&w.paths).unwrap();
    std::fs::remove_file(w.paths.models.join(model_cfg(&file, "3.6").unwrap().gguf.unwrap())).unwrap();
    assert_eq!(proposed("3.5-4b", "3.6", None).as_deref(), Some("3.8"));
}

/// Another program holds 7000 MiB of the 3060 Ti, the card of the 4B (what Windows takes, 1100, is not counted). If the 4B
/// still fits, on another card or with less context, the failure has another cause: nothing is said. If it does not fit
/// at all (it may run only on that card), the sentence says which card is taken, and how much is in use there.
#[test]
fn after_a_failed_start_the_card_another_program_holds_is_named_only_if_the_model_does_not_fit_now() {
    let w = world(false);
    let hw = three_gpus();
    let taken = [(0, 7000, 8192), (1, 900, 8192)];
    let still_fits = view::after_failure(&w.paths, &hw, &taken, "3.5-4b", Some("3.6"), None).unwrap();
    assert_eq!(still_fits.taken, None, "it fits on another card");

    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec!["NVIDIA GeForce RTX 3060 Ti".into()], ..Choices::default() }).unwrap();
    // The memory in use on the card, as before a start (`taken_before_start`): the same case, the same number.
    let six_eight = if lang() == Lang::It { "6,8" } else { "6.8" };
    assert_eq!(
        view::after_failure(&w.paths, &hw, &taken, "3.5-4b", Some("3.6"), None).unwrap().taken,
        Some(tr!(
            "Sulla NVIDIA GeForce RTX 3060 Ti un altro programma sta usando {six_eight} GB: per questo modello non resta abbastanza memoria.",
            "On the NVIDIA GeForce RTX 3060 Ti another program is using {six_eight} GB: there is not enough memory left for this model."
        ))
    );
    // What a large desktop may take (under 1 GiB more than the reserve) is not another program.
    assert_eq!(view::after_failure(&w.paths, &hw, &[(0, 2000, 8192)], "3.5-4b", Some("3.6"), None).unwrap().taken, None);
}

// --- room beside the other programs, before a start -------------------------------------------------------

/// The cards as NVML reads them with no model of Mango Code on them: the desktop on the 3060 Ti, nothing on the others.
fn desktop_only() -> Vec<(u32, u64, u64)> {
    vec![(0, 345, 8192), (1, 0, 8192), (2, 0, 6144)]
}

fn with_used(card: u32, mib: u64) -> Vec<(u32, u64, u64)> {
    desktop_only().into_iter().map(|u| if u.0 == card { (u.0, mib, u.2) } else { u }).collect()
}

fn gb(text: &str) -> String {
    if lang() == Lang::It { text.replace('.', ",") } else { text.to_string() }
}

/// Qwen3.6 on the three cards has a setup measured with them free (`-ts`, the margin is small): another program that holds
/// 4.8 GB of the GTX 1080 leaves no room for it, and the sentence says which card and how much is in use there. The desktop
/// on the main card, a large desktop under 1 GiB over the reserve, a measure that is missing and a card lent to another job
/// do not keep it from starting.
#[test]
fn a_measured_setup_does_not_start_where_another_program_holds_one_of_its_cards() {
    let w = world(true);
    let hw = three_gpus();
    let taken = |used: &[(u32, u64, u64)], lent: &[u32]| taken_before_start(&w.paths, &hw, used, "3.6", lent).unwrap();

    let r26 = taken(&with_used(1, 4915), &[]).expect("the GTX 1080 is taken");
    assert_eq!(r26.cards, [1]);
    assert_eq!(
        r26.sentence,
        tr!(
            "Sulla NVIDIA GeForce GTX 1080 un altro programma sta usando {}: per questo modello non resta abbastanza memoria.",
            "On the NVIDIA GeForce GTX 1080 another program is using {}: there is not enough memory left for this model.",
            gb("4.8 GB")
        )
    );
    let two = taken(&[(0, 345, 8192), (1, 4915, 8192), (2, 3000, 6144)], &[]).unwrap();
    assert_eq!(two.cards, [1, 2]);
    assert!(two.sentence.contains(&tr!(", sulla NVIDIA GeForce GTX 1660 SUPER {}", ", on the NVIDIA GeForce GTX 1660 SUPER {}", gb("2.9 GB"))), "{}", two.sentence);

    assert_eq!(taken(&desktop_only(), &[]), None, "the desktop");
    assert_eq!(taken(&with_used(0, 2000), &[]), None, "a large desktop: 900 MiB over the reserve");
    assert_eq!(taken(&[], &[]), None, "nothing read: it starts as before");
    assert_eq!(taken(&with_used(1, 4915), &[1]), None, "a card lent to another job is held by that job");
}

/// A plan computed from the memory (official llama.cpp, on one card here) starts as long as what the other programs leave
/// gives the same plan: the same card, the same context. Qwen3.5-2B has its whole context with room to spare and starts
/// beside 1.1 GB over the reserve; Qwen3.5-4B fills the card, would get less context, and does not start. Neither starts
/// when it would need another card, and a card they do not use is not looked at.
#[test]
fn a_computed_plan_starts_while_the_memory_left_gives_the_same_plan() {
    let w = world(false);
    let hw = three_gpus();
    let taken = |key: &str, used: &[(u32, u64, u64)]| taken_before_start(&w.paths, &hw, used, key, &[]).unwrap();
    for key in ["3.5-2b", "3.5-4b"] {
        assert_eq!(cards(&plan(&w, key, &hw).unwrap()), [RTX_3060_TI], "{key}");
        assert_eq!(taken(key, &with_used(1, 7000)), None, "{key}: another card");
        let full = taken(key, &with_used(0, 7000)).expect("the 3060 Ti is taken");
        assert_eq!(full.cards, [0]);
        assert!(full.sentence.contains("NVIDIA GeForce RTX 3060 Ti") && full.sentence.contains(&gb("6.8 GB")), "{}", full.sentence);
    }
    assert_eq!(taken("3.5-2b", &with_used(0, 2200)), None, "the 2B keeps its context");
    assert_eq!(taken("3.5-4b", &with_used(0, 2200)).map(|t| t.cards), Some(vec![0]), "the 4B would get less context");
}

/// After a start that failed while another program holds the GTX 1080, the model proposed fits beside it: not a setup
/// measured with the three cards free, which would not start either.
#[test]
fn after_a_failed_start_the_model_proposed_fits_beside_the_other_programs() {
    let w = world(true);
    let hw = three_gpus();
    let proposed = |used: &[(u32, u64, u64)]| view::after_failure(&w.paths, &hw, used, "3.6", Some("3.6"), None).unwrap().proposal.map(|p| p.key);
    let free = proposed(&desktop_only()).unwrap();
    assert!(view_of(&w, &free, &hw).tailored, "with the cards free the first that fits is a measured setup: {free}");
    let beside = proposed(&with_used(1, 4915)).unwrap();
    assert_ne!(beside, free);
    assert_eq!(taken_before_start(&w.paths, &hw, &with_used(1, 4915), &beside, &[]).unwrap(), None, "{beside} starts");
}

/// With the GTX 1080 lent to another job, the plan of Bonsai-2 (computed from the memory, on two cards) moves to the 3060 Ti
/// and the 1660 SUPER: another program on the 1660 SUPER takes memory it counts on, although with every card free the plan
/// would not use it.
#[test]
fn a_card_lent_to_another_job_is_out_of_the_plan_that_is_looked_at() {
    let w = world(false);
    let hw = three_gpus();
    assert_eq!(cards(&plan_for(&w.paths, Some("bonsai2"), 8080, &hw, &[1]).unwrap()), [RTX_3060_TI, GTX_1660_SUPER]);
    assert_eq!(cards(&plan(&w, "bonsai2", &hw).unwrap()), [RTX_3060_TI, GTX_1080]);
    let used = with_used(2, 3500);
    assert_eq!(taken_before_start(&w.paths, &hw, &used, "bonsai2", &[1]).unwrap().map(|t| t.cards), Some(vec![2]));
    assert_eq!(taken_before_start(&w.paths, &hw, &used, "bonsai2", &[]).unwrap(), None, "with the 1080 back the 1660 SUPER is not used");
}
