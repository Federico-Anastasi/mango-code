# The Mango Code desktop app

Rust/Tauri 2. Double click → loading page → engine, dictation and agent server hidden, in a
Job Object (they die with the app) → window with the agent's web UI (opencode, in `packages/` at the repo root).
What the app opens for the user (files with "Open", links in the browser, the logs folder) starts outside that job
(`supervisor::open_outside_job`): a browser opened by the app stays open when the app quits.
On close the engine saves its memory and stops. Once the agent runs, the X hides the window in the tray (a click on the
icon brings it back) and the icon's "Quit" closes; before that (model choice, download, startup error) the X quits.
The window shows only the app's own pages: nothing else, a local file included, can take its place.
At startup the dictation models (whisper `small` and the Silero VAD, ~490 MB) are downloaded if missing, with the
progress on the loading page; without network the app starts without dictation and tries again next time.

| where | what |
|---|---|
| `src-tauri/` | window, startup (`lib.rs`), process supervisor, native bridge for the web UI (`bridge.rs`), Preview panel (`preview.rs`), "Use my Chrome" (`chrome.rs`), model preparation (`preparation.rs`), first run and model changes (`first_run.rs`, `choice.rs`, `system.rs`), "Other models" (`other_models.rs`), the Team (`team.rs`), zoom of the window (`zoom.rs`), problem reports (`report.rs`), tray |
| `crates/engine` | the engine manager on 8080: starts the model the request asks for, saves the conversation before stopping, releases and resumes the GPUs (`/engine/*`), rejects web pages. Also `fake-engine` (the tests), `mango-bench` (the speeds of the catalog models), `mango-tune` (tuning: measures a tune, keeps the log, writes the profile; the `optimize/` skill uses it) and `mango-launch` (the engine plan, the model list and the downloads for the terminal: the same logic as the app, `--hardware <file.json>` applies it to a PC that is not this one) |
| `crates/mango-common` | paths (`Paths::discover`), data folder, service file, `Build` (the build of an engine: `cpu`, `vulkan`, `cuda-12`, `cuda-13`), the app's language (`i18n`); `download`: download of engines (`mango-engines.json`) and models (`mango-models.json`) with resume and sha256, plus Hugging Face (`download/hugging_face.rs`: search, links, GGUF files with hash); `credentials`: the keys in the Windows Credential Manager |
| `crates/engine-cfg` | the PC's hardware (`hardware.rs`: GPUs of any vendor, CPU, RAM, build to use), the optimized profile if it applies (`profiles.rs`, `launcher/profiles/`) or the general plan with the official llama.cpp (`general.rs`), the recommended models (`recommended`), the split of layers across GPUs (`split.rs`) |
| `crates/agent-cfg` | the agent's config, the same one `launcher/mango-code.ps1 -Web` generates (the test compares them); `team.rs`: the Team |
| `crates/voice` | dictation: whisper in Rust, on the CPU |
| `crates/phone` | the web UI on the phone: the network port, the key, the sessions, the forwarding to the agent, the links with the QR (below, "From your phone") |
| `ui/` | the loading page, the model choice and the download; its texts are in `first-run.js` (Italian and English) |
| `scripts/` | staging and installer; `test/` to drive the app from scripts |

## Where it takes the files from

The resources are the `launcher/` tree: the same as the terminal. `Paths::discover` finds it like this: `MANGO_DIST`,
otherwise going up from the executable to the first `launcher/` folder (repo), then `resources/` (installed app).
`launcher/mango-paths.json` (optional, written by `setup.ps1`) moves engines, models and agent; without it, the
paths of the installed app apply: `%LOCALAPPDATA%\MangoCode\engine` and `\models` (an update does not delete them) and
`<dist>/opencode`, that is `resources/opencode` when installed and `launcher/opencode` in the repo, where `setup.ps1 -Only opencode`
builds the agent.

At startup it starts the last model used (`<data>\model.txt`), otherwise the catalog default.

## Language

The app speaks Italian or English. The choice is `"language"` in `<data>\settings.json`; without it, the Windows display
language. Rust texts use `mango_common::tr!("testo italiano", "English text")`, which reads the language at every call.
The first-run page asks for it with the `language` command and picks its texts from the table in `ui/first-run.js`. The
tray menu follows a change when the pointer reaches the icon; the installer's labels follow the language of the
installer (`bundle.windows.nsis.languages` in `tauri.conf.json`, `windows/hooks.nsh`).

