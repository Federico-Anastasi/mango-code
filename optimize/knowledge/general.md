# What holds for anyone

Class **G**: holds for whoever has that kind of hardware or engine. The numbers are from an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER
(with an i7-10700K) and give the order of magnitude, not a forecast for another PC. Abbreviations and how to read a number: [method.md](method.md).

## 1. What limits speed

- **G1. Decode (generation) of a dense model is limited by memory bandwidth; prefill (the prompt) by compute.**
  So a GPU that is slow at prefill can be fast at decode, and vice versa.
- **G2. The real bandwidth is below the declared one, and llama.cpp uses a fraction of it that depends on the architecture.** Real bandwidth
  measured with a read-only kernel: 3060 Ti 422 GB/s, 1080 249, 1660S 319. The decode of Qwen3-4B IQ4_XS uses 73%, 57% and 50% of
  those bandwidths (135, 62, 70 tok/s). On Pascal the limit is the `dp4a` kernel, not occupancy: a sweep of rows and warps gave +5%.
 
- **G3. A ceiling is computed, not guessed:** `max tok/s = real bandwidth ÷ bytes read per token`. For a MoE the bytes are those of the
  active parameters (Qwen3.6-35B-A3B: 3 B active out of 35 B): 50-60 tok/s on the GPUs, 14-15 on the desktop CPU; a 27 B dense model on
  CPU does 2-4. The file size does not predict speed: at 6.7 GiB Bonsai 2 decodes at 26.6 tok/s, a 2-bit Qwen3.8 at 14.9.
- **G4. The forecast from bandwidth holds only if the limit is bandwidth.** With 1-2 bit trellis weights the kernel is limited by decoding instructions, not by DRAM (~4.3 instructions per weight): on the 1660S 214 GB/s effective out of the 305 measured in a read-only test; at 4 bits it is memory-bound again. On the 1080 decode stops at ~72% of the bandwidth with any
  format ([dead-ends.md](dead-ends.md) F24).
- **G5. Measure per operation before hypothesizing.** The "by eye" hypotheses (pipeline, clock, CUDA graph) were wrong or partial;
  the real waits (the scheduler that stalls the CPU at every pass between GPUs, a small weight in RAM that sends an operation to the CPU) were
  found with `GGML_SCHED_DEBUG=1` and per-batch times.

## 2. Memory

- **G10. The VRAM CUDA declares free is not what can be allocated.** Measured: declared 7128/7187/5134 MiB, allocatable
  7488/7520/5440 (360, 333 and 306 MiB more per GPU, ~1 GB over the three). On top of that Windows (WDDM) keeps a reserve of ~1 GB per GPU
  (`RIP`: 1063 and 1009 MiB between total and declared free). llama.cpp splits the layers on the declared figure: with `-ts` by hand you reason on the real memory,
  and you measure how much is allocated (32 MiB blocks until the first refusal).
- **G11. On Windows going over the VRAM gives no error: everything runs much slower.** A 27B on the 3060 Ti (weights 6326 + buffer 1204 MiB on 7128 free):
  prefill 10.7 tok/s instead of 320, visible only from the second pass. 4 slots × 4096 tokens fit (8013 MiB, full speed); 4 × 6144 went over
  (10 times slower). The NVIDIA setting "CUDA - Sysmem Fallback Policy = Prefer No Sysmem Fallback" would turn it into an error: it is written in three
  documents, **never tried on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER**. Cure tried: a guard that compares used and free memory before every measurement.
- **G12. The KV cost is computed.** `attention_layers × 2 × KV_heads × head_size × bytes`: Qwen3.8/Bonsai (16 layers, 4 heads, 256) are
  34 KiB/token in q8_0 (4.25 GiB at 128k) and 64 KiB in f16; LFM2.5 20 KiB/token in f16 (2.5 GiB at 128k). Hybrid models (Gated DeltaNet) have few
  attention layers but a recurrent state for every slot (~150 MB per slot).
