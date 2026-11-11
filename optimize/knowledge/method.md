# How to measure, and the measurement mistakes we paid for

Class **X** (measurement mistake) and the method that worked.

## How to read a number

What we learned in months of measurements on three old NVIDIA GPUs and on CPU. Unless a fact says otherwise, it was measured on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER with an i7-10700K: on other hardware, measure again before relying on it. Where two measurements disagree, the text says so. The identifiers (`G12`, `F7`, `R3`, `M5`, `X4`) are stable: the skill and the report of an optimization cite them.

- A number is valid **with its yardstick**. `llama-bench` (no server, no draft, prefill is the start time of a point) and the "as the app starts it" bench (`mango-bench`/`mango-tune`: real server, real text, prompt cache off) differ by 2-4 times on prefill and must not be compared with each other.
- The classes: **G** holds for anyone with that kind of hardware or engine; **R** holds only for that hardware or for our patches; **F** is a failed attempt (with the why); **X** is a measurement mistake.
- The engine changes things: the "before" numbers are from llama.cpp mainline b9874 (`mango` build), the "after" ones from the `prism` fork b10709 with our patches. Comparing the two columns mixes engine, clock keeper and draft.

## The method

- **M1. Find out whether the number is stable before chasing it:** three repetitions and the spread. A spread of 3-7 tok/s was not "the model": it was the clocks.
- **M2. One variable at a time against a fixed base,** same idle machine; the round resumes where it stopped (one line per measurement in `esiti.jsonl`, with status: running, does not start, error, fallback without pipeline, and peak memory per GPU). Failures are data.
- **M3. Measure what the user lives:** context depth (0, 64k, 118-128k) and not only the empty context; real text (code and summary) for speculative decoding; the server with the product's exact arguments, with `--fit off` so that an OOM stays an OOM; one server per point when the argument cannot be changed while running.
- **M4. Re-measure the adopted configuration as the product launches it:** the "launcher-3.6" row of the bench is the same as the trial row.
- **M5. Look in the log after every "does not start":** almost all the causes are compute memory (compute buffer, draft context, cuBLAS), not the model; and the lines that report a fallback (`retrying without pipeline parallelism`, `fused Gated Delta Net ... disabled`).
- **M6. The bottleneck before the lever:** decode that grows with cores says the limit is the processor; bytes read per token ÷ bandwidth says whether it is memory. Then the lever (engine, format, active parts), not the side tuning.
- **M7. Quality with the same engine and the same configuration as the speed:** answer forced with a grammar, perplexity only between files of the same model, KLD against the reference, answers saved one by one, uncertainty stated (one-shot MMLU ±0.9 on 1548 questions, with thinking ±1.7 on 400).
- **M8. Every number carries source, yardstick and protocol;** "indicative" measurements (machine not idle) do not go in the table. A non-quantized reference tells whether two harnesses match.
- **M9. Look at the source when a number does not add up** (Qwen3.5's RMSNorm uses `(1+w)`: perplexity 332.9 instead of 4.037 after four wrong diagnoses).
- **M10. An optimization is validated with a number that MUST change and a variant that MUST give zero:** a LoRA silently ignored because of an old ban with flash attention gave bit-for-bit identical perplexity with and without.
- **M11. Measure every GPU in the real regime before a long job:** 8 hours lost on three wrong setups (1080+1660 for long contexts: 2-3 tok/s per request against 19.5 for the 1080 alone).
- **M12. The prompt chain is read from the real request:** a fake endpoint that saves the request body shows what reaches the model (the tool definitions weighed twice the system prompt); the agent's SQLite store gives the numbers. None of this touches the GPUs.

## The mistakes

- **X1. Different yardstick:** `llama-bench` and the app's server give prefill with a 2-4 times difference (3.6: 2180 against 518-637 tok/s at 64k); the "1.51×" against "1.07×" of two texts was the yardstick (2.6% real, 68 GPU-hours almost spent).
- **X2. Wrong regime:** "L=16 costs 1.4x" measured at batch 16 (launch overhead) cost 8.1x at the real batch of 512.
- **X3. Low clocks:** a bench right after a CPU computation, or with the GPUs idle, measures the GPU in P3: you need 300 ms of warm-up and the best of 3 batches.
- **X4. Bench running together with an engine with the keeper:** it measures half; the keeper takes the GPUs in turn even against other processes.
- **X5. Silent VRAM overrun (WDDM):** prefill went from 320 to 10.7 tok/s without an error, visible only from the second pass. Every measurement goes through a guard that compares used and free memory.
- **X6. A badly captured graph does not crash:** launch without a current stream → replay without the GEMVs, 168 tok/s of plausible, wrong text; with tensors on `cuda:1` without the current device the graph was empty and fell back to eager (1080 and 1660 at about half speed in every run). Correctness (logits, text identical at T=0) before speed.
- **X7. Correctness tests do not find performance bugs:** 3072 dequantizations per token = 0.14 tok/s; another library's `generate()` measures its own wrapper (2.5 against 32.85 tok/s with our own loop); on Windows every operation of a Python library costs 20-30 µs of CPU: the bottleneck can be the loop, not the kernel.
- **X8. An A/B is blind to what both arms pay equally;** a variant "that must give zero" validates the mechanics, not the base.
- **X9. Token-by-token perplexity with int8 activations:** the order of the sums is enough to shift it by ~0.015%. Judge with KLD, a deterministic path and a check with a known perturbation (noise floor 0.0002).
- **X10. The file mapped into RAM:** `llama-bench` with the GGUF mapped keeps everything in RAM (17.9 GB for 16.5) even if it lives on the GPUs; you could not see it without measuring the RAM next to the speed.
- **X11. `llama-bench` uses neither MTP nor the template nor the draft:** the 3.8 numbers were "without"; for MTP you need the server. `llama-perplexity`'s multiple choice does not show the options: 40.5% against 83.7% with the options in view.
- **X12. The file from the network:** the model still loading (11.5 minutes with `--no-mmap` from the network) distorts the first point (3.96 tok/s at 512); official measurements are made with local files.
- **X13. A local metric does not replace the final one:** −25% gate error made the final KLD worse; −6.5% error at L16 = +0.6% perplexity at 3.5x the cost. Recipe decisions are made on the final metric.
- **X14. A single point for a factor:** "30 times slower" (WDDM) is a measurement on one model; elsewhere the same condition is "10 times". Cite the factor with its case.
- **X15. An optimization that changes two variables at once isolates neither:** "15.6 with keeper and without graphs, 27.4 without keeper and with graphs"; the 3.6 "before/after" with engine, keeper and draft changed together.
- **X16. "Indicative" measurements:** CPU on a machine that is not idle, 4 threads at minimum priority. Useful for the order of magnitude; they do not go in the table or in the profile.
