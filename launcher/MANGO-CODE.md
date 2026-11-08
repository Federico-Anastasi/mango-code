# mango-code — a local coding agent

> **What it is:** a real coding agent — opencode — running against a **local, offline model** instead of the cloud,
> on your own hardware. One command: `mango-code`. This document covers the terminal; the desktop app is in
> `app/README.md`, the integration for other apps in `docs/INTEGRATION.md`.

## Installation (from cloned repo to working tool)

```powershell
cd mango-code\launcher
.\setup.ps1
```

It does everything: builds the two engines from source with the repo's patches (`llama-prism`: PrismML fork for 3.6,
3.8, bonsai2, lfm; `llama-toq`: ik_llama.cpp for TOQ), builds the agent (`opencode`: from the repo's own sources,
`packages/`), downloads the **GGUF** files from Hugging Face, runs `npm ci`, writes this machine's paths
(`mango-paths.json`) and installs the `mango-code` function in the PowerShell profile. It is **idempotent** and can be
run in parts with `-Only llama-prism|llama-toq|opencode|launch|models|npm|config|command`; binaries and weights
elsewhere with `-Llama D:\... -Models D:\... -Opencode D:\...`. Building needs git, cmake, Ninja, nvcc 12.x, Visual
Studio (MSVC) and, for TOQ, clang-cl (from the PATH, from `LLVM_DIR`, from `C:\Program Files\LLVM` or from Visual
Studio's "C++ Clang tools"); the agent needs Bun 1.4.2 or later.

**What is NOT in the repo, and why:** the engine and agent binaries (~1.5 GB) and the GGUF files (~60 GB) don't belong
in git. The repo stays self-consistent because it contains the **code that gets them**: the source commits and the
engine forks' tags (`prism_build`, `toq_build`), the Hugging Face repos in `mango-models.json`. The only thing that changes from
machine to machine is `mango-paths.json`, which is generated.

## How to use it

From **any** folder, in a new terminal:
```powershell
mango-code                     # opens the agent in the current folder, on the local model
mango-code -p "do X"           # one-shot
mango-code -Models             # lists the configured models, * = the one loaded now
mango-code -Model 3.8          # switches model (reloads the engine); the choice sticks
mango-code -EngineOnly         # starts only llama-server, without opening the agent
mango-code -Lan                # opens the engine to the other PCs on the wifi (sticky); -NoLan closes it again
mango-code -Remote 192.168.1.20 # from the OTHER PC: use that PC's model, don't start one here
mango-code -Local              # ...and this goes back to this machine's engine
mango-code -Chrome             # checks/unlocks the integration with YOUR Chrome
mango-code -Chrome -Sandbox    # ...or opens mango-code's separate browser
```

The `mango-code` function lives in the PowerShell profile (`$PROFILE`), **installed by `setup.ps1`**, and always calls
the same `mango-code\launcher\mango-code.ps1`. The engine stays up between launches; it is closed with
`Stop-Process -Id <pid>` (the pid is printed by `mango-code -EngineOnly`). With the app open the engine is the app's:
the terminal asks it for the engine and doesn't start another.

## The agent (opencode)

The engine (llama-server) lives in `mango-engine.ps1` and knows nothing about who talks to it; opencode sits on top,
launched by `mango-code.ps1`. The one-shot `mango-code -p "..."` becomes `opencode run`.

### Isolation

`OPENCODE_CONFIG_DIR` moves the agent's whole home into `opencode-home\`: config, plugins, agents, commands. The
user's "normal" opencode (`~\.config\opencode`) stays untouched and sees neither our skills nor our plugin.
`OPENCODE_DISABLE_PROJECT_CONFIG` is not set: it also turns off the project's `AGENTS.md` and `CLAUDE.md`. Measured by
capturing the real request to the model:

| | system prompt | the repo's `CLAUDE.md` |
|---|---|---|
| flag on | 19,432 characters | absent |
| flag off | 22,645 characters | **present** |

The price is stated: a repo with its own `opencode.json` can change our settings. Reading the project rules wins
anyway: without them the model works blind.

⚠️ **The isolation is one-way, and it is good to know it.** `OPENCODE_CONFIG_DIR` *adds* a config source, it does not
replace the global one: verified in the logs, opencode loads `~\.config\opencode\{config,opencode}.json[c]` first and
then ours, which wins on conflicting fields. So: mango-code's things do **not** end up in the normal opencode (that is
the direction we care about, and it is guaranteed), but if a user-level global config ever existed, its fields *not*
overridden by ours would be inherited. Today that config does not exist — `opencode debug config` without the
variable returns empty — and the template explicitly declares everything that matters (model, provider, permissions,
tools, skills, MCP), which is the real defense.

