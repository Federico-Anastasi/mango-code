# Roads tried that do not pay, and why

Class **F**. A road listed here is not forbidden: it cost a measurement, and repeating it needs a new reason (another
architecture, another engine). Where the reason is the specific hardware, it says so. Sources: abbreviations in [README.md](README.md).

## Memory and cache

- **F1. q4_0 KV.** On Pascal flash attention with q4 KV falls onto the slow path: Qwen3.8 prefill 47-53 (from 140), decode 8-9 (from 17.8); Bonsai at 64k 10.3 against 16.1 for f16.
- **F2. Different types for K and V** (f16 K, q8 V): attention runs on the CPU, the GPUs stay at 0%; trial stopped after 13 minutes.
- **F3. f16 KV at 128k on 3.6 at 4 bits:** does not start (110k and 120k do). The 2 bit fits even in f16 (31.1 tok/s at 128k).
- **F4. Forcing flash attention's "vec" kernel for 2-4 tokens with quantized KV:** on an empty context 55.5/60.5 but at 64k 23.4/28.1 against 35.9/42.2 without.
- **F5. `-ub 256` on 3.6 to make pipeline parallelism fit:** the draft is left without space and prefill drops by 15%; the pipeline does not help prefill on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER.
- **F6. Raising `-ub` to 4096 on CPU:** prefill 58.7 against 81-85 and +3.9 GB of working memory (indicative measurement: machine not idle); 128/256 change nothing.
- **F7. Trimming the context to make the draft fit:** below 64k MTP gains nothing more on 3.8 (48k = 18.7 tok/s); the memory it frees is not the lever.

## Several GPUs

- **F10. `-sm row` on GPUs with different PCIe (x16/x4/x1):** Qwen3.8 prefill 35 (from 140), decode 7.9 (from 17.8). On the morning of 25 Aug it showed up as "OOM, duplicates too much"; after the corrected build it is decode that collapses.
- **F11. Reversed GPU order** (`CUDA_VISIBLE_DEVICES=2,1,0`, `1,2,0` with different `-ts`; idea: give output and draft to the last GPU): 11 combinations, none starts.
- **F12. More layers to the strong GPU beyond the limit:** Qwen3.8 `44,36,20` and Bonsai `34/18/13` do not fit at 128k; 3.8 with `-ts 38,38,24` beats the automatic mode but `40,40,20` and `44,38,18` fail. The optimum is at the OOM edge.
- **F13. Two local models together (`-np 2`, 2 slots of 128k) for two agents:** 20.0-21 tok/s each against 27.1-27.6 alone; while one prefills a long prompt the other drops to ~4.5. Removed by product decision.
- **F14. More prompts >128 tokens together on 1080+1660 with prefill on the main GPU:** the engine hangs (switched off with `LLAMA_PREFILL_MAIN_MIN=1000000`), cause not investigated. With `-np 4` the TOQ server collapses.
- **F15. Three GPUs with MTP at 128k for TOQ:** the head on the 1080 takes the 3060's buffer from 242 to 698 MB, cause not found.
- **F16. More copies of the scheduler's pipeline (1, 2, 4):** 135 tok/s all the same, change removed.
- **F17. More than 2 heavy processes together:** with 3 launch-bound processes the 3060 slows down 3.5x and the 1660 1.8x; the theoretical "2.25x on 3 GPUs" "must be re-measured".
- **F18. 8 or 10 quality requests in parallel on a single 8 GB GPU:** the server closes with `create_context` failed; with 6 it starts.

## Formats and quantization

- **F20. Bonsai 2 in PTQ1_0 (5.9 GB)** instead of PQ2_0: it has MMQ only with Turing `mma`; on 1080/1660S it falls back to dequantization + cuBLAS. On the 3060 Ti alone 34.3 tok/s but maximum context 32k; on three GPUs it decodes at half and prefills 8 times slower. The same weights in PQ2_0 give the same quality numbers (perplexity 9.5371 against 9.5373).
- **F21. Q4_K_S, Q4_0, Q4_K_M instead of IQ4_XS on 3.8:** 14.6 against 17.8; Q4_0 equal; Q4_K_M slower and +1.5 GB. A mixed requant is not worth it.
- **F22. The antirez 2-bit recipe (`iq1_m` experts):** does not beat Unsloth in quality (perplexity 8.41 against 7.69) and prefills at a third because `iq1_m` has no batched multiplication on the GPUs; the "fast" version with `iq2_xxs` (9.67 GiB) is in between (perplexity 7.95 against 7.69; MMLU with thinking 80.0 against 82.5).
- **F23. 2 bits on the 27 B dense model:** Qwen3.8 loses 10 MMLU points (82.6 → 72.9). A MoE tolerates more (−3).
- **F24. "Striped" PQ2_0 kernel (funnel shift) for the 1080:** 178 → 174 GB/s (loses); for Turing +1.6% (248 → 252), within the noise on the whole model. The 1080 stops at ~72% of the bandwidth with any decoding (even q4_0, iq4_xs: 193-202 GB/s): the limit is memory access (a 128-bit load was never tried).
- **F25. Requantizing from BF16 with a recipe of our own** (distillation on the symbols, per-expert bit allocation, two-sided rotation): in three research branches none beat the base (per-expert allocation: 7.428 uniform against 7.642; distillation on the symbols: Newton step with predicted ΔKL −129, measured +16; distillation reduces KL by 23% but MMLU stays equal, 78.04 against 78.29, p=0.77). For a user: take a published quant and measure.

