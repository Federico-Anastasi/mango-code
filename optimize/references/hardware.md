# Roads by hardware type

What to look at first, what to expect, what pays, which traps. The facts have their identifier (`G40`, `F10`...) in
`knowledge/`. Where we have no measurements, it says so: do not extrapolate from the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER as if it were a law.

## For any GPU: the ceiling first

1. `mango-tune detect --engine <folder>` and `llama-server --list-devices`: name, memory, compute capability, what the engine sees (the driver may not be the one expected).
2. The decode ceiling: `real bandwidth ÷ bytes read per token` (G3). Measure the real bandwidth with a single GPU and a small model (`llama-bench -p 0 -n 128`): the decode of a dense model
   reaches 50-75% of the **real** bandwidth (measured with a read-only kernel) on our GPUs (G2). Much less = clocks (G50), kernel or fallback to the CPU: look at the log.
3. Prefill (prompt) is a different quantity: it depends on compute (G1). Measure **prefill and decode separately** at several contexts; the agent lives both (a turn reads a lot and writes little).
4. Real memory: how much is actually allocated, not what the driver declares (G10). A start test at growing context finds the edge.

## NVIDIA with tensor cores (Turing RTX 20xx, Ampere, Ada, Blackwell)

- On the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER the only such GPU is the 3060 Ti (Ampere): CUDA graphs gave +16-23% in the ik fork, the clock keeper was useful on normal weights and harmful on the persistent trellis kernel (G51); the big gain was in the prefill kernels (trellis, ours) and in the split.
  We never measured Ada and Blackwell: **no data**. Start from the official `cuda-12`/`cuda-13` build right for the cc and measure.
- With a single GPU that holds model + context + draft there is no split: you optimize KV, `-ub`, speculative decoding, maximum context (`levers.md`). More GPUs for a model that fits in one does not speed it up (G30).
- An RTX 20xx (cc 7.5 with tensor cores) must **not** be treated like a GTX 16xx: our TU116 patch for the whole cc 7.5 would penalize it (G41). Do not apply it without measuring GPU by GPU.
- Build (if needed) only for the architectures present (`building.md`).

## NVIDIA without tensor cores or old (GTX 16xx TU116, Pascal GTX 10xx)

This is the case on which we have the most experience.
- **TU116:** stock llama.cpp chooses an emulated `mma` path: prefill 3.9 times slower (264 versus 1030 tok/s on the 1660S, G40). The log says "suboptimal performance due to a lack of tensor cores". It is solved with the patch, which denies `mma` at compile time (`-DGGML_CUDA_TU116`, cc 7.5 only) or,
  more modestly, by trying `GGML_CUDA_FORCE_MMQ` and comparing prefill (we did not measure it as an alternative to the patch). Building without arch 75 does not work (F30).
- **Pascal:** no tensor cores, `dp4a`. Formats with MMQ/MMVQ quantized kernels do well (IQ4_XS is the optimum, G80); those that want `mma` (PTQ1_0, `iq1_m`) prefill 3-8 times slower (G43). CUDA graphs (even though they are off in stock llama.cpp below Volta) gave +9-10% on Windows (G44):
  try `GGML_CUDA_GRAPHS_ANY_ARCH=1` only if the engine has the patch, and check the text.
- Quantized KV costs at long context (G61, G62): f16 if it fits; q8_0 if you need the memory; never q4_0.
- GPUs with 6 GB: the compute buffer decides (G13): `-ub 256 → 128` before touching anything else.

## Several GPUs, even different ones

- The minimum number of GPUs that holds model + context + draft (G30). `-sm layer`, layers with `-ts` **in layers**, balancing the real memory, KV included (G32, G33). The automatic mode goes by the declared VRAM: with a draft it can put the output and the draft on the small GPU (G32).
- Check each GPU's PCIe (`nvidia-smi -q | findstr -i "Link Width"`): `-sm row` and copies between GPUs depend on it (G31). A GPU on x1 is not a GPU to split across.
- Prefill is limited by the weakest GPU (G34): if a GPU without tensor cores does much of the prefill, the road is to move the compute, which needs an engine patch (`building.md`, R10). First measure prefill **per GPU** (one at a time).
- `CUDA_DEVICE_ORDER=PCI_BUS_ID` always (G35); to exclude a GPU use `-ngl 0 -dev none` or `-dev` with the list (G36).
- Mixed NVIDIA + other vendor GPUs: no experience.

## AMD and Intel (Vulkan, or ROCm/SYCL)

**We have no measurements.** The official `vulkan` engine is the general road. What holds all the same: the ceiling from bandwidth (G3), real versus declared memory (G10), KV and `-ub` as knobs, speculative decoding. What we do not know: which quantized
kernels are fast on those GPUs, whether flash attention with quantized KV is as slow as on Pascal, how mixed GPUs split. Measure every lever in `levers.md` instead of trusting our numbers, and say in the report that the road is new.

## CPU only

- Choose the **model** first of all: the bytes read per token decide (G3, G84). A MoE with few active parameters (Qwen3.6-35B-A3B: 3 B active) decodes at 14-15 tok/s on an 8-core desktop; 27 B dense ones 2-4. A dense model on CPU is unusable for an agent.
- The **engine** weighs more than any tuning (G90): ik_llama.cpp with `-rtr -muge` prefills 3.5x faster and decodes +20-25% faster than llama.cpp on CPU. It is a separate engine, to build (clang, a suitable `-march`) or to find already built; it is not the official build. Measure both.
- Threads: decode grows with physical cores (G91). One thread per core with a mask and `--cpu-strict 1` removes the variability of the Windows scheduler (the mask depends on the topology: look at physical against logical cores); for prefill, free threads are better. `--prio`, `--poll`, small `-ub`, power plan: no effect (F37).
- Laptop with a single RAM bank: decode is limited by the channel (G92): recompute the ceiling with the channel's bandwidth. The model takes at most 60-65% of the RAM (G20): the rest is needed by Windows, the context, the agent.
- Context costs: decode in RAM collapses with context (llama.cpp 15.5 → 4.4 at 32k, ik 19.2 → 12.5). The agent's fixed prompt is ~14k tokens: at 70-170 tok/s of prefill (a MoE) that is 80-200 s on the first turn; the conversation's on-disk memory and a stable prefix (G101, G102) are the most profitable levers.
- Fewer bytes per token with more compact always-active parts (G83) is a lever with a quality loss: measure KLD.
- Never `CUDA_VISIBLE_DEVICES=-1`: `-ngl 0 -dev none` (G36).
- Files over the network are not measured (X12). Loading without mmap from a slow disk is part of the user's experience: say so in the report.

## Windows versus other systems

All our experience is Windows 11 (WDDM). The silent VRAM overrun, the pinned-RAM limits, the low clocks with the layer split, the cost of kernel launches: these are effects of the driver or the platform (G11, G19, G44, G50) and on Linux
they might not be there or might be different. If the PC is Linux, treat every number as a hypothesis.

## A new model

For every new model: architecture (dense, MoE, hybrid with DeltaNet: few attention layers, G12), the MTP head in the GGUF (`--spec-type draft-mtp`, G70), the chat template (G101: check what reaches the engine and that non-initial `system` messages are not discarded), the declared maximum context
against the one that fits (G100), the weight-format kernels for **your** GPU (G43). The same procedure for all models: no special cases for an engine.
