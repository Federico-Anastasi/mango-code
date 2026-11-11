# The Mango Code desktop app

Rust/Tauri 2. Double click → loading page → engine and agent server hidden, in a
Job Object (they die with the app) → window with the agent's web UI (opencode, in `packages/` at the repo root).
What the app opens for the user (files with "Open", links in the browser, the logs folder) starts outside that job
(`supervisor::open_outside_job`): a browser opened by the app stays open when the app quits. "Open" opens only documents,
text, images, sound and video (`OPENABLE` in `bridge.rs`: the agent writes these files, and other types may run code); any other
type is shown in File Explorer.
On close the engine saves its memory and stops. Once the agent runs, the X hides the window in the tray (a click on the
icon brings it back) and the icon's "Quit" closes; before that (model choice, download, startup error) the X quits.
The window shows only the app's own pages: the loading page and the agent's web UI on its port. Nothing else, a local
file or another local port (a project's development server) included, can take its place, and only those two get the
bridge (`capabilities/default.json` for the loading page, a capability added in `bridge::install` for the agent's port).
Dictation (the microphone in the chat) is the user's choice and does not hold the start: it is off until it is turned on,
on the first start page ("Models and engine" too) or in the settings, under "Dictation (microphone in the chat)". On, once the app is
ready, its models (whisper `small` and the Silero VAD, 465 MB) download in the background with the progress shown where it was
turned on, then the service starts; the chat's microphone works when it is ready, and before that it leads to the setting. Off
(even halfway through the download) the service stops and `models\whisper` is deleted. The choice is `<data>\dictation.json`
(`{"enabled": true}`); without it, whoever updates from a version that already had the models finds it on. `dictation.rs` holds
the rules and the tests; the agent always gets `MANGO_VOICE_URL` (the service's fixed address for the whole run), and a failed
download or start is shown in the setting, with "Try again". Development builds: `MANGO_DICTATION_FAKE=<MiB per second>` replaces
the download and the service with a pretence of the same duration (tests and pictures).

| where | what |
|---|---|
| `src-tauri/` | window, startup (`lib.rs`), process supervisor, native bridge for the web UI (`bridge.rs`), Preview panel (`preview.rs`), "Use my Chrome" (`chrome.rs`), dictation (`dictation.rs`), model preparation (`preparation.rs`), first run and model changes (`first_run.rs`, `choice.rs`, `system.rs`), the engine of another PC (`engine_remote.rs`), "Other models" (`other_models.rs`), the Team (`team.rs`), zoom of the window (`zoom.rs`), problem reports (`report.rs`), tray |
| `crates/engine` | the engine manager on 8080: starts the model the request asks for, saves the conversation before stopping, releases and resumes the GPUs (`/engine/*`), rejects web pages; `share.rs` shares it with the user's other PCs (below, "The engine for your other PCs") and `remote.rs` is the other side, the code of another PC checked and kept ("Using the engine of another PC"). Also `fake-engine` (the tests), `mango-bench` (the speeds of the catalog models), `mango-tune` (tuning: measures a tune, keeps the log, writes the profile; the `optimize/` skill uses it) and `mango-launch` (`-p "request"`: one request from a script to the running app, `docs/INTEGRATION.md`) |
| `crates/mango-common` | paths (`Paths::discover`), data folder, service file, `Build` (the build of an engine: `cpu`, `vulkan`, `cuda-12`, `cuda-13`), the app's language (`i18n`); `network` (the addresses of the home network and of Tailscale, for the phone and for the shared engine) and the key helpers (`random_hex`, `equal_ct`); `download`: download of engines (`mango-engines.json`) and models (`mango-models.json`) with resume and sha256, plus Hugging Face (`download/hugging_face.rs`: search, links, GGUF files with hash); `credentials`: the keys in the Windows Credential Manager |
| `crates/engine-cfg` | the PC's hardware (`hardware.rs`: GPUs of any vendor, CPU, RAM, build to use), the optimized profile if it applies (`profiles.rs`, `launcher/profiles/`) or the general plan with the official llama.cpp (`general.rs`), the recommended models (`recommended`), the split of layers across GPUs (`split.rs`) |
| `crates/agent-cfg` | the agent's config, generated from `launcher/opencode-home/opencode.template.json` (the test checks the generated config against a fixed file); `team.rs`: the Team |
| `crates/voice` | dictation: whisper in Rust, on the CPU |
| `crates/phone` | the web UI on the phone: the network port, the key, the sessions, the forwarding to the agent, the links with the QR (below, "From your phone") |
| `ui/` | the loading page, the model choice and the download; its texts are in `first-run.js` (Italian and English) |
| `scripts/` | staging and installer; `test/` to drive the app from scripts |

## Where it takes the files from

The resources are the `launcher/` tree. `Paths::discover` finds it like this: `MANGO_DIST`,
otherwise going up from the executable to the first `launcher/` folder (repo), then `resources/` (installed app).
`launcher/mango-paths.json` (optional, written by hand: `{"llama": "<engines>", "models": "<GGUF folder>", "opencode": "<agent folder>"}`)
moves engines, models and agent; without it, the
paths of the installed app apply: `%LOCALAPPDATA%\MangoCode\engine` and `\models` (an update does not delete them) and
`<dist>/opencode`, that is `resources/opencode` when installed and `launcher/opencode` in the repo, where `scripts\build-agent.ps1`
builds the agent.

At startup it starts the last model used (`<data>\model.txt`), otherwise the catalog default.

## Language

The app speaks Italian or English. The choice is `"language"` in `<data>\settings.json`; without it, the Windows display
language. Rust texts use `mango_common::tr!("testo italiano", "English text")`, which reads the language at every call.
The first-run page asks for it with the `language` command and picks its texts from the table in `ui/first-run.js`. The
tray menu follows a change when the pointer reaches the icon; the installer's labels follow the language of the
installer (`bundle.windows.nsis.languages` in `tauri.conf.json`, `windows/hooks.nsh`).

## Models, profiles, engines

- What the app installs as resources: `launcher/MANGO-CODE.md`. `launcher/mango-models.json` is the **model catalog**: what they are and where they are downloaded from (repo, revision, name,
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
  layers to RAM. A loaned GPU (`/engine/release`) does not send a GPU model to the CPU. **How fast a model on the CPU
  writes** (`speed.rs`) is told in a band, not in a number: tokens per second ≈ bandwidth ÷ bytes read for each token
  (`ModelCfg::read_per_token`), with one bandwidth (17 GiB/s) because the app does not know the PC's memory; the two PCs
  measured in `optimize/knowledge/general.md` (G90-G92) sit at 13.5 and about 24 GiB/s, so a figure would be wrong by more
  than half for many PCs. The choice page says "molto lento / lento / discreto / svelto" with words per second (from
  `Recommendation.speed` and, for the models found online, `Proposal.speed`, which takes them as dense); the versions of a repository are told "piccolo / medio / grande" by weight, their names in a "Dettagli
  tecnici" fold. Builds:
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
the next start resumes by itself. "Models and engine" reopens the choice when the app is in use: from the tray icon
or from "Download more models…" at the bottom of the model menu under the chat (Cancel goes
back to where it was; if something is downloaded the agent restarts to know the new models). The model menu under
the chat lists the models on this PC: the engine loads the chosen one with the next message, and the chosen one is
the default at the next start. Under each name the menu has a line (weight, "sulla scheda video" / "sul processore · lento",
"legge le immagini"; a model of another PC has its PC in its name) and, for a model marked `on_request`, the catalog's own warning that it is not reliable as an agent: the app gives
the facts to the agent in `MANGO_MODELS_INFO` (`agent-cfg`, `ModelInfo`) and the web UI reads them from `GET /mango/models/info`.
Models without a catalog verdict about their quality (the `fallback` 2B among them) have no warning. A model marked `fallback` in the catalog (Qwen3.5-2B, for 4 GB cards) is proposed,
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

## The engine for your other PCs

A PC with graphics cards can lend its models to the user's other PCs, at home or with Tailscale. **Off by default**; it is turned on
from the "Models and engine" page of the app (tray icon, or "Manage" in the model menu under the chat; `ui/first-run.js`, section
"Share the engine with my PCs"; `engine_share_*` bridge commands in `src-tauri/src/engine_share.rs`). The page is where the other
half lives too, "Use the engine of another PC of mine" (below). The service is `engine::share` (`crates/engine/src/share.rs`)
and the requests are served by the engine manager itself (`engine/src/http.rs`, `handle_network`): the manager stays on
`127.0.0.1:8080` as before, without a key, for the apps of this PC. The contract for a client is in `docs/INTEGRATION.md`
("The engine of another PC").

- **Its own port**, `47098` (`MANGO_SHARE_PORT`), open only while on, and **only on the addresses the settings show**: the home
  network's (a private address of an adapter with a gateway) and Tailscale's (`100.64.0.0/10`), never `0.0.0.0`. A thread reads the
  addresses again every 3 s (the Wi-Fi changes them) and opens or closes the ports to match. If a port does not open the settings say
  why. In development builds `MANGO_SHARE_PC_ONLY` keeps it on `127.0.0.1` (the tests: Windows asks nothing and no network is touched).
- **The key**: 24 random bytes in hex, in `<data>\engine-share.json` next to `enabled` (like `phone.json`). The settings show the address
  and a button that copies the **code**, `mango://<ip>:<port>/<key>`: one paste on the other PC. Turning off removes the key; "New key"
  drops the old one at once and closes the open connections. A request needs `Authorization: Bearer <key>` (compared in constant time):
  without it `401`, whatever the route. The key is not passed on to `llama-server`.
- **Checks, in order** (`admit` in `http.rs`, as soon as the head is read, before any body): an `Origin` `403`; a `Host` that is not a numeric
  IPv4 address `403`; the key `401`; the route. Allowed: `/v1/*` (`GET`, `POST`), and `GET` of `/health`, `/props`, `/metrics`, `/slots`, `/engine` and
  `/mango/models` (answered here: the models that are on the PC and fit, with their context and whether they see images, and the one
  running; the list is set at every start by `lib.rs`). Everything else `403`: the GPUs' loans (`/engine/release|resume|model`), the
  engine's writes (`POST /slots`, `POST /props`), paths with `..` or `%`.
- **Bounded**: the head must arrive within 10 s (however slowly), at most 32 connections are open at once (more are closed
  unanswered), and the refusals written to `manager.log` are at most 30 a minute (with the address and the path, never the key);
  `manager.log` itself becomes `manager.1.log` at 1 MB.
- **What it is worth**: whoever has the code can use the models and keep the engine busy (and make it reload another model), not
  see files or drive the agent. At home the code and the requests travel in the clear on the Wi-Fi; on Tailscale they are encrypted.
  Windows asks the first time whether the app may receive connections (no firewall rule is added by the app).

## Using the engine of another PC

The other half: a PC that uses the engine another one shares, even a laptop without a graphics card and with little disk. The code
(`mango://<ip>:<port>/<key>`) is pasted on the **"Models and engine" page** (`ui/first-run.js`, card "Use the engine of another PC of
mine"): at the first start it is the first thing the page offers, before the models; in use it is the tray icon's "Models and engine…"
or "Manage" in the model menu.

- **Checking** (`engine::remote`, `crates/engine/src/remote.rs`): the code is read by the same rule that writes it (`Code::parse`), then
  `GET /mango/models` with the key, 5 s. `200` with models: it is saved. `401`: "the code is not valid, or sharing is off on that PC".
  Refused or no answer: "the PC with the engine does not answer: is it on? Is Mango Code open there, with sharing on?". No models:
  "that PC has no model ready". Something else answering: it says it is not Mango Code. The sentence is shown under the field
  (`engine_remote_connect` in `src-tauri/src/engine_remote.rs`, bridge `engineRemote.connect`); the pasted text is never repeated.
- **Kept**: `<data>emote-engine.json` (`address`, `key`, in the clear like `phone.json`; see `SECURITY.md`). Its presence is the
  whole state: the app uses that PC's engine until "Back to the engine of this PC" (`engineRemote.disconnect`) deletes it.
- **At startup** (`lib.rs::startup`, `engine_remote::start`) with the file there: the PC's hardware is not read, no engine or model is
  downloaded, no `EngineManager` is made, port 8080 stays free and the model preparation is skipped. The other PC is checked again
  (the page "Connecting to the engine of the PC …"); the models offered to the agent are that PC's, named "… · on PC <ip>", and the
  default is the one running there. `service.json` has `"engine": null`. A PC that does not answer is the startup error page,
  with "Retry" and "Back to the engine of this PC" (`ErrorInfo.remote`). Dictation and the rest start as always.
- **The agent** (`agent-cfg`): `AgentInputs.engine_key` puts the key in the environment variable `MANGO_ENGINE_KEY` and the provider's
  `apiKey` becomes `{env:MANGO_ENGINE_KEY}`: the key is never in `opencode.json`. The agent sends it on `/v1` and on its two reads of
  the manager (`/engine`, `/slots`: "loading the model", the reading bar). `POST /tokenize` is not offered by the other PC's network
  door, so the weights in "What the model reads" stay "not measured". A connection that drops is worded "the PC with the engine
  does not answer…" and tried again with growing waits (about a minute); then the next message tries again.
- **The page when it is in use** (`choice.rs::show_remote`): no hardware, no downloads, no sharing; that PC and its models and the
  way back. Moving to a PC's engine while the app is in use stops this PC's model (it restarts on a request if sharing is on) and
  restarts the agent; at the first start it goes on from the page.

## From your phone

The web UI on the phone, from the same Wi-Fi or from outside the house with Tailscale. **Off by default**; it is turned on from the
web UI settings in the app ("From your phone", `settings-v2/phone.tsx`, `phone_*` bridge commands in
`src-tauri/src/phone.rs`), which shows the link with the key and its QR for the home network and for Tailscale (an
address in `100.64.0.0/10`). The phone does not see the bridge: no phone settings from the phone.

- **Its own ports**: `47096` for the web UI and `47097` for the browser panel's pages (`MANGO_PHONE_PORT` and
  `MANGO_PHONE_PREVIEW_PORT` for the tests), both open only while on and **only on the addresses the settings show** (the home
  network's and Tailscale's, never `0.0.0.0`; `mango_common::network::reconcile`, the same as the shared engine's). A thread reads
  the addresses again every 3 s. On an address where one does not open the other is closed too, and the settings say which. In
  development builds `MANGO_PHONE_PC_ONLY` keeps them on `127.0.0.1`. If Windows calls the home network public
  (`network::is_public`, the network list of Windows), the settings show a warning under its link. Agent and engine stay on `127.0.0.1` as before; the engine cannot be reached from the phone.
- **Entry**: `GET /phone?key=…` (24 random bytes, compared in constant time) → `303` to `/` with the cookie
  `mango_phone` (a random value of a session, never the key; `HttpOnly; SameSite=Strict; Path=/`, 90 days, not
  renewed); wrong or missing key `401` with a page made for the phone (`crates/phone/src/key.html`: the app's dark look, the icon, how
  to get in and a field to paste the link or the key, for an app on the home screen that cannot open a link).
- **Every other request**: requested address not numeric (a name pointing to the computer, DNS rebinding) `403`, also for
  `/phone`; `Origin` different from `http://<requested address>` `403`; without a valid session `401` (a sentence for the
  browser, JSON for the rest), except the manifest and the icons of the app (`PUBLIC_FILES`), which the system reads without the cookie;
  methods other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` `405`; the routes only the
  app on the PC uses (`/mango/warmup`, `/mango/extra-folders`) `403`; chunked body `400`; a line break or NUL outside `\r\n`
  in the head `400`; agent off `502`. The head must arrive within 10 s and at most 64 connections are open at once (more are
  closed unanswered).
- **Problem reports** (`/phone/report`): the one route the port answers itself. `GET` says what a report may carry,
  `POST` hands one to the app (`phone::Reports`, implemented by `PhoneReports` in `report.rs`: the logs and the sending are
  on the computer). It needs the same session, `Origin` and `Content-Length` as everything else, the body is bounded
  (`413` above the limit, refused before reading it) and the log has the outcome, never the content. The web UI shows
  "Report a problem" in Settings > Help also from the phone, without the window's screenshot, the updates or the logs.
- **The browser panel from the phone** (`site.rs`). The pages the agent builds live on the computer (`127.0.0.1:<port>`, local
  files), which the phone cannot reach, so the preview port shows them. Every request there needs the same session (the
  cookie of the first port is valid on the second: cookies do not depend on the port) and has the same checks: numeric
  address `403`, foreign `Origin` `403`, no session `401` (JSON, never the page that asks for the key), methods and chunked
  bodies as above. It is a port of its own and not a path under the first because pages with absolute paths (`/assets/…`)
  break inside a prefix. What it serves is decided on every request by what the panel on the computer shows *at that
  moment*, and never by what the phone writes: the phone sends only a path and a query.
  - A page on `http://localhost:<port>` or `http://127.0.0.1:<port>` is relayed to that loopback address (`localhost` is tried
    on `127.0.0.1` and `::1`; no name is resolved), with the page's own `Host`, `Origin` and cookies, without the phone's
    session cookie, `Referer` or `Authorization`. A redirect to the page's own address comes back as a path, and a WebSocket
    (the reload of a development server) passes both ways. Absolute addresses written inside the page (`http://localhost:3000/api`)
    still point at the phone itself and do not work.
  - A local file (`file://`) serves its folder, read-only (`GET` and `HEAD`, `Range` for videos): `/` is the file, and no path
    may leave the folder (`..`, a drive, a stream, a device name, a link out are `404`; the real file is resolved and must be
    inside).
  - A page of the internet, a blank panel or a server that does not answer get a page that says so (`404`, `502`).
  - `GET /phone/preview` (main port) says the preview port and the path of the page the panel shows (never its address on the
    disk); `POST /phone/preview` asks the panel to open a page first: `{"url"}` of a page of the computer (the same
    `localhost`/`127.0.0.1` rule) or `{"directory","path"}` of an HTML file of a project. The panel opens it (it is the
    computer's panel: on the computer it appears as when the agent opens a page).
  - On the phone, the globe in a conversation's bar opens the page full screen, over the conversation, in a frame (without
    the right to take the app away: no `allow-top-navigation`) with the arrow back to the conversation and a reload. A tap
    on a link to `localhost` or `127.0.0.1` in a message opens it there.
- **Files from the chat** (`/phone/file?directory=…&path=…`, main port): the cards of the documents the agent wrote (Word,
  Excel, PowerPoint, PDF, images) have "Open" also on the phone: the file is taken as a download (`Content-Disposition:
  attachment`, `nosniff`, so it is never shown as a page of the app); an HTML file opens in the preview instead. A picture
  and, where the browser has a PDF viewer (`navigator.pdfViewerEnabled`), a PDF open inside the app instead of downloading:
  the web UI fetches the file (up to 50 MB, `PREVIEW_MAX_BYTES`), gives it the type it must have and shows it from memory
  (`<img>` for a picture, an SVG too, so its scripts never run; a frame for a PDF, which is why the policy the port adds to
  the web UI allows `blob:` frames). The same session
  and checks, `GET`/`HEAD` only, and only a file inside the folder of the conversation's project: `directory` must be, or lie
  inside, a project folder the agent knows, `path` must be absolute and, with links and `..` resolved, inside `directory`
  (`403` otherwise, `404` if it is not there). With `&info=1` the answer is the size, as the card shows it. The log has the
  outcome and never a name.
- **Pages are never kept**: the HTML of the web UI goes out with `Cache-Control: no-cache` (the files with a hash in their name keep
  their own rule), so after an update the phone asks again.
- **Forwarding**: to the agent with its own `Host` and `Origin` (for the agent it is its web UI), without `Cookie`, `Referer`,
  `Authorization` or proxy headers; one request per connection, the response streamed (events included), the
  web UI terminal (WebSocket) both ways.
- **Turning off** closes the port, drops the sessions, closes the open connections and removes the key: a link seen
  before is not valid when it is turned on again. **New key** does the same without closing the port.
- State in `<data>\phone.json` (`enabled`, the key, of the sessions only the SHA-256 hash and the expiry, at most
  20); every entry, rejection, turning on and off is a line of `<data>\logs\phone.log`, never the key; the file stays bounded (the
  path of a request is cut to 200 characters, 60 refusals a minute, at 1 MB it becomes `phone.1.log`).
- **A session is worth the computer**: it commands an agent with the shell. At home the traffic goes in the clear on the Wi-Fi (this is
  why the cookie has no `Secure`); on Tailscale it is encrypted. The first time Windows asks whether the app may receive
  connections: allow it on private networks (and on Tailscale's, if Windows classifies it as public).
- **The page on a phone** (under 768 px; the computer's layout does not change): the page is exactly the area the browser leaves and
  follows the keyboard while it is open. The top bar is one row: in the Home the mark and the settings; in a conversation the back arrow,
  the title, a new conversation, the preview (the globe), the changes and the menu "…" (the settings are its first item); elsewhere the arrow, the title and the
  settings. The changes are a screen of their own. Messages are read at 16 px, small print and code at 14 px; buttons and menu rows are
  44 px tall, fields 16 px (iOS does not zoom them). The settings are two screens. The app can be put on the home screen (manifest with
  its icons).
- Tests: `cargo test -p phone` (the rules one by one, on 127.0.0.1: both ports, the checks, what the preview port may reach,
  the folder and project limits); `integration/tests/phone.test.ts` (the real app:
  turned on from the bridge, entry, web UI and agent from the port, turned off). In development builds `MANGO_PHONE_PC_ONLY` keeps
  the port on `127.0.0.1`, so the tests do not make Windows ask to open it.

## Zoom

Ctrl+ / Ctrl- / Ctrl+0 and Ctrl+wheel zoom the page they are on: the chat or the page in the Preview panel, each by itself
(the keys are the browser's own: both webviews are built with `zoom_hotkeys_enabled`). WebView2 tells `zoom.rs` when a
zoom changes. The window's zoom is kept in `<data>\zoom.txt` (the file goes away at 100%) and applied at the next start;
it is the zoom WebView2 reports, not one worked out from the page scale, which also contains the screen's scale and
Windows' text size. The panel's zoom lasts until the app closes and sits on top of the format's own (`fit` × `user` in
`preview.rs`: a phone or a tablet is shown whole, shrunk to the room there is). `preview_place` converts the placeholder's rectangle
with the page scale, so after a zoom of the window the native panel stays on its place. While a dialog, menu or list is open above the
page the panel steps aside (`layerOver` in `preview-panel.tsx`: Kobalte marks its open layers) and comes back when it closes.

**How the panel looks.** A card with the chat's gap and rounded corners (`preview-panel.tsx`). The page is a native window on
top of it, a rectangle: `preview_place` also receives how round its corners are and `round_corners` in `preview.rs` cuts the
window to that shape, again at every change of size (the two bottom corners in the desktop format, where the page reaches
the card's; all four on a device). The phone and the tablet formats draw a device, a recent iPhone (393 × 852) and an
11-inch iPad (834 × 1194), with the page on its screen at its real size and the whole device scaled to fit the panel.

**PDF and pictures in the panel.** The card of a PDF or a picture (png, jpg, gif, webp, bmp, ico, svg) opens it in the panel with a
click (`preview_file` in `preview.rs`, the bridge's `preview.openFile`): the same checks as `open_path` (only a file inside a
project or in `Documents\Mango Code`), at most 50 MB, readable. A PDF or a raster picture is opened by its own `file://`
address; an SVG goes through `<data>\preview-view\image.html`, a page with no script that draws it in an `<img>`, because as
a page of its own an SVG runs its scripts. The refusals carry a code the card turns into a sentence: `too_large`,
`unreadable`, `blocked_type`, `not_found`, `forbidden`. Word, Excel and PowerPoint keep opening in their Windows program.

**While a page loads.** The native panel stays hidden until the page it navigates to is the one it shows; the web UI puts its own message
("Loading the preview…") in the placeholder, so no blank rectangle appears. The WebView2 events (`on_navigation` at the start,
`Finished` at the end) arrive for pages, pictures, PDFs, SVG pages and refused addresses; the start of the content (`Started`) only when the
server answers. An address whose page has not arrived after 30 s (`load_limit`, `MANGO_PREVIEW_LIMIT_MS` in debug builds) is given up:
the panel goes to `about:blank`, `preview.state()` carries `failed` with the address and the web UI shows the sentence and "Try again".
A page that arrived and is still loading is left alone.

## What goes in the prompt

Every item of the fixed prompt (base tool, MCP server, skill, instructions file, plugin) is on or off. The agent
rereads at every request `<data>\settings.json` (`agent-cfg` sets `MANGO_SETTINGS`, so it follows `MANGO_DATA`) and
`.mango/settings.json` of the working folder; the settings "Prompt" tab writes them. The weight in tokens of
each item is counted by the engine (`POST /tokenize`, which goes through the manager; the fake engine counts one word per token) with the
first request of a conversation and writes it in `opencode.log`. The format and the routes: `docs/INTEGRATION.md`.

## The Team

Roles in `launcher/opencode-home/MANGO-{manager,dev,agent}.md`, plugin
`launcher/opencode-home/plugin/mango-team.js`. The **manager** (a cloud model, DeepSeek V4.1 Flash by
default) is the opencode agent `team` in the app's server; the **dev** (the local model) and the **agents** (up to 4, cloud)
are hidden `opencode serve` processes that the plugin starts at the first `ask_dev` and at every `launch_agent`, in the
manager's project folder, with their own config and data (`<data>\team\`); links and pids are in `<data>\team\`, not in
the distribution. One Team at a time: the ports are fixed (dev 4090, agents 4092-4095).

- **In the chat**: the "Team" switch next to the model (`packages/app/src/components/team-switch.tsx`) passes the
  conversation to the manager (agent `team`, with its model) and back to the local model. It is there only once the
  key is saved (`utils/team-switch.ts`); before that the Team is set up from the settings.
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

The agent is opencode, in `packages/` at the repo root with the rest of the upstream tree (base `v1.19.5`). One
binary, `launcher/opencode/web/mango-code.exe` (folder ignored by git).

```powershell
app\scripts\build-agent.ps1   # bun install + bun run script/build.ts --single (5-15 min)
```

It needs **Bun 1.4.4 or later**: the Bun runtime is inside the binary, so the one it is built with counts (1.4.0 had
a segfault on Windows). Which runtime is in a binary:
`findstr /M /C:"38afee6c8" mango-code.exe` (38afee6c8 = Bun 1.4.4). After a build: `mango-code.exe --version` prints
`1.19.5-mango` and the integration tests (below) pass with that binary. `MANGO_OPENCODE` (the tests) and `--opencode`
(the staging) use a separate build, in a folder with `web\mango-code.exe`. The tests of the agent sources
are run from the package folder (`cd packages\opencode; bun test --timeout 30000`, which is what `bun run test` does: Bun's own
limit of 5 s fails the slow ones on a busy computer, and `bunfig.toml` cannot set it): the root refuses them.
`test/project/vcs.test.ts` "keeps carriage returns inside patch hunks" fails the same way on the upstream tag (v1.19.5, Windows): it is upstream's, not ours.

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

## Building and testing

```powershell
app\scripts\build-agent.ps1          # the agent (above)
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

`launcher/opencode-home/package.json` (tracked: `{"dependencies": {"@opencode-ai/plugin": "1.19.5"}}`) is what the
staging installs the plugin packages from; without it `npm install` there goes up to the launcher's `package.json` and modifies it.

`bun test integration` from the root does not start: opencode's `bunfig.toml` points the tests to a folder that does not exist,
to prevent running them from the root. `--cwd integration` runs them from inside.

The staging takes the files named in `prepare-installer.mjs`, the folders only with the files tracked by git, the node
packages that are really needed and `<opencode>\web\mango-code.exe`. It rejects secrets, generated configs, logs, weights, engines and
NVIDIA libraries: the installer is a base one, the engines are downloaded at first run. Development from source does not change
(`scripts\build-engines.ps1` builds an engine fork into the `llama` folder that `mango-paths.json` names). `mango-tune.exe`
goes into `resources\optimize` and `mango-launch.exe` into `resources`, built by `build.ps1`.

An installer built from a worktree can fail in `makensis` ("failed opening file") because of paths over 260
characters: `subst W: <worktree>` and build from `W:\app\src-tauri`.

To install: close **all** instances of the app and delete the old setup, then
`target\release\bundle\nsis\Mango Code_*_x64-setup.exe /S`. It installs in `%LOCALAPPDATA%\Mango Code`,
the data goes in `%LOCALAPPDATA%\MangoCode` (logs in `logs\`).

Uninstalling asks whether to free the space: if yes, it deletes `models\` (dictation included), `engine\`, `slots\`,
`memory\` and `logs\`, and leaves the conversations (`agent\`) and the settings (the files next to the folders). The
question says so and where they are, for whoever wants to delete them by hand. `windows/hooks.test.mjs` runs the
deletion on a copy (`node --test app/src-tauri/windows/hooks.test.mjs`, needs the `makensis` that `tauri build` downloads).

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
- Live engine speed: `llamacpp:tokens_predicted_total` in `engine.log` (delta over 15 s) and the `eval time` lines;
  the counters update at the end of a request, so a long write looks stuck.
- Logs: `%LOCALAPPDATA%\MangoCode\logs\{startup,agent,engine,manager,ui}.log` (`manager.log`: who called `release`,
  `resume` or `model`, when and with what outcome; `ui.log`: the web UI's uncaught errors and `console.error`, and the
  calls to the app slower than a second or with no answer, at most 100 lines a minute and 2 MB (then `ui.1.log`); the TOQ engine's `llama.log` is in the same folder); the
  agent's real one is `%LOCALAPPDATA%\MangoCode\agent\data\opencode\log\opencode.log` (`init count=N` = skills loaded
  per instance). With the app open, Windows can show these files at 0 bytes: they are being written, not empty.

## The app's connections to the internet

Every HTTP call of the app (downloads of models and engines, Hugging Face, problem reports, the calls to its own servers) starts in
`crates/mango-common/src/internet.rs` (`ureq` 3): the certificates are Windows' (`rustls-platform-verifier`), and the app neither installs one nor
has an option to skip the check. The proxy is decided for each address, in this order:
1. this computer and the local network (`127.0.0.1`, `localhost`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, Tailscale's `100.64-127.x`, IPv6 `fc00::/7` and `fe80::/10`): never through a proxy;
2. `NO_PROXY` (comma-separated: `host`, `.domain`, `*`, patterns like `10.*`) takes the host out of the proxy, Windows' too;
3. `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (lower case too) win over Windows; with `http://user:password@proxy:port` the proxy gets Basic access;
4. Windows' proxy for the user (Settings > Network > Proxy): the auto-configuration script or the detection (WinHTTP resolves them), otherwise the manual proxy with its "don't use for" list.

SOCKS proxies and proxies that want the Windows login (NTLM, Kerberos) are not supported. When the certificate of a company filter is not among Windows',
the download, the report and the update check stop at once with a sentence that says what to ask whoever manages the computer; a proxy that refuses or
does not answer is named in the sentence. The updates' plugin has its own network (`reqwest`, also with Windows' certificates): `updater.rs` gives it the
proxy `internet.rs` names for the updates' address. The agent (Bun, with the servers it starts) reads only the environment variables, so the app gives it Windows' proxy as `HTTP_PROXY` and `HTTPS_PROXY`
(`child_proxy_env`, when Windows has one and the user has named none), with a `NO_PROXY` for this computer, the local network ranges (Bun reads
CIDR ranges, not `10.*` patterns) and the engine's own address: without it Bun sends even `127.0.0.1` to the proxy and the agent cannot reach the engine
(`integration/tests/agent-proxy.test.ts`, with `MANGO_WINDOWS_PROXY` giving a debug build a Windows proxy). The servers run by `npx` (Node, which ignores these variables unless told otherwise) were not tried. In the tests, `internet/fake_proxy.rs` plays a proxy (it records the `CONNECT`s, forwards, refuses, or presents a certificate
signed by a root no computer knows; the root's key was thrown away and the root must not be installed anywhere), and reading Windows' settings sits behind `windows_proxy`, which the tests replace.

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
   final `X.Y.Z` is higher), and write the notes in `release-notes/v<version>.md` with a `**Changed since …**` list:
   it is the text of `latest.json`'s notes. `node app/scripts/check-version.mjs` checks all of this; the workflow
   runs it with `--tag`, so the tag must be `v` + the version;
2. push the tag `v<version>`: the workflow waits for the maintainer's approval on the `release` environment, which
   holds the signing key (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`);
3. it runs the tests that need neither a graphics card nor the network (`cargo test --workspace`, the release
   scripts' tests, the list of Rust crates against `Cargo.lock`), builds the agent and the installer with
   `scripts\build.ps1 -Phase Build` (no key in the environment), signs it with `-Phase Sign` (the only step that reads
   the key), checks the signature with `scripts\verify-signature.mjs`, writes `latest.json` with
   `scripts\update-manifest.mjs`, creates the release as a draft with the installer, its `.sig`, `latest.json` and the
   SHA-256 in the notes, and publishes it only when GitHub lists the three files with the sizes they have here; a tag
   with `-` is a pre-release, which the automatic update does not see.

`scripts\build.ps1` on a PC (phase `All`) signs with `%USERPROFILE%\.tauri\mango-code.key` (and `mango-code.password`) when the
variables above are not set; without any key it builds an installer that does not update (a fork's build).

Testing an update before publishing it: build the old version with `scripts\build.ps1 -InsecureUpdates` and install
it; build the new one with `-Version <higher>` and `update-manifest.mjs --notes "test" --url http://127.0.0.1:8765/<installer>`; serve
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
are**: the form says so. Before anything leaves, the user name in paths (or the whole profile folder, if it is not under
`Users`), the PC and Windows domain names, the company's name in a OneDrive folder, emails, network addresses, keys and
tokens are replaced by placeholders (not in the user's files); the names of the user's project folders and files stay, and
the logs may carry them; on Sentry's side the data scrubbers are on and IP
addresses are not stored.

The page sends one body, from the window (`reportProblem` of the bridge) and from the phone (`POST /phone/report`):
4 bytes with the length of a JSON header (`error`, `note`, `page`, `screenshot`, `files` with name, type and size), the
header, the files one after the other (`Submission::parse`, `utils/report.ts`). The limits are Sentry's (its documentation
on attachments): 40 MB for a request and 200 MB of attachments per event. The request goes out uncompressed,
so the user's files may add up to 30 MB (`FILES_MAX`) and the whole envelope is measured before sending (`ENVELOPE_MAX`,
40 MB, with `report.txt` and the screenshot in it). The page checks the limit before sending (`maxBytes` from `report_info`
or `GET /phone/report`) and the app checks again: a file that is too large is refused with a sentence that names it, in
the form, never dropped. A build without the Sentry address has no attachments (it writes a text file). Every report has level `error`, so the project's alert emails about it. The DSN is in the source (it only lets
one send); `MANGO_CODE_SENTRY_DSN=<dsn>` at build time sends elsewhere, `MANGO_CODE_SENTRY_DSN=off` turns sending off, and then
the button saves the same text on the Desktop and opens a GitHub issue already filled in.

## Traps

- With the app open the installer fails with "Access denied" and the old version stays.
- The development server (`bun … serve --port 4096`) takes the app's port and makes its startup fail.
- Starting the app from a redirected console does not work: `start "" "<path>\mango-code.exe"`.
- Pictures without `SetProcessDPIAware` come out cut off on the right and at the bottom: it is not the app.
- `SetForegroundWindow` fails if the caller is not in the foreground: `ui.ps1` presses a fake ALT
  first; the first key after the focus can be lost.
- No pagination (`more`) in long commands: the terminal waits for keys.
- The engines' command line: the official llama.cpp reads any path, the forks (`toq`, `prism`) read it in the ANSI code page and do not
  open a file under a user called `José`. The plan passes paths by their short names (`mango_common::engine_path`); tried with
  `llama-server` on folders with `è ñ`, `Ł`, Cyrillic and Chinese. On a volume without short names the engine's own error remains.
