# launcher: what the app installs as resources

A real coding agent, opencode, running against a **local, offline model**, on your own hardware. This folder is the tree
the desktop app installs as its `resources` (and reads live from the repo when it is built there): the model and engine
catalogs, the profiles, the agent's template, plugins and instructions, the MCP servers and the skills. The app is in
`app/README.md`; using Mango Code from another program is in `docs/INTEGRATION.md`.

```
opencode  --provider mango, /v1 OpenAI-compatible-->  llama-server (official, prism or toq)
                                                      model from mango-models.json
```

The engine and agent binaries and the GGUF files are not in git: the repo has the code that gets them (the fork tags in
`mango-engines.json`, the Hugging Face repos in `mango-models.json`). `mango-paths.json` (ignored by git, optional) moves
engines, models and agent on a development PC (`app/README.md`, "Where it takes the files from"). The agent is built with
`app/scripts/build-agent.ps1`; an engine fork from source, for whoever works on the forks, with
`app/scripts/build-engines.ps1 prism|toq`.

## The agent (opencode)

opencode v1.19.5 with Mango Code's changes, built from the sources in `packages/` into one binary,
`<opencode>\web\mango-code.exe` (by default `launcher/opencode`; what it brings and how it is built is in `app/README.md`,
"The agent"). The app starts it as `serve`, with the config it generates (below). No subagents (`task` is off): the same
model would serve them in series, and it only makes it derail.

### Isolation

The app starts the agent as on a PC where nothing has ever been: `OPENCODE_CONFIG_DIR` is the agent's whole home
(config, plugins, agents, commands) and the `XDG_*` variables put its conversations, cache and state under
`<data>\agent`. The user's own opencode (`~\.config\opencode`) stays untouched and sees neither our skills nor our plugins;
Claude Code's skills and `CLAUDE.md` of the user's home and the external skills are not read (`OPENCODE_DISABLE_CLAUDE_CODE`,
`_EXTERNAL_SKILLS`), nor opencode's own commands. It talks to no server but the local engine (and the web, when the agent
searches): `OPENCODE_DISABLE_AUTOUPDATE`, `_MODELS_FETCH`, `_SHARE`, `_LSP_DOWNLOAD`. The list is in `agent-cfg`.

`OPENCODE_DISABLE_PROJECT_CONFIG` is not set: it also turns off the project's `AGENTS.md` and `CLAUDE.md`. The price: a repo
with its own `opencode.json` can change our settings.

### The config is generated, not written

`opencode.json` **is generated** from `opencode-home/opencode.template.json` at every start (the `agent-cfg` crate), with
the numbers of the model that is running at that moment (the context changes with it). The template is edited by hand, and
its `_` keys are notes for whoever edits it, each one a constraint (the generated file drops them). The generated file has
absolute paths, i.e. machine state: it lives in `<data>`, never in the repo. The OpenRouter key is not in it: the config says
`{env:MANGO_OPENROUTER_KEY}` and the app puts the key from the Credential Manager in the agent's environment, only for the Team.

### The discipline plugin, and why it injects at the end

`opencode-home/plugin/mango-discipline.js` is loaded once inside opencode, with its state in memory. It re-injects the
discipline reminder and adds the web instructions of the request's model to the system prompt.

**The reminder is appended AT THE END** — last part of the user message, or the tail of a tool's output. **Never in
the system prompt.** The system prompt is the prefix llama.cpp keeps in cache: touching it would mean re-prefilling
the whole context at every injection. Where prefill is the bottleneck, that is the difference between a free reminder and
one that costs tens of seconds of GPU.

### What opencode brings

- **The engine's cache comes first.** `compaction.prune` is off: it replaced old tool outputs once they passed ~40k
  tokens, which changed the old part of the conversation and made the engine re-read everything after it. For the
  same reason the chat templates keep the reasoning of past turns (`preserve_thinking` true by default).
- **Few tools in the prefill**: the tool definitions are paid for at every turn. Capturing the real request, they weighed
  twice the system prompt, and `chrome-devtools` alone was 25,429 characters over 29 tools; the 13 that are duplicates or
  useless here are cut at the source.
- **Native skills**: `skill` is a tool of the product. It reads the `SKILL.md` format, the one of ours.
- **Permissions declared one by one**: full autonomy is there, but you see what you are granting and removing a
  permission is one line.

## The Team