### The config is generated, not written

`opencode-home\opencode.json` **is generated** from `opencode.template.json` at every start, with the numbers of the
model that is running at that moment. It is not edited by hand: the template is.

The context changes with the model (128k on the 3.6 MoE, 80k on the dense 3.8): written by hand in the config it would
be a second place where that number lives, and sooner or later it would lie. Single source: `mango-models.json`. The
file has absolute paths, i.e. machine state, not source: the template with the `{{SELF}}` placeholder is versioned, the
generated file is gitignored.

### The discipline plugin, and why it injects at the end

`opencode-home\plugin\mango-discipline.js` is loaded once inside opencode, with its state in memory. It does two
things: it re-injects the discipline reminder and it blocks the hunt for skills on disk (skills are opened with the
`skill` tool).

**The reminder is appended AT THE END** — last part of the user message, or the tail of a tool's output. **Never in
the system prompt.** The system prompt is the prefix llama.cpp keeps in cache: touching it would mean re-prefilling
the whole context at every injection. Where prefill is the bottleneck (as on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER), that is no detail — it is the
difference between a free reminder and one that costs 40 seconds of GPU.

### What opencode brings

- **`compaction.prune`**: throws away old tool outputs instead of keeping them until compaction. On a real 80k, two
  `cat`s of big files eat the context and nobody needs them ten turns later.
- **Few tools in the prefill**: opencode has 13 by default. Capturing the real request, the **tool definitions weighed
  46,481 characters against the system prompt's 22,645** — the tools are twice the instructions, and they are paid for
  at every turn in prefill. `chrome-devtools` alone was 25,429 over 29 tools. After cutting the 13 that are duplicates
  or useless here (profiling, device emulation, `type_text` which `fill` and `press_key` cover, `select_page` which is
  not needed with `pageIdRouting`): **36,249 characters, ~2,500 tokens fewer at every turn**.
- **Native skills**: `skill` is a tool of the product. It reads the `SKILL.md` format, the one of our 14.
- **Permissions declared one by one**: full autonomy is there, but you see what you are granting and removing a
  permission is one line.

### The agent: opencode, built from the repo

The terminal and the app use the same binary, `<opencode>\web\mango-code.exe` (by default `launcher/opencode`):
opencode v1.18.23 with Mango Code's changes, built from the sources in `packages/`. What it brings and how it is built
is in `app/README.md`, "The agent". In the TUI it adds the two numbers that on a local model are the only compass:

```
+ Thought: 10.3s · in 1.2k out 400          <- tokens of the single message, next to the time
... 36.9K (28%)   pp 794  tg 33.8 t/s       <- prefill and decode, in the prompt line
```

`pp` / `tg` come from the engine's `/metrics`, from the cumulative counters (llama.cpp resets the gauges at every
read); `in` is the **new** prompt, without the re-read cache.

## The team (`-Team`): manager, dev, agents

`mango-code -Team` opens **several windows with roles**, not a single model:

| role | model | where | who starts it |
|---|---|---|---|
| **manager** | cloud, default `deepseek` (`-Manager`) | the window you start from | the launcher |
| **dev** | local, Qwen3.6-35B-A3B at 128k (`-Model`, default `3.6`) | one window | the launcher |
| **agent 1-4** | cloud, default `deepseek` (`-Agent`) | one window per agent | the manager: opens and closes |

The mechanism is in `opencode-home\plugin\mango-team.js`. It is not `main -> subagent -> main` (the `Task` tool is
off): they are **peer, independent opencode sessions**, each with its own process and its own fixed port (dev 4090,
manager 4091, agents 4092-4095). Communication is explicit and non-blocking — whoever sends an instruction **does not
wait**; the other side's summary arrives later, as a separate message.

