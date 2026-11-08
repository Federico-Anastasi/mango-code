# The levers, in order of yield

From the most profitable and least costly to the most costly. Each lever: when it pays, how to measure it, at what price (memory, quality), what to look at. One change at a time (`hygiene.md`);
the base is repeated first (`tools.md`). Numbers and evidence: `knowledge/` (identifiers in parentheses). The numbers are from an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER: orders of magnitude, not forecasts.

**Lossless** = same text at temperature 0 (the test: the same answer to the same request with and without). **Lossy** = changes the weights or the approximations: also measure quality (KLD or perplexity against the reference).

## 0. The right model and format for the hardware (lossy, but it is the choice that matters most)

- The bytes read per token set the ceiling (G3). A MoE with few active parameters on CPU or on slow GPUs; a dense model only where the bandwidth is there.
- The architecture's native format: IQ4_XS on Pascal/Turing (G80); check that the format has the quantized kernel for each of your GPUs (G43). At 2 bits quality depends on the model (G81).
- The file size does not predict speed (G3). Compare two candidates with `mango-tune` before downloading a third.
- Stop here if the model cannot be changed: everything else optimizes that model.

## 1. The whole model in VRAM, with no fallbacks (lossless)

- `-ngl 999` and, to measure, `--fit off`: an OOM must stay an OOM (G18). A single layer off the GPU can cost a factor of 3 (hybrids with DeltaNet).
- If the model does **not** fit: less context, KV q8_0, a smaller quantization, or everything on the processor (`-dev none`). Mango Code never splits
  a model between GPUs and RAM (`--fit`, `-ncmoe`, `-cmoe`): a profile like that is not written.
- Look in the log for `offloaded N/M layers`, `fused Gated Delta Net ... disabled`, `retrying without pipeline parallelism`.

## 2. Context and KV (f16 is lossless; q8 has a small error)

- Memory decides the context (G100): look for the maximum that fits with model + KV + draft + compute buffers, with the margin that will hold the real prompt. Context the user does not use is not worth the speed it costs; Mango Code's prompt is ~14k tokens (14,253).
- **f16 first:** it is faster than q8_0 at long context on 3.6 and on Bonsai (+34% at 64k on 3.6, G61); on 3.8 with the server it gave no gain; if it does not fit, q8_0 with `-fa on`; never q4_0 on old GPUs (F1); K and V of the same type (F2).
- The KV formula (G12) tells you at once whether f16 fits. With hybrid models (few attention layers) the KV is small.
- For mixed types you need a build with `GGML_CUDA_FA_ALL_QUANTS`.
- Measure **at several depths** (1k, 8k, 32k, and the maximum): quantized KV only costs at depth.

## 3. `-ub`, `-np`, `-b` (lossless)

- `-np 1` (a single agent): removes ~750 MB per GPU (G14).
- Higher `-ub` = faster prefill, bigger compute buffer (G13). Start from 512 and go down (256, 128) **only** for an OOM; go up only where the buffer fits. On the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER, 128 → 256 was worth +20% prefill on 3.8 (289 → 347 tok/s) and 256 → 512 +3% on Bonsai (316 → 325). It is not a decode lever.
- On CPU `-ub` is not a lever (F6).

## 4. Split across GPUs (lossless)

- First the minimum number of GPUs (G30). Then `-ts` in **layers**, balancing memory (with KV and draft), more layers to the GPU with more bandwidth as far as it fits (G32). The limit is at the OOM edge: look for the edge with trials in steps of one layer.
- Measure per GPU the real memory (`mango-tune` logs it) and the bandwidth: GPU with more bandwidth = more layers, but only if it is not the only one with the big compute buffer.
- Pipeline parallelism: see whether the engine falls back (G16); switching it off by hand (an `-ot` that touches no tensors, as our bench did) is a shortcut to be measured.
- Split prefill is limited by the weakest GPU (G34): measure prefill **per GPU**.
- Do not try `-sm row` with different PCIe (F10). `-sm tensor` exists in recent official llama.cpp: we never tried it.

## 5. Speculative decoding (lossless, costs prefill and memory)

- **MTP** if the GGUF has the head (`--spec-type draft-mtp --spec-draft-n-max 2`): from +70% to +116% decode on the dense model, +18% on an empty context and +35-47% at 118k on the MoE (G70). `n-max` 2 is the most balanced; 3 wins on code and loses on prose. It costs VRAM (head and graph): the context goes down, and the draft must fit (G72: draft KV f16, small draft ubatch).
  Measure on **real text** (summary and code): the yield depends on predictability (G71).
- **`ngram-simple`** (no drafter, zero VRAM): for agents that edit files, the text is copied again: 26.7 → 69 tok/s (G73). On new text it costs little (−5%/+11%). It is almost always worth turning on.
- On CPU: only ik's speculative decoding; llama.cpp's makes prose worse (G74).
- Low acceptance can be a bug (G75): if the number does not add up, first check the correctness of the path.
- `llama-bench` does **not** use speculative decoding: you need the server.

## 6. Clocks, graphs (lossless; depend on platform and engine)

- **Clocks:** during decode look at `clocks.sm`/`pstate` (`tools.md`). With a layer split the GPUs can end up in P3 (G50): our remedy was a patch (clock keeper). Without the patch: no solution without administrator rights (`nvidia-smi -lgc`); with administrator rights locking the clocks is the road, but it is a change to the user's PC: ask.
- **CUDA graphs:** +9-29% on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (Windows) where launch cost dominates (G44); in stock builds they are off below Volta. Always check the text at T=0 and the speed. A badly captured graph produces wrong text without an error (X6).
- Re-measure **every** optimization in its own regime: the keeper was +36% on normal weights and harmful on the persistent kernel (F40).

## 7. Building and kernels (lossless if the check gives zero)

- A build only for the architectures present; `FORCE_MMQ`/`FORCE_CUBLAS` for prefill (to be measured: we did not compare them; G42 only shows that an fp16 cuBLAS path can lose a lot); an engine version newer than the release (`building.md`).
- Then, if after levers 0-6 you are below the ceiling and the per-operation profile (`building.md`, 2) points to a kernel: a patch. It has a switch and a check that must give zero.

## 8. Quantization and requantization (lossy)

- Take a published quant; measure KLD/perplexity against the reference and MMLU if you change the bits (G81, G82). At equal size another author's recipe is not better (F22).
- A requant made by you (activations at IQ4_XS on CPU, G83) pays only where the limit is bandwidth and only if the format decodes fast; the count of bytes must be multiplied by the decoding cost.
- A recipe of your own (distillation, bit allocation) never beat the base in our trials (F25): it is not a job for this skill.

## 9. On-disk memory and prefix (lossless, changes the first-turn time)

- An agent rereads the system prompt (~14k tokens) at every conversation: with the conversation's on-disk memory only the new tokens are reread (G102). It is already in the app; check that your setup does not break it (`--cache-disk` and `-np 1`).
- The stable prefix between one step and the next (G101): reminders at the tail, never in the system prompt; check with the real request that the template discards nothing.

## When a lever does not pay

Inside the noise = it does not pay: it is not kept, because every extra argument is one more thing that breaks. The profile has only what won against the base, with its measurement.