A cloud **manager**, a local **dev** and up to 4 cloud **agents**, as peer, independent opencode sessions that talk
through the tools of `opencode-home/plugin/mango-team.js` (`ask_dev`, `ask_manager`, `launch_agent`, `ask_agent`,
`close_agent`). Whoever sends an instruction does not wait: the other side's summary arrives later, as a separate message.
The roles' instructions are `MANGO-manager.md`, `MANGO-dev.md` and `MANGO-agent.md`; how the app runs it (the manager is the
agent `team` of the app's server, dev and agents are hidden `opencode serve` processes, the ports, the keys) is in
`app/README.md`, "The Team". The agents are on OpenRouter, not on the local GPUs: the cloud entries are in `mango-models.json`
(`cloud` block), and an agent costs real tokens at every turn.

## Ports

| Port | Process | Note |
|---|---|---|
| 8080 | the app's engine manager (and under it llama-server) | the active model |
| 4096 | the agent's server: the web interface | |
| 4097 | the dictation service | |
| 4090-4095 | the Team: dev, agents | |

## The browser

`mango-chrome-mcp.mjs` chooses the browser the agent attaches to, in this order (the choice is written to
`mcp-chrome.log`, "browser: ..."; a port that shows Mango Code's own window is never used):

0. **your Chrome**, if you turned on "Use my Chrome" in the app and Chrome's remote debugging is active;
1. the app's **preview panel**;
2. otherwise a browser of its own, started now, with an empty profile (no logins).

Your Chrome shows "Allow remote debugging?" at every connection: it does so on purpose on the default profile, and since
Chrome 136 no program can turn that debugging on for you. When the agent finishes a site it opens it in the panel, with a
local server or the project's own dev server; in your own browser only if you ask.

## The models (`mango-models.json`)

The model catalog, read by the app: GGUF path, repo and files with sha256, maximum context, memory they need and, in the
entries that start with `_`, the reason for each. Adding a model = adding an entry and its place in `order`, the order in
which local models are listed everywhere, followed by the user's models (`user-models.json` in the data dir, same format,
added to the catalog; see `profiles/README.md`) and the cloud ones. `default` is the model that starts when none is chosen;
the speed of each on the development PC is in the root `README.md`.

How a model runs on a given PC (engine, arguments, measured context, the reason for each argument) is in its profile
(`profiles/3060ti-1080-1660s/<model>.json` for an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER, `measurements.note`); on
another PC the general plan applies (official llama.cpp, arguments from the hardware: `app/README.md`). All the models
keep the conversations' **disk memory** (`--cache-disk`): the system prompt and the conversations of the last 24 hours
stay ready after an engine shutdown (loaned GPUs, model switch, closing).

Models without images get their own web instructions: `mango-discipline.js` adds `MANGO-web-text.md` (pages are read
with `take_snapshot`) instead of `MANGO-web-images.md`, depending on the request's model; the list of models that see
images reaches the plugins in `MANGO_IMAGE_MODELS`.

### The engines (forks `mango-prism` and `mango-toq`)

