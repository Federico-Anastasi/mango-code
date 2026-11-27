//! The user's choices in the plan and in the verdict (`choices.rs`, `general.rs`, `view.rs`), on the real catalog and
//! the real profiles with the fake hardware of `mango_common`'s fixtures: the three-card PC of the tests (RTX 3060 Ti,
//! GTX 1080, GTX 1660 SUPER), Vulkan cards, and the PC of issue 2.

use super::*;
use crate::choices::{Choices, SmallModels, Style, WhereChoice};
use crate::hardware::fixture::*;
use crate::view::{models_view, GpuView};
use mango_common::catalog::Sampling;
use mango_common::Build;
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
        choices::set_gpu_used(&w.paths, &three_gpus(), n, false).unwrap();
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

/// Two identical cards are chosen and left out one by one; a name alone, as an older file may hold it, names both.
#[test]
fn identical_cards_are_chosen_and_left_out_one_by_one() {
    const TWIN_1: &str = "NVIDIA GeForce RTX 3060 #1";
    const TWIN_2: &str = "NVIDIA GeForce RTX 3060 #2";
    let w = world(false);
    let hw = twin_gpus();
    let names = |w: &World| computer_view(&w.paths, &hw).unwrap().gpus.into_iter().map(|g| (g.name, g.used)).collect::<Vec<_>>();
    choices::set_gpu_used(&w.paths, &hw, TWIN_2, false).unwrap();
    assert_eq!(names(&w), [(TWIN_1.to_string(), true), (GTX_1080.to_string(), true), (TWIN_2.to_string(), false)]);
    choose(&w, "3.5-4b", WhereChoice::All);
    assert_eq!(visible_cards(&plan(&w, "3.5-4b", &hw).unwrap()), "0,1", "the twin left out is not used");
    choices::set_gpu_used(&w.paths, &hw, TWIN_2, true).unwrap();
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![TWIN_2.into()], ..Choices::default() }).unwrap();
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert_eq!(visible_cards(&p), "2", "the second twin alone");
    assert_eq!(view_of(&w, "3.5-4b", &hw).verdict.place.unwrap().gpus, [TWIN_2]);

    // the name alone leaves out both; turning one on keeps the other out
    with_unused(&w, &["NVIDIA GeForce RTX 3060"]);
    assert_eq!(names(&w), [(TWIN_1.to_string(), false), (GTX_1080.to_string(), true), (TWIN_2.to_string(), false)]);
    choices::set_gpu_used(&w.paths, &hw, TWIN_1, true).unwrap();
    assert_eq!(choices::read(&w.paths).unwrap().computer.unused_gpus, [TWIN_2]);
}

/// One of two identical cards taken out of the PC: the card left now has the plain name, and a twin left out by its
/// number names nothing. If it was the one left, it is in use again: Computer says so, and the choice comes back with
/// the card.
#[test]
fn a_twin_left_out_and_then_taken_out_of_the_pc_is_told() {
    const TWIN_1: &str = "NVIDIA GeForce RTX 3060 #1";
    let w = world(false);
    choices::set_gpu_used(&w.paths, &twin_gpus(), TWIN_1, false).unwrap();
    let one = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060", 12288, (8, 6), (12, 6)), nvidia(1, GTX_1080, 8192, (6, 1), (12, 6))], 65_536);
    let view = computer_view(&w.paths, &one).unwrap();
    assert_eq!(view.gone, [TWIN_1]);
    assert!(view.gpus[0].used, "the card is in use, and Computer says why");
    assert!(computer_view(&w.paths, &twin_gpus()).unwrap().gone.is_empty(), "with both cards back nothing is missing");
    let no_twin = pc(vec![nvidia(0, GTX_1080, 8192, (6, 1), (12, 6))], 65_536);
    assert!(computer_view(&w.paths, &no_twin).unwrap().gone.is_empty(), "no card of that name: nothing runs in its place");
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
    choices::set_gpu_used(&w.paths, &three_gpus(), GTX_1080, true).unwrap();
    choices::set_gpu_used(&w.paths, &three_gpus(), RTX_3060_TI, true).unwrap();
    assert_eq!(visible_cards(&plan(&w, "bonsai2", &hw).unwrap()), "0,1");
    assert!(choices::read(&w.paths).unwrap().computer.unused_gpus.is_empty());
}

/// A setup tailored to the PC that needs a card the user left out gives way: the model runs with the general plan on
/// the cards left (here the processor, where Qwen3.6 does not fit two cards), Bonsai 2 opens its general engine's file,
/// TOQ takes its profile for every PC with this build, and the verdict says why in its first sentence. The Computer page
/// no longer counts those setups. A card lent to another job keeps its sentence.
#[test]
fn a_tailored_setup_that_needs_a_card_left_out_gives_way_to_the_general_plan_and_says_why() {
    let w = world(true);
    let hw = three_gpus();
    assert!(plan(&w, "3.6", &hw).unwrap().spec.exe.starts_with(w.paths.engines.join("prism")));
    let before = computer_view(&w.paths, &hw).unwrap().tailored.map(|t| t.models);
    with_unused(&w, &[GTX_1660_SUPER]);
    let p = plan(&w, "3.6", &hw).unwrap();
    assert!(p.spec.exe.starts_with(w.paths.engines.join("llamacpp")) && !cards(&p).contains(&GTX_1660_SUPER), "{:?}", p.spec);
    let v = view_of(&w, "3.6", &hw);
    let why = tr!("che hai segnato come non usata", "which you marked as not used");
    assert!(v.verdict.fits && v.verdict.reason.contains(GTX_1660_SUPER) && v.verdict.reason.contains(&why), "{:?}", v.verdict);
    assert!(!v.tailored, "the tailored setup does not apply while its card is left out");
    assert!(plan(&w, "bonsai2", &hw).unwrap().gguf.ends_with("Ternary-Bonsai-2-27B-Q2_0.gguf"));
    let toq = view_of(&w, "toq", &hw).verdict;
    assert!(toq.fits && !toq.place.unwrap().gpus.iter().any(|g| g == GTX_1660_SUPER), "TOQ takes its profile for every PC with this build");
    let after = computer_view(&w.paths, &hw).unwrap().tailored.map(|t| t.models);
    assert!(after < before, "{before:?} -> {after:?}");
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

    // More than fits: the most that fits.
    for asked in [200_000, 262_144] {
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

/// Nothing caps the context of the automatic choice but what the model holds and what the memory carries.
#[test]
fn the_automatic_context_reaches_the_models_maximum_when_it_fits() {
    let w = world(false);
    let big = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_576, (8, 9), (12, 6))], 65_536);
    assert_eq!(plan(&w, "3.5-4b", &big).unwrap().ctx, 262_144);
    assert_eq!(view_of(&w, "3.5-4b", &big).limits.context, [32_768, 65_536, 131_072, 262_144]);
    // a model whose own maximum is lower keeps it
    assert_eq!(plan(&w, "ling", &big).unwrap().ctx, 131_072);
    assert_eq!(view_of(&w, "ling", &big).limits.context, [32_768, 65_536, 131_072]);
}