## Models, profiles, engines

- `launcher/mango-models.json` is the **model catalog**: what they are and where they are downloaded from (repo, revision, name,
  size and sha256 of the files), maximum context, the memory they need (`memory`: K+V cache per token at f16 and fixed
  state, from the GGUF header; `shape`: the layers, to split them across the GPUs before downloading), `requires_engine`
  if the weights cannot be read with the official llama.cpp. A file with `engine` serves only that engine, which opens it instead of
  `gguf`: each PC downloads the files of the engine the model runs with (Bonsai 2: `Q2_0` with the official llama.cpp,
  `PQ2_0` with prism).
- `launcher/profiles/<family>/<model>.json` is a **profile**: model + hardware + engine + build + arguments +
  context + measured numbers (`measurements`). It applies if the PC's GPUs with at least 2 GiB are exactly the ones it asks for
  (`3060ti-1080-1660s/`), or on every PC with one of its builds (`general/`: TOQ on NVIDIA). Format in `launcher/profiles/README.md`.
- Without a profile that applies, `plan()` uses the **general plan**: official llama.cpp
  (`<engines>\llamacpp\<version>-<build>\`) with the build from `choose_build` and the arguments computed from the hardware.
  The model runs **all on the GPUs or all on the CPU, never split**: on the GPUs (`-fit off -ngl all`, GPUs
  visible with CUDA) if weights, image encoder and cache for at least 32k tokens fit; otherwise on the CPU
  (`-dev none -t <cores>`, with the same build: nothing to download) if they fit in RAM; otherwise it does not fit, and
  the error says how much is needed and what to do. The context is the maximum that fits, in steps of 4096, up to the
  catalog target; the cache drops to q8_0 if f16 is not enough. `-fit` must be off because llama.cpp turns it on by itself and would move
  layers to RAM. A loaned GPU (`/engine/release`) does not send a GPU model to the CPU. Builds:
  NVIDIA with CUDA 13.4 driver and Turing or later GPUs `cuda-13`; CUDA 12.4 driver `cuda-12`; AMD, Intel or NVIDIA
  with an older driver `vulkan`; no GPU with 2 GiB `cpu`. Models with `requires_engine` do not run without a
  profile of their own (for the GPUs or the build).
- `recommended(paths, hw)` says for each model where it runs (GPUs or CPU) with what context, or why it does not fit, and
  which of the recommended ones is probably the fastest: on the GPUs it beats the CPU, at equal placement the one that
  reads fewer weights per token wins (`active_permille` of the MoEs in the catalog).

## First run and changing models

The installer brings no engines or weights. If at startup there is no model that can be started (weights and engine for the hardware
on disk), instead of failing the window shows the choice: the computer (GPUs, memory, processor), the engine that
will be needed, the recommended models with where they run ("On the graphics card · 128k context", "On the processor · slower"),
the probably fastest one and, for those that do not fit, why (they cannot be chosen). Below the list it points to the
`optimize/` skill (in the installed app in `resources\optimize`) to give to a frontier AI. In the web UI a model
that runs on the CPU or does not fit says so in its name; choosing one that does not fit shows the sentence of the plan (the
manager answers 422, which the agent does not retry). Then it downloads engine and models
with progress and the app starts as usual. What is being downloaded is in `<data>\first-run.json`: if the app is closed halfway,
the next start resumes by itself. "Models and engine" reopens the choice when the app is in use: from the tray icon,
from Settings → Models, or from "Download more models…" at the bottom of the model menu under the chat (Cancel goes
back to where it was; if something is downloaded the agent restarts to know the new models). The model menu under
the chat lists the models on this PC: the engine loads the chosen one with the next message, and the chosen one is
the default at the next start. A model marked `fallback` in the catalog (Qwen3.5-2B, for 4 GB cards) is proposed,
and called the fastest, only when no other model fits on the graphics cards.

With `--service` nobody is there to choose: the app writes the reason in `service.json` (`reason`) and in `startup.log`, and
waits for the window to be opened from the icon and "Retry" to be pressed.

The code: the logic in `src-tauri/src/first_run.rs` (what is missing, the plan, the execution, the remembered choice), the
page and the commands in `choice.rs` + `ui/`, everything that touches the computer and the network behind the `System` trait
(`system.rs`: real hardware and downloads; `fake.rs`: in development builds, `MANGO_FAKE_SYSTEM=<file>` describes a fake
computer with downloads from a local server; it is what `integration/tests/first-run.test.ts` uses).

## Other models

Below the recommended ones, the choice page has "Other models": you search on Hugging Face (public API), paste a
link (`huggingface.co/o/n`, `.../blob/main/f.gguf`, `hf.co/o/n:Q4_K_M` or `o/n`) or choose a GGUF already on the computer.
For a repo the app lists the quantizations (the pieces of a split model joined, the image encoder as an
option) and for each says **before** whether it fits in the PC's memory and with what context: the same estimate as the recommended ones
(`general.rs`), with `memory` computed from the GGUF header (for a remote file the first MBs are enough, with `Range`).
The warnings come from the conversation format inside the GGUF (`tokenizer.chat_template`), tried with a
conversation that has the tool list, a call with its result and a system message in the middle: if the
template rejects it (`raise_exception`), ignores the tools or drops that message, the warning says so and the button
becomes "Add anyway". A template the tester cannot run gives "could not check", never a
verdict. "Add" writes the entry in `<data>\user-models.json` (`mango_common::catalog::add_user`) and the
page comes back with the new model already ticked; from there the download is the usual one (`install_model`,
with resume and sha256 from Hugging Face, at the revision read). A file on the computer stays where it is: the entry remembers its
path. "Remove from the list" removes the entry, not the files.

The Hugging Face token (protected models) is checked by `whoami` and lives in the Windows Credential Manager as
`HF_TOKEN` (`mango_common::credentials`); it never goes through a file or the logs. The download uses it after the `HF_TOKEN`
of the environment.

The code: `engine-cfg/src/other_models.rs` (analysis, template, entry), `engine-cfg/src/gguf.rs` (header: strings, per-layer
vectors, memory of any model), `mango-common/src/download/hugging_face.rs`, `src-tauri/src/other_models.rs`
(commands) and the section in `ui/`. Test by hand with the network: the ignored tests of `engine-cfg`
(`cargo test -p engine-cfg --lib -- --ignored --nocapture`; `MANGO_TEST_SEARCH`, `MANGO_TEST_REPO` change search and repo).

## Without a window: the service

`mango-code.exe --service` starts with the window hidden (the tray icon opens it) and writes `<data>\service.json`
with the agent and engine ports: this is how the other apps find it (`docs/INTEGRATION.md`). For the tests:
`MANGO_DATA` (data folder), `MANGO_AGENT_PORT`, `MANGO_ENGINE_PORT`, `MANGO_DIST`; with `MANGO_DATA`
the single instance is tied to that folder, so a test instance runs next to the real one. The integration tests
(`bun test --cwd integration`) start an instance like this with the fake engine.

## Open with Mango Code

`mango-code.exe "<folder>"` opens that folder as a project (`src-tauri/src/folder.rs`): at startup, or, if
the app is already open, the second start passes the folder to it and exits. A folder that does not exist, or a file, gives a
message and leaves everything as it is. The installer adds the "Open with Mango Code" item (Italian: "Apri con Mango Code", chosen
by the installer's language) to the right click on a folder and on the background of an open folder (`windows/hooks.nsh`, keys
`Directory\shell` and `Directory\Background\shell`, removed on uninstall); the command is `"mango-code.exe" "%V\."`, because the trailing `\.`
keeps a drive root (`C:\`) from escaping the quote. Test: `integration/tests/open-folder.test.ts`.

## From your phone

The web UI on the phone, from the same Wi-Fi or from outside the house with Tailscale. **Off by default**; it is turned on from the
web UI settings in the app ("From your phone", `settings-v2/phone.tsx`, `phone_*` bridge commands in
`src-tauri/src/phone.rs`), which shows the link with the key and its QR for the home network and for Tailscale (an
address in `100.64.0.0/10`). The phone does not see the bridge: no phone settings from the phone.

- **Its own port**: `0.0.0.0:47096` (`MANGO_PHONE_PORT` for the tests), open only while on. Agent and engine stay
  on `127.0.0.1` as before; the engine cannot be reached from the phone.
- **Entry**: `GET /phone?key=…` (24 random bytes, compared in constant time) → `303` to `/` with the cookie
  `mango_phone` (a random value of a session, never the key; `HttpOnly; SameSite=Strict; Path=/`, 90 days, not
  renewed); wrong or missing key `401`.
- **Every other request**: requested address not numeric (a name pointing to the computer, DNS rebinding) `403`, also for
  `/phone`; `Origin` different from `http://<requested address>` `403`; without a valid session `401` (a sentence for the
  browser, JSON for the rest); methods other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` `405`; the routes only the
  app on the PC uses (`/mango/warmup`, `/mango/extra-folders`) `403`; chunked body `400`; agent off `502`.
- **Problem reports** (`/phone/report`): the one route the port answers itself. `GET` says what a report may carry,
  `POST` hands one to the app (`phone::Reports`, implemented by `PhoneReports` in `report.rs`: the logs and the sending are
  on the computer). It needs the same session, `Origin` and `Content-Length` as everything else, the body is bounded
  (`413` above the limit, refused before reading it) and the log has the outcome, never the content. The web UI shows
  "Report a problem" in Settings > Help also from the phone, without the window's screenshot, the updates or the logs.
- **Forwarding**: to the agent with its own `Host` and `Origin` (for the agent it is its web UI), without `Cookie`, `Referer`,
  `Authorization` or proxy headers; one request per connection, the response streamed (events included), the
  web UI terminal (WebSocket) both ways.
- **Turning off** closes the port, drops the sessions, closes the open connections and removes the key: a link seen
  before is not valid when it is turned on again. **New key** does the same without closing the port.
- State in `<data>\phone.json` (`enabled`, the key, of the sessions only the SHA-256 hash and the expiry, at most
  20); every entry, rejection, turning on and off is a line of `<data>\logs\phone.log`, never the key.
- **A session is worth the computer**: it commands an agent with the shell. At home the traffic goes in the clear on the Wi-Fi (this is
  why the cookie has no `Secure`); on Tailscale it is encrypted. The first time Windows asks whether the app may receive
  connections: allow it on private networks (and on Tailscale's, if Windows classifies it as public).
- Tests: `cargo test -p phone` (the rules one by one, on 127.0.0.1); `integration/tests/phone.test.ts` (the real app:
  turned on from the bridge, entry, web UI and agent from the port, turned off). In development builds `MANGO_PHONE_PC_ONLY` keeps
  the port on `127.0.0.1`, so the tests do not make Windows ask to open it.

## Zoom

Ctrl+ / Ctrl- / Ctrl+0 zoom the whole window (the keys are the browser's own: the window is built with
`zoom_hotkeys_enabled`). The web UI tells the app its page scale after a change (`remember_zoom`, 800 ms after the last
resize of the page, `INIT_SCRIPT` in `bridge.rs`); `zoom.rs` turns it into the zoom (page scale over the screen's scale)
and keeps it in `<data>\zoom.txt` (the file goes away at 100%), and `lib.rs` applies it to the window at the next start.
The Preview panel is a webview of its own and keeps its zoom: `preview_place` already converts the placeholder's rectangle
with the page scale, so after a zoom the native panel stays on its place. While a dialog, menu or list is open above the
page the panel steps aside (`layerOver` in `preview-panel.tsx`: Kobalte marks its open layers) and comes back when it closes.

## What goes in the prompt

Every item of the fixed prompt (base tool, MCP server, skill, instructions file, plugin) is on or off. The agent
rereads at every request `<data>\settings.json` (`agent-cfg` sets `MANGO_SETTINGS`, so it follows `MANGO_DATA`) and
`.mango/settings.json` of the working folder; the settings "Prompt" tab writes them. The weight in tokens of
each item is counted by the engine (`POST /tokenize`, which goes through the manager; the fake engine counts one word per token) with the
first request of a conversation and writes it in `opencode.log`. The format and the routes: `docs/INTEGRATION.md`.

## The Team

The same as the terminal (`mango-code -Team`, roles in `launcher/opencode-home/MANGO-{manager,dev,agent}.md`, plugin
`launcher/opencode-home/plugin/mango-team.js`), with three differences: the **manager** (a cloud model, DeepSeek V4.1 Flash by
default) is the opencode agent `team` in the app's server; the **dev** (the local model) and the **agents** (up to 4, cloud)
are hidden `opencode serve` processes that the plugin starts at the first `ask_dev` and at every `launch_agent`, in the
manager's project folder, with their own config and data (`<data>\team\`); links and pids are in `<data>\team\`, not in
`launcher\runtime`. One Team at a time: the ports are the terminal's (dev 4090, agents 4092-4095), so it does not
coexist with `mango-code -Team`.

- **In the chat**: the "Team" switch next to the model (`packages/app/src/components/team-switch.tsx`) passes the
  conversation to the manager (agent `team`, with its model) and back to the local model. Without the key it is a
  button that opens the "Team" page.
- **Settings, "Team"** (`settings-v2/team.tsx`): the OpenRouter key, how many agents (0-4), the models of manager and
  agents (the cloud entries of `mango-models.json`). Saving restarts the agent. The choices are in `<data>\team.json`.
- **The key** lives only in the Windows Credential Manager (service `MangoCode`, credential `OPENROUTER_API_KEY`, that is
  target `OPENROUTER_API_KEY.MangoCode`, `mango-common::credentials`). At startup the app reads it and puts it in the environment
  of the agent server (`MANGO_OPENROUTER_KEY`); the config reads it from there (`{env:MANGO_OPENROUTER_KEY}`) and dev and agents
  inherit it: it is never in a file or a log. Without the key the Team does not start and the page says so. With
  `MANGO_DATA` the service changes (it carries a hash of the folder): the tests do not touch the real credentials.
- **What `agent-cfg::team` generates**: in the server config the `openrouter` provider with the manager and agent models,
  the `team` agent and the ban of the manager's tools (`ask_dev`, `launch_agent`, …) for the normal agent; in
  `<data>\team\` the configs of dev (`dev-home`) and agents (`agent-home`) and `launch.json`, which tells the plugin how to start them.
  With 0 agents the manager does not have the agents' tools.

## The agent

The agent is opencode, in `packages/` at the repo root with the rest of the upstream tree (base `v1.18.23`). One
binary for the app and the terminal: `launcher/opencode/web/mango-code.exe` (folder ignored by git).

```powershell
launcher\setup.ps1 -Only opencode   # bun install + bun run script/build.ts --single (5-15 min)
```

It needs **Bun 1.4.2 or later**: the Bun runtime is inside the binary, so the one it is built with counts (1.4.0 had
a segfault on Windows). Which runtime is in a binary:
`findstr /M /C:"744846f84" mango-code.exe` (744846f84 = Bun 1.4.2). After a build: `mango-code.exe --version` prints
`1.18.23-mango` and the integration tests (below) pass with that binary. `MANGO_OPENCODE` (the tests) and `--opencode`
(the staging) use a separate build, in a folder with `web\mango-code.exe`. The tests of the agent sources
are run from the package folder (`cd packages\opencode; bun test`): the root refuses them.

With the app or the agent windows open, copying over the exe fails (file in use). Windows does let you **rename**
a running exe: rename the old one, copy the new one, and what is already open stays on the renamed file.

What it brings compared to opencode:

- **Embedded, offline web UI**: the server never forwards it from `app.opencode.ai`; Mango Code brand, dark theme,
  accent `#FFA61F`; `?project=<folder>` opens that folder as a project.