- **manager -> dev**: tool `ask_dev`; the dev answers with `ask_manager` → `[DEV]` message.
  A single local dev (Qwen3.6 unless `-Model` says otherwise) with its whole context: no slots to split.
- **the dev links itself**: the launcher opens it with a `[START] ...` message that creates the session (hence the
  link) and puts the system prompt in cache; the plugin doesn't treat it as a task. There is no need to type "ready" in
  every window anymore.
- **manager -> agent N**: `launch_agent` (opens the window, once) and `ask_agent`; the agent answers with
  `ask_manager` → `[AGENT N]` message. `list_agents` says who is open, `close_agent` closes it (kills the window's
  process tree from the PID in `runtime\mango-agents\agent-N.pid` and frees the slot; a window closed by hand is
  recognized as closed).

Each side writes its **own** session to a file under `runtime\` (`team-link*.json`) at the first message; the other
reads it and delivers with `session.promptAsync`. No polling, no reading of the history.

**The agents are on OpenRouter**, not on the local GPUs: `deepseek/deepseek-v4.1-flash-20260910` (1M context, $0.15/M in,
$0.6/M out, $0.003/M cache read). Default since 2026-09-19: before it was `qwen/qwen3.8-27b`, which costs more on every
item (0.214/2.55/0.15) and does worse on coding work. `-Agent <key>` is still there to change it. The entry is in
`mango-models.json` as a `cloud` block; the key in `mango-secrets.json` (`OPENROUTER_API_KEY`). Each agent is a
separate process with its own config (`runtime\opencode-agent-N\opencode.json`) and its own script
(`runtime\mango-agents\agent-N.ps1`): the launcher prepares them at startup, it **doesn't start them** — starting is on
the manager's request.

An agent costs real tokens at every turn: start only the ones you need, and give them self-sufficient instructions (it
has no memory of the manager's conversation). The dev and agent windows can still be opened separately: the user can
enter and talk to them directly at any time.

The **stderr** of every agent window ends up in `runtime\logs\agent-N.log`, with a start line and an exit line with the
code: a runtime panic dies with the window, and without this no trace would be left. `stdout` and `stdin` stay on the
console, so the TUI is untouched.

## From another PC on the wifi (`-Lan` / `-Remote`)

The PC that runs the model is one (for example 3 GPUs, ~43 GB of GGUF, 20 s of loading). On a second PC none of this is duplicated - only **the agent**
moves, and the model stays where it is. The laptop doesn't need a GPU, `llama-cpp\` or the `models\` folder: the repo
and Node are enough.

**On this PC (the one with the model), once:**

```powershell
mango-code -Lan -EngineOnly      # starts the engine and opens it to the LAN. Prints the IP to use
```

`-Lan` does three things: it puts `llama-server` on `--host 0.0.0.0` instead of `127.0.0.1`, it opens port 8080
inbound in the firewall (asks for Windows authorization, once: the rule is for the **Private** profile, i.e. the home
network) and it leaves a marker in `runtime\engine-lan.txt`, so it doesn't have to be repeated at every start. It is
closed again with `-NoLan`. `-EngineOnly` is handy but not required: a plain `mango-code -Lan` does the same and then
opens the agent here.

**On the other PC:**

```powershell
git clone <repo> ; cd launcher
.\setup.ps1 -Only opencode
mango-code -Remote 192.168.1.20   # the IP printed above. Sticky: from the second start plain 'mango-code' is enough
mango-code -Local                 # undo, back to this machine's engine
```

From there on it is **identical**: same skills, same MCPs, same discipline plugin. Only one address changes. The
browser, the files and the commands stay those of the PC you are working on: only inference travels.

### Why there are not two configs to keep aligned

`-Remote` **starts nothing**, but downstream the model's card (context, label, quant) is still needed: without it the
generated configs would lie. So it is not deduced from the local `mango-models.json` - it is **asked** to the server's
`/props`, which gives the real context and which GGUF it loaded. If that file is also in this copy's
`mango-models.json`, its card is reused (same name, same quant you see on the PC that runs the model); if it is not there, the file name
stays. It is the usual rule: the number lives in **one place only**, and that place is whoever knows it. The same goes
for the t/s of the status bar: `MANGO_ENGINE_URL` makes them be asked to whoever really computes them, not to a
`localhost` that is doing nothing.

### The price, plainly

`llama-server` has **no authentication**: whoever is on your network and finds port 8080 can use the model. On the
home wifi that is exactly what you want; on a network that isn't yours, no - that is why `0.0.0.0` is never the default
and `-Lan` has to be asked for by hand. Away from home nothing is opened to the internet: with Tailscale on both PCs,
`mango-code -Remote <tailscale-ip>` works identically without exposing anything.

## Ports

This table is the **single source**: the README points here instead of copying it. There were three
copies and they were already diverging (the 9222 row existed in only one).

| Port | Process | Important |
|---|---|---|
| 8080 | llama-server (model) | **DO NOT KILL** = active model. With `-Lan` it also listens on the home network |
| 9333 | mango-code's Chrome | Opened by `-Chrome -Sandbox` or by the MCP server when needed |
| 9222 | Real Chrome with debugging on | Only if you enabled chrome://inspect. It is the branch that gives your logins; `MANGO_CHROME=mango` skips it |
| 4090 | dev (`-Team`) | The dev window's opencode server: this is where `ask_dev` arrives |
| 4091 | manager (`-Team`) | This window's opencode server: this is where `ask_manager` from dev and agents arrives |
| 4092-4095 | agents 1-4 (`-Team`) | One opencode server per agent started by the manager |

## How it is built

```
opencode  --provider mango, /v1 OpenAI-compatible-->  llama-server (prism or toq)
                                                      model from mango-models.json
