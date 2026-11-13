# Common problems: symptom, cause, remedy

Only what we saw and verified. In parentheses the evidence in `knowledge/`. When the symptom is not here, apply `systematic-debugging` (if you have it) or the rule: cause first, remedy after, after two failed attempts stop.

| symptom | cause | remedy |
|---|---|---|
| The engine does not start; the useful message is at the end of the log | almost always OOM: `out of memory`, `failed to allocate`, `cudaMalloc`, `CUDA error`, `failed to create ... context` (G17) | in order: lower `-ub` (256, 128), `-ts` with fewer layers on the small GPU, a shorter context **only if measured that it does not fit**. Look at the compute buffer in the log (G13) |
| It starts but runs 10-30 times slower, especially prefill, and from the second pass on | WDDM moves VRAM to RAM without an error: the model went over (G11) | look at used memory against total **before** measuring; lower `-ub` or context; the NVIDIA setting "CUDA - Sysmem Fallback Policy = Prefer No Sysmem Fallback" (never tried: try it and measure) |
| A hybrid model (DeltaNet) drops to ~3 tok/s | a single layer on CPU switches off the fused DeltaNet kernel for the whole model (`fused Gated Delta Net ... disabled` in the log, G18) | `-ngl 999 --fit off`; reduce the context or the KV until all layers fit |
| Automatic `--fit`: the model runs at a third of the speed and nobody says so | `--fit` (on by default) moved layers or weights to the CPU | always `--fit off`: Mango Code does not split a model between GPUs and RAM; if it does not fit, less context or everything on the processor |
| The automatic `-ts` goes OOM with MTP | the automatic mode goes by the declared VRAM and puts the last layer, the output and the draft on the small GPU (G32) | `-ts` in **layers** balancing the real memory |
| Prefill is much slower than the GPU should manage | a GPU without tensor cores takes the emulated `mma` path (G40), or cuBLAS in fp16 on an old GPU (G42), or a format with no quantized kernel for that GPU (G43) | look at the log (`lack of tensor cores`); try `FORCE_MMQ`; change the format; measure prefill GPU by GPU |
| With quantized KV long context is slow, with a draft worse | flash attention converts the KV to f16 at every step and reserves the copy (G15) | KV f16 if it fits; draft with KV f16 |
| `-ctk q8_0` does not create the context, or with different K and V the GPUs sit at 0% | quantized KV without `-fa on`; different types for K and V → attention goes to the CPU (G60) | `-fa on`; the same type for K and V; or a build with `GGML_CUDA_FA_ALL_QUANTS` |
| The MTP draft does not start: `failed to create MTP context` | the draft's context copies the model's ubatch and reserves a whole-model buffer (G72) | draft KV f16, low `-ub` (or the engine variable that fixes it), less context |
| MTP acceptance is 3-6% (instead of 60-90%) | a bug in the memory of the graph output (`result_norm`), not a limit of the model (G75) | check the path against a reference; a cross graft (one author's GGUF + another's head) isolates the fault |
| The benchmark jumps around (±3-7 tok/s) | clocks in P3 or idle (X3, G53); another CUDA process or a running engine with the keeper (X4); free threads on CPU (G91); the machine is not idle | warm up, repeat, check `pstate`, stop what is not needed, pin the threads; write down the noise |
| The benchmark measures half | another engine or a bench on the same GPUs | one heavy job per GPU at a time |
| `/health` makes the engine crash (or a bench mistakes it for a fault) | a bug in the ik engine (`lite` read from null data), fixed in our branch; in every engine `/health` answers 503 while loading | wait for the 200 with `curl -sf`; do not start measurements before |
| "Stop" does not stop; the engine seems hung reading the prompt | some engines ignored cancellation during prefill | patch already in our ik; with other engines wait for the prefill to end |
| Every request gives 400 `Unable to generate parser for this template` | the GGUF's template does `raise_exception` on non-initial `system` messages (G101) | a copy of the template with one line changed (`launcher\chat-templates\`); it must be redone if the GGUF changes |
| ~1600 tokens of prompt disappear with no error | the model's template silently discards non-initial `system` messages (G101) | render them in place (copy of the template); check with the real request what reaches the engine |
| The prompt is reread from scratch at every step (tens of seconds) | the prefix changes between one step and the next (reminders in the system prompt, different preserved reasoning) (G101) | reminders at the tail; do not change the preserved reasoning mid-session; on-disk memory (G102) |
| The model does not see images, or the engine crashes with the vision encoder | an encoder from another model or a derivative (TOQ-v1: random text for any image); with the encoder on GPU it crashes in `ggml_cuda_op_upscale` | `--no-mmproj-offload` (keeps the encoder in RAM); check that the encoder is the model's right one |
| "Access violation" crash in the middle of a long job | virtual memory exhausted (disk C: full), not RAM (G104) | free the disk, check free virtual memory, large files on another volume |
| The long job dies after ~30 minutes | background commands are closed | detach it (`Start-Process`), save at every step, check the disk first |
| The build runs out of disk | parallel builds | few processes (`-j 8`), free disk beforehand; a from-scratch ik build takes tens of minutes |
| A new feature changes no number | an inherited constraint switched it off without an error (e.g. LoRA ignored with flash attention) | verify with a number that **must** change |
| The wrong GPU gets loaded, or an OOM that appears only with several GPUs | without `CUDA_DEVICE_ORDER=PCI_BUS_ID` the device order is not the driver's (G35) | set the variable; indices from the same source |
| The engine crashes at random when GPUs are "hidden" | `CUDA_VISIBLE_DEVICES=-1` (G36) | `-ngl 0 -dev none` |
| A load from the network or from a slow disk looks like a slow engine | 11.5 minutes for 15.8 GiB from the network without mmap (X12) | model local; do not measure until it is in memory |
| On CPU prefill is much lower than expected with the official build of a ternary model | the fast path wants VNNI; on AVX2 0.7 tok/s (G94) | engine rebuilt with AVX2 dot product, or ik |

For things not listed and for measurement mistakes: `knowledge/method.md`.
