# Licensing

Copyright (C) 2026 Federico Anastasi.

Mango Code is free software: you can use it, study it, change it and earn money with it. If you distribute a modified
version, or let people use one over a network, you must offer its source code under the same license.

Source code: https://github.com/Federico-Anastasi/mango-code

| What | License |
|---|---|
| Everything in this repository, unless listed below | [AGPL-3.0-or-later](LICENSE) |
| Client for the apps that connect to Mango Code (`integration/client/`) | [MIT](integration/client/LICENSE) |
| Qwen3.8-27B-TOQ-v1 weights | CC BY-SA 4.0, on top of the Apache-2.0 notices of Qwen3.8-27B |

The name and logo are covered by separate rules: see [TRADEMARKS.md](TRADEMARKS.md).

## Third-party code

These parts keep their original licenses. The AGPL applies to the changes made for Mango Code.

| Component | Where | License |
|---|---|---|
| [opencode](https://github.com/anomalyco/opencode), with the changes made for Mango Code | `packages/` and the other opencode files at the repository root | MIT, see [LICENSES/opencode-MIT.txt](LICENSES/opencode-MIT.txt) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp), official builds downloaded at first start | `launcher/mango-engines.json` | MIT, see [LICENSES/llama.cpp-MIT.txt](LICENSES/llama.cpp-MIT.txt) |
| [llama.cpp, PrismML fork](https://github.com/PrismML-Eng/llama.cpp) | engine `prism`, from our fork [mango-prism](https://github.com/Federico-Anastasi/mango-prism) | MIT, see [LICENSES/llama.cpp-MIT.txt](LICENSES/llama.cpp-MIT.txt) |
| [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) | engine `toq`, from our fork [mango-toq](https://github.com/Federico-Anastasi/mango-toq) | MIT, see [LICENSES/ik_llama.cpp-MIT.txt](LICENSES/ik_llama.cpp-MIT.txt) |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp), the engine of the models that make images, official builds downloaded when one of those models is | engine `sd` in `launcher/mango-engines.json` | MIT, see [LICENSES/stable-diffusion.cpp-MIT.txt](LICENSES/stable-diffusion.cpp-MIT.txt) |
| Chat templates of third-party models, rendered by the tests | `app/crates/engine-cfg/tests/templates/` | each its own, given with its source in `templates.json` there; the texts that must travel with a copy (Llama 3.1 and 3.2, Gemma, LFM) are in the same folder |
| [Git for Windows](https://gitforwindows.org) 2.56.1, its official release unchanged, in the installer: Git Bash is the terminal of Mango Harness 2 and git makes every project a repository | `resources/git` of the installed app, from `app/scripts/prepare-installer.mjs` (address and SHA-256) | GPL-2.0, see [LICENSES/git-for-windows-GPL-2.0.txt](LICENSES/git-for-windows-GPL-2.0.txt); the licenses of its parts are in its `usr/share/licenses` and `ucrt64/share/licenses`; the source is at [git-for-windows/git v2.56.1.windows.1](https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1) |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp), voice dictation, built into the app through `whisper-rs` | `app/crates/voice/` | MIT, see [LICENSES/whisper.cpp-MIT.txt](LICENSES/whisper.cpp-MIT.txt) |
| Paths of the interface icons, copied from [Lucide](https://lucide.dev) (the app has no Lucide package); a part of them derives from [Feather](https://github.com/feathericons/feather) | `packages/ui/src/components/icon.tsx`, `packages/ui/src/v2/components/icon.tsx` and the inline icons of the components | ISC, see [LICENSES/lucide-ISC.txt](LICENSES/lucide-ISC.txt); MIT for the Feather part, see [LICENSES/feather-MIT.txt](LICENSES/feather-MIT.txt) |
| The typefaces [Archivo](https://github.com/Omnibus-Type/Archivo), [Instrument Sans](https://github.com/Instrument/instrument-sans) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | `suite/fonts/` | SIL Open Font License 1.1, see the `OFL-*.txt` files in [suite/fonts](suite/fonts) |
| Skill `frontend-design` (shortened) | `launcher/harness/mango-harness-1/skills/frontend-design.md` | Apache-2.0, see `LICENSE-frontend-design.txt` in the same folder |
| Skills `debugging`, `test-first`, `verify-before-done`, shortened and adapted from [superpowers](https://github.com/obra/superpowers) | `launcher/harness/mango-harness-1/skills/`; shorter again as `debugging.md`, `test-first.md` and `done.md` in `launcher/harness/mango-harness-2/skills/` | MIT, see `LICENSE-superpowers.txt` in `launcher/harness/mango-harness-1/skills/` |

The Rust crates built into the app are listed, with license and source, in [LICENSES/rust-crates.md](LICENSES/rust-crates.md) (generated from `app/Cargo.lock`). Dependencies installed by package managers, and the models downloaded at first start, have their own licenses.
