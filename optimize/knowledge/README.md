# Optimizing local inference: the knowledge base

What we learned in months of measurements on three old NVIDIA GPUs and on CPU, written for whoever has to
optimize Mango Code on another PC. Unless a fact says otherwise, it was measured on an RTX 3060 Ti + GTX 1080 +
GTX 1660 SUPER with an i7-10700K; details in [3060ti-1080-1660s.md](3060ti-1080-1660s.md)): on other hardware, measure again before relying on it.
Where two measurements disagree, the text says so. The operating guide is the skill (`../SKILL.md`): it says what to
do and in what order. The evidence lives here.

| file | contents |
|---|---|
| [general.md](general.md) | what holds for anyone: physical limits, memory, multiple GPUs, architectures, clocks, speculative decoding, KV, quantization, CPU |
| [dead-ends.md](dead-ends.md) | roads tried that do not pay, and why |
| [3060ti-1080-1660s.md](3060ti-1080-1660s.md) | example: RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER. Hardware, final setups, our patches, the sequence of turning points |
| [method.md](method.md) | how to measure, and the measurement mistakes we paid for |

The identifiers (`G12`, `F7`, `R3`, `M5`) are stable: the skill and the report of an optimization cite them.

## How to read a number

- A number is valid **with its yardstick**. `llama-bench` (no server, no draft, prefill is the start time of a
  point) and the "as the app starts it" bench (`mango-bench`/`mango-tune`: real server, real text, prompt cache off)
  differ by 2-4 times on prefill and must not be compared with each other.
- "Measured on the three GPUs" is not "valid everywhere". The classes: **G** holds for anyone with that kind of hardware or engine;
  **R** holds only for that hardware (RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER) or for our patches; **F** is a failed attempt (with the why); **X** is a measurement mistake.
- The engine changes things: the "before" numbers are from llama.cpp mainline b9874 (`mango` build), the "after" ones from the `prism` fork
  b10709 with our patches. Comparing the two columns mixes engine, clock keeper and draft.
