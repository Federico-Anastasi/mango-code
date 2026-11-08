# Building the engine and, if it pays, patching it

You only get here after `levers.md`: an official build with the right arguments covers almost everything. Building is needed in three cases.

## 1. The downloaded build is not the best for that PC

The official llama.cpp releases are for hardware classes (`cpu`, `vulkan`, `cuda-12`, `cuda-13`). Building yourself
pays off if: the GPU has an architecture the release covers poorly, you need `GGML_CUDA_FA_ALL_QUANTS` (different KV types
for K and V with flash attention), or the processor has instructions the generic build does not use.

CMake options (verified in the source of the fork we use, `ggml/CMakeLists.txt`; names rarely change but check
in the tag you build):

| option | when |
|---|---|
| `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="61;75;86"` | only the architectures present in the PC (`compute_cap` from `nvidia-smi --query-gpu=compute_cap --format=csv`). Building for all of them lengthens the build and bloats the binary |
| `-DGGML_CUDA_FA_ALL_QUANTS=ON` | KV with different types for K and V; without it, the combination either does not start or falls back to the CPU. Lengthens the build a lot |
| `-DGGML_CUDA_FORCE_MMQ=ON` / `-DGGML_CUDA_FORCE_CUBLAS=ON` | try both on prompt prefill: on GPUs without real tensor cores (see `hardware.md`) the fp16 cuBLAS path lost 3.7x against bf16/fp32 (G42) |
| `-DGGML_CUDA_GRAPHS=ON` | CUDA graphs (the default depends on the fork). Their switch-off below Volta is in the runtime code: you need a patch or the `GGML_CUDA_GRAPHS_ANY_ARCH` variable of our fork (G44) |
| `-DGGML_CUDA_NO_VMM=ON`, `-DGGML_CUDA_NO_PEER_COPY=ON` | only if a diagnosis (`problems.md`) points to it |
| `-DGGML_VULKAN=ON` | AMD/Intel GPUs (and NVIDIA without CUDA): needs the Vulkan SDK |
| `-DGGML_NATIVE=ON` | CPU: optimizes for the processor that builds. Do not distribute the binary |
| `-DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON` | a CPU binary that picks the right variant at startup (this is how the official releases are made) |
| `-DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF`, targets `llama-server llama-bench` | shorter build |

How we do it on Windows: `launcher/setup.ps1` (detects the architectures, generates with Visual Studio or Ninja+clang,
`-j 8`). Few processes: several builds together have filled disk C: down to zero bytes. The first build from scratch is long
(tens of minutes): launch it detached and look at the disk first.

After every build: `llama-server --list-devices`, then the **same `mango-tune` trial** as the build it replaces.
A new build that does not beat the old one on the same setup is not kept.

## 2. The engine has a defect or a cost that no argument removes

These are the cases where we patched (details and numbers in `knowledge/3060ti-1080-1660s.md`, patches in the
`mango` branch of the forks mango-prism and mango-toq). Criterion: **first the measurement that says where the time goes**, then the patch.

1. Profile per operation, not per model (`GGML_SCHED_DEBUG=1`, `GGML_CUDA_DISABLE_GRAPHS=1` to see the individual
   kernels, `llama-bench` with `-p` and `-n` separate, the kernel micro-benches). Nsight on Windows did not work.
2. Compare with the **physical ceiling**: bytes read per token ÷ the GPU's real bandwidth. The decode of a dense model normally
   reaches 50-75% (G2): inside that band a new kernel gains little; far below, the problem is kernel, clock or launch.
3. Look at the code and the SASS **before** optimizing: more than once in our history the hypotheses about what limited a kernel were wrong (F31).
4. Every patch has a switch (environment variable) to return to the exact path, and a check that must give
   zero: identical perplexity/KLD, or identical text at temperature 0. A patch without a check is a bet.
5. Re-measure in the real regime (server, long context, draft on): a faster kernel in the micro-bench can lose in
   real use (direct q8 attention in prefill was 0.7x).

What a patch paid for in our history: denying a GPU's fake tensor cores (3.9x in prefill), CUDA graphs where
launch cost dominates (+9-29%), the clock keeper (+27-39%), the per-architecture MMVQ tables, the draft buffer that
copied the model's ubatch. What did not pay: `knowledge/dead-ends.md`.

## 3. A weight format the official engine does not read

Weights in a format of our own or from a fork (ternary PQ2_0 from the PrismML fork, trellis TOQ) do not run on stock llama.cpp:
it loads badly or produces garbage with no errors. The engine must be declared in the profile (`engine`) and the format has its own
kernels per architecture: check **for each GPU** that the quantized path (MMQ/MMVQ) exists for that type; where
it is missing, prefill is 8 times slower and nobody says so.