/// A context between the steps (typed, or reached with the plus) is the context of the plan, exactly.
#[test]
fn a_personal_context_is_the_one_of_the_plan() {
    let w = world(false);
    let hw = three_gpus();
    choices::set_model(&w.paths, "3.5-4b", Choices { context: Some(100_000), ..Choices::default() }).unwrap();
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert_eq!(p.ctx, 100_000);
    assert!(has(&p.spec.args, ["-c", "100000"]), "{:?}", p.spec.args);
    let v = view_of(&w, "3.5-4b", &hw);
    assert_eq!(v.verdict.place.unwrap().context, 100_000);
    assert_eq!(v.limits.context, [32_768, 65_536, 126_976], "the steps offered don't follow the choice");
    assert_eq!(v.choices.context, Some(100_000));
}

/// Under the minimum, or over what the model holds, a choice is refused with a sentence and nothing is saved.
#[test]
fn a_context_under_the_minimum_or_over_the_models_maximum_is_refused() {
    let w = world(false);
    let ask = |key: &str, context| choices::set_model(&w.paths, key, Choices { context: Some(context), ..Choices::default() });
    let under = ask("3.5-4b", 32_767).unwrap_err().to_string();
    assert!(under.contains(&tr!("Almeno 32K token: con meno l'agente non ha spazio per lavorare.", "At least 32K tokens: with less the agent has no room to work.")), "{under}");
    let over = ask("ling", 131_073).unwrap_err().to_string();
    assert!(over.contains(&tr!("regge al massimo 128K token di contesto", "holds at most 128K tokens of context")), "{over}");
    assert!(ask("3.5-4b", 262_145).is_err());
    assert!(!w.paths.data.join(choices::FILE).exists(), "a refused choice leaves nothing behind");
    // the limits themselves are valid
    ask("3.5-4b", 32_768).unwrap();
    ask("3.5-4b", 262_144).unwrap();
    ask("ling", 131_072).unwrap();
}

/// A saved context larger than what the cards now hold is kept as chosen: the plan takes what fits, the view says both.
#[test]
fn a_saved_context_larger_than_the_new_hardware_holds_is_kept_and_the_effective_one_is_shown() {
    let w = world(false);
    write_choices(&w, r#"{ "models": { "3.5-4b": { "context": 262144 } } }"#);
    let small = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3050", 7000, (8, 6), (12, 6))], 16_384);
    let p = plan(&w, "3.5-4b", &small).unwrap();
    assert!((32_768..262_144).contains(&p.ctx), "{}", p.ctx);
    let v = view_of(&w, "3.5-4b", &small);
    assert_eq!((v.choices.context, v.verdict.place.unwrap().context), (Some(262_144), p.ctx));
    assert_eq!(*v.limits.context.last().unwrap(), p.ctx, "the largest offered is what fits, not the choice");
}

// --- the PC of issue 2 ----------------------------------------------------------------------------------------

/// One card alone, as a laptop's GeForce: «all the cards» would be that card, so a model chooses only between automatic
/// and the processor.
#[test]
fn with_one_card_a_model_does_not_offer_all_the_cards() {
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce GTX 1650", 4096, (7, 5), (12, 4))], 16_384);
    let w = world(false);
    assert_eq!(view_of(&w, "ling", &hw).limits.places, [WhereChoice::Auto, WhereChoice::Cpu]);
    assert_eq!(view_of(&w, "3.5-2b", &hw).limits.places, [WhereChoice::Auto, WhereChoice::Cpu]);
}

/// Issue #2: a GeForce GT 710 of 2 GB (read from DXGI, without CUDA), Core Ultra 5 245K with 14 cores and 16 GB of RAM:
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
    assert_eq!(v.limits.places, [WhereChoice::Auto, WhereChoice::All, WhereChoice::Cpu, WhereChoice::Pick], "the choice saved stays shown");
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
                    choices::set_gpu_used(paths, &three_gpus(), &format!("card {i}"), i % 2 == 1).unwrap();
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
    assert_eq!(v.limits.places, [WhereChoice::Auto, WhereChoice::Cpu], "the processor, and Automatic, which was chosen");
    // The sentence asks to use the card again or to leave all of them out: every switch does one or the other.
    let c = computer_view(&w.paths, &hw).unwrap();
    assert!(c.gpus.iter().all(|g| g.note.is_empty()), "{:?}", c.gpus);
    assert_eq!(c.gpus.iter().map(|g| g.used).collect::<Vec<_>>(), [true, false]);
    choices::set_gpu_used(&w.paths, &hw, "AMD Radeon RX 6800", true).unwrap();
    let note = tr!("Con il motore di questo computer non si può escludere una scheda sola.", "With this computer's engine a single card can't be left out.");
    assert!(computer_view(&w.paths, &hw).unwrap().gpus.iter().all(|g| g.note == note && g.used));
    with_unused(&w, &["AMD Radeon RX 6800"]);

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
        assert!(choices::set_gpu_used(&paths, &three_gpus(), "A", false).is_err() && choices::set_default(&paths, Some("ling")).is_err());
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

/// A model's harness is one built into the agent or one the user made: the choice is kept, a name that is neither is
/// refused, and the default harness is not written.
#[test]
fn a_model_takes_a_harness_that_is_there() {
    let w = world(false);
    let mine = w.paths.data.join("harness").join("mine");
    std::fs::create_dir_all(&mine).unwrap();
    std::fs::write(mine.join("harness.json"), "{}").unwrap();
    for chosen in ["mango-harness-2", "mine"] {
        choices::set_model(&w.paths, "ling", Choices { harness: Some(chosen.into()), ..Choices::default() }).unwrap();
        assert_eq!(choices::read(&w.paths).unwrap().models["ling"].harness.as_deref(), Some(chosen));
    }
    let err = choices::set_model(&w.paths, "ling", Choices { harness: Some("gone".into()), ..Choices::default() }).unwrap_err();
    assert!(err.to_string().contains("gone"), "{err}");
    assert_eq!(choices::read(&w.paths).unwrap().models["ling"].harness.as_deref(), Some("mine"), "a refused choice changes nothing");
    choices::set_model(&w.paths, "ling", Choices::default()).unwrap();
    assert!(!std::fs::read_to_string(w.paths.data.join(choices::FILE)).unwrap().contains("harness"));
}

/// What is written is read back, and only the models whose choices differ from the standard ones are in the file.
#[test]
fn what_is_written_is_read_back_and_only_the_differences_are_kept() {
    let w = world(false);
    let mut mine = Choices { place: WhereChoice::Pick, gpus: vec![GTX_1080.into()], context: Some(65_536), style: choices::Style::Creative, reasoning: Some("off".into()), sampling: Sampling { temperature: Some(0.4), top_k: Some(10), ..Sampling::default() }, harness: None };
    choices::set_model(&w.paths, "ling", mine.clone()).unwrap();
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Cpu, ..Choices::default() }).unwrap();
    choices::set_default(&w.paths, Some("ling")).unwrap();
    choices::set_gpu_used(&w.paths, &three_gpus(), GTX_1660_SUPER, false).unwrap();
    choices::set_gpu_used(&w.paths, &three_gpus(), GTX_1660_SUPER, false).unwrap();
    choices::set_gpu_used(&w.paths, &three_gpus(), GTX_1080, false).unwrap();
    choices::set_gpu_used(&w.paths, &three_gpus(), GTX_1080, true).unwrap();
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