```

- The launcher starts the engine if needed, generates `opencode-home\opencode.json` from the template and launches the
  agent with `--auto` (full autonomy: the config's `deny` entries stay). No subagents (`task` is off): the same model
  would serve them in series, and it only makes it derail.

## The models (`mango-models.json`)

The model catalog, read by the launcher and the app: GGUF path, repo and files with sha256, maximum
context, memory they need and, in the entries that start with `_`, the reason for each. Adding a model = adding an
entry and its place in `order`, the order in which local models are listed everywhere (selector and first run of the
app, `mango-code -Models`), followed by the user's models (`user-models.json` in the data dir, same format, added to
the catalog; see `profiles/README.md`) and the cloud ones. `default` is the model that starts when none is chosen. How
they run on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (engine, tuned arguments, measured context, notes) is in the profiles
`profiles/3060ti-1080-1660s/<model>.json`; on another PC the general plan applies (official llama.cpp, arguments from the
hardware, see `app/README.md`). The terminal chooses nothing: it asks `mango-launch.exe` for the plan
(`app/crates/engine`, `setup.ps1 -Only launch`), the same logic as the app, so on the same PC terminal and app start
the same engine with the same arguments, and on a PC without a profile the general plan works. If the engine or the
weights are missing, `mango-code -Model <key> -Install` downloads them. `MANGO_LAUNCH` points to a separate
`mango-launch.exe`, `MANGO_ENGINE_PORT` to the engine's port (default 8080).

| key | model | quant | engine | ctx | images | prefill 1k / 32k / 64k | decode 1k / 32k / 64k |
|---|---|---|---|---|---|---|---|
| `3.6` (default) | Qwen3.6-35B-A3B MoE, with MTP head | UD-IQ4_XS | prism | 128k | yes | 518 / 637 / 474 | 61.6 / 49.5 / 39.5 |
| `3.8` | Qwen3.8-27B (unsloth), dense, with MTP head | UD-IQ4_XS | prism | 92k | yes | 267 / 258 / 204 | 25.4 / 16.8 / 13.1 |
| `bonsai2` | Ternary Bonsai 2 27B | PQ2_0 | prism | 256k | yes | 250 / 320 / 254 | 25.3 / 16.6 / 12.9 |
| `toq` | Qwen3.8-27B-TOQ-v1 | trellis 2 bit, distilled | toq | 120k | yes | 567 / 649 / 533 | 27.5 / 26.5 / 23.2 |
| `lfm` | LFM2.5-24B-A2B MoE, text only | Q4_0 QAD | prism | 128k | no | 1063 / 1496 / 1142 | 93.0 / 76.3 / 64.1 |

Tokens per second, measured in November 2026 with the app's bench (`app/crates/engine/src/bin/mango-bench.rs`): the
model started the way the app starts it, real text cut to the exact number of tokens, temperature 0, 256 tokens
written, no prompt cache. The full context is not measured.

- **toq**: the 3.8 at 2 bits, distilled, on two GPUs (3060 Ti + 1660 S) with the 1080 free. It has MTP (two tokens
  anticipated and verified, the answer doesn't change). The image encoder sits on the 1080.
- All models have **disk memory** (`--cache-disk`): the system prompt and the conversations of the last 24 hours stay
  ready after an engine shutdown (loaned GPUs, model switch, closing).
- **3.6**: MoE with 3B active per token, the fastest at writing among the models that see images. MTP draft from the
  head inside the GGUF.
- **3.8**: unsloth's Qwen3.8-27B (Apache-2.0), dense. It sits at 92k: beyond the context that fits with all layers on
  the GPU, a single layer on CPU turns off the fused Gated Delta Net kernel across the whole model (3.2 tok/s). That is
  why `-ngl 999` is mandatory: better a start that fails and says so.
- **bonsai2**: the same ternary 27B, weights half the 3.8's, hence 256k. It runs only on prism (weights in rotated
  basis).
- **lfm**: 2.4B active and 10 attention layers out of 40, hence KV at f16 even at 128k. The fastest, but as an agent it
  stays below the 3.6 (it doesn't verify its own work with the browser). LFM Open 1.0 license: free under $10M of
  annual revenue.

Models without images get their own web instructions: `mango-discipline.js` adds `MANGO-web-text.md` (pages are read
with `take_snapshot`) instead of `MANGO-web-images.md`, depending on the request's model; the list of models that see
images reaches the plugins in `MANGO_IMAGE_MODELS`.

`-Model` is **sticky** (`runtime\active-model.txt`). Changing model reloads the engine: the weights have to be re-read;
first the conversation is saved, as in the app, and on restart it is restored. The terminal stops only the engine it
started itself (`runtime\engine.json`).

### The engines (forks `mango-prism` and `mango-toq`)

Each profile declares its engine (`"engine"`), with no fallback to another (without a profile the official llama.cpp
applies); each engine comes from our fork at a fixed tag, as a zip built by the fork's GitHub Actions or built here by
`setup.ps1`: `prism` ([mango-prism](https://github.com/Federico-Anastasi/mango-prism), PrismML's llama.cpp, tag
`prism_build`) and `toq` ([mango-toq](https://github.com/Federico-Anastasi/mango-toq), ik_llama.cpp, tag `toq_build`).
The changes, on each fork's `mango` branch, carry what the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER ask for, measured GPU by
GPU:

1. **The 1660S has no tensor cores.** It is cc 7.5 and llama.cpp treats it as Turing: MMQ and flash attention with the
   `mma` kernels, which TU116 **emulates**. Alone it did 264 tok/s of prefill where the 1080 does 1383; the patch
   (`GGML_CUDA_TU116`) denies the mma path to cc 7.5 only → 1030 tok/s (3.9×).
2. **CUDA graphs below Ampere too.** llama.cpp turns them off for cc < 8.0; on WDDM the launch cost is felt.
   `GGML_CUDA_GRAPHS_ANY_ARCH=1` (the engine always sets it): +9% in decode.
3. **Clock keeper** (`GGML_CUDA_CLOCK_KEEPER`): the driver lowers the clocks after a few seconds of decoding; keeping
   them up is worth +27-39% on the 3.6.
4. **3.6 MTP draft** (`LLAMA_MTP_UBATCH`): the draft context reserved a whole-model buffer; reduced, the draft fits at
   128k.
5. **toq**: the trellis weights, prompt prefill on the main GPU, MTP, cancellation even while reading the prompt.
6. **Disk memory** (`--cache-disk`, in both engines): the state of conversations and of the system prompt on file,
   reloaded at start and when returning to a conversation.

What you **can't** buy with software: the 1080 and the 1660S reach 57% and 50% of their real bandwidth in decode (the
3060 Ti 73%), the 1660S's PCIe is x1 and the 1080's x4. Tried and discarded: KV q4_0, `-sm row`, Q4_K_S/Q4_0/Q4_K_M
(IQ4_XS is already the fastest format on all three GPUs).

### The context

128k is the **target**, and it sits at global level in the JSON so that it isn't lowered out of laziness. A model can
declare its own `ctx` **only if it was measured** that at 128k it doesn't fit, and it writes in its `_ctx` what it
measured. The agent's config uses the **effective** ctx of the loaded model.

### What the 3.6 does on the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER

| | |
|---|---|
| **Context** | 128k real, all in VRAM. KV at q8_0 is needed (at f16 it doesn't fit); 256k = OOM on the 1660S. |
| **Tool-calling** | works (4/4 on the bench, correct Anthropic format). |
| **Context rot** | none between 50k and 107k (retrieval 4/4, zero hallucinations, 3 tests). |

## Gotchas and useful truths

- **Thinking ON by default** (it makes the model good at programming). On "hi" it thinks for 1-2 min: that is the
  price. Qwen supports only two levels: **`high` and `max` (default max)** — not Opus's scale.
- **Conversations** are saved by opencode in SQLite (`~/.local/share/opencode/opencode.db`).
- **Telemetry:** `--metrics` → `http://127.0.0.1:8080/metrics` (Prometheus). Per-request timings already in
  `srv_err.log`.