- **G13. The compute buffer grows with `-ub`:** it is the first knob for an OOM. Qwen3.8: `-ub` 128 → prefill 289 tok/s, 256 → 347, 512 does not start on the 6 GB
  GPU (`mango` build, with the TU116 patch). Measured exception: Bonsai 2 with 512 has a smaller buffer (1242 against 1346 MiB) and prefills more
  (325 against 316), cause not verified.
- **G14. `-np 1` removes ~750 MB per GPU** compared with the server default.
- **G15. With quantized KV and more tokens at a time (prefill, verification of a draft) flash attention converts a layer's whole KV to f16,** and the compute
  buffer reserves that copy: 2 KB per context token on 3.6, 256 MiB per GPU at 128k. The kernel that reads q8 directly is slow at long context:
  forcing it for 2-4 tokens makes things worse (at 64k 23.4/28.1 instead of 35.9/42.2 tok/s).
- **G16. If the compute buffer does not fit, llama.cpp falls back by itself "without pipeline parallelism"** (slower) without reporting it as an error. Look for it in the log
  (`retrying without pipeline parallelism`). With `-ub 512` or with an MTP draft the pipeline does not fit.
- **G17. The margin is hundreds of MiB:** 3.6 at 128k leaves ~1 GB in total; the 1660S was ~140 MiB from the crash point; 24 starts out of 46 on the 26 Oct bench
  were "does not start", almost all because of the compute buffer, the draft's context or cuBLAS. An OOM at the limit does not say whether the limit is real: retry with less context or a lower `-ub`.
- **G18. `--fit` (on by default in current llama.cpp) moves layers and weights to the CPU without saying so.** On a hybrid model a single layer off the GPU switches off the fused Gated DeltaNet kernel
  for the whole model: 3.2 tok/s. To measure: `--fit off -ngl 999`, so an OOM stays an OOM. For use: `--fit` with `-fitt` (margin) is the right tool when the model does **not** fit
  entirely in VRAM.
- **G19. Windows limits "pinned" RAM:** a single allocation of ~4.4 GB is refused even after one of 2.4 was granted; with three GPUs the ceiling comes sooner. One buffer per layer is allocated (~92 MB)
  and you check that it is really pinned (otherwise the copies become synchronous, with no errors).
- **G20. A MoE or dense model on CPU needs free RAM, not only total:** the model takes at most 60% of the RAM (at 64k context); a 10.4 GB 2-bit on a 16 GB laptop (Windows uses ~5.7) leaves 0.6 GB. From the network,
  loading without mmap costs 11.5 minutes for 15.8 GiB (30 s locally).

## 3. Several GPUs

- **G30. With the layer split (`-sm layer`) the GPUs work in line:** each one sits idle for much of the token. Adding GPUs adds memory, not speed: use the smallest number of GPUs that holds
  model, context and draft. Measured on the same bench: TOQ 27B 35.7 tok/s on the 3060 Ti alone against 26.0-26.2 on 3060+1660 (38/26 layers). The price of the single GPU is the context (~14k).
- **G31. `-sm row` on narrow PCIe is a disaster:** Qwen3.8 prefill 35 instead of 140, decode 7.9 instead of 17.8 (GPUs on x16/x4/x1). On uniform fast PCIe it is not measured.
- **G32. The automatic `-ts` goes by the declared VRAM and with a draft it can fail:** 3.6 with 16/15/11 puts the last layer, the output and the whole draft on the smallest GPU (OOM); `16,16,10` in **layers** moves a layer to the middle GPU
  (the 1080, which at 128k had 774 MiB free) and makes 128k fit. 3.8 with MTP: `42,36,22` (more layers to the GPU with more bandwidth), `44,36,20` does not fit. Rule: `-ts` in layers, balancing the **memory** (KV included), not the bandwidth percentages.
