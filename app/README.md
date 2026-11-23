# The Mango Code desktop app

Rust/Tauri 2. Double click → the logo → the control server (the engine manager on its port, with no model yet) and the
agent server hidden, in a Job Object (they die with the app) → window on the home of the agent's web UI (opencode, in
`packages/` at the repo root), never on the last conversation → the default model loads in the background, and the engine
manager tells how it goes (`GET /engine`). Nothing at startup concerns the last conversation; `logs\startup.log` has one
line per phase with the time since the start.
What PowerShell 7 from the Microsoft Store starts (a web server left in the background) is created outside every job: the agent gets
`MANGO_APP_RUN`, a value of this run, every process it starts inherits it, and at Quit `mango_common::stragglers` stops the ones that carry it; the start of the next run stops the ones left by an app
that was closed by force (its value names the process that owned it, which no longer runs), except those with a visible window and the ones those started: the user may be working in them. A guardian does the same without waiting for the next start: the app starts `mango-code.exe --reap <pid> <run>` (`helper.rs`) outside its job and without a window, which starts a second copy of itself and ends, so that ending the app with its processes (`taskkill /T`) does not reach it; the copy waits for the app to end, however it ends, and stops the processes of the run that have no visible window. Measured with `off-screen`: every
process started by the Store's PowerShell 7 leaves the job, while the ones of Windows PowerShell 5.1 do not. Where an outer job does not let a process leave it (the tests run the app inside one) the guardian starts inside the app's job and ends with it, which `startup.log` says; the next start then stops what the agent left running. The copy that starts the app again after a move is let go of the job just before the app ends.
What the app opens for the user (files with "Open", links in the browser, the logs folder) starts outside that job
(`supervisor::open_outside_job`): a browser opened by the app stays open when the app quits. "Open" opens only documents,
text, images, sound and video (`OPENABLE` in `bridge.rs`: the agent writes these files, and other types may run code); any other
type is shown in File Explorer.
On close the engine saves its memory and stops. Once the agent runs, the X hides the window in the tray (a click on the
icon brings it back) and the icon's "Quit" closes; before that (startup, a startup error) the X quits.
The window shows only the app's own page (the logo while it starts, the error that stops a start) and the agent's web UI on its port. Nothing else, a local
file or another local port (a project's development server) included, can take its place, and only those two get the
bridge (`capabilities/default.json` for the loading page, a capability added in `bridge::install` for the agent's port).
Dictation (the microphone in the chat) is the user's choice and does not hold the start: it is off until it is turned on
in the settings, under "Dictation". On, once the app is
ready, its models (whisper `small` and the Silero VAD, 465 MB) download in the background with the progress shown where it was
turned on, then the service starts; the chat's microphone works when it is ready, and before that it leads to the setting. Off
(even halfway through the download) the service stops and `models\whisper` is deleted. The choice is `<data>\dictation.json`
(`{"enabled": true}`); without it, whoever updates from a version that already had the models finds it on. `dictation.rs` holds
the rules and the tests; the agent always gets `MANGO_VOICE_URL` (the service's fixed address for the whole run), and a failed
download or start is shown in the setting, with "Try again". Development builds: `MANGO_DICTATION_FAKE=<MiB per second>` replaces
the download and the service with a pretence of the same duration (tests and pictures).

| where | what |
|---|---|
| `src-tauri/` | window, startup (`lib.rs`), process supervisor, native bridge for the web UI (`bridge.rs`), Preview panel (`preview.rs`), the folders served to it as sites (`sites.rs`), "Also in my Chrome" (`chrome.rs`), dictation (`dictation.rs`), the control server's routes (`control.rs`), the downloads in the background (`downloads.rs`), the user's choices about the models and the computer and taking a model off it (`model_choices.rs`), the models the agent knows, told again when they change (`agent_models.rs`), the engine of another PC (`engine_remote.rs`), "Other models" (`other_models.rs`), the Team (`team.rs`), automatic updates (`updater.rs`), zoom of the window (`zoom.rs`), problem reports (`report.rs`), tray (`tray.rs`: "Open", "Settings…", "Quit") |
| `crates/engine` | the engine manager on 47080: starts the model the request asks for, adds to the chat requests that do not say them the style and the reasoning the user chose (and `preserve_thinking`, always), loads the running model again when the user's choices change its plan, remembers the model the conversations stay on while a request marked as a side one has the engine on another, keeps the official engine's slot files (the system prompt of a new conversation, read once; the last conversation, saved before stopping: `prefix.rs`), releases and resumes the GPUs (`/engine/*`), rejects web pages; `share.rs` shares it with the user's other PCs (below, "The engine for your other PCs") and `remote.rs` is the other side, the code of another PC checked and kept ("Using the engine of another PC"). Also `fake-engine` (the tests), `mango-bench` (the speeds of the catalog models), `mango-tune` (tuning: measures a tune, keeps the log, writes the profile; the `optimize/` skill uses it), `mango-launch` (`-p "request"`: one request from a script to the running app, `docs/INTEGRATION.md`) and `off-screen` (a command on a Windows desktop nobody sees: the integration tests without their windows on the screen) |
| `crates/images` | the image manager: one picture at a time, drawn by a server of the image engine (`sd-server`, stable-diffusion.cpp) that stays on between the pictures of a conversation about images and is started and stopped for a single picture; it takes the card from the engine manager while it draws (a model that writes there is put aside and comes back), tells how far the picture is step by step with a small preview, and stops a picture on request. `jobs.rs` gives each picture a number to follow it by; `routes.rs` is the routes under `/control/image` on the engine manager's port (`docs/INTEGRATION.md`, "Pictures") |
| `crates/mango-common` | paths (`Paths::discover`), data folder, service file, `Build` (the build of an engine: `cpu`, `vulkan`, `cuda-12`, `cuda-13`, and `cuda-12-gtx16` of our forks for the GTX 16 family), the app's language (`i18n`); `network` (the addresses of the home network and of Tailscale, for the phone and for the shared engine) and the key helpers (`random_hex`, `equal_ct`); `download`: download of engines (`mango-engines.json`: llama.cpp, our forks, and `sd` for the models that make images) and models (`mango-models.json`) with resume and sha256, plus Hugging Face (`download/hugging_face.rs`: search, links, GGUF files with hash); `credentials`: the keys in the Windows Credential Manager |
| `crates/engine-cfg` | the PC's hardware (`hardware.rs`: GPUs of any vendor, CPU, RAM, build to use), the optimized profile if it applies (`profiles.rs`, `launcher/profiles/`) or the general plan with the official llama.cpp (`general.rs`), the recommended models (`recommended`), the split of layers across GPUs (`split.rs`), the plan of a model that makes images (`image.rs`: the image engine, the model's files, the card it draws on) |
| `crates/agent-cfg` | the agent's config, generated from `launcher/opencode-home/opencode.template.json` (the test checks the generated config against a fixed file); `team.rs`: the Team |
| `crates/voice` | dictation: whisper in Rust, on the CPU |
| `crates/phone` | the web UI on the phone: the network port, the key, the sessions, the forwarding to the agent, the links with the QR (below, "From your phone") |
| `ui/` | the app's own page: while the app starts, the wordmark with the mango moving slightly, a line saying what happens and a bar that advances one piece at each stage of the start (the app sends `step` and `steps` with the state); and the error that stops a start, with Retry, Open the logs and, when the engine in use is another PC's, the way back to this one; "Report a problem" is at the bottom in every state; its texts are in `startup.js` (Italian and English); colours and typefaces come from `suite/` at the repo root, which `src-tauri/build.rs` copies into `ui/suite/` (not committed) before Tauri packs the page |
| `scripts/` | staging and installer; `test/` to drive the app from scripts |

## Where it takes the files from

The resources are the `launcher/` tree. `Paths::discover` finds it like this: `MANGO_DIST`,
otherwise going up from the executable to the first `launcher/` folder (repo), then `resources/` (installed app).
`launcher/mango-paths.json` (optional, written by hand: `{"llama": "<engines>", "models": "<GGUF folder>", "opencode": "<agent folder>"}`)
moves engines, models and agent; without it, the
paths of the installed app apply: `%LOCALAPPDATA%\MangoCode\engine` and `\models` (an update does not delete them) and
`<dist>/opencode`, that is `resources/opencode` when installed and `launcher/opencode` in the repo, where `scripts\build-agent.ps1`
builds the agent. The models folder the user chose (`%LOCALAPPDATA%\MangoCode\models-dir.txt`, one line, written by the app
in the settings) comes after `mango-paths.json` and before `\models`; every binary that calls `Paths::discover` reads it.

**Choosing and moving the models folder** (`mango_common::models_dir`, `src-tauri/src/models_move.rs`): the preview changes
nothing (bytes and files to move, free space with the margin of a download, same volume or not, junctions and hard links found,
partial downloads, whether the engine can open files in the new path, whether the destination has files of its own, a line of
warning for a network or removable disk). On the same volume each entry of the old folder is renamed; on another volume the
files are copied one by one with their modification time (the note of a verified hash, `.verified`, depends on it), checked by
size and, where a note exists, by hash, the choice is written, and only then the old files are removed one by one
(`remove_file`, `remove_dir`, never `remove_dir_all`). Junctions and symbolic links are never followed or removed. Before it,
everything that uses the folder stops as when a model is taken off the computer (the engine and the pictures, the downloads
held without being paused, the dictation, the watch); the app then starts again by itself (`mango-code.exe --relaunch <pid>`,
which waits for the old process to end), or, if something stayed in the old folder (a junction that holds models, a file another
program had open), waits until the user has seen what and asks for it. A move that is cancelled or fails before the choice is written
leaves the old folder as it was and the app goes on; ending the app or installing an update first stops a move under way. Only what
is Mango Code's moves (the files of the catalog's models and of the user's list that are in the folder, the dictation models, what the
app writes next to them); any other file stays and the preview says so. Copies are hashed on both sides, the places and the user's
models that point into the old folder are rewritten and read back before an original is removed, and a journal (`models-move.json`)
lets the next start finish or put back a move that stopped half way. A destination with files of its own is only used as it is.

**One model's files elsewhere** (`mango_common::model_files`, `models_dir::place`): the files of a catalog model (with their
notes and partial downloads) can be put in a folder of the user's, on the same safe terms, and the app remembers it in
`%LOCALAPPDATA%\MangoCode\model-files.json` (catalog path of each file → where it is). `catalog::read` applies it, so the plan
of the engine, the downloads, the sizes and the removal find the file there; removing the model deletes it there, downloading
it again puts it there. A GGUF chosen on the computer that is the very file of a catalog model (same name, size and hash) is not
added to the user's list: the model keeps its settings and runs from that file, which is never downloaded or deleted.