A profile declares its engine, with no fallback to another (without a profile the official llama.cpp applies). `prism`
([mango-prism](https://github.com/Federico-Anastasi/mango-prism), PrismML's llama.cpp) and `toq`
([mango-toq](https://github.com/Federico-Anastasi/mango-toq), ik_llama.cpp) come from our forks at the tag of
`mango-engines.json`, as zips built by the fork's GitHub Actions. What the forks change (TU116 without the `mma` kernels,
CUDA graphs below Ampere, the clock keeper, the MTP draft's buffer, the trellis weights of toq, the disk memory) and what
was measured with it: `optimize/knowledge/3060ti-1080-1660s.md`.

### The context

128k is the **target**, and it sits at global level in the JSON so that it isn't lowered out of laziness. A model can
declare its own `ctx` **only if it was measured** that at 128k it doesn't fit, and it writes in its `_ctx` what it
measured. The agent's config uses the **effective** ctx of the loaded model.

## Gotchas and useful truths

- **Thinking is on by default**: it makes the model better at programming, at the price of time on short messages.
- **KV cache:** the context lives ONLY in the KV caches. A new turn goes through the model only for the new tokens; the
  past is read from the cache (prefix reuse, safe, doesn't mix). Disk memory (`--cache-disk`) keeps the conversations
  even after an engine restart.

## Extensions (MCP + skills + plugins)

- **Web search MCP** (`mcp` block of `opencode.template.json`): `mango-websearch-mcp.js`, **home-made**. Zero cloud/key/Docker:
  **direct scrapers** + Mozilla's **Readability** + markdown. Four tools: `search` (DDG lite + Bing + Startpage in
  parallel, merge/dedup, confirmed-by-several-engines first; a broken engine = carry on with the others) · `read_url`
  (page → clean markdown, images as compact links `[img: alt](url)`, Googlebot retry on 403s, reddit→old.reddit) ·
  `research` (search + top-N already-extracted pages in ONE call, skips the anti-bot ones — fewer round trips for a slow
  model) · `search_images` (DDG Images via vqd token: direct URLs). Engines chosen by **probing**: Brave 429, Ecosia 403,
  Mojeek empty. If an engine changes markup, its parser is fixed (~15 lines each).
- **Skills** in `mango-plugin/skills/`: **capabilities** (word/excel/powerpoint/pdf, which use the `documents_*` tools of the
  `mango-documents` server: no Python or LibreOffice; frontend-design) + **discipline** (verify-before-done, debugging,
  test-first). Chosen for the **absence of subagents** (disabled), for a PC without Python or Node, and for the local
  models' real flaws. Every skill's description is in the prompt at every turn: a skill earns its place or it goes.
- **Browser MCP** (`mango-chrome-mcp.mjs`): a wrapper around Google's chrome-devtools-mcp that chooses which browser to
  attach to (see The browser) and cuts the `performance` and `emulation` categories at the source. It is launched with
  `node` on a fixed path and not with `npx`: on Windows the `.cmd` shim opens a `cmd.exe` that inherits the console. Its
  stdout is written from a thread of its own (`mango-mcp-stdout.cjs`) and a guard (`mango-mcp-watchdog.cjs`) ends the
  process if the main loop freezes: on Windows a pipe that nobody reads blocks a Node process in the middle of a write.
- **`mango-web-diet`**, the context diet while browsing. `wait_for` **always** appends the page's accessibility tree
  (~33,000 characters on a busy page, ~8k tokens) and nobody asks for it: there it is cut on output. `click`, `fill`,
  `press_key` have `includeSnapshot` (default **false**): if the tree is there, the model asked for it. The flag is
  turned off **on input** and the model is **told** so in the reply: that is the difference between optimizing and lying.
- **Discipline plugin** (`mango-discipline.js`): re-injects a SHORT reminder (verify / root-cause / test / no-half-done-work /
  search-after-2-fails / web for recent facts) at the 1st, 4th, 7th... user message and every 12 actions. The text stays in
  the conversation until compaction: it is kept short for that reason. **Deterministic** (not opt-in like a skill) → it
  fights the "drift" of rules in long context. It also points to the right skills.

## Files

| file | what |
|---|---|
| `opencode-home/` | the agent's home: config template, plugins, instructions |
| `opencode-home/opencode.template.json` | opencode's config **with the why of every entry**. The real file is generated |
| `opencode-home/plugin/mango-discipline.js` | discipline reminder (injected at the end) and the web instructions of the request's model |
| `opencode-home/plugin/mango-web-diet.js` | removes repeated page trees from the context (not the requested ones) |
| `opencode-home/plugin/mango-project.js` | the project context as in Claude Code: `CLAUDE.md`, `.claude/rules`, `.claude/skills`, `.mcp.json` |
| `opencode-home/plugin/mango-documents.js` | Word, Excel, PowerPoint, PDF attachments converted to text for the model |
| `opencode-home/plugin/mango-team.js` | the Team's tools and the links between its sessions |
| `opencode-home/MANGO*.md` | the instructions: answers, file reading, no subagents; the Team's roles; how to look at a web page |
| `mango-documents/` | the MCP server for Office and PDF documents: create, read, edit, convert (MIT libraries, no Python) |
| `mango-websearch-mcp.js` | our own web search MCP: direct scrapers + Readability |
| `mango-chrome-mcp.mjs`, `mango-mcp-stdout.cjs`, `mango-mcp-watchdog.cjs` | the browser MCP wrapper, its output thread and its freeze guard |
| `mango-plugin/skills/` | the skills |
| `mango-models.json` | **the models**: paths, HF repos with sha256, maximum context, memory. Single source |
| `mango-engines.json` | the engines to download: official llama.cpp and our two forks, with url, size and sha256 of every build |
| `profiles/3060ti-1080-1660s/` | **the profiles for the RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER**: for each model engine, arguments, env, context and measured notes. The app reads them (`engine-cfg`) |
| `chat-templates/` | the Jinja chat templates passed to llama-server, one per model |
| `opencode/` | the agent built from the repo, `web/mango-code.exe` (`app/scripts/build-agent.ps1`). Generated, gitignored |
| `mango-paths.json` | where binaries and weights are on THIS machine. Optional, written by hand, gitignored |
| `package.json` | the node dependencies (readability, jsdom, turndown, chrome-devtools-mcp, document libraries) |
| `docs/known-issues.md` | open problems, with the cause |