- **G33. Attention layers carry the KV:** in a hybrid model every N layers there is an attention that weighs (Bonsai: 544 MiB at 256k) and the balancing is on memory, not on the number of layers.
- **G34. Split by layers, prefill is limited by the compute of the weakest GPU:** 3060 Ti + 1660S did 136 tok/s with the 3060 working 5% of the time. If a GPU without tensor cores does much of the prefill, you move the **compute** to the strong GPU by making the weights travel
  (pinned RAM → GPU): 664/757/649/508 tok/s at 1k/32k/64k/120k (our patch, [3060ti-1080-1660s.md](3060ti-1080-1660s.md) R10). The cost is PCIe bandwidth (12.9 GB/s for the GPU on x16, 0.8 on x1).
- **G35. `CUDA_DEVICE_ORDER=PCI_BUS_ID` always**, otherwise `cuda:1` can be a small GPU and goes OOM (invisible with a single GPU).
- **G36. To exclude GPUs use `-ngl 0 -dev none`**, not `CUDA_VISIBLE_DEVICES=-1`: with the latter the engine crashed 4 times out of 9 (access violation), 0 out of 10 with the other.
- **G37. Process parallelism across several GPUs is not free:** launch-bound processes on 3 GPUs, the 3060 slows down 3.5 times and the 1660 1.8; at most 2 heavy processes together (measured on an encoder, not on inference).

## 4. Architecture and kernels

- **G40. A GPU without real tensor cores runs in emulation the path llama.cpp chooses for "Turing".** The GTX 1660/1650 (TU116, cc 7.5) has HGEMM 0.6 TF against 61 for a 3060 Ti; llama.cpp treats it as Turing with `mma`: prefill 264 tok/s on the 1660S. Denying it `mma` (dp4a only) takes it to 1030 (3.9x);
  whole Qwen3.8 140 → 347, Qwen3.6 471 → 1014. Building without architecture 75 (PTX 61 via JIT) does not work: 84 tok/s and the JIT eats VRAM. llama.cpp's logs say so: "suboptimal performance due to a lack of tensor cores".
- **G41. RTX 20xx have the same cc 7.5 but with tensor cores:** a build with the TU116 patch for the whole cc 7.5 would penalize them (deduced from the code, not measured). The patch must be per device, or a separate build per GPU model.
- **G42. The "standard" library can be many times slower on an old GPU:** the branch that rebuilds the weights in fp16 and calls cuBLAS with fp16 accumulation was 97% of the prefill time on the 1660S (6.6 ms for 3584×1024×512, ~0.6 TFLOPS);
  with bf16 weights and fp32 accumulation prefill 510 → 1872 (3.7x, on the 0.8B). Turing has no real bf16 (cuBLAS bf16 at 2.5 TF). Found by measuring per operation.
- **G43. A weight format has kernels only for some architectures.** PTQ1_0 has batched multiplication only where real Turing `mma` exists: on three GPUs it prefills 8 times slower (47 s against 6 per perplexity step). `iq1_m` does not have it on the GPUs: a 3.6 with `iq1_m` experts prefills at a third (750 against 2200 tok/s).
  Before choosing a quant, check the quantized path for **every** GPU.
- **G44. CUDA graphs:** stock llama.cpp switches them off below Volta (cc < 7.0). On the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (Windows/WDDM) turning them on even on Pascal/Turing gave +9-10% decode (Qwen3.8: 9.9 → 10.8 without MTP, 16.1 → 17.7 with) and +20% on Bonsai/1080 with the graphs alone (17.3 → 20.7; 22.4, +29%, together with the new MMVQ kernels); in the ik fork +16-23% below Ampere.
  The cause stated in the code is the launch cost on WDDM, so it is a **platform** effect, not an architecture one. A badly captured graph gives no error: it produces plausible, wrong text (check with identical text at temperature 0).
