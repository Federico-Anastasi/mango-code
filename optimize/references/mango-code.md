# Mango Code seen from outside

This is the layout set by the profile and engine contract (catalog `mango-engines.json`, `profiles/` folders, engines in `<engine>\<version>-<build>\`). If they are missing on the PC, the app is an earlier version: work with `mango-tune` and with the engines in `<dist>\engine\<name>\`.

What you need to know to measure an engine, write a profile and test it, without reading the app's code. If a point does not
match what you find on the PC, the PC is right: recheck (`hygiene.md`).

## Where things are

| what | where (Windows) |
|---|---|
| installed app | `%LOCALAPPDATA%\Mango Code\` (`mango-code.exe`); in development from the repo, `app\target\{release,debug}\` |
| distribution (`dist`): catalog, templates, MCP | in the installed app's `resources\` folder; in the repo `launcher\` (the `MANGO_DIST` variable moves it) |
| model catalog | `<dist>\mango-models.json`: for each model name, GGUF file, mmproj, repo, maximum context, chat template; `order` is the listing order. The user's models are in `%LOCALAPPDATA%\MangoCode\user-models.json` (same format, they are added) |
| engine catalog | `<dist>\mango-engines.json`: downloadable versions per build (`cpu`, `vulkan`, `cuda-12`, `cuda-13`, and the `prism`, `toq` engines of the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER profiles) |
| installed engines | `<engines>\<engine>\<version>-<build>\llama-server.exe`; an engine placed by hand in `<engines>\<name>\llama-server.exe` counts as installed. `<engines>` = `<dist>\engine` or what `<dist>\mango-paths.json` says (`llama`) |
| downloaded models | `%LOCALAPPDATA%\MangoCode\models\` (or `mango-paths.json`, `models`) |
| optimized profiles | `<dist>\profiles\<family>\*.json` (the distributed ones); yours in `%LOCALAPPDATA%\MangoCode\profiles\`, which the app reads: for the same model and GPUs, yours wins. Format: `launcher\profiles\README.md` |
| user data | `%LOCALAPPDATA%\MangoCode\` (`MANGO_DATA` moves it) |
| logs | `%LOCALAPPDATA%\MangoCode\logs\`: `manager.log` (one JSON line per `/engine/*` call and per engine event), `engine.log`, `llama.log` (ik engine) |
| on-disk memory of conversations | `%LOCALAPPDATA%\MangoCode\memory\<model>\` (6 GiB, 24 hours) |
| server addresses | `%LOCALAPPDATA%\MangoCode\service.json` (fields `agent`, `engine`, `pid`): present only if Mango Code is running |
| trial log and engine logs of your trials | `%LOCALAPPDATA%\MangoCode\optimize\log.jsonl`, `...\optimize\log\` |

`scripts/find.ps1` prints what is really on the PC (paths, whether the app is running, engines and models, `mango-tune.exe`).

## The general level and the profiles

- **General:** an official, stable llama.cpp build chosen according to the hardware (`cpu`, `vulkan`, `cuda-12`, `cuda-13`, version pinned with
  sha256), arguments computed from the hardware, the context that fits. The model runs **entirely on the GPUs** (`-fit off -ngl all`) or, if it does not
  fit there, **entirely on the processor** (`-dev none -t <cores>`): never split between GPUs and RAM. The same holds for the profiles you write.
- **Profile:** model + hardware + engine + arguments + measured numbers. It applies only if the PC's GPUs are **exactly** those of the profile
  (order does not matter; one extra GPU = it does not apply) and if the engine is installed. Otherwise the general level applies. The RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER is the first profile.
- So a profile you write is for **this** hardware: `hardware.gpus` has the GPU names as the driver reports them.

```json
{ "id": "my-pc/3.6", "model": "3.6", "engine": "llamacpp", "build": "cuda-12",
  "hardware": { "gpus": ["NVIDIA GeForce RTX 4070"] },
  "env": {}, "args": ["-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"],
  "ctx": 65536, "split": false, "ub": 512,
  "measurements": { "date": "2026-11-05", "decode_tok_s": 61.6, "prefill_tok_s": 518, "note": "..." } }
```
`args` are the ones the app **adds** to `-m <gguf> -c <ctx> --jinja --host 127.0.0.1 --port <p> -np 1 --no-warmup --metrics` and to the on-disk memory;
`ctx` and `ub` have their own field (do not repeat them in the arguments). `mtp`: tokens anticipated by the prediction head in the ik engine (in official llama.cpp, speculative decoding is written
in `args`: `--spec-type draft-mtp --spec-draft-n-max 2`). `split: true` only for the engine that reads the layer map (`LLAMA_LAYER_DEVICES`, `toq` engine).
`mango-tune profile` writes this format from a successful trial.

## Measuring an engine

Three levels, from the closest to the product:

1. **`mango-tune trial`** (this skill's tool): starts `llama-server` with the given setup, measures prefill and decode at several contexts, logs. This is the one
   for exploring. `references/tools.md`.
2. **`mango-bench <key> ...`** (`app/crates/engine`, `cargo run --release -p engine --bin mango-bench -- toq 3.6`): starts a model **from the catalog** as the app starts it
   (plan, manager, profile if there is one) and measures it with the same text and the same method. It is the final test: "the profile I wrote, started as the app starts it, gives the numbers I measured?".
3. **`llama-bench`**: prefill and decode without a server; for comparing files and KV types, not for saying how fast it really goes.

## How the app starts a model (to reproduce the same behavior)

The engine manager (port 8080, `service.json`) keeps **one** `llama-server` running at a time and switches it when a request asks for another model. Fixed arguments: `-m`, `-c`, `--jinja`,
`--host 127.0.0.1`, `--port`, `--slot-save-path`, `-np 1`, `--no-warmup`, `--metrics`, the on-disk memory (`--cache-disk` with cap and age), then the model's `args`,
`--mmproj` and `--chat-template-file` if the model has them, `-ub`, `-ts`. Environment: `CUDA_DEVICE_ORDER=PCI_BUS_ID`, `GGML_CUDA_GRAPHS_ANY_ARCH=1` (stock
llama.cpp without patches ignores these two variables), then the model's `env`. An engine that does not start gives an error with the last lines of its log (`engine.log`).

The manager holds the GPUs: to use them yourself, `POST <engine>/engine/release {"gpus":[0,2]}`, then `POST <engine>/engine/resume` (`docs/INTEGRATION.md` §6). The local model's
requests wait for as long as you hold them.

## Testing a new profile

1. Write it with `mango-tune profile` (or by hand, format above) in `%LOCALAPPDATA%\MangoCode\profiles\`.
2. Start the model as the app starts it: `POST <engine>/engine/model {"model":"<key>"}` and `GET <engine>/engine` (`phase` `running`, `context`, memory per GPU).
3. `mango-bench <key>`: the same points as your trial. The numbers must match those of the profile within the noise; if not, the app adds something your trial did not have (on-disk memory, `--no-warmup`, images).
4. Try a restart and a long conversation: the memory margin you measured must also hold with the real system prompt (~14k tokens) and with `--cache-disk`.
5. A profile that does not hold is removed: it is not left "almost".

## What does not change under you

The model catalog, the profile format and the app's files belong to Mango Code; do not modify them to make a measurement pass. Change only your profiles, your log and the engines you build
in a folder of your own.