- **Server without a password but closed to web pages** (`middleware/origin-guard.ts`): a request with `Origin` passes
  only from the same server's web UI or from the app. CORS is not enough: a "simple" request starts from any
  page, and the agent has the shell.
- **Folder of the `x-opencode-directory` header decoded** on all routes (`workspace-routing.ts`).
- **In the interface**: Preview panel (the agent's browser next to the chat), "Use my Chrome", live dictation
  (`/mango/voice/*`), progress of the prompt read and prefill and decode speed per reply (from the engine's
  `timings`), documents and attachments read as text, titles from the user's words, history with
  "Archived", only the product's commands (`OPENCODE_DISABLE_BUILTIN_COMMANDS`).
- **The model waits for the GPUs**: `/mango/engine/speed` asks the engine manager (`GET /engine`) why a
  request has no answer yet, and the page writes it in the conversation.
- **The same wrong call repeated is not executed** (`session/repeat-guard.ts`), for every tool.
- **What goes in the prompt** (`session/settings.ts`, `session/prompt-measurement.ts`, `shared/mango-settings.ts`):
  `GET`/`PUT /mango/settings` and the "Prompt" tab (`settings-v2/prompt.tsx`); the `PUT` passes only from the page.
- **Rules per path**: the `tool.execute.after` hook also receives `messageID` and the turn's history; the plugin
  `mango-project` brings in one with `paths:` once per conversation.
- **Shorter descriptions of the base tools** (13,696 → 7,096 characters), **the brand** (`logo.tsx`, favicon),
  **engine preparation** (`POST /mango/warmup`).
- **In the TUI**: `pp 794  tg 33.8 t/s` in the prompt line and, next to the time of every message, the new tokens read
  and written. It is in the sources and not in a plugin because in 1.18.23 TUI plugins are not loaded (upstream
  #36525).

## Building and testing

```powershell
launcher\setup.ps1 -Only opencode    # the agent (above)
cd launcher;                npm ci
cd opencode-home;           npm install   # reads package.json (see below)
cd ..\..\app
node scripts\prepare-installer.mjs   # staging: also needed by cargo test (tauri-build wants the folder)
cargo test --workspace
cargo build -p mango-code -p engine  # the app and the fake engine: the integration tests start them
cd ..
bun test --cwd integration              # from the repo root; app windows open with the fake engine
powershell -File app\scripts\build.ps1   # staging + cargo tauri build -> app\target\release\bundle\nsis\*.exe
```

`launcher/opencode-home/package.json` (ignored by git: `{"dependencies": {"@opencode-ai/plugin": "1.18.23"}}`) is written by
the agent at first start; for the staging and the tests it must be created first, by hand, otherwise `npm install` there goes up to the
launcher's `package.json` and modifies it.

`bun test integration` from the root does not start: opencode's `bunfig.toml` points the tests to a folder that does not exist,
to prevent running them from the root. `--cwd integration` runs them from inside.

The staging takes the files named in `prepare-installer.mjs`, the folders only with the files tracked by git, the node
packages that are really needed and `<opencode>\web\mango-code.exe`. It rejects secrets, generated configs, logs, weights, engines and
NVIDIA libraries: the installer is a base one, the engines are downloaded at first run. Development from source does not change
(`setup.ps1` builds the engines in `launcher/runtime`, `mango-paths.json` points to them).

An installer built from a worktree can fail in `makensis` ("failed opening file") because of paths over 260
characters: `subst W: <worktree>` and build from `W:\app\src-tauri`.

To install: close **all** instances of the app and delete the old setup, then
`target\release\bundle\nsis\Mango Code_*_x64-setup.exe /S`. It installs in `%LOCALAPPDATA%\Mango Code`,
the data goes in `%LOCALAPPDATA%\MangoCode` (logs in `logs\`).

## Looking and measuring

- `scripts\test\ui.ps1 -Action shot|click|type|key|info`: picture of the window (DPI-aware, even covered),
  clicks in fractions of the window, text with SendKeys.
- `scripts\test\send.ps1 -Text … -Directory …`: sends a message to the agent with the web UI routes.
- Driving it via CDP: start it with `MANGO_WINDOW_CDP=9333`, which turns on remote debugging for the main window
  only (9222 is Chrome's). Not `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`: it applies to all
  the process's WebView2s, the Preview panel loses its port and the agent can't use it (the browser server refuses a
  port that shows Mango Code's own window).
- A test is valid when it is done as a user does it: a new conversation, the panel closed, clicks in the window.
- Model speeds: `cargo run --release -p engine --bin mango-bench -- toq 3.6` (starts each model like
  the app; table at the end).
- Logs: `%LOCALAPPDATA%\MangoCode\logs\{startup,agent,engine,manager,ui}.log` (`manager.log`: who called `release`,
  `resume` or `model`, when and with what outcome; `ui.log`: the web UI's uncaught errors and `console.error`, and the
  calls to the app slower than a second or with no answer; the TOQ engine's `llama.log` is in the same folder); the
  agent's real one is `%LOCALAPPDATA%\MangoCode\agent\data\opencode\log\opencode.log` (`init count=N` = skills loaded
  per instance). With the app open, Windows can show these files at 0 bytes: they are being written, not empty.

## Automatic updates

`src-tauri/src/updater.rs`. Once per start, a minute after it (not periodically), the app reads
`https://github.com/Federico-Anastasi/mango-code/releases/latest/download/latest.json` (the latest release that is not
a pre-release), downloads the newer installer in the background and checks its signature against the public key in
`tauri.conf.json`. Then the web UI offers "Install and restart": the button in the title bar, a notice, and Settings >
Help, which also has "Check for updates". The click stops agent and engine as "Quit" does, starts the installer in
passive mode (`/P /UPDATE /R`: only its progress bar, then it reopens the app) and closes the app. The installer is
started by the app with `CREATE_BREAKAWAY_FROM_JOB`: inside the app's job Windows would kill it together with the app.
No automatic checks in the service, in test instances (`MANGO_DATA`) and in debug builds.

Publishing a release (`.github/workflows/release.yml`; official installers are built only there, never on a PC: a
local build carries the PC's paths inside its binaries):
1. raise `version` in `src-tauri/tauri.conf.json` and in `Cargo.toml` (a release candidate is `X.Y.Z-rc.N`, so the
   final `X.Y.Z` is higher), and write the notes in `release-notes/v<version>.md`;
2. push the tag `v<version>`: the workflow waits for the maintainer's approval on the `release` environment, which
   holds the signing key (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`);
3. it builds the agent and the installer with `scripts\build.ps1`, checks the signature with
   `scripts\verify-signature.mjs`, writes `latest.json` with `scripts\update-manifest.mjs` and creates the release with
   the installer, its `.sig`, `latest.json` and the SHA-256 in the notes; a tag with `-` is a pre-release, which the
   automatic update does not see.

`scripts\build.ps1` on a PC signs with `%USERPROFILE%\.tauri\mango-code.key` (and `mango-code.password`) when the
variables above are not set; without any key it builds an installer that does not update (a fork's build).

Testing an update before publishing it: build the old version with `scripts\build.ps1 -InsecureUpdates` and install
it; build the new one with `-Version <higher>` and `update-manifest.mjs --url http://127.0.0.1:8765/<installer>`; serve
`latest.json` and the installer on 127.0.0.1:8765 and start the old app with
`MANGO_UPDATE_URL=http://127.0.0.1:8765/latest.json` (honoured only for 127.0.0.1 and localhost; an http address works
only in a `-InsecureUpdates` build). The key is the maintainer's and is never in the repo: if it is lost, the installed apps can no
longer update.

## Problem reports

"Report a problem" (Settings > Help, the error page, the startup error page) is one click (`src-tauri/src/report.rs`).
It sends a Sentry event to the project `mango-code` of the `mango-o6` organization (data in the EU): the user's
optional line, the error, the computer as tags (GPU, VRAM, model, RAM) and the attachments: `report.txt` (summary and
the end of every log), `screenshot.png` (`PrintWindow`, panel included; only if the user leaves the switch on, because
it can show the conversation) and the files the user chose with "Attach files" or pasted (an image), which go **as they
are**: the form says so. Before anything leaves, the user name in paths, the PC name, emails, network addresses,
keys and tokens are replaced by placeholders (not in the user's files); on Sentry's side the data scrubbers are on and IP
addresses are not stored.

The page sends one body, from the window (`reportProblem` of the bridge) and from the phone (`POST /phone/report`):
4 bytes with the length of a JSON header (`error`, `note`, `page`, `screenshot`, `files` with name, type and size), the
header, the files one after the other (`Submission::parse`, `utils/report.ts`). The limits are Sentry's (its documentation
on attachments): 40 MB for a request and 200 MB of attachments per event. The request goes out uncompressed,
so the user's files may add up to 30 MB (`FILES_MAX`) and the whole envelope is measured before sending (`ENVELOPE_MAX`,
40 MB, with `report.txt` and the screenshot in it). The page checks the limit before sending (`maxBytes` from `report_info`
or `GET /phone/report`) and the app checks again: a file that is too large is refused with a sentence that names it, in
the form, never dropped. A build without the Sentry address has no attachments (it writes a text file). Every report has level `error`, so the project's alert emails about it. The DSN is in the source (it only lets
one send); `MANGO_SENTRY_DSN=<dsn>` at build time sends elsewhere, `MANGO_SENTRY_DSN=off` turns sending off, and then
the button saves the same text on the Desktop and opens a GitHub issue already filled in.
- Live engine speed: `llamacpp:tokens_predicted_total` in `engine.log` (delta over 15 s) and the `eval time` lines;
  the counters update at the end of a request, so a long write looks stuck.

## Traps

- With the app open the installer fails with "Access denied" and the old version stays.
- The development server (`bun … serve --port 4096`) takes the app's port and makes its startup fail.
- Starting the app from a redirected console does not work: `start "" "<path>\mango-code.exe"`.
- Pictures without `SetProcessDPIAware` come out cut off on the right and at the bottom: it is not the app.
- `SetForegroundWindow` fails if the caller is not in the foreground: `ui.ps1` presses a fake ALT
  first; the first key after the focus can be lost.
- No pagination (`more`) in long commands: the terminal waits for keys.