- **G45. Every kernel table (MMVQ: rows per block, warps) is per architecture:** Pascal 62.2 → 65.4 tok/s (+5%) with 1 row/1 warp; Turing stays better with its own table (73.8 against 70.4); for ternary PQ2_0 the dedicated geometry gave 1080 151 → 179 GB/s, 1660S 131 → 248, Bonsai 3 GPUs 23.7 → 28.4. These are gains that require building and measuring.
- **G46. A kernel more precise than necessary is paid for:** the "exact" trellis GEMM cost 4 times; rounding the weight to one byte (`round(q/4)`) costs +0.02% perplexity (6.9789 against 6.9776) and is worth 2.5x. Judge with KLD and a check that must give zero, not with token-by-token perplexity (with int8 activations the order of the sums is enough to shift it).

## 5. Clocks

- **G50. With the layer split the driver sends the GPUs into a low clock state (P3).** Measured the 3060 Ti at 720 MHz SM / 5000 MHz memory instead of 2100 / 7000. Without administrator rights the clocks cannot be locked (`nvidia-smi -lgc`).
  An idle warp on a minimum-priority stream (the "clock keeper" in our patches) keeps them up: Qwen3.6 +27-39% decode (30.3 → 42.2 on an empty context; six repetitions in a row 36 → 24 without it, 42.0 steady with it), Bonsai 2 17.4 → 23.7 (+36%). Cost: at idle the GPUs stay at 160 W if the warp runs all the time; it must start only if there was a graph in the last 0.5 s.
- **G51. The keeper is not always a gain:** on the persistent trellis GEMV (as many blocks as fit) the warp takes away a slot: 26.2 → 19.4 tok/s without CUDA graph; with graphs on and without MTP the difference is small (at 120k equal); with MTP on two GPUs it helps (27.5/24.3 → 30.3/30.7). In the app it is off because in the app it was worse.
  The rule is to **re-measure every optimization in its own regime**.
- **G52. A kernel bench launched right after a CPU computation measures the GPU in P3** (~900 MHz): you need 300 ms of warm-up and the best of 3 batches. And a bench running together with an engine with the keeper measures half.
- **G53. The variability between repetitions is a result:** the first round gave 31.70 ± 3.35 tok/s; it was the clocks, not the model.

## 6. KV cache and flash attention

- **G60. Quantized KV requires flash attention** (q8_0 without `-fa` does not create the context) and **K and V must have the same type**: with f16 keys and q8 values attention runs on the CPU (GPUs at 0%, trial stopped by hand after 13 minutes). For mixed types build with `GGML_CUDA_FA_ALL_QUANTS`.
- **G61. f16 KV is faster than q8_0 at depth, but weighs more.** Qwen3.6 IQ4_XS: 64k 34.9 against 26.1 tok/s (+34%); at 128k f16 does not fit (at 120k it decodes 29.8; q8 at 128k 18.6). IQ2_XXS 128k: 31.1 against 19.4 (+60%). Bonsai 2 128k: 12.5 against 8.7; f16 costs 17.4 GiB against 14.6 and at 256k q8 is needed.
  On 3.8 the sources diverge: `llama-bench` gives +17-34%, the app's server "fits but does not gain". On our Pascal/Turing/Ampere q8_0 was never faster than f16 at long context.
- **G62. q4_0 KV is a dead end on old GPUs:** Qwen3.8 prefill 47-53 (from 140), decode 8-9 (from 17.8); Bonsai at 64k 10.3 against 16.1 for f16.
- **G63. The draft has its own KV:** `-ctkd/-ctvd f16` for the MTP draft (one layer: it costs 272 MiB against 136+256 in q8), model q8_0.

## 7. Speculative decoding

All lossless (the model verifies every token). The yield depends on how predictable the text is, and it always costs prefill.

- **G70. MTP (the prediction head inside the GGUF; `--spec-type draft-mtp --spec-draft-n-max 2`):** dense Qwen3.8 10.4 → 17.8 tok/s (55% acceptance, mean length 2); `n-max` 2 = 18.6-19.8, 3 = 17.4, 4 = 13.6 ("verifying a batch of 5 is not free" on slow GPUs).
  Qwen3.6 MoE at 118k, same engine: ~21 without → 28.8-31.2 with (+35-47%; drafts accepted 65-83%; the 16.7 of the previous engine without draft mixes engine, keeper and MTP); prefill goes down (at 64k 716 → 466 tok/s: the head rereads the prompt). `n-max` 3: +8-10% on code, −4-12% on prose.
