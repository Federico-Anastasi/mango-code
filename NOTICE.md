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
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp), voice dictation, built into the app through `whisper-rs` | `app/crates/voice/` | MIT, see [LICENSES/whisper.cpp-MIT.txt](LICENSES/whisper.cpp-MIT.txt) |
| Skills `frontend-design`, `skill-creator`, `theme-factory`, `web-artifacts-builder`, `webapp-testing` | `launcher/mango-plugin/skills/` | Apache-2.0, see the `LICENSE.txt` in each folder |
| Skills `systematic-debugging`, `test-driven-development`, `verification-before-completion`, from [superpowers](https://github.com/obra/superpowers) | `launcher/mango-plugin/skills/` | MIT, see the `LICENSE.txt` in each folder |

Dependencies installed by package managers, and the models downloaded at first start, have their own licenses.
