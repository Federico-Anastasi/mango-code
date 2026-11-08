# Tools and how to measure

Every number that ends up in the report or the profile comes from here. A number without the command that produced it is worthless.

## `mango-tune` (`scripts/find.ps1` says where it is; if it is missing, `cargo build --release -p engine --bin mango-tune` in `app/`)

Starts a `llama-server` with the setup you give it, measures **prefill** (prompt, tok/s) and **decode** (generation, tok/s)
at several context lengths, and keeps a numbered log. Real text (Mango Code's files, cut to the exact number of
tokens with the model's tokenizer), temperature 0, `cache_prompt` off: every point rereads everything. A warm-up
request is thrown away before the points. It fixes `-np 1 --jinja --host 127.0.0.1` and `CUDA_DEVICE_ORDER=PCI_BUS_ID`:
you can override them in the arguments.

```
mango-tune detect [--engine <folder>]            # hardware, engines and models found, what the engine sees
mango-tune trial --engine <folder> --model <gguf> --name base --points 1k,8k,32k --token 128 -- -c 40000 -ngl 99 -fa on
mango-tune trial --base 1 --name kv-f16 --change "-ctk f16" --change "-ctv f16"   # one change to trial 1
mango-tune trial --base 1 --name repeat                                           # the base repeated: measures the noise
mango-tune trial --base 1 --env GGML_CUDA_CLOCK_KEEPER=1 --name keeper           # an environment variable
mango-tune trial --base 1 --remove -fa --name no-fa                               # removes a flag with its value
mango-tune log                                                               # all the trials
mango-tune profile --from 3 --model <key> --id my-pc/<key> [--gpus "Name;Name"] [--note "..."]
```

Things the command does that you need to know:
- The arguments after `--` are `llama-server`'s (without `-m` and `--port`). `-c` is mandatory: it tells the tool how far
  to measure. A point longer than `-c` is an error before starting (`full` = the whole context minus the reply).
- With `--base`, without `--points` and `--token`, the change measures the same points and the same tokens as the base: the comparison is always point by point.
- `--repeat N` gives the median of N rounds at every point. With `--base` the trial is compared with the base: for each point
  the percentage difference in prefill and decode, judged `better` / `worse` / `same` against the **noise**.
  The noise is the largest difference seen between trials with the same setup as the base; until the base has been
  repeated, an assumed 5% applies, and the command says so. **Repeat the base before judging any change.**
- An engine that does not start or a measurement that fails ends up in the log with the error (`does not start`, `error`): these are data
  (an OOM is a limit found). You do not build on a failed trial and you do not write a profile from it.
- The engines' memory on NVIDIA GPUs (MiB more than before the start, per GPU) is in the log: it is the **real**
  memory, not the declared one. It is used to find the margin before the OOM.
- The profile: the plan's arguments (`-m`, port, `-np`, `--jinja`) removed, `-c` in the `ctx` field, `-ub` in the `ub` field. Engine and
  build are derived from the folder name (`<engine>/<version>-<build>`); outside that layout you need `--engine-name` and `--build`.
  The GPUs are the NVIDIA ones detected; for other vendors `--gpus "Name;Name"` with the names `llama-server --list-devices` prints.
  It is written to `%LOCALAPPDATA%\MangoCode\profiles\` (or `--out`). The profile of a PC without GPUs has `gpus: []`.
- The log is `%LOCALAPPDATA%\MangoCode\optimize\log.jsonl` (or `--log`); the engines' logs are in `optimize\log\`.

## Other tools, in the engine you download

- `llama-server --list-devices`: what the engine sees, for every GPU vendor, with the free memory as the GPU declares it.
- `llama-bench -m <gguf> -ngl 99 -fa 1 -p 512 -n 128 -d 0,8192,32768 -r 3 -o md`: prefill and decode at different context
  depths, no server. Fine for comparing files and cache types; **not** for saying "how fast it really goes"
  (it has no draft, no template, no agent batch). For that, use `mango-tune`.
- Clocks and power during decode: `nvidia-smi --query-gpu=index,clocks.sm,clocks.mem,power.draw,pstate --format=csv -l 1`.
  A GPU in `P3` or with clocks far below the maximum while the engine is decoding is a result, not a detail.
- Bandwidth share: `bandwidth% = model_bytes_read_per_token × tok/s ÷ bandwidth` with a single GPU and a model that fits
  (`llama-bench -p 0 -n 128`). Our 50-75% is on the **real** bandwidth, measured with a read-only kernel; on the declared bandwidth
  the percentages come out lower. Far below 50% of the real one says the kernel or the clock is wrong (see `hardware.md`).

## The user's PC is busy with their engine

If Mango Code is running, its local model holds the GPUs. To measure on those GPUs, take them on loan
(`docs/INTEGRATION.md` §6; the manager's address is in the `engine` field of `%LOCALAPPDATA%\MangoCode\service.json`):
`POST /engine/release {"gpus":[0,2]}` (without `gpus`: all of them), `GET /engine` for the state, `POST /engine/resume` when the
work is done. The loan belongs to the calling process, and the manager must recognize it: if you call with `curl` (which exits immediately) the loan ends with it, or the call returns 400. Pass `"pid": <PID of a process that stays alive>` (or `"pid": 0`: nobody's, until `resume`). If the process closes, the manager restarts the engine by itself. If your own model
runs on those GPUs, its requests wait for as long as you hold them: work from an online model or from another terminal.
One heavy job per GPU at a time: two engines on the same GPU, or a bench with an engine running, measure half.

## Before trusting a number

1. Is the machine idle? (no heavy browsers, games, other engines, updates; Task Manager). A number taken on a
   busy machine is "indicative" and does not go in the table.
2. Did you repeat the base? How much does it vary? A difference inside that noise does not exist.
3. Were the clocks high? (a GPU idle for seconds starts in P3: the warm-up is in the command, but check.)
4. Did you look at the engine log? (an excluded GPU, a cache type that falls back, layers that ended up on the CPU show up
   there and not in the number: `offloaded N/M layers`, `fused Gated Delta Net ... disabled`, `retrying without pipeline parallelism`.)
5. Does the lossless variant give **the same text** at temperature 0? If it is not lossless (quantization, KV, reducing the
   experts) also measure quality: perplexity/KLD on the same text against the reference, never on the tok/s number.