/// A model of the user's from a file on the computer names that file among its own: «Remove» leaves it. The files Mango
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

/// A file of the user's that became a Mango Code model's own (the catalog that came with the app has it): what was chosen
/// for it is written under the model's key, so that the agent, which reads the file by the model's key, finds it too.
#[test]
fn the_choices_of_a_file_that_became_a_catalog_model_move_under_its_key() {
    let w = world(false);
    let file = load_models(&w.paths).unwrap();
    let ling = &file.models["ling"];
    let name = |path: &str| path.rsplit(['/', '\\']).next().unwrap().to_string();
    let files: Vec<serde_json::Value> = ling["files"].as_array().unwrap().iter().filter(|f| f.get("engine").is_none()).map(|f| {
        serde_json::json!({ "path": format!("C:\\mine\\{}",name(f["path"].as_str().unwrap())), "size": f["size"] })
    }).collect();
    let gguf = files[0]["path"].clone();
    let list = serde_json::json!({ "models": { "local-ling": { "label": "mine", "gguf": gguf, "origin": "local", "files": files } } });
    std::fs::create_dir_all(&w.paths.data).unwrap();
    std::fs::write(w.paths.data.join(mango_common::catalog::USER_FILE), list.to_string()).unwrap();
    let saved = serde_json::json!({ "default": "local-ling", "models": { "local-ling": { "harness": "mango-harness-2" } } });
    std::fs::write(w.paths.data.join("choices.json"), saved.to_string()).unwrap();

    choices::settle_keys(&w.paths).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(w.paths.data.join("choices.json")).unwrap()).unwrap();
    assert_eq!(raw["models"]["ling"]["harness"], "mango-harness-2", "{raw}");
    assert!(raw["models"].get("local-ling").is_none() && raw["default"] == "ling", "{raw}");

    let before = std::fs::metadata(w.paths.data.join("choices.json")).unwrap().modified().unwrap();
    choices::settle_keys(&w.paths).unwrap();
    assert_eq!(std::fs::metadata(w.paths.data.join("choices.json")).unwrap().modified().unwrap(), before, "nothing to move: not written");
}

