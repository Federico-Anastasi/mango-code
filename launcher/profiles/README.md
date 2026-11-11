# Profiles

A profile says how a model runs on a piece of hardware: engine, arguments, context, measurements. It applies if the
PC's GPUs are exactly the ones it asks for (order doesn't matter) or, if it asks for no GPUs, on every PC whose build
(`cpu`, `vulkan`, `cuda-12`, `cuda-13`, chosen from the hardware) is among its own. The GPU profile wins over the build
profile; with neither, the general plan applies (official llama.cpp).

## Where they are

- `profiles/<family>/<model>.json`, here: Mango Code's own. `3060ti-1080-1660s/` is for a PC with an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER. `general/` has the per-build profiles
  of the models the official llama.cpp can't read: today TOQ, on every NVIDIA PC, with GPUs and context computed from
  memory.
- `<data>\profiles\`, in any subfolder (for example `<data>\profiles\<name>\<model>.json`): the user's own, also for a
  model of their own. `<data>` is `%LOCALAPPDATA%\MangoCode`, or `MANGO_DATA`. `mango-tune profile` writes the profiles
  it produces there. For the same model and GPUs the user's wins.

## Format

```json
{ "id": "my-pc/3.6", "model": "3.6", "engine": "llamacpp", "build": "cuda-12",
  "hardware": { "gpus": ["NVIDIA GeForce RTX 4070"] },
  "env": {}, "args": ["-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"],
  "ctx": 65536, "ub": 512,
  "measurements": { "date": "2026-11-05", "decode_tok_s": 61.6, "prefill_tok_s": 518, "note": "..." } }
```

- `model`: the key in `mango-models.json`, or in the user's catalog (below).
- `engine`, `build`: the engine folder (`llamacpp`, `prism`, `toq`) and the hardware it is built for (`cpu`, `vulkan`,
  `cuda-12`, `cuda-13`).
- `args`: the `llama-server` arguments beyond those common to all models; the model sits entirely on the GPUs
  (`-ngl 999`) or, with the `cpu` build, entirely on the CPU: never split (no `--fit`, `-ot`, `-ncmoe`, `-cmoe`);
  `ctx`, `ub` (`-ub`) and `ts` (`-ts`) have their own field. `env`: the engine's environment variables.
- `hardware`: `{ "gpus": [...] }` (the GPU names, `[]` for a PC without) or `{ "build": ["cuda-12", ...] }`, one of the
  two.
- `split`: the layers are split across the GPUs automatically (only the `toq` engine), and with them the context (up to
  `ctx`) and the GPU of the image encoder. `mtp`: tokens anticipated by the MTP head (only `toq`).
- `measurements.date` is missing until the tune is measured: the app says so instead of writing a date.

## User models

`<data>\user-models.json` adds models to Mango Code's catalog, without replacing it: `{ "models": { "<key>":
{ ... } } }`, each entry in the same format as `models` in `mango-models.json`. A key already in the catalog is an
error. User models appear after the recommended ones and before the cloud ones, by key, in the selector, in the first
run; they are never the recommended one.

The app writes this file from the "Other models" section of the model choice (`app/README.md`). A Hugging Face entry
has `repo`, `revision` and `files` (`path` on disk, `size`, `sha256`, and `name` if the file sits in a folder of the
repo); one for a file on the computer has the absolute path in `gguf` and only `path` and `size` in `files`. In all of
them, `memory` (`kv_kib_token`, `state_mib`) comes from the GGUF header.