## Kernels and engine

- **F30. Building without architecture 75 (PTX 61 via JIT) to avoid the 1660S's emulated `mma` kernels:** 84 tok/s of prefill, and the JIT module takes up VRAM. The patch denies `mma` at compile time, for cc 7.5 only (`-DGGML_CUDA_TU116`).
- **F31. Optimizing the kernel before looking at the code:** `v5` (magic numbers to eliminate the conversion) 0.91-0.95x because nvcc was already applying it; a grid-stride kernel was the worst (occupancy counts); PRMT+LOP3 would have optimized 2.6% of the time. The estimate "five hypotheses out of five refuted" covers three cases (two measured, one estimated).
- **F32. The "exact" trellis GEMM with the 4 bytes of `state·K`:** four times the tensor work (15 equivalent TFLOPS against 29 for cuBLAS bf16). The weight rounded to one byte is used (+0.02% perplexity, 2.5x).
- **F33. The tensor-core GEMV with 2 columns:** loses against the GEMV (47.8/53.3/58.7 ms against 43.3/57.4/70.5 at 2/3/4 requests); the threshold is at 3. The 4-column GEMV is limited by integer arithmetic (7 operations per weight), not by memory nor by occupancy.
- **F34. Prefill attention directly on the q8 KV (`FA_Q8_PREFILL`):** 38 MB temporary instead of 480 at 120k, error 4e-4 against 1e-2 for f16, but 0.7x the speed (prefill 508 → 393 at 120k). Off by default; only useful where memory is short.
- **F35. Cheap prefill of the experts on CPU** (fewer experts for the tokens being read): speeds up 7-8% because the experts are ~35% of the prefill time and 21% of the bytes. It is a quality knob, not a speed one.
- **F36. Approximation ideas for skipping layers on CPU** (per-token linear transport; mean field of the experts): error still 0.27-0.60 at 30-38 layers; R² 0.05-0.33 against the threshold 0.3-0.4.
- **F37. High priority, active waiting, "high performance" power plan, 16 threads pinned on 8 physical cores:** no gain (16 pinned 13.7 against 15.2).
- **F38. Another CPU engine:** OpenVINO (official int4) 27 tok/s prefill and 11.0-11.8 decode, the slowest; KTransformers, PowerInfer, vLLM, SGLang, T-MAC, llamafile, IPEX-LLM discarded (GPU only, Linux only, other models, or llama.cpp underneath).
- **F39. Trellis (TOQ) on the processor:** every weight costs ~4 decoding instructions and the CPU has little compute per byte; a table saves nothing. For a PC without GPUs, look for a MoE.

## Clocks and CUDA graphs

- **F40. The clock keeper on the persistent trellis GEMV without CUDA graph:** 26.2 → 19.4 tok/s (the warp takes a slot from the persistent blocks). With graphs on and MTP it helps or is equal; in the app it stays off. The app comparison "15.6 with keeper and without graphs, 27.4 without keeper and with graphs" changes two variables at once and does not isolate the keeper.
- **F41. A kernel bench after a CPU computation:** the GPU is in P3, all the numbers underestimated.

## Streaming from disk and engines we built

- **F50. An engine of our own for a model larger than the RAM** (GLM of 255 GB streamed from NVMe on 32 GB): at best 0.2238 tok/s (+12% over llama.cpp, 0.2). The bottleneck is moving data from the disk (the compute of all the experts of one token is ~0.62 s, end-to-end 6.17 s). Working set of 10,684 experts = 120 GiB; LRU hit 0%, LFRU worse; the profiled static pin takes 31% with 1 GPU, 56% with 3. Discarded: RAM-tier with malloc and VirtualLock (they steal page cache), predictive prefetch, attention on GPU.
- **F51. A hot set of experts profiled on wikitext** does not hold for the agent: hit 10.2% against 53.5% expected; the effect is the text domain's (1.5x), not the context's.
- **F52. CPU offload of a 27 B dense model:** every layer off the GPU is paid for at every token, and a single layer switches off the fused DeltaNet kernel for the whole model (3.2 tok/s). `-ncmoe` exists only for MoEs.

## Estimates never verified (not failures: they are open ideas)

- `-ot` to move the slow GPUs' FFNs onto the strongest: forecast +4% (Bonsai) or 28-30 tok/s; the 28.4 came with keeper and MMVQ, not with `-ot`. It would switch off pipeline parallelism.
- A tile kernel that reads q8 without the f16 copy (it would free 256 MiB per GPU on 3.6).
- NVIDIA's Sysmem Fallback setting to turn going over into an error.
- The reduced draft (FR-Spec) on CPU, forecast ×1.5.