/// A model whose downloaded files the user put in another folder says which one; the others say nothing.
#[test]
fn a_model_moved_to_another_folder_says_where() {
    let w = world(false);
    let file = load_models(&w.paths).unwrap();
    let gguf = model_cfg(&file, "ling").unwrap().gguf.unwrap();
    let fast = w._dir.path().join("fast disk");
    touch(&fast.join("ling.gguf"));
    mango_common::model_files::update(&w.paths.data, |all| {
        drop(all.insert(gguf, mango_common::model_files::Place { at: fast.join("ling.gguf"), own: true }))
    })
    .unwrap();

    let views = models_view(&w.paths, &three_gpus()).unwrap();
    let placed = |key: &str| views.iter().find(|v| v.key == key).unwrap().placed_in.clone();
    assert_eq!(placed("ling"), Some(fast.display().to_string()));
    assert_eq!(placed("3.5-4b"), None);
    assert!(views.iter().find(|v| v.key == "ling").unwrap().own_files.is_empty(), "Mango Code's own file, not the user's");
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
    assert_eq!(c.tailored, None, "no setup tailored to these cards applies while one of them is left out");
    choices::set_gpu_used(&w.paths, &hw, GTX_1660_SUPER, true).unwrap();
    let c = computer_view(&w.paths, &hw).unwrap();
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
    // Integrated graphics with memory from the BIOS is not a card, and the list says so.
    hw.gpus.push(other(4, "AMD Radeon(TM) Graphics", Vendor::Amd, 4096));
    let c = computer_view(&paths, &hw).unwrap();
    assert!(!c.gpus[4].used && c.gpus[4].note.contains(&tr!("grafica integrata", "integrated graphics")), "{:?}", c.gpus[4]);
    // Integrated graphics that would borrow the RAM, beside dedicated cards: off, with why, and its switch changes nothing.
    hw.gpus.push(integrated(5, "Intel(R) UHD Graphics 630", 128, 32_000));
    let c = computer_view(&paths, &hw).unwrap();
    assert!(!c.gpus[5].used && c.gpus[5].shared && c.gpus[5].note.contains(&tr!("dedicata", "dedicated")), "{:?}", c.gpus[5]);
    assert_eq!(c.gpus[5].memory_mib, 0, "no memory the models can use is shown");
    // Alone, it shows the memory it may borrow, and its switch is the choice on the integrated graphics, off at first.
    let w = world(false);
    let mut hw = pc(vec![integrated(0, "AMD Radeon(TM) Graphics", 512, 7_700)], 15_700);
    let row = |hw: &Hardware| computer_view(&w.paths, hw).unwrap().gpus.remove(0);
    assert_eq!(row(&hw), GpuView { name: "AMD Radeon(TM) Graphics".into(), memory_mib: 7_700 - 1024, shared: true, used: false, note: String::new() });
    choices::set_gpu_used(&w.paths, &hw, "AMD Radeon(TM) Graphics", true).unwrap();
    let saved = choices::read(&w.paths).unwrap().computer;
    assert!(saved.integrated && saved.unused_gpus.is_empty(), "{saved:?}");
    hw.integrated = saved.integrated;
    assert!(row(&hw).used);
    // Integrated graphics with the memory of a card is listed as the card it is, and can be left out like one.
    let hw = pc(vec![other(0, "AMD Radeon(TM) 8060S Graphics", Vendor::Amd, 65_536)], 63_000);
    let c = computer_view(&paths, &hw).unwrap();
    assert_eq!((c.gpus[0].used, c.gpus[0].note.as_str()), (true, ""));
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

/// Gives the model `key` of the world a GGUF whose chat template is `template`.
fn give_template(w: &World, key: &str, template: &str) {
    let file = load_models(&w.paths).unwrap();
    let cfg = model_cfg(&file, key).unwrap();
    crate::fixtures::write_gguf_with_template(&w.paths.models.join(cfg.gguf.unwrap()), template);
}

/// The style of the answers and the reasoning become fields of the requests: the catalog's own values, another
/// temperature for «precise» and «creative», the reasoning of the past turns kept in the history for every model, and the
/// level the user chose under the name the model's template reads.
#[test]
fn the_style_and_the_reasoning_are_what_a_request_gets_when_it_does_not_say() {
    let w = world(false);
    give_template(&w, "ling", crate::fixtures::SWITCH_TEMPLATE);
    give_template(&w, "3.8", crate::fixtures::EFFORT_TEMPLATE);
    let defaults = |key: &str| serde_json::Value::Object(choices::request_defaults(&w.paths, key).unwrap());
    let kept = serde_json::json!({ "preserve_thinking": true });
    assert_eq!(defaults("ling"), serde_json::json!({ "temperature": 1.0, "top_p": 0.95, "top_k": 20, "chat_template_kwargs": kept }));
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Precise, reasoning: Some("off".into()), ..Choices::default() }).unwrap();
    assert_eq!(
        defaults("ling"),
        serde_json::json!({ "temperature": 0.3, "top_p": 0.95, "top_k": 20, "chat_template_kwargs": { "preserve_thinking": true, "enable_thinking": false } })
    );
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Creative, reasoning: Some("on".into()), ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling")["temperature"], serde_json::json!(1.1));
    assert_eq!(defaults("ling")["chat_template_kwargs"], serde_json::json!({ "preserve_thinking": true, "enable_thinking": true }));
    // a model with levels: `reasoning_effort`, and `high` is what its template calls the highest
    for (chosen, sent) in [("low", "low"), ("medium", "medium"), ("high", "xhigh")] {
        choices::set_model(&w.paths, "3.8", Choices { reasoning: Some(chosen.into()), ..Choices::default() }).unwrap();
        assert_eq!(defaults("3.8")["chat_template_kwargs"], serde_json::json!({ "preserve_thinking": true, "reasoning_effort": sent }), "{chosen}");
    }
    // the choices of a model are its own; one whose template offers nothing gets only the reasoning of the past turns
    assert_eq!(defaults("lfm"), serde_json::json!({ "temperature": 0.1, "top_k": 50, "repeat_penalty": 1.05, "chat_template_kwargs": kept }));
    assert!(choices::request_defaults(&w.paths, "ghost").is_err());
}