**In the settings** (`packages/app/src/components/settings-page/models-folder.tsx`): the card «The rest» of Settings › Computer
has the row «Models folder» (the folder, how much the models take and on which disk, «Change…»). The Windows folder picker
opens, then the row asks what the preview says (size, free space, same disk or not, the warning for a network or removable
drive, what stops, that the app starts again) with «Cancel» and «Move»; a destination with files of its own offers «Use this
folder» instead; one that cannot be used says why. While it moves the row shows the bar, the bytes and «Cancel» (not once the old
files are being removed); a move that fails, is cancelled or waits for the app to start again is told in the row. In a model's
detail in Settings › Models, «Move this model…» does the same for that model's files (the app goes on), the row says where
its files are when they are not in the models folder (`placed_in` of `/mango/models`), and «Put back in the models folder»
puts them back. Models whose files the user chose, or that the user added, do not have it.

## Language

The app speaks Italian or English. The choice is `"language"` in `<data>\settings.json`; without it, the Windows display
language. Rust texts use `mango_common::tr!("testo italiano", "English text")`, which reads the language at every call.
The app's own page asks for it with the `language` command and picks its texts from the table in `ui/startup.js`. The
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
  context + measured numbers (`measurements`). It applies if the PC's GPUs with more than 2 GiB are exactly the ones it asks for
  (`3060ti-1080-1660s/`), or on every PC with one of its builds (`general/`: TOQ on NVIDIA). Format in `launcher/profiles/README.md`.
