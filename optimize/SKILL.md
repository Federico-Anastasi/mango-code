---
name: optimize
description: "Use when the user wants to optimize Mango Code on their own PC: find the best engine (llama.cpp) setup for their GPUs or CPU and their local models (arguments, layer split across several GPUs, KV cache, MTP and ngram speculative decoding, context, builds), measure prefill and decode at several contexts, and write an optimized profile with a report of the measurements. Also for understanding why a local model is slow or does not start (memory, OOM, GPUs, clocks)."
---

# Optimize Mango Code on this PC

Mango Code is a harness for local language models: an app (Tauri/Rust), an agent (a fork of opencode) and an engine, llama.cpp's `llama-server`, which
keeps the models on the user's GPUs or CPU. You are the agent that finds the best engine setup **for this PC and the models the user
chooses**, and leaves it written down as a profile. You work from outside, as an engineer: you measure, try, decide, verify.

**Result:** a profile (`profiles/<id>.json`, format in `references/mango-code.md`) and a short report with the measurements. Nothing else stays on the PC: the trial work is removed.

## Before you start

1. Read `references/hygiene.md`: the rules you work by (consent for the GPUs, one heavy job per GPU, one change at a time, independent verification, cleanup). They matter as much as the optimizations.
2. Read `references/mango-code.md`: where things are, how the app starts a model, how to test a profile.
3. Run `scripts/find.ps1 -Repo <repo, if there is one>`: paths, whether Mango Code is running, engines, models, `mango-tune.exe` (the installed app has it in this skill's folder). Without `mango-tune.exe`, build it from the repo
   (`cargo build --release -p engine --bin mango-tune` in `app/`).
4. Ask the user, in a few lines: **which models** (and whether they are already downloaded), **what use** (a coding agent: fast decode, prompt prefill, long context? how much does context matter?), **how much time**
   they have (a trial on a large model takes minutes), and **permission to use the GPUs** (and to take on loan the ones Mango Code holds: `references/tools.md`).
5. The knowledge base is in `knowledge/`, inside the skill.
   It holds the measured facts, by identifier (`G12`, `F3`, `R5`, `X4`): cite them in the report.

## How to reason (the idea in ten lines)

1. **The ceiling before the trial.** The decode of a dense model is limited by memory bandwidth, the prefill by compute; `max tok/s = real bandwidth ÷ bytes read per token`. The decode of a dense model normally reaches 50-75% of the real bandwidth (G2): inside that band a new kernel gains little; far below it there is a defect (clocks, kernel, fallback to the CPU). (G1-G4)
2. **The model and the format set the ceiling,** the arguments get close to it, the patches push it up where a defect holds it down. In that order. (`references/levers.md`)
3. **Memory is the real constraint:** model + KV + compute buffers + draft must fit with a margin; the VRAM the driver reports is not what can be allocated; on Windows going over does not raise an error and runs 10-30 times slower. (G10-G17)
4. **Adding GPUs adds memory, not speed.** The minimum number of GPUs that holds everything; then `-ts` in layers. (G30-G34)
5. **GPUs and formats are not equivalent:** without tensor cores, without the quantized kernel for that format, with a narrow PCIe link, the same lever does the opposite. Measure per GPU. (G40-G45)
6. **Every optimization is re-measured in its own regime:** the clock keeper was +36% on one kernel and −26% on another. Do not trust a "it worked on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER". (F40)
7. **Lossless versus lossy:** speculative decoding, KV f16/q8, split, graphs are lossless (same text at T=0); quantization, requantization, cheap prefill are not, and need a quality measurement. (`levers.md`)
8. **The bottleneck is measured end-to-end and per operation,** not from the micro-bench and not by eye. More than once in our history the hypotheses about what limited a kernel were wrong before we looked at the code. (G5, F31)
9. **Failures are data:** an OOM is a limit found, a "does not start" goes in the log with the reason. The roads already tried and why they do not pay are in `knowledge/dead-ends.md`: do not retry them without a new reason.
10. **The user's PC is not the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER:** our measurements are orders of magnitude and an example (`knowledge/3060ti-1080-1660s.md`), not a forecast. Where we have no experience (AMD, Intel, Ada, Blackwell, Linux) say so in the report.

## The steps, in the order that works best

Every step ends with a measurement written in the log. At the end of every step clean up (`hygiene.md`).

**0. Goal and criterion.** A number that says "better": for a coding agent, decode at 8-32k and the prefill of the ~14k-token prompt (Mango Code's fixed prompt, 14,253 tokens on 5 Nov 2026) matter more than decode on an empty context. Write it down.

**1. Inventory.** `mango-tune detect --engine <folder>`, `llama-server --list-devices`, PCIe per GPU, driver version, RAM, free disk. Compute the ceilings (real bandwidth, bytes per token). Find what already applies to this hardware in Mango Code's profiles, if any.
Roads by hardware type: `references/hardware.md`.

**2. The general baseline.** The right official engine for the hardware, `-ngl 999 --fit off -fa on -np 1`, KV f16 if it fits, a context that fits. Trial 1 in the log (`mango-tune trial`, three contexts). **Repeat it** (`--base 1`): the noise tells you how much a difference is worth. Check the engine log.

**3. Diagnosis.** Compare decode with the ceiling: if you are far below, look at the clocks during decode, the log (fallbacks, layers on the CPU, tensor cores), the prefill GPU by GPU (`problems.md`). A wrong diagnosis wastes more time than a wrong lever.

**4. The levers, one at a time, most profitable first** (`references/levers.md`): context and KV → `-ub`/`-np` → split → speculative (MTP, ngram) → clock/graph → format. Each lever is a `--base` trial
with `--change`/`--env`/`--remove`. Keep the change only if it beats the base **beyond the noise** at a point that matters. One that loses in prefill and wins in decode is decided with the goal from step 0.

**5. More GPUs.** Only if the model does not fit in one (`levers.md`, 4). Look for the OOM edge with trials in steps of one layer. Measure the prefill per GPU.

**6. Build and patch,** only if after steps 2-5 you are below the ceiling and the per-operation profile shows where (`references/building.md`). This is the most expensive step: every patch has a switch and a check that gives zero. An ordinary user usually does not need it.

**7. Quality** wherever you changed something lossy (format, KV q8, approximations): KLD/perplexity against the reference on the same text; never the tok/s number alone.

**8. The profile.** `mango-tune profile --from <n> --model <key>` from the best trial. Test it **as the app starts it** (`mango-code.md`, "Testing a new profile"): `mango-bench`, a restart, a long conversation. The numbers must match within the noise, otherwise it is not kept.

**9. Independent verification.** A separate agent, without your context, redoes the measurements and tries to refute the result (`hygiene.md`, "Independent verification"). Only then, the report.

**10. Report and cleanup.** The report (below) and the PC as you found it, plus the profile and the log: stop only the processes you started (by PID), remove trial builds, model copies, measurement files.

## When to stop

- You are inside the normal band of real bandwidth (50-75% for a dense model) and levers 2-5 have been tried: the rest is noise or a patch that is not worth it for a user.
- Three levers in a row inside the noise: the bottleneck is not where you are looking; go back to the diagnosis (step 3), do not try a fourth lever at random.
- After **two** failed attempts at the same thing: stop and look for the cause (log, documentation, the source) before trying again.
- The machine is not idle or the numbers do not repeat: this is not the time to measure.
- The expected gain is small and the lever has a quality loss or a risk for the user's PC: do not do it without asking.
- Anything that modifies the PC (clocks with administrator rights, NVIDIA settings, drivers, building in the app's folders): ask first.

## The report

It opens with the answer: the recommended setup, how much it improves (decode and prefill at every context, base against final, with the noise), what it costs (memory, quality), the profile written (path).
Then: the table of the log's trials (what you tried, outcome), the levers that did not pay and why (with the identifiers from `dead-ends.md`), what you did **not** try (AMD? Linux? more models?), the things the user must know
(the driver update, a change made to the PC, a GPU that must be kept free). A few lines per section; the numbers with the command that produced them.

## The files

- `references/hygiene.md`: the working rules (read it first).
- `references/mango-code.md`: Mango Code seen from outside (paths, profiles, how to test a profile).
- `references/tools.md`: `mango-tune`, `llama-bench`, clocks, bandwidth, GPU loans, before trusting a number.
- `references/hardware.md`: the roads by hardware type.
- `references/levers.md`: the levers in order of yield.
- `references/problems.md`: symptom, cause, remedy.
- `references/building.md`: building the engine, patching, formats the official engine does not read.
- `scripts/find.ps1`: what is on the PC.
- `knowledge/`: the measured facts (`general.md`, `dead-ends.md`, `3060ti-1080-1660s.md`, `method.md`).
- In the Mango Code repo: `docs/INTEGRATION.md` §6 (the engine and the GPUs on loan), `app/crates/engine/` (`mango-tune`, `mango-bench`).