- **KV cache:** the context lives ONLY in the KV caches. A new turn goes through the model only for the new tokens; the
  past is read from the cache (prefix reuse, safe, doesn't mix). Disk memory (`--cache-disk`) keeps the conversations
  even after an engine restart.

## Extensions (MCP + skills + discipline plugin)

- **Web search MCP** (`mcp` block of `opencode.template.json`): `mango-websearch-mcp.js`, **home-made** (2026-07-18,
  replaces open-websearch: dirty text; and then SearXNG: too much Docker for the fraction we used). Zero cloud/key/Docker:
  **direct scrapers** + Mozilla's **Readability** + markdown — the Tavily/Jina/Firecrawl recipe in ~200 lines of our
  own. Four tools: `search` (DDG lite + Bing + Startpage in parallel, merge/dedup, confirmed-by-several-engines first; a
  broken engine = carry on with the others) · `read_url` (page → clean markdown, images as compact links
  `[img: alt](url)` downloadable with curl, Googlebot retry on 403s, reddit→old.reddit) · `research` (**Tavily
  pattern**: search + top-N already-extracted pages in ONE call, skips the anti-bot ones — fewer round trips for a slow
  35B) · `search_images` (DDG Images via vqd token: direct URLs → curl → Read to verify, Qwen is VL). Engines chosen by
  **probing**: Brave 429, Ecosia 403, Mojeek empty. If an engine changes markup, its parser is fixed (~15 lines each).
- **Skills** in `mango-plugin/skills/` (14): **capabilities** (our own word/excel/powerpoint/pdf, which use the
  `documents_*` tools of the `mango-documents` server: no Python or LibreOffice; frontend-design, theme-factory,
  web-artifacts-builder, webapp-testing, skill-creator) + **discipline** (verification-before-completion,
  systematic-debugging, test-driven-development, no-deferred-work, research-after-failure; the first three
  from `obra/superpowers`). ⚠️ Chosen for the **absence of subagents** (disabled) and for the 35B's real flaws.
- **Browser MCP** (`mango-chrome-mcp.mjs`): it is not Google's server launched as is, it is a wrapper that decides
  **which Chrome** to attach to — mango-code's on 9333 (no consent banner), the real profile if you turned on debugging
  from `chrome://inspect`, or a new visible and persistent one. Two details that cost blood: it is launched with `node`
  on a fixed path and **not with `npx`**, because on Windows the `.cmd` shim opens a `cmd.exe` that inherits the console
  and on exit puts it back in cooked mode — the TUI draws but no longer receives keys; and the `performance`/`emulation`
  categories are turned off at the source, before opencode even sees them.
- **opencode plugins** (`opencode-home/plugin/`): `mango-discipline` (discipline + anti skill hunting), `mango-speed`
  (t/s in the window title, useful when the terminal is behind other windows), `mango-web-diet` (below).
- **`mango-web-diet`**, the context diet while browsing. Measured: `wait_for` **always** appends the page's
  accessibility tree (~33,000 characters on LinkedIn, ~8k tokens) and nobody asks for it — 551,000 characters in the
  database, ~138k tokens. There it is cut on output. `click`, `fill`, `press_key` instead have `includeSnapshot`
  (default **false**): if the tree is there, the model asked for it. The first version cut it anyway, in secret, and the
  result was a model blind after the click that concluded "panel stuck" and pressed Escape at random. Now the flag is
  turned off **on input** and the model is **told** so in the reply: that is the difference between optimizing and
  lying.
- **Discipline plugin** (`opencode-home/plugin/mango-discipline.js`): re-injects a SHORT reminder (verify /
  root-cause / test / no-half-done-work / search-after-2-fails) at every user turn and every 12 actions.
  **Deterministic** (not opt-in like a skill) → it fights the "drift" of rules in long context. It also points to the
  right skills (forcing function: a 35B often doesn't invoke them on its own).

## Files

| file | what |
|---|---|
| `setup.ps1` | **installation**: engines, agent, GGUF, npm, paths, command, `mango-launch`. Idempotent, `-Only <part>` |
| `mango-code.ps1` | the launcher: picks the model, starts the engine, launches the agent. Banner, autonomy, no subagents |
| `mango-engine.ps1` | **the engine**: starts llama-server with the plan given by `mango-launch.exe` (or asks the app's engine manager for it). Knows nothing about the agent |
| `opencode-home/` | opencode's ISOLATED home: config template, plugins, instructions. `OPENCODE_CONFIG_DIR` |
| `opencode-home/opencode.template.json` | opencode's config **with the why of every entry**. The real file is generated |
| `opencode-home/plugin/mango-discipline.js` | discipline + anti skill hunting, in-process, injection at the end |
| `opencode-home/plugin/mango-web-diet.js` | removes repeated page trees from the context (not the requested ones) |
| `opencode-home/plugin/mango-speed.js` | prefill/decode in the terminal window title |
| `opencode-home/MANGO.md` | mango-code's instructions for opencode: answers, file reading, no subagents |
| `opencode-home/MANGO-web-images.md`, `MANGO-web-text.md` | how to look at a web page: with a screenshot if the model sees images, with a snapshot if it is text only (added by `mango-discipline.js` depending on the request's model) |
| `opencode-home/plugin/mango-project.js` | the project context as in Claude Code: `CLAUDE.md`, `.claude/rules`, `.claude/skills`, `.mcp.json` |
| `opencode-home/plugin/mango-documents.js` | Word, Excel, PowerPoint, PDF attachments converted to text for the model |
| `mango-documents/` | the MCP server for Office and PDF documents: create, read, edit, convert (MIT libraries, no Python) |
| `mango-chrome-mcp.mjs` | browser MCP wrapper: chooses which Chrome to attach to |
| `mango-cookie-import.mjs` | brings your Chrome's logins into mango-code's profile, via CDP. It is what removes the banner |
| `opencode/` | the agent built from the repo, `web/mango-code.exe` (`setup.ps1 -Only opencode`). Generated, gitignored |
| `runtime\logs\agent-N.log` | the stderr of every agent window: runtime panics and exit code |
| `mango-models.json` | **the models**: paths, HF repos with sha256, maximum context, memory, engine commits. Single source, the app reads it too |
| `profiles\3060ti-1080-1660s\` | **the profiles for the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER**: for each model engine, arguments, env, context and measured notes. The app reads them too (`engine-cfg`) |
| `mango-paths.json` | where binaries and weights are on THIS machine. Generated, gitignored |
| `mango-websearch-mcp.js` | our own web search MCP: direct scrapers + Readability, tools `search`/`read_url`/`research` |
| `mango-voice.py` | **local voice dictation**: space hook (hold SPACE, types by sentences), `--serve` for the web UI, `--devices`/`--test`/`--audio`/`--off`. Config in `mango-voice.json`. See `docs/voice.md` |
| `mango-voice-test.py` | the tests of `mango-voice.py`'s pure logic: tap/hold, auto-repeat, signed-event filter, config |
| `chat-templates/` | the Jinja chat templates passed to llama-server, one per model |
| `package.json` | the launcher's node dependencies (readability, jsdom, turndown, chrome-devtools-mcp, document libraries) |
| `docs/voice.md` | how the terminal's voice dictation works |