- Without a profile that applies, `plan()` uses the **general plan**: official llama.cpp
  (`<engines>\llamacpp\<version>-<build>\`) with the build from `choose_build` and the arguments computed from the hardware.
  The model runs **all on the GPUs or all on the CPU, never split**: on the GPUs (`-fit off -ngl all`, GPUs
  visible with CUDA) if weights, image encoder and cache for at least 32K tokens fit; otherwise on the CPU
  (`-dev none -t <cores>`, with official llama.cpp's processor-only build, `cpu`: the CUDA build used with no card in sight
  can close with an access violation while it reads a prompt; on a PC with cards that build is a download of 25 MB, which the app
  makes by itself because the PC already has the engine for its cards) if they fit in RAM; otherwise it does not fit, and
  the error says how much is needed and what to do. The context is the maximum that fits, in steps of 4096, up to the
  model's own maximum (or the context the user chose, any number of tokens from 32K to that maximum); the cache drops to
  q8_0 if f16 is not enough. The context is computed on all the NVIDIA cards that are not
  loaned; the model then takes the fewest of them (among as many, the strongest: `split::by_power`) that give the same context with the
  same cache type (with Vulkan, all of them). `-fit` must be off because llama.cpp turns it on by itself and would move
  layers to RAM. A loaned GPU (`/engine/release`) does not send a GPU model to the CPU. **How fast a model on the CPU
  writes** (`speed.rs`) is told in a band, not in a number: tokens per second ≈ bandwidth ÷ bytes read for each token
  (`ModelCfg::read_per_token`), with one bandwidth (17 GiB/s) because the app does not know the PC's memory; the two PCs
  measured in `optimize/knowledge/general.md` (G90-G92) sit at 13.5 and about 24 GiB/s, so a figure would be wrong by more
  than half for many PCs. The interface says the band (`ModelView.verdict.speed` and, for the models found online,
  `Proposal.speed`, which takes them as dense). Builds:
  NVIDIA with CUDA 13.4 driver and Turing or later GPUs `cuda-13`; CUDA 12.4 driver `cuda-12`; AMD, Intel or NVIDIA
  with an older driver `vulkan`; no GPU with more than 2 GiB of its own `cpu` (the processor's integrated graphics counts as a GPU only when it was given 8 GB or more, as on a Ryzen AI Max: `Gpu::is_integrated`, read from the adapter's name, and `MIN_INTEGRATED_GPU_MEMORY_MIB`; a name that does not say it for certain is a card). Models with `requires_engine` do not run without a
  profile of their own (for the GPUs or the build). Our forks (`prism`, `toq`) are compiled for AVX2 and cannot start on a
  processor without it (`avx2` in `mango-engines.json`); the official llama.cpp picks its code for the processor at run time and
  starts on any x64 one (checked in the zips of the catalog: `ggml-cpu-x64` up to `ggml-cpu-sapphirerapids`, also in the Vulkan and CUDA ones).
  On a processor without AVX2 a profile on a fork does not apply (the general plan does) and a model that requires a fork says so in
  its line.
- `recommended(paths, hw)` says for each model where it runs (GPUs or CPU) with what context, or why it does not fit, and
  which of the recommended ones is probably the fastest: on the GPUs it beats the CPU, at equal placement the one that
  reads fewer weights per token wins (`active_permille` of the MoEs in the catalog).
  The model proposed to whoever has none (`mark_recommended`) is the first in the catalog that fits and is not on the disk, on
  the GPUs if one fits there; on the processor, the first that writes at the speed of reading or faster (band «fair»), or the
  fastest if none does: a 27B dense model that merely fits in a laptop's 16 GB is not proposed.

## The models on the computer

The installer brings no engines or weights. With no model on disk the app opens on the home all the same, and the agent
knows every model of the catalog from the start (a model downloaded later needs no new agent). The models are chosen and
downloaded in the settings of the web UI, section Models (`GET /control/models`, the bridge's `models.*`): the tray's
"Settings…" opens it with the event `mango-settings` on the
window (`{ section: "models" }`, `tray::open_settings`). A model that does not fit is listed without the line that says
where it runs; choosing it shows the sentence of the plan (the manager answers 422, which the agent does not retry). The agent knows every model of the catalog, also the ones not
downloaded yet; the model menu under the chat lists those on the disk (`present`), and the engine loads the model chosen
there with the next message. When the app opens it loads the default model (`default` in
`<data>\choices.json`) or, without one, the first model on disk in the catalog's order. If the default's engine is being
updated (a new version of it came with the app), the app waits for it as long as a download that brings that engine is
queued or running, and loads the default as soon as the engine is on the disk (not when the files of the download that
brought it end), also if a message to the agent had made its start fail meanwhile;
if the download fails, is paused or cancelled, or none was queued, it loads another model that is ready (never one being
taken off the computer). Under each name the menu says where the model runs and with how much context («2 cards ·
128K», «Processor · 128K»; a model of another PC has its PC in its name): the app gives the facts from its control
server (`/control/models`, `/control/state`), which the web UI reads through the agent's `GET /mango/models` and
`GET /mango/state` (the agent forwards them to `MANGO_CONTROL_URL`). A model marked `on_request` is never preselected nor
called the fastest. A model marked `fallback` in the catalog (Qwen3.5-2B, for 4 GB cards) is proposed, and called the
fastest, only when no other model fits on the graphics cards.

The models that make pictures (`image` in the catalog; `about` is the line under the name, in both languages, like the
models that write) come in the same answer of `/control/models` as `image_models` (`key`, `label`, `about`, `license`,
`present`, `bytes`, `where`: the cards its plan draws on, or the processor) and `image_default`; the engine that is on
after a picture is `image_loaded` in `/control/state`. Whether one fits this computer is not told: what they ask of a card
and of the processor is not measured. In the settings, Models has the group «They make pictures» (`settings-page/images.tsx`)
with the words and the actions of the other models: the same background downloads, «Remove from the computer», and «Use as
default» (`models.setImageDefault`, saved as `image_default` in `choices.json`; a picture asked without a model is
made by it, and taking that model off the computer gives the choice back to the catalog's default). Under the models, two
choices of the web UI itself, kept with its other settings (`images.rewrite`, `images.rewriter`): whether a model that
writes rewrites the request before the picture (on by default), and which one (automatic: Ling if it is on the computer,
otherwise the default model).

**Pictures in the conversation** (`packages/app/src/components/prompt-picture.tsx`, `packages/session-ui/src/components/picture-tool.tsx`).
The box a conversation is written in has a choice «Text / Picture», first of its controls, in a
conversation and in a new one. On «Picture» what is written is the description of the picture: the model menu lists the
models that make pictures and are on the computer (the conversation's choice holds; without one, the default), the format
(Square, Portrait 9:16, Landscape 16:9) and the size (Small, Large) are two segmented controls that take a second
line of the box when they do not fit, and attachments, commands, mentions and the shell are not offered; dictation is.
What was attached on «Text» is not sent with a picture and stays in the box.
Sending asks the agent for a turn of the conversation (`POST /session/<id>/image`, `docs/INTEGRATION.md`, "Pictures"); a new
conversation is created as for a message, and in a new worktree the picture is asked once the worktree is ready. With no model that makes pictures on the computer the side says so in one line
and leads to its group in Models, and sending is off; a model that writes is not needed with rewriting off. Rewriting
follows the settings: off, the words go as they are; on, the model chosen there writes the description, if the agent still
offers it, otherwise the agent chooses. The choice is the conversation's, kept in its prompt (`PicturePick`); without one a
conversation whose last turn was a picture opens on «Picture». The row of the tool `image_generate` is the same for the
picture the user asked for and for the one the model makes by itself: it says what is going on («Writing the description»,
«Waiting for my turn», «Getting the card ready», «Step 5 of 8», «Finishing»), shows the picture as it forms in a frame of its
final proportions, then the picture (a click opens its file in the panel that shows PDFs and pages), how long it took and how
big it is, the file with «Open» and «Show in folder» among the files of the turn, and a collapsed «Description»
with the description in English to correct: «Make it again with this description» draws it again with the corrected text and
«Again» with the same one (a new seed); neither while the conversation is busy. A question of the model that rewrites is
shown by the conversation's question dock, which closes by itself if the turn is stopped; «Dismiss» leaves the choice to
the model, and the picture is made. The first picture the model makes
by itself asks the permission `image`, in plain words with what it will draw. The engine that draws stays on while pictures
are on view; when the box goes back to «Text», or the conversation is closed or left for another one or for the Home, it is
put away a moment later (`utils/mango-picture-engine.ts`): the app is asked once (`POST /mango/image/unload`), and an
engine that is drawing then stops when its picture is made. The tab remembers that pictures were shown in it (the box on
«Picture», or a picture asked for) until the engine has been put away, so a page reloaded in that moment asks when it is
back; it does not start counting before it has read the state, the models and the conversation's messages, and it does not
ask if pictures are on view again. A tab that never showed pictures does not ask, whoever turned the engine on. The model
that writes the description takes the engine for a while
(only one local model runs at a time). The agent marks that request as a side one (`X-Mango-Side-Request`), and the engine
manager keeps the model that was in use as `conversation_model` of its state (`docs/INTEGRATION.md`, section 6): the
conversations, the new ones too, the messages waiting for the model and every page, phone and window follow it, the box
names it, and the top bar says what the engine really runs. The state loses it when the engine is on that model again, when
a message of a conversation starts a model, or when the user picks one.
`integration/tests/pictures.test.ts` drives all of this in the real window with the fake image engine; `FAKE_SD_PNG=1` makes
the fake engine draw real PNGs.

**Downloads in the background** (`src-tauri/src/downloads.rs`, the bridge's `models.download/pause/resume/cancel`): the
models asked from the app's window download one at a time while the app is in use, the engine of a model included if
it is missing. The queue is in `<data>\downloads.json`: closing the app leaves the partial file and the next start goes
on from there, a paused download stays paused, a cancelled one deletes what had arrived. A saved download that cannot
go on at the next start stays, failed, with the reason; one whose model is already on the computer or left the catalog
goes. A failed download says so in a sentence with the model's name; the addresses and the details go to
`<data>\logs\startup.log`. Taking a model off the computer (`models.remove`, `model_choices.rs`) stops its download first
and waits for it to leave its files; a model the user added also leaves `user-models.json`, and the files the user chose
stay where they are. The control server's state (`GET /control/state`, `downloads`) says how each one
goes; when a model arrives and no model is running, it is loaded.
Development builds download from `MANGO_HF_URL` instead of Hugging Face, if set (`integration/tests/downloads.test.ts`
serves the files itself).

The models folder is watched (`src-tauri/src/models_watch.rs`): a file put in it or taken out by hand, at any depth, makes the
interface read the catalog and the computer again (the space the models use, the models on the computer) two seconds after the last change. The nearest existing parent is watched too (names of folders only): a folder deleted, renamed away or put back is told as a change and watched again. The watch ends only when it is stopped. When the folder and every folder above it are gone (a disk that was unplugged) it is told as a change and the thread waits for Windows to announce a volume arriving (`CM_Register_Notification` on the volume interface class); two seconds after one it looks again and, if the folder is back, tells it and watches it. Reading the models does not start or look for anything. A network share that comes back is not a volume arrival: it is not noticed until the app starts again. The folder is made at startup, not by the watch. A move of the folder takes the watch away until the app starts again.

With `--service` and no model the app is in use all the same: whoever asks the engine for a model that is not on disk gets
the sentence that says so.

**A start that fails** (the model does not load) is `failed` in the control server's state, with the sentence and, when there is
one, a model on the disk that fits now (`proposal`, `engine_cfg::after_failure`, read once for each failure in `control.rs`): the
default if it fits, otherwise the first in the catalog. If the model fits this computer but another program holds the memory of its
card (read while no model of Mango Code is on the cards: NVML for the NVIDIA cards, Windows' counters of the memory dedicated to
each graphics adapter for every other brand), a sentence of its own (`taken`) names the card and how much it holds. A model that
goes on the cards starts even when the memory of one of them cannot be read: nothing says that another program holds it, so
it is not held back, and the state of the running model (`ready`) carries one line, `notice` (`engine::PublicState::notice`), that
says nobody looked: «I can't read the memory of the cards (…): I can't tell whether another program is using it.»

## Other models

"Another model" (the settings, section Models): you search on Hugging Face (public API), paste a
link (the model's page, a file's page or its download link, `hf.co/o/n:Q4_K_M` or `o/n`, also amid other words;
`?download=true`, a line break after a `/` and revisions like `refs/pr/1` are read) or choose a GGUF already on the
computer, wherever it is (any piece of a split model brings all its pieces, which must be next to it; a `*mmproj*.gguf`
next to it is offered as the version with images only if it is shown to be the model's: its `clip.vision.projection_dim`
equals the model's `embedding_length`, and the same `general.basename` or `general.name`, or a file named after the
model's; another one is left out and `startup.log` says why).
For a repo the app lists the quantizations (the pieces of a split model joined, the image encoder as an
option) and proposes, on the cards, the largest that keeps the context of «Automatic» (`AUTO_CTX`, or the model's own
if smaller), otherwise the largest that fits, never F16, BF16 or F32; on the processor, where speed counts more, Q4_K_M
or the nearest below it that fits. For each it
says **before** whether it fits in the PC's memory and with what context: the same estimate as the recommended ones
(`general.rs`), with `memory` computed from the GGUF header (for a remote file the first MBs are enough, with `Range`;
the later pieces of a split model from 256 KiB; all the headers of a link within two minutes). The header reader
believes no length beyond the file and no product that overflows: an absurd header is an invalid file.
A header the count doesn't know all of (a new architecture, a missing field, a `block_count` beyond the layers the
tensors name) isn't refused: what is missing takes the most a layer can ask (K and V as wide as the tensors' shapes
say, or twice the model's width), the context is the smallest the agent works with (`split::MIN_CTX`),
`memory.estimated` keeps what was missing (and `startup.log` says it when the model is added), and the analysis and
the verdict say `estimated`.
The warnings come from the conversation format inside the GGUF (`tokenizer.chat_template`), tried with the requests the
agent really sends (`engine-cfg/tests/requests`: the first request, the one after a tool has been called, the one that
brings the reasoning back): if the template rejects one of them (`raise_exception`), ignores the tools, the calls, their
parameters or their results, the warning says which moment of the conversation breaks. The arguments of the calls go to
the template as the agent sends them (a string) and, if it cannot take that, as objects, as the engine gives them to the
templates that need it. A template the tester cannot run gives "could not check", never a verdict. A model that holds
fewer tokens of context than `split::MIN_CTX` gets a warning too.
What the catalog writes by hand for its models, the entry of a model added reads from the file: `active_permille` of a MoE
(the rest of the model plus `expert_used_count` of `expert_count` of the expert tensors, `gguf::active_permille`), which
the speed band on the processor uses. What the reasoning offers (a switch, levels, nothing) is read from the template of
the GGUF on the disk, for a model of the user's as for the catalog's (`reasoning.rs`): `enable_thinking` gives off and on,
`reasoning_effort` gives low, medium and high. A model whose template is the Qwen3.5 original (by its SHA-256) gets the
entry `chat_template: qwen3.5-mango.jinja`, the same template with one line changed so that the reasoning of the past
turns stays in the history. "Add" writes the entry in `<data>\user-models.json` (`mango_common::catalog::add_user`) and the
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
`MANGO_DATA` (data folder), `MANGO_AGENT_PORT` (the preferred port of the agent: a free one is used when it is taken), `MANGO_ENGINE_PORT`, `MANGO_DIST`; with `MANGO_DATA`
the single instance is tied to that folder, so a test instance runs next to the real one. The integration tests
(`bun test --cwd integration`) start an instance like this with the fake engine.

## What the interface remembers

The open and recently closed projects, the preferences, the tabs, the messages waiting to be sent and the drafts with
their attachments are kept by the app, not by the browser of the window: `<data>\ui-state.json` (written whole or not at
all, flushed to the disk, with the state before the last write in `ui-state.json.bak`) and `<data>\ui-state\blobs\` (the
attachments, named by the SHA-256 of their bytes). The browser keeps such things per origin, and the agent's origin has its
port, which changes when another program holds the preferred one. The page reads the file through the bridge (`uiState`,
`ui_state.rs`) before it draws and sends its changes a moment after they happen (at the latest two seconds after the first),
when it goes to the background, when it closes, before it reloads itself (a setting that needs a new start, «Restart» on the
error page) and when the app asks: before «Quit» in the tray (after the agent has stopped, which can take up to a minute),
before an update is installed and before the window is taken away from the page, the app asks the page to write what it
holds and waits for the answer for up to a second and a half, and then for a write that is running to end. The page says
whether it wrote; if not, or if it does not answer, the app logs it. At the end of a Windows session the page cannot be
asked (the window's thread, which delivers its answers, is the one that ends the process): the changes of the last quarter
of a second may be lost, and a write that is running is waited for. The agent's own address is not written in the file, so the state is the same on any
port. A normal browser and the phone keep their `localStorage`.

A change that cannot be written is told to the user and tried again every few seconds until it can; a change the app
refuses as invalid (a key over 4096 bytes) is left out and logged, so it cannot hold back the others. If the content of
`ui-state.json` cannot be read the app starts from the backup and says so, once; if neither can be read, the file is of a
newer version, or the disk does not give it, the page shows the paths and nothing is touched or replaced.

On its first start the app reads what the window's browser kept for the preferred port's origin (every key of
`localStorage`, the drafts of `IndexedDB` with their attachments) with a hidden window of the same profile, to which the app
itself serves that origin (`old_origin.rs`): this works whichever program holds the port, and none receives a
request. The page merges it into the file: what the app already has stays, the old values fill the rest, and the lists of
projects are joined. A draft whose attachment is missing is skipped and logged; the copy is marked done only when the list
of drafts was read and every write succeeded, otherwise the next start tries again. The browser's data is left where it is. Until that copy is made the app waits up to six seconds for the
preferred port before it takes another. The integration tests are `tests/ui-state.test.ts` and `tests/ui-state-exit.test.ts`.

## Open with Mango Code

`mango-code.exe "<folder>"` opens that folder as a project (`src-tauri/src/folder.rs`): at startup, or, if
the app is already open, the second start passes the folder to it and exits. A folder that does not exist, or a file, gives a
message and leaves everything as it is. The installer adds the "Open with Mango Code" item (Italian: "Apri con Mango Code", chosen
by the installer's language) to the right click on a folder and on the background of an open folder (`windows/hooks.nsh`, keys
`Directory\shell` and `Directory\Background\shell`, removed on uninstall); the command is `"mango-code.exe" "%V\."`, because the trailing `\.`
keeps a drive root (`C:\`) from escaping the quote. Test: `integration/tests/open-folder.test.ts`.

## The engine for your other PCs

A PC with graphics cards can lend its models to the user's other PCs, at home or with Tailscale. **Off by default**; it is turned on
from the settings of the web UI, section Connections (`engine_share_*` bridge commands in `src-tauri/src/engine_share.rs`). The
other half lives there too, "Use the engine of another PC" (below). The service is `engine::share` (`crates/engine/src/share.rs`)
and the requests are served by the engine manager itself (`engine/src/http.rs`, `handle_network`): the manager stays on
`127.0.0.1:47080`, without a key, for the apps of this PC. The contract for a client is in `docs/INTEGRATION.md`
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
(`mango://<ip>:<port>/<key>`) is pasted in the settings of the web UI, section Connections (bridge `engineRemote.connect`).

- **Checking** (`engine::remote`, `crates/engine/src/remote.rs`): the code is read by the same rule that writes it (`Code::parse`), then
  `GET /mango/models` with the key, 5 s. `200` with models: it is saved. `401`: "the code is not valid, or sharing is off on that PC".
  Refused or no answer: "the PC with the engine does not answer: is it on? Is Mango Code open there, with sharing on?". No models:
  "that PC has no model ready". Something else answering: it says it is not Mango Code. The command rejects with the code of the
  failure and the sentence (`engine_remote_connect` in `src-tauri/src/engine_remote.rs`); the pasted text is never repeated.
- **Kept**: `<data>\remote-engine.json` (`address`, `key`, in the clear like `phone.json`; see `SECURITY.md`). Its presence is the
  whole state: the app uses that PC's engine until "Back to the engine of this PC" (`engineRemote.disconnect`) deletes it.
- **At startup** (`lib.rs::startup`, `engine_remote::start`) with the file there: the PC's hardware is not read, no engine or model is
  downloaded, and the engine manager is there with no model to load (its port must be free in this case too). The other PC is checked again
  (the app's page shows the logo meanwhile); the models offered to the agent are that PC's, named "… · on PC <ip>", and the
  default is the one running there. `service.json` has `"engine": null` (and `control`, as always). A PC that does not answer is the startup error page,
  with "Retry" and "Back to the engine of this PC" (`ErrorInfo.remote`): it is the only way out at that point. Dictation and the rest start as always.
- **The agent** (`agent-cfg`): `AgentInputs.engine_key` puts the key in the environment variable `MANGO_ENGINE_KEY` and the provider's
  `apiKey` becomes `{env:MANGO_ENGINE_KEY}`: the key is never in `opencode.json`. The agent sends it on `/v1` and on its two reads of
  the manager (`/engine`, `/slots`: "loading the model", the reading bar). `POST /tokenize` is not offered by the other PC's network
  door, so the weights in "What the model reads" stay "not measured". A connection that drops is worded "the PC with the engine
  does not answer…" and tried again with growing waits (about a minute); then the next message tries again.
- **While it is in use** the control server's state is `remote`, with that PC's address and models, and `reachable`: whether that
  PC answered the last time the app asked, every 5 s (`remote::watch`; a refused key counts as an answer, and is asked again
  every 60 s, so that PC's log does not get a refusal every few seconds). Moving to a PC's engine while
  the app is in use stops this PC's model (it restarts on a request if sharing is on) and restarts the agent. A model of this PC
  that was still loading stops loading.

## From your phone

The web UI on the phone, from the same Wi-Fi or from outside the house with Tailscale. **Off by default**; it is turned on from the
web UI settings in the app (Connections, "Phone", `settings-v2/phone.tsx`, `phone_*` bridge commands in
`src-tauri/src/phone.rs`), which shows the link with the key and its QR for the home network and for Tailscale (an
address in `100.64.0.0/10`). The phone does not see the bridge: no phone settings from the phone.

- **Its own ports**: `47096` for the web UI and `47097` for the browser panel's pages (`MANGO_PHONE_PORT` and
  `MANGO_PHONE_PREVIEW_PORT` for the tests), both open only while on and **only on the addresses the settings show** (the home
  network's and Tailscale's, never `0.0.0.0`; `mango_common::network::reconcile`, the same as the shared engine's). A thread reads
  the addresses again every 3 s. On an address where one does not open the other is closed too, and the settings say which. In
  development builds `MANGO_PHONE_PC_ONLY` keeps them on `127.0.0.1`. If Windows calls the home network public
  (`network::is_public`, the network list of Windows), the settings show a warning under its link. Agent and engine stay on `127.0.0.1`; the engine cannot be reached from the phone.
- **Entry**: `GET /phone?key=…` (24 random bytes, compared in constant time) → `303` to `/` with the cookie
  `mango_phone` (a random value of a session, never the key; `HttpOnly; SameSite=Strict; Path=/`, 90 days, not
  renewed); wrong or missing key `401` with a page made for the phone (`crates/phone/src/key.html`: the app's dark look, the icon, how
  to get in and a field to paste the link or the key, for an app on the home screen that cannot open a link).
- **Every other request**: requested address not numeric (a name pointing to the computer, DNS rebinding) `403`, also for
  `/phone`; `Origin` different from `http://<requested address>` `403`; without a valid session `401` (a sentence for the
  browser, JSON for the rest), except the manifest and the icons of the app (`PUBLIC_FILES`), which the system reads without the cookie;
  methods other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` `405`; the routes only the
  app on the PC uses (`/mango/reload`, `/mango/extra-folders`) `403`; chunked body `400`; a line break or NUL outside `\r\n`
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
    session cookie, `Referer` or `Authorization`. A redirect to the page's own address comes back as a path, one to another
    address of the computer (`localhost` or `127.0.0.1`, any port) as `/__mango_loopback/<host>/<port>/<path>`, and a WebSocket
    (the reload of a development server) passes both ways. The HTML of a page the browser opens (a navigation or a frame, as
    `Sec-Fetch-Dest` says; a browser that sends none is taken at `Accept: text/html`) is read to put a script in it: asked
    with `Accept-Encoding: identity`, whole within 3 s, up to 4 MiB, UTF-8 (a page in another character set, a compressed
    one, a bigger or slower one, and every fragment a page fetches for itself, are left exactly as they are). The script,
    `<script src="/__mango_loopback.js">`, goes first in its `<head>`. Absolute addresses written inside a page
    (`http://localhost:3000/api`) would point at the phone itself; the script makes `fetch`, `XMLHttpRequest`, `WebSocket`
    and `EventSource` aimed at `localhost` or `127.0.0.1`, **on any port**, go to the preview port as
    `/__mango_loopback/<localhost|127.0.0.1>/<port>/<path>`. Such a call has the same checks as everything on that port
    (session, numeric address, `Origin`, methods), goes to that port of the computer's loopback and to no other address
    (any host but those two, or a port that is not a number from 1 to 65535, is `400`), and is relayed like the page itself
    (its own cookies, not the phone's session). A `Request` given to `fetch` is rebuilt with its method, headers, credentials,
    mode and body (read as bytes); the `credentials` the page wrote are kept. Not covered: `navigator.sendBeacon`, workers
    (their own `fetch` is not the page's), subresources and navigations written in the markup (`<script src>`, `<img src>`,
    `<iframe src>`, `<form action>`, a link, all with an absolute `http://localhost:…` address), pages with a Content
    Security Policy that does not allow scripts from their own origin, and `https:` and `wss:` addresses (the computer's
    ports are plain HTTP).
  - **What a page shown on the phone can and cannot reach.** The phone's session is worth the computer; a page is not the
    phone's user. A page (generated by the model, a development server, a `file://` page, all of which get the script) acts
    through `/__mango_loopback/…`, and there:
    - it cannot reach the agent's port, the phone service's two ports, nor any port of the app's own listeners (`403`): the
      engine's manager, the engine's server from its start until its process has exited (also while it saves the
      conversation and stops), the image engine, the sharing of the engine, the voice, the debugging port of the browser panel
      and every folder site (`sites.rs`) except the one the panel is showing. The listeners that live as long as the run are
      written down in one place (`src-tauri/src/ports.rs`), the engines keep their own lists, and the whole is asked of the
      app at every call (`phone::Computer::owned_ports`); `integration/tests/app-ports.test.ts` reads the ports that the
      running app's processes listen on and asks for each one through this route, so a listener nobody registered fails
      it. Otherwise a page could drive the agent, which has the shell, with the phone's authority.
    - its `Origin` is the one the computer's browser would send: the origin of the page the panel shows
      (`http://localhost:3000` for a panel at `http://localhost:3000/`), so a server that accepts that page's calls (a CORS
      or CSRF list) accepts them from the phone too; for a page that is a file the phone's own origin goes on. No `Origin` is
      made up when the phone's browser sent none. `Sec-Fetch-Site`, which the phone's browser fills with
      `same-origin` (it only talks to the phone's port), is rewritten to what the computer's browser would say: `same-origin`
      for that server, `same-site` for another port under the same name, `cross-site` for the other name and for a page that
      is a file. The page that is calling cannot be told from the request (every page of the phone has the preview port as its
      origin, and its relative requests also go to what the panel shows now), so a phone tab left on an earlier page is
      treated like the one the panel shows.
    - it can reach any other port of the computer's loopback with what a web page can do from the computer: servers of the
      user's own (development servers, databases with an HTTP interface), with the cookies the page itself has, never the
      phone's session. A server that trusts every request that reaches it on the loopback is as exposed as it is with a
      page open in the computer's browser.
    - it cannot reach anything but `localhost` and `127.0.0.1`: no other address of the computer, no network address.
    - a server of the computer cannot set `mango_phone`, the phone's session cookie (cookies belong to a host, not to a port):
      that `Set-Cookie` is dropped from the replies of the page and of its calls, the other ones pass.
    The page the panel shows itself is relayed with its server's own `Origin` and is not subject to the limits of calls; it
    is the server the phone's user chose to look at. But the phone is never shown a page of the app's own ports (a notice
    with `403`), and it cannot ask the panel to open one (`POST /phone/preview` answers `403`); the computer's own panel may
    open anything. An HTML reply with `Content-Disposition: attachment` is a download and gets no script.
  - A local file (`file://`) serves its folder, read-only (`GET` and `HEAD`, `Range` for videos; an HTML file read whole, as
    UTF-8 and up to 4 MiB, gets the same script): `/` is the file, and no path
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
  `Authorization` or proxy headers; one request per connection, the response streamed (events included),
  WebSockets (`Upgrade`) both ways.
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
  the folder and project limits, the calls of a page to the computer's addresses) and `node --test
  app/scripts/phone-loopback.test.mjs` (the script that sends them); `integration/tests/phone.test.ts` (the real app:
  turned on from the bridge, entry, web UI and agent from the port, turned off); `integration/tests/app-ports.test.ts` (the
  ports the running app listens on are all refused to a page). In development builds `MANGO_PHONE_PC_ONLY` keeps
  the port on `127.0.0.1`, so the tests do not make Windows ask to open it.

## Zoom

Ctrl+ / Ctrl- / Ctrl+0 and Ctrl+wheel zoom the page they are on: the chat or the page in the Preview panel, each by itself
(the keys are the browser's own: both webviews are built with `zoom_hotkeys_enabled`). WebView2 tells `zoom.rs` when a
zoom changes. The window's zoom is kept in `<data>\zoom.txt` (the file goes away at 100%) and applied at the next start;
it is the zoom WebView2 reports, not one worked out from the page scale, which also contains the screen's scale and
Windows' text size. The panel's zoom lasts until the app closes and sits on top of the format's own (`fit` × `user` in
`preview.rs`: a phone or a tablet is shown whole, shrunk to the room there is). `preview_place` converts the placeholder's rectangle
with the page scale, so after a zoom of the window the native panel stays on its place. A menu, list or popover that does not
reach the panel leaves it live. One that reaches it, or the dimmed backdrop of a dialog, makes it step aside: `layerOver`
(`preview-layers.ts`) decides by the rectangle each open layer is drawn in, not by where the library leaves the pointer.
The native panel cannot be drawn under the page, so just before it steps aside the web UI asks for a picture of it
(`preview_capture` in `preview.rs`, the bridge's `preview.capture()`: WebView2's `CapturePreview`, a PNG of the panel's size) and
shows it in the placeholder, under the layer, dimmed with the page by a dialog's backdrop; the capture has 500 ms, during which the
layer is still under the panel. A tooltip does not make the panel step aside: a hover would freeze the live page. When the layer closes the panel
comes back and the picture goes once the live page is over it. A capture that fails leaves the empty area and writes one line
in `logs/ui.log`; it is not tried again until the layer closes.

**How the panel looks.** A card with the chat's gap and rounded corners (`preview-panel.tsx`). The page is a native window on
top of it, a rectangle: `preview_place` also receives how round its corners are and `round_corners` in `preview.rs` cuts the
window to that shape, again at every change of size (the two bottom corners in the desktop format, where the page reaches
the card's; all four on a device). The phone and the tablet formats draw a device, a recent iPhone (393 × 852) and an
11-inch iPad (834 × 1194), with the page on its screen at its real size and the whole device scaled to fit the panel.

**PDF, pictures and web pages in the panel.** The card of a PDF, a picture (png, jpg, gif, webp, bmp, ico, svg) or a web page (html,
htm) opens it in the panel with a click (`preview_file` in `preview.rs`, the bridge's `preview.openFile`): the same checks as
`open_path` (an existing file, wherever the agent wrote it), at most 50 MB, readable. A PDF, a raster picture or a
web page is opened by its own `file://` address (the page runs); an SVG goes through
`<data>\preview-view\image.html`, a page with no script that draws it in an `<img>`, because as a page of its own an SVG
runs its scripts. The refusals carry a code the card turns into a sentence: `too_large`,
`unreadable`, `blocked_type`, `not_found`, `forbidden`. Word, Excel and PowerPoint keep opening in their Windows program.

**A page the agent opens by its file.** The agent shows a page it wrote with `new_page` and the page's file (`index.html`),
and starts no server: the browser server (`launcher/mango-chrome-mcp.mjs`) asks the control server for the page's address
(`POST /control/site` `{ "path" }` → `{ "url" }`) and opens that. `sites.rs` serves the folder of the file, read-only, on a
port of its own on `127.0.0.1`, opened the first time the folder is asked for and kept until the app quits; a request whose
`Host` is not this computer is refused. A site with several pages, modules or `fetch` works as on the web, and a path the
model wrote the Unix way (`/home/user/site/index.html`) names the file in the project, as it does for the agent's file tools.

**A page the model changes.** When the model writes or changes a file that can be part of the page shown, the panel
reloads the page by itself, once after the last of a series (`preview-panel.tsx`; the rule in
`packages/app/src/utils/preview-reload.ts`): for a `file://` page, a file in its folder or below it; for a page of a server on this computer
(`localhost`, `127.x`, `::1`, so also the sites of `sites.rs`), a file of the web (html, css, scripts, json, pictures). The
agent says which files: its `write` and `edit` tools at once (`file.watcher.updated`), and what a command of
its shell changed in the project at the end of the step (the step's `patch` part). A file changed by another program, or by
a command outside the project, does not reload it: "Reload" does.

**While a page loads.** The native panel stays hidden until the page it navigates to is the one it shows; the web UI puts its own message
("Loading the preview…") in the placeholder, so no blank rectangle appears. The WebView2 events (`on_navigation` at the start,
`Finished` at the end) arrive for pages, pictures, PDFs, SVG pages and refused addresses; the start of the content (`Started`) only when the
server answers. An address whose page has not arrived after 30 s (`load_limit`, `MANGO_PREVIEW_LIMIT_MS` in debug builds) is given up:
the panel goes to `about:blank`, `preview.state()` carries `failed` with the address and the web UI shows the sentence and "Try again".
A page that arrived and is still loading is left alone. A `data:` address carries its page: it counts as arrived at once, because WebView2
reports no end of loading for it and `Webview::url` cannot read its address.

## What goes in the prompt

Every item of the fixed prompt (base tool, MCP server, skill, instructions file, plugin) is on or off. The agent
rereads at every request `<data>\settings.json` (`agent-cfg` sets `MANGO_SETTINGS`, so it follows `MANGO_DATA`) and
`.mango/settings.json` of the working folder; the settings' Agent section ("What the model reads") writes them. The weight in tokens of
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
- **Settings, Connections, "Cloud, paid"** (`settings-v2/team.tsx`): the OpenRouter key, how many agents (0-4), the models of manager and
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

With the app or the agent windows open, copying over the exe fails (file in use). Windows does let you **rename**
a running exe: rename the old one, copy the new one, and what is already open stays on the renamed file.

What it brings compared to opencode:

- **Two model providers only**: the agent carries the local engine (`mango`) and OpenRouter, both through the
  OpenAI-compatible client, with no subscription logins and no provider-specific plugin or loader. The app enables the local engine,
  and OpenRouter when the Team has a key (`enabled_providers` in the configuration it writes).
- **Embedded, offline web UI**: the server never forwards it from `app.opencode.ai`; Mango Code brand, light or dark as Windows is until the user picks one,
  the colours of `suite/tokens.css`; `?project=<folder>` opens that folder as a project.
- **Server without a password but closed to web pages** (`middleware/origin-guard.ts`): a request with `Origin` passes
  only from the same server's web UI or from the app. CORS is not enough: a "simple" request starts from any
  page, and the agent has the shell.
- **Folder of the `x-opencode-directory` header decoded** on all routes (`workspace-routing.ts`).
- **In the interface**: Preview panel (the agent's browser next to the chat), "Also in my Chrome", live dictation
  (`/mango/voice/*`), progress of the prompt read and prefill and decode speed per reply (from the engine's
  `timings`), documents and attachments read as text, titles from the user's words, history with
  "Archived", only the product's commands (`OPENCODE_DISABLE_BUILTIN_COMMANDS`).
- **The model waits for the GPUs**: `/mango/engine/speed` asks the engine manager (`GET /engine`) why a
  request has no answer yet, and the page writes it in the conversation.
- **The same wrong call repeated is not executed** (`session/repeat-guard.ts`), for every tool.
- **What goes in the prompt** (`session/settings.ts`, `session/prompt-measurement.ts`, `shared/mango-settings.ts`):
  `GET`/`PUT /mango/settings` and the settings' Agent section (`settings-page/agent.tsx`); the `PUT` passes only from the page.
- **Rules per path**: the `tool.execute.after` hook also receives `messageID` and the turn's history; the plugin
  `mango-project` brings in one with `paths:` once per conversation.
- **Shorter descriptions of the base tools**, **the brand** (`logo.tsx`, favicon).
- **The model, the models and the computer** (`shared/mango-control.ts`): `GET /mango/state`, `/mango/models`,
  `/mango/computer`, `POST /mango/model/use`, `/mango/model/retry` go to the app's control server (`MANGO_CONTROL_URL`,
  always on this PC) and return its status and body; `503` if it does not answer within 10 s.
- **The configuration read again** (`shared/mango-reload.ts`): after `agent_cfg::set_models` rewrote `opencode.json`,
  `POST /mango/reload` makes the agent read it again as soon as no conversation is answering (`200` done now, `202` it
  waits); until then the configuration before holds. The app does both (`src-tauri/src/agent_models.rs`) when what the agent
  knows of this PC's models changes: a context or the cards chosen, a model of the user added or removed, a model that
  arrives or goes, the default; never with another PC's engine.

## Building and testing

```powershell
app\scripts\build-agent.ps1          # the agent (above)
cd launcher;                npm ci
cd opencode-home;           npm ci
cd ..\..\app
node scripts\prepare-installer.mjs   # staging: also needed by cargo test (tauri-build wants the folder)
cargo test --workspace
cargo build -p mango-code -p engine -p images  # the app and the fake engines: the integration tests start them
cd ..
bun test --cwd integration              # from the repo root; app windows open with the fake engine
app\target\debug\off-screen bun test --cwd integration   # the same on a desktop nobody sees: no window reaches the screen
bun test --cwd integration tests/zoom.test.ts            # the one test that needs the screen (it turns Windows' own wheel)
powershell -File app\scripts\build.ps1   # staging + cargo tauri build -> app\target\release\bundle\nsis\*.exe
```

`launcher/opencode-home/package.json` (tracked: `{"dependencies": {"@opencode-ai/plugin": "1.19.5"}}`) is what the
staging installs the plugin packages from; without it `npm install` there goes up to the launcher's `package.json` and modifies it.

`bun test integration` from the root does not start: opencode's `bunfig.toml` points the tests to a folder that does not exist,
to prevent running them from the root. `--cwd integration` runs them from inside.

The screenshots some integration tests take are kept in the folder of the environment they start, which goes away with it;
`MANGO_TEST_SCREENSHOTS=<folder>` keeps them there to be looked at.

### The agent's requests and the chat templates

Whether a model accepts what the agent sends depends on its chat template, so the tests use the real request and real templates:

- `integration/tests/capture-requests.test.ts` runs six scenarios (first turn, a tool's result, a long run with the
  reminders, after a summary, an image, earlier reasoning) and compares the body each sends to `/v1/chat/completions` with
  the fixture in `app/crates/engine-cfg/tests/requests/`. `UPDATE_FIXTURES=1` writes them again, after a change of the
  request that is meant.
- `cargo test -p engine-cfg --test templates_render` renders every fixture with the original chat templates of many model
  families (`app/crates/engine-cfg/tests/templates/`, with `templates.json`: the repo and revision each text comes from, its
  license, and what the template legitimately refuses or leaves out). A template that rejects a request, or silently loses
  a message, a tool, a call or a result, fails the test.
- `cargo test -p engine-cfg template_texts -- --ignored` checks that the committed texts are the ones in the GGUF headers
  of their repos (only the headers are read); with `UPDATE_TEMPLATES=1` it follows the repos to their latest revision and
  rewrites them.
- `cargo test -p engine-cfg --test templates_render -- --ignored the_engine` asks a real `llama-server` which requests each
  template accepts and checks that the test's renderer agrees. It needs the processor build of the engine and any tiny GGUF
  (`MANGO_TEST_LLAMA_SERVER`, `MANGO_TEST_TINY_GGUF`); it never uses a graphics card.
- The fake engine refuses like the strictest of those templates when it starts with `FAKE_ENGINE_STRICT=1` (the `strict`
  option of `start` in `integration/tests/environment.ts`): more than one system message or one that is not first, turns that
  do not alternate, a result without its call. The tests that look at what the model receives start it that way, and
  `systemMessages` (`integration/tests/requests.ts`) checks that a request has a single system message, first.

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
question says so and where they are, for whoever wants to delete them by hand. A models folder chosen in Settings, or a
model put in a folder of its own, is outside the data folder and is not deleted. `windows/hooks.test.mjs` runs the
deletion on a copy (`node --test app/src-tauri/windows/hooks.test.mjs`, needs the `makensis` that `tauri build` downloads).

### Tests on GitHub

`.github/workflows/prove.yml` holds every test that needs neither a graphics card nor the network, in parallel jobs on
a Windows runner: `cargo test --workspace`, the release scripts' tests, the document tools' tests, the typecheck of the
whole monorepo, the tests of the agent (`packages/opencode`) and of the packages it ships (`packages/core`,
`packages/app`, `packages/ui`, `packages/session-ui`, `packages/llm`, `packages/codemode`, `packages/client`,
`packages/http-recorder`, `packages/effect-drizzle-sqlite`), each with its own `test` script from its folder.
`release.yml` calls it before anything is built, so a failing test stops a release before the key is read. It also runs
on its own (Actions, "prove", Run workflow), on any branch and without a tag, to see the result before a tag is pushed.
Not in it: the engines' own tests (they need the models), the end-to-end tests of `integration/` (on the hosted runner the app's window shows no page to the debugger) and the packages that are not part of the product.

## Looking and measuring

- `scripts\test\ui.ps1 -Action shot|click|type|key|info`: picture of the window (DPI-aware, even covered),
  clicks in fractions of the window, text with SendKeys.
- `scripts\test\send.ps1 -Text … -Directory …`: sends a message to the agent with the web UI routes.
- Driving it via CDP: start it with `MANGO_WINDOW_CDP=9333`, which turns on remote debugging for the main window
  only (9222 is Chrome's). Not `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`: it applies to all
  the process's WebView2s, the Preview panel loses its port and the agent can't use it (the browser server refuses a
  port that shows Mango Code's own window).
- Model speeds: `cargo run --release -p engine --bin mango-bench -- toq 3.6` (starts each model like
  the app; table at the end).
- Live engine speed: `llamacpp:tokens_predicted_total` in `engine.log` (delta over 15 s) and the `eval time` lines;
  the counters update at the end of a request, so a long write looks stuck.
- Logs: `%LOCALAPPDATA%\MangoCode\logs\{startup,agent,engine,manager,ui}.log` (`manager.log`: who called `release`,
  `resume` or `model`, when and with what outcome; `ui.log`: the web UI's uncaught errors and `console.error`, and the
  calls to the app slower than a second or with no answer, at most 100 lines a minute and 2 MB (then `ui.1.log`); the TOQ engine's `llama.log` is in the same folder); the
  agent's real one is `%LOCALAPPDATA%\MangoCode\agent\data\opencode\log\opencode.log` (`init count=N` = skills read
  from disk, each time the list is read again: a new conversation, a turn, the «/» menu, the settings page). With the app open, Windows can show these files at 0 bytes: they are being written, not empty.

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
It waits in `%TEMP%\mango-code-update-<version>`; a minute after the next start (the installer has ended by then) the app deletes
the folders with that name, those of earlier updates too.
No automatic checks in the service, in test instances (`MANGO_DATA`) and in debug builds. The user can turn the check of each start
off (bridge `updates.setAutomatic(false)`, saved as `update.automatic` in `<data>\choices.json`; read when the check is due, so a
choice made in the first minute counts); "Check for updates" works all the same. The state the web UI reads carries `automatic`.

Publishing a release (`.github/workflows/release.yml`; official installers are built only there, never on a PC: a
local build carries the PC's paths inside its binaries):
1. raise `version` in `src-tauri/tauri.conf.json` and in `Cargo.toml` (a release candidate is `X.Y.Z-rc.N`, so the
   final `X.Y.Z` is higher), let `cargo` bring `Cargo.lock` to it, and write the notes in
   `release-notes/v<version>.md` with a `**Changed since …**` list: it is the text of `latest.json`'s notes.
   `node app/scripts/check-version.mjs` checks all of this; the workflow runs it with `--tag`, so the tag must be
   `v` + the version;
2. push the tag `v<version>`: the workflow runs the tests first (`.github/workflows/prove.yml`, see "Tests on GitHub"
   above) and only when they pass waits for the maintainer's approval on the `release` environment, which holds the
   signing key (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`);
3. with the key out of reach it builds the agent and the installer with
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
- The development server (`bun … serve --port 4096`) takes the agent's preferred port: the app then runs on a free one.
- Starting the app from a redirected console does not work: `start "" "<path>\mango-code.exe"`.
- Pictures without `SetProcessDPIAware` come out cut off on the right and at the bottom: it is not the app.
- `SetForegroundWindow` fails if the caller is not in the foreground: `ui.ps1` presses a fake ALT
  first; the first key after the focus can be lost.
- No pagination (`more`) in long commands: the terminal waits for keys.
- The engines' command line: the official llama.cpp reads any path, the forks (`toq`, `prism`) read it in the ANSI code page and do not
  open a file under a user called `José`. The plan passes paths by their short names (`mango_common::engine_path`); tried with
  `llama-server` on folders with `è ñ`, `Ł`, Cyrillic and Chinese. On a volume without short names the engine's own error remains.