- **G71. MTP yields much more on code than on text:** at 64k code 42.2 tok/s (drafts 159/191), summary 35.9 (66/102). Measure on real text (summary and code), not on synthetic prompts.
- **G72. The draft needs VRAM:** the draft's context copied the model's ubatch and reserved a whole-model buffer (432 MiB at 128k with `-ub 512`, 294 with 32). With `LLAMA_MTP_UBATCH=32` (our patch) and draft KV f16 the draft fits at 128k; without, "failed to create MTP context".
- **G73. `ngram-simple` (no drafter, zero VRAM)** takes drafts from the context: Bonsai 2 on edits (the agent copies the file again) 26.7 → 69 tok/s (>95% accepted), new text −5%; LFM 99 → 139 on recopied files, new text 100 → 111. Excellent for agents that edit files.
- **G74. On CPU llama.cpp's MTP helps only on code and makes text worse** (13.1 against 14.3 on the summary): it proposes more drafts and gets half wrong, and checking them on the processor costs. ik_llama.cpp proposes one at a time (22.2-24.6 at 2 bits against 18.6-18.9 without).
- **G75. Low acceptance can be a bug, not a limit:** MTP acceptance 3-6% → 92% after fixing the memory of the graph output (`result_norm` not marked, reused by the allocator). The "kernel against reference" check was blind because it shared the input; the cause was isolated with cross grafts (81% with our layer + another author's GGUF, 6% with our head).
- **G76. The cost of verification decides whether MTP pays:** at 2 tokens it costs ×1.44 on the 3060 and ×1.8 on 3060+1660; with 92% acceptance decode did not speed up (26.3 → 26.3) as long as the MTP layer was bf16 (810 MiB); in trellis (101.5 MiB) 35.9 → 46.5 (+30%).

## 8. Quantization and model

- **G80. The architecture's native format:** IQ4_XS is already the optimum on Pascal/Turing (dp4a): Q4_K_S 14.6 against 17.8, Q4_0 = IQ4_XS, Q4_K_M slower.
- **G81. At 2 bits quality depends on the model:** one-shot MMLU Qwen3.6 4 bit 83.7 → 2 bit 80.7 (−3); Qwen3.8 82.6 → 72.9 (−10). At 2 bits the models sometimes stop closing their reasoning (12-21 questions out of 400 without an answer). The ternary Bonsai 2 (dense) beats the Unsloth 2 bit by 5-6 points at equal size.
- **G82. At equal size, another author's recipe is not enough to beat the standard one:** the antirez recipe (`iq1_m` experts at 2 bits) does not beat Unsloth and prefills at a third. Equal size at 4 bits: same perplexity (7.12) and MMLU.
- **G83. The quantization type for active parts against experts:** on CPU 83% of the bytes per token are the always-active parts (attention, DeltaNet, head), not the experts. Requantizing the active parts to IQ4_XS: bytes per token 1.57 → 1.27 GiB (−19%) at 2 bits, decode on the laptop +16.4% (forecast +23%: IQ4_XS decodes slower, 13.76 → 13.02 GiB/s), KLD 0.1611 → 0.1732;
  at 4 bits 2.318 → 1.571 GiB (−32%), KLD 0.0410, desktop decode +28/+40% (machine not idle: indicative). **The count of bytes must be multiplied by the format's decoding cost.**
- **G84. The model must be chosen by the bytes read per token:** on CPU only a MoE with few active parameters is usable; Qwen3.6-35B-A3B is the only one we found (LFM2.5-24B-A2B, Gemma 4 26B-A4B, gpt-oss-20b discarded as weaker for agents).
- **G85. The reduced draft (reduced-vocabulary head for the drafts, FR-Spec)** is forecast ×1.5 on CPU: MTP on the laptop gave only ×1.23-1.39 (forecast ×1.5-1.6) because every draft rereads the head (0.27 GiB). Not done.

## 9. CPU

- **G90. The engine changes more than all the tuning together.** Same file, same machine (i7-10700K, DDR4-3600): ik_llama.cpp with `-rtr -muge` prefills 172/156 tok/s against 49/45 for llama.cpp (3.5x) and decodes 19.2/14.5 against 15.5/11.9 (+20-25%); at 32k llama.cpp falls to 4.4, ik to 12.5. Dense models: ik prefills 4-7x, decodes +10-15%.
- **G91. On desktop decode is limited by compute, not by RAM:** it grows with cores (6 threads 12.7, 7 → 13.6, 8 → 15.3). Pinning one thread per core (`-C 0x5555 --cpu-strict 1`) removes the case in which Windows puts two on the same core (prefill from 48 to 37, −23%). The mask depends on the topology (here 8 cores/16 threads with adjacent SMT); 16 pinned threads are worse (13.7 against 15.2); for prefill 16 free threads do better.
  `--prio`, `--poll`, small `-ub`, the "high performance" power plan: no effect.
- **G92. On a laptop with a single RAM bank decode is limited by bandwidth:** 1.57 GiB per token × 8.6 tok/s = 13.5 GiB/s ≈ 70% of the single DDR4-2400 channel.
- **G93. A MoE on CPU: `-rtr -muge` (ik) and the count of bytes** (see G83). Cheap prefill (fewer experts when reading the prompt) speeds up only 7-8%: it is not a speed lever but a quality one (4@30-38 costs 0.005-0.023 KLD). `-ub 4096` makes things worse (prefill 58.7 against 81-85, 3.9 GB more; indicative measurement, machine not idle).
- **G94. The wide-instruction path may be missing:** Bonsai 2's official engine wants VNNI: on AVX2 it decodes at 0.7 tok/s; rebuilt with an AVX2 dot product ~4 tok/s (4.1); ik reads the dense models by itself and makes this unnecessary.

## 10. Context, prefix, on-disk memory

- **G100. VRAM decides the context, not preference:** target 128k; lower it only if measured that it does not fit: Qwen3.6 128k with q8 KV (f16 only 120k), Qwen3.8 80k (beyond that, the engine moves layers to the CPU or crashes with a CUDA error during prefill), Bonsai 2 256k (1 slot), LFM 128k f16, TOQ 120k on two GPUs, ~14k on a 3060 Ti. 256k on 3.6 does not fit.
- **G101. The prompt prefix must stay stable between one step and the next,** otherwise every step rereads everything: reminders at the tail and never in the system prompt; changing the preserved reasoning mid-session makes the whole context be reread (reinjecting the system prompt alone cost ~40 s of GPU). A model's Jinja template can silently discard or reject non-initial `system` messages (Qwen3.6 discards ~1600 tokens, Qwen3.8 raises a 400): check the real prompt that reaches the engine.
- **G102. The conversation's on-disk memory (`--cache-disk`) avoids rereading the prompt:** 42.6k tokens → a 1.82 GiB file saved in 1.7 s; after the restart 22 tokens are reread instead of 42,649 (1.2 s against ~1 minute). An agent's system prompt (~18.6k tokens at ~790 tok/s) costs 20-35 s on the first message without it. It is a feature of our patches, but the cost to avoid is everyone's.
- **G103. The host's RAM can be cut:** `--no-mmproj-offload` keeps the image encoder in RAM; with `llama-bench` `-lm none` avoids a mapped GGUF staying entirely in RAM even if it lives on the GPUs (17.9 GB for a 16.5 GB file). On 20 Sep `llama-server` had ~25 GB private out of 32 with `--cache-ram` at 8 GB (ENG), which were cut; another episode (KI) cites ~14.7 GB.
- **G104. A long process on Windows is detached** (`Start-Process`, saving at every step): background commands die at ~30 minutes or when RAM runs short; exhausted virtual memory (disk C: full) gives "access violation" without the RAM being used up.