/// A choice saved before the levels is a boolean: it is read as on or off, becomes a string at the next write, and
/// means the highest or the lowest level to a model that has levels.
#[test]
fn a_choice_of_reasoning_saved_as_a_boolean_is_read_and_written_as_a_string() {
    let w = world(false);
    give_template(&w, "ling", crate::fixtures::SWITCH_TEMPLATE);
    give_template(&w, "3.8", crate::fixtures::EFFORT_TEMPLATE);
    write_choices(&w, r#"{ "models": { "ling": { "reasoning": false }, "3.8": { "reasoning": true }, "3.6": { "reasoning": null } } }"#);
    let read = choices::read(&w.paths).unwrap();
    assert_eq!((read.models["ling"].reasoning.as_deref(), read.models["3.8"].reasoning.as_deref(), read.models["3.6"].reasoning.as_deref()), (Some("off"), Some("on"), None));
    let kwargs = |key: &str| choices::request_defaults(&w.paths, key).unwrap()["chat_template_kwargs"].clone();
    assert_eq!(kwargs("ling"), serde_json::json!({ "preserve_thinking": true, "enable_thinking": false }));
    assert_eq!(kwargs("3.8"), serde_json::json!({ "preserve_thinking": true, "reasoning_effort": "xhigh" }));
    let hw = three_gpus();
    assert_eq!(view_of(&w, "3.8", &hw).choices.reasoning.as_deref(), Some("high"), "the view says a level the model has");
    assert_eq!(view_of(&w, "ling", &hw).choices.reasoning.as_deref(), Some("off"));
    // the next write
    choices::set_default(&w.paths, Some("ling")).unwrap();
    let text = std::fs::read_to_string(w.paths.data.join(choices::FILE)).unwrap();
    assert!(text.contains(r#""reasoning": "off""#) && text.contains(r#""reasoning": "on""#) && !text.contains(r#""reasoning": false"#) && !text.contains(r#""reasoning": true"#), "{text}");
    // a name that is not a level is not a choice
    write_choices(&w, r#"{ "models": { "ling": { "reasoning": "maximum" } } }"#);
    assert!(choices::read(&w.paths).unwrap_err().to_string().contains(&tr!("Le tue scelte salvate non sono valide", "Your saved choices are not valid")));
}

/// A choice the model's template does not offer (a level a model that only has a switch does not know, a choice left from
/// another model) is not sent, and the view does not show it.
#[test]
fn a_choice_the_template_does_not_offer_is_not_sent() {
    let w = world(false);
    give_template(&w, "ling", crate::fixtures::SWITCH_TEMPLATE);
    choices::set_model(&w.paths, "ling", Choices { reasoning: Some("medium".into()), ..Choices::default() }).unwrap();
    assert_eq!(choices::request_defaults(&w.paths, "ling").unwrap()["chat_template_kwargs"], serde_json::json!({ "preserve_thinking": true }));
    assert_eq!(view_of(&w, "ling", &three_gpus()).choices.reasoning, None);
}

/// A chat request does not read the disk: the defaults of a model are kept until a file they come from is written by the app.
#[test]
fn the_request_defaults_are_kept_until_the_choices_or_the_models_are_written() {
    let w = world(false);
    let defaults = choices::ModelDefaults::new(w.paths.clone());
    let temperature = |key: &str| defaults.get(key).unwrap().get("temperature").cloned();
    assert_eq!(temperature("ling"), Some(serde_json::json!(1.0)));
    // the file is changed behind the app's back: the request is still given what is in memory
    write_choices(&w, r#"{ "models": { "ling": { "style": "creative" } } }"#);
    assert_eq!(temperature("ling"), Some(serde_json::json!(1.0)));
    // whoever writes the choices says so
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Precise, ..Choices::default() }).unwrap();
    assert_eq!(temperature("ling"), Some(serde_json::json!(0.3)));

    // a model of the user's is not known before it is added; once added, and again when its entry is replaced, its defaults follow
    assert!(defaults.get("mine").is_err());
    let entry = |gguf: &str| serde_json::json!({ "label": "Mine", "gguf": gguf, "files": [{ "path": gguf, "size": 1 }], "memory": { "kv_kib_token": 1, "state_mib": 0 } });
    let kwargs = |key: &str| defaults.get(key).unwrap()["chat_template_kwargs"].clone();
    crate::fixtures::write_gguf_with_template(&w.paths.models.join("plain.gguf"), "{% for m in messages %}{{ m.content }}{% endfor %}");
    crate::fixtures::write_gguf_with_template(&w.paths.models.join("thinks.gguf"), crate::fixtures::SWITCH_TEMPLATE);
    mango_common::catalog::add_user(&w.paths, "mine", entry("plain.gguf")).unwrap();
    choices::set_model(&w.paths, "mine", Choices { reasoning: Some("off".into()), ..Choices::default() }).unwrap();
    assert_eq!(kwargs("mine"), serde_json::json!({ "preserve_thinking": true }), "the model does not reason: its switch adds nothing");
    mango_common::catalog::add_user(&w.paths, "mine", entry("thinks.gguf")).unwrap();
    assert_eq!(kwargs("mine"), serde_json::json!({ "preserve_thinking": true, "enable_thinking": false }));
    mango_common::catalog::remove_user(&w.paths, "mine").unwrap();
    assert!(defaults.get("mine").is_err());
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

/// A model of the user's has no values in the catalog: the recommended style adds no sampling value, the others their temperature.
#[test]
fn a_model_without_values_in_the_catalog_gets_only_what_the_user_chose() {
    // A catalog of its own, in a temporary folder: `data_only` reads the real one.
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    let paths = Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("data") };
    std::fs::create_dir_all(&paths.dist).unwrap();
    std::fs::write(paths.dist.join("mango-models.json"), r#"{ "ctx": 8192, "default": "m", "order": ["m"], "models": { "m": { "label": "M", "gguf": "m.gguf" } } }"#).unwrap();
    let kept = serde_json::json!({ "preserve_thinking": true });
    assert_eq!(serde_json::Value::Object(choices::request_defaults(&paths, "m").unwrap()), serde_json::json!({ "chat_template_kwargs": kept }));
    choices::set_model(&paths, "m", Choices { style: choices::Style::Creative, ..Choices::default() }).unwrap();
    assert_eq!(serde_json::Value::Object(choices::request_defaults(&paths, "m").unwrap()), serde_json::json!({ "temperature": 1.1, "chat_template_kwargs": kept }));
    // its file is not on the disk, so its template offers nothing: a reasoning chosen for it adds nothing
    choices::set_model(&paths, "m", Choices { style: choices::Style::Precise, reasoning: Some("on".into()), ..Choices::default() }).unwrap();
    assert_eq!(serde_json::Value::Object(choices::request_defaults(&paths, "m").unwrap()), serde_json::json!({ "temperature": 0.3, "chat_template_kwargs": kept }));
}

/// The values of the style are chosen one by one: they win over the style's, only the ones chosen change, and the
/// view shows what a request gets.
#[test]
fn the_values_chosen_win_over_the_style_and_over_the_catalog() {
    let w = world(false);
    let defaults = |key: &str| serde_json::Value::Object(choices::request_defaults(&w.paths, key).unwrap());
    let own = Sampling { temperature: Some(0.5), top_k: Some(0), repeat_penalty: Some(1.2), ..Sampling::default() };
    choices::set_model(&w.paths, "ling", Choices { sampling: own, ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling")["top_k"], serde_json::json!(0));
    assert_eq!(defaults("ling")["repeat_penalty"], serde_json::json!(1.2));
    let hw = three_gpus();
    assert_eq!(view_of(&w, "ling", &hw).sampling, Some(Sampling { temperature: Some(0.5), top_p: Some(0.95), top_k: Some(0), repeat_penalty: Some(1.2), ..Sampling::default() }));
    // over a style that is not the model's own
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Precise, sampling: own, ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling")["temperature"], serde_json::json!(0.5));
    choices::set_model(&w.paths, "ling", Choices { style: choices::Style::Precise, ..Choices::default() }).unwrap();
    assert_eq!(defaults("ling")["temperature"], serde_json::json!(0.3));
    assert_eq!(view_of(&w, "ling", &hw).sampling.unwrap().temperature, Some(0.3));
    // a value for a field the catalog leaves empty
    choices::set_model(&w.paths, "lfm", Choices { sampling: Sampling { top_p: Some(0.9), ..Sampling::default() }, ..Choices::default() }).unwrap();
    assert_eq!(defaults("lfm")["top_p"], serde_json::json!(0.9));
    // saved and read back
    assert_eq!(choices::read(&w.paths).unwrap().models["lfm"].sampling.top_p, Some(0.9));
    // the choices saved before the values existed read as they were
    write_choices(&w, r#"{ "models": { "ling": { "style": "creative", "context": 65536 } } }"#);
    let c = choices::read(&w.paths).unwrap();
    assert_eq!(c.models["ling"].sampling, Sampling::default());
    assert_eq!(defaults("ling")["temperature"], serde_json::json!(1.1));
}

/// Each value has its interval; a value outside it is refused with a sentence that names it, and the edges are valid.
#[test]
fn the_values_of_the_style_have_their_intervals() {
    let w = world(false);
    let set = |sampling: Sampling| choices::set_model(&w.paths, "ling", Choices { sampling, ..Choices::default() });
    let refused = [
        ("temperature", Sampling { temperature: Some(2.01), ..Sampling::default() }),
        ("temperature", Sampling { temperature: Some(-0.01), ..Sampling::default() }),
        ("top_p", Sampling { top_p: Some(1.01), ..Sampling::default() }),
        ("top_p", Sampling { top_p: Some(-0.5), ..Sampling::default() }),
        ("min_p", Sampling { min_p: Some(1.5), ..Sampling::default() }),
        ("presence_penalty", Sampling { presence_penalty: Some(2.5), ..Sampling::default() }),
        ("presence_penalty", Sampling { presence_penalty: Some(-2.5), ..Sampling::default() }),
        ("repeat_penalty", Sampling { repeat_penalty: Some(0.0), ..Sampling::default() }),
        ("repeat_penalty", Sampling { repeat_penalty: Some(-1.0), ..Sampling::default() }),
    ];
    for (name, sampling) in refused {
        let e = set(sampling).unwrap_err().to_string();
        assert!(e.contains(name) && e.contains("Ling"), "{name}: {e}");
    }
    assert!(set(Sampling { temperature: Some(f64::NAN), ..Sampling::default() }).is_err());
    assert!(!w.paths.data.join(choices::FILE).exists());
    set(Sampling { temperature: Some(0.0), top_p: Some(0.0), min_p: Some(0.0), top_k: Some(0), presence_penalty: Some(-2.0), repeat_penalty: Some(0.01) }).unwrap();
    set(Sampling { temperature: Some(2.0), top_p: Some(1.0), min_p: Some(1.0), top_k: Some(100_000), presence_penalty: Some(2.0), repeat_penalty: Some(10.0) }).unwrap();
    // a saved file with a value outside the interval is an error with a sentence, not the standard values in its place
    write_choices(&w, r#"{ "models": { "ling": { "sampling": { "temperature": 5 } } } }"#);
    assert!(choices::read(&w.paths).unwrap_err().to_string().contains(&tr!("Le tue scelte salvate non sono valide", "Your saved choices are not valid")));
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
    assert!(v.bytes > 10_000_000_000, "{v:?}");
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
        placed_in: None,
        present,
        waits_engine: false,
        bytes: 1,
        sampling: None,
        verdict: Verdict { fits: placement.is_some(), place: placement.map(|placement| Where { placement, gpus: vec![], context: 4096 }), reason: String::new(), speed: None, fastest: false, estimated: false },
        recommended: false,
        on_request: false,
        limits: Limits { places: vec![], context: vec![], reasoning: vec![], reasoning_default: None },
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

    // On the processor: the first that writes at the speed of reading or faster, otherwise the fastest.
    let at = |key: &str, speed| {
        let mut v = listed(key, Some(Cpu), false);
        v.verdict.speed = Some(speed);
        v
    };
    use crate::Speed::{Fair, Quick, Slow, VerySlow};
    assert_eq!(proposed(vec![at("dense", Slow), at("moe", Fair), at("small", Quick)], &none), ["moe"]);
    assert_eq!(proposed(vec![at("dense", VerySlow), at("big", Slow), at("huge", VerySlow)], &none), ["big"], "none is fair: the fastest");
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
    let taken = |used: &[(u32, u64, u64)], lent: &[u32]| taken_before_start(&w.paths, &hw, used, FREE_RAM_MIB, "3.6", lent).unwrap();

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

/// What the tests leave free of the RAM when it is not what they look at.
const FREE_RAM_MIB: u64 = 48_000;

/// On the integrated graphics that borrows the PC's memory, what counts before the start is the RAM left free by the other
/// programs: with enough it starts, with too little for the same plan it does not, and the sentence says why. A model on
/// the processor is not looked at.
#[test]
fn a_model_on_the_integrated_graphics_starts_while_the_free_ram_gives_the_same_plan() {
    let w = world(false);
    let mut hw = pc(vec![integrated(0, "AMD Radeon(TM) Graphics", 512, 7_700)], 15_700);
    hw.integrated = true;
    assert_eq!(cards(&plan(&w, "3.5-4b", &hw).unwrap()), ["AMD Radeon(TM) Graphics"]);
    let taken = |hw: &Hardware, free: u64| taken_before_start(&w.paths, hw, &[(0, 300, 512)], free, "3.5-4b", &[]).unwrap();
    assert_eq!(taken(&hw, 10_000), None, "Windows and a browser beside it");
    let short = taken(&hw, 3_000).expect("too little RAM left");
    assert_eq!(short.cards, [0]);
    assert!(short.sentence.contains(&gb("2.9 GB")), "{}", short.sentence);
    hw.integrated = false;
    assert_eq!(taken(&hw, 3_000), None, "on the processor nothing is looked at");
}

/// The memory of a Radeon counts like that of an NVIDIA card: 15 GB of the RX 7800 XT's 16 held by another program leave no
/// room for a model that fits with the card free, and the sentence names the card; with the card free it starts, and the
/// desktop's share and a large desktop do not keep it from starting.
#[test]
fn a_radeon_held_by_another_program_does_not_start_a_model_that_fits_with_it_free() {
    let w = world(false);
    let hw = pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768);
    assert_eq!(cards(&plan(&w, "3.5-4b", &hw).unwrap()), ["AMD Radeon RX 7800 XT"], "with the card free the model is on it");
    let taken = |mib: u64| taken_before_start(&w.paths, &hw, &[(0, mib, 16_368)], FREE_RAM_MIB, "3.5-4b", &[]).unwrap();

    let held = taken(15_360).expect("the Radeon is taken");
    assert_eq!(held.cards, [0]);
    assert_eq!(
        held.sentence,
        tr!(
            "Sulla AMD Radeon RX 7800 XT un altro programma sta usando {}: per questo modello non resta abbastanza memoria.",
            "On the AMD Radeon RX 7800 XT another program is using {}: there is not enough memory left for this model.",
            gb("15.0 GB")
        )
    );
    assert_eq!(taken(500), None, "the desktop");
    assert_eq!(taken(2_000), None, "a large desktop: 900 MiB over the reserve");

    // Chosen to run on the card, the model that failed does not fit beside the other program, and the sentence is the same.
    choose(&w, "3.5-4b", WhereChoice::All);
    let after = view::after_failure(&w.paths, &hw, &[(0, 15_360, 16_368)], "3.5-4b", None, None).unwrap();
    assert_eq!(after.taken, Some(held.sentence));
}

/// A plan computed from the memory (official llama.cpp, on one card here) starts as long as what the other programs leave
/// gives the same plan: the same card, the same context. Qwen3.5-2B has its whole context with room to spare and starts
/// beside 1.1 GB over the reserve; Qwen3.5-4B fills the card, would get less context, and does not start. Neither starts
/// when it would need another card, and a card they do not use is not looked at.
#[test]
fn a_computed_plan_starts_while_the_memory_left_gives_the_same_plan() {
    let w = world(false);
    let hw = three_gpus();
    let taken = |key: &str, used: &[(u32, u64, u64)]| taken_before_start(&w.paths, &hw, used, FREE_RAM_MIB, key, &[]).unwrap();
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
    assert_eq!(taken_before_start(&w.paths, &hw, &with_used(1, 4915), FREE_RAM_MIB, &beside, &[]).unwrap(), None, "{beside} starts");
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
    assert_eq!(taken_before_start(&w.paths, &hw, &used, FREE_RAM_MIB, "bonsai2", &[1]).unwrap().map(|t| t.cards), Some(vec![2]));
    assert_eq!(taken_before_start(&w.paths, &hw, &used, FREE_RAM_MIB, "bonsai2", &[]).unwrap(), None, "with the 1080 back the 1660 SUPER is not used");
}

/// A model that runs on the processor of a PC with graphics cards is started with the processor-only build of official
/// llama.cpp: the CUDA one, used with no card in sight, can close while it reads a prompt. The plan, the verdict's engine
/// and the download all say the same build; the same model on the cards keeps the cards' build.
#[test]
fn a_model_on_the_processor_of_a_pc_with_cards_uses_the_processor_build() {
    let w = world(false);
    let hw = three_gpus();
    let on_cards = plan(&w, "3.5-4b", &hw).unwrap();
    assert!(on_cards.spec.exe.starts_with(w.paths.engines.join("llamacpp")) && !on_cards.spec.exe.starts_with(w.paths.engines.join("llamacpp").join("b12110-cpu")), "{:?}", on_cards.spec.exe);
    assert_eq!(download_of(&w.paths, "3.5-4b", &hw).unwrap().build, Build::Cuda12);

    choose(&w, "3.5-4b", WhereChoice::Cpu);
    let p = plan(&w, "3.5-4b", &hw).unwrap();
    assert!(is_on_cpu(&p), "{:?}", p.spec.args);
    assert_eq!(p.spec.exe, w.paths.engines.join("llamacpp").join("b12110-cpu").join("llama-server.exe"));
    assert_eq!(download_of(&w.paths, "3.5-4b", &hw).unwrap().build, Build::Cpu);
    let entry = catalog_for(&w.paths, &hw).unwrap().0.into_iter().find(|e| e.key == "3.5-4b").unwrap();
    assert_eq!(entry.engine, Some(("llamacpp".to_string(), Build::Cpu)));
    assert_eq!(view_of(&w, "3.5-4b", &hw).verdict.place.map(|p| p.placement), Some(Placement::Cpu));

    // Another model, which the cards keep, still has the cards' build.
    assert_eq!(download_of(&w.paths, "3.5-2b", &hw).unwrap().build, Build::Cuda12);
}

/// The processor build is small and the PC already has the engine for its cards: a model on the processor whose build is
/// not there yet waits for it like for an engine update (the app downloads it by itself); a PC without any build of the
/// engine downloads it with the model, as ever.
#[test]
fn the_processor_build_missing_arrives_by_itself_on_a_pc_that_has_the_cards_engine() {
    let w = world(false);
    let hw = three_gpus();
    choose(&w, "3.5-4b", WhereChoice::Cpu);
    std::fs::remove_dir_all(w.paths.engines.join("llamacpp").join("b12110-cpu")).unwrap();
    let v = view_of(&w, "3.5-4b", &hw);
    assert!(!v.present && v.waits_engine, "present {} waits {}", v.present, v.waits_engine);
    assert!(plan(&w, "3.5-4b", &hw).is_err(), "it does not start until the build is there");
    let updates = engine_updates(&w.paths, &hw).unwrap();
    assert_eq!(updates.len(), 1, "one build, one update: {updates:?}");
    assert!(view_of(&w, &updates[0].model, &hw).waits_engine, "the model that carries it waits for it: {updates:?}");

    std::fs::remove_dir_all(w.paths.engines.join("llamacpp")).unwrap();
    for other in ["prism", "toq"] {
        std::fs::remove_dir_all(w.paths.engines.join(other)).unwrap();
    }
    let v = view_of(&w, "3.5-4b", &hw);
    assert!(!v.present && !v.waits_engine, "a PC with no engine at all: the model's download brings it");
    assert!(engine_updates(&w.paths, &hw).unwrap().is_empty());
}

// --- a choice that a change in Computer makes impossible ------------------------------------------------------

/// «I choose» on two cards, then one of them left out in Computer with the third: the choice stays as it was saved and is shown as
/// chosen, the verdict names the card, and the choice without that card is saved.
#[test]
fn a_pick_with_a_card_left_out_afterwards_stays_shown_and_can_be_changed() {
    let w = world(false);
    let hw = three_gpus();
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![RTX_3060_TI.into(), GTX_1080.into()], ..Choices::default() }).unwrap();
    with_unused(&w, &[GTX_1080, GTX_1660_SUPER]);
    let v = view_of(&w, "3.5-4b", &hw);
    assert_eq!(v.choices.place, WhereChoice::Pick);
    assert!(v.limits.places.contains(&WhereChoice::Pick), "{:?}", v.limits.places);
    assert!(!v.verdict.fits && v.verdict.reason.contains(GTX_1080), "{:?}", v.verdict);
    choices::set_model(&w.paths, "3.5-4b", Choices { place: WhereChoice::Pick, gpus: vec![RTX_3060_TI.into()], ..Choices::default() }).unwrap();
    assert_eq!(cards(&plan(&w, "3.5-4b", &hw).unwrap()), [RTX_3060_TI]);
}

/// «All the cards» saved, then every card but one left out: the choice is still shown as chosen.
#[test]
fn a_saved_place_that_the_cards_left_no_longer_offer_is_still_shown() {
    let w = world(false);
    let hw = three_gpus();
    choose(&w, "3.5-4b", WhereChoice::All);
    with_unused(&w, &[GTX_1080, GTX_1660_SUPER]);
    let v = view_of(&w, "3.5-4b", &hw);
    assert!(v.limits.places.contains(&WhereChoice::All), "{:?}", v.limits.places);
}

/// The dedicated card left out: the row of the integrated graphics does not say that the models use it.
#[test]
fn the_integrated_graphics_beside_a_dedicated_card_left_out_tells_the_truth() {
    let w = world(false);
    let mut hw = pc(vec![nvidia(0, RTX_3060_TI, 8192, (8, 6), (12, 6)), integrated(1, "Intel(R) UHD Graphics 630", 128, 32_000)], 32_768);
    hw.integrated = false;
    choices::set_gpu_used(&w.paths, &hw, RTX_3060_TI, false).unwrap();
    let c = computer_view(&w.paths, &hw).unwrap();
    let uses = tr!("I modelli usano la scheda video dedicata", "The models use the dedicated graphics card");
    assert!(!c.gpus[1].note.contains(&uses) && !c.gpus[1].note.is_empty(), "{:?}", c.gpus[1]);
    assert!(is_on_cpu(&plan(&w, "3.5-4b", &hw).unwrap()));
}

/// A model that runs only with its own engine, every card left out: the sentence says so, not that the cards are old.
#[test]
fn a_model_with_its_own_engine_and_every_card_left_out_says_so() {
    let w = world(true);
    let hw = three_gpus();
    with_unused(&w, &[RTX_3060_TI, GTX_1080, GTX_1660_SUPER]);
    let v = view_of(&w, "toq", &hw);
    assert!(!v.verdict.fits && !v.verdict.reason.contains("Found: .") && !v.verdict.reason.contains("Trovate: ."), "{:?}", v.verdict);
    assert!(v.verdict.reason.contains(&tr!("segnate come non usate", "marked as not used")), "{:?}", v.verdict);
}

/// A field saved before that no longer holds (its harness folder deleted) does not keep the other choices of the model
/// from being saved; a harness chosen now must be there.
#[test]
fn a_stale_field_does_not_block_the_other_choices_of_the_model() {
    let w = world(false);
    write_choices(&w, r#"{ "models": { "3.5-4b": { "harness": "gone" } } }"#);
    let saved = choices::read(&w.paths).unwrap().models["3.5-4b"].clone();
    choices::set_model(&w.paths, "3.5-4b", Choices { style: Style::Precise, ..saved.clone() }).unwrap();
    assert_eq!(choices::read(&w.paths).unwrap().models["3.5-4b"].harness.as_deref(), Some("gone"), "kept, as the user chose it");
    let e = choices::set_model(&w.paths, "3.5-4b", Choices { harness: Some("other-gone".into()), ..saved }).unwrap_err().to_string();
    assert!(e.contains("other-gone"), "{e}");
}
