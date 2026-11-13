# Using Mango Code from another program

Another program uses Mango Code the way it would use Claude Code, in two ways: **one request from a script**
(`mango-launch -p`, next section), or **a session of its own** over HTTP: it opens sessions on its own
folder, receives the text as it arrives, sees the tools being called, answers permissions and questions, passes its own
MCP servers and instructions, and picks the model. The TypeScript client is `integration/client/mango-code.ts` (no
dependencies, Bun or Node 18+); the automated test `integration/tests/integration.test.ts` shows every piece at work.

## One request from a script: `mango-launch -p`

```
mango-launch -p "Which files are here?" [--model <key>] [--dir <folder>]
```

`mango-launch.exe` comes with the app, in its `resources` folder (`%LOCALAPPDATA%\Mango Code\resources`). It needs nothing
else: it uses the models and the engine of the app, in the way `claude -p` uses Claude.

- It uses the Mango Code that is open or, if none is, starts it without a window (the tray icon shows it; the first
  start loads the model, tens of seconds) and leaves it open for the next request.
- The agent works in `--dir` (default: the folder the command runs from). Its answer goes to stdout; the tools it calls and
  the rest of what it does, to stderr. The conversation is saved among the folder's sessions, and the app lists it.
- `--model` is a key of `launcher/mango-models.json`; without it, the app's default.
- Nobody is there to answer: the app's configuration asks for no permission, and one that a project's own rules ask for is
  refused. Use the HTTP session below when the program has to decide.
- Exit code: `0` answered; `1` the agent could not answer (the reason is on stderr); `2` wrong command line; `3` Mango Code
  cannot be used (not installed next to the program, or it does not start),
  with the sentence on stderr.

The request goes through the same agent server as the HTTP interface below, so a session opened this way can also be read
with it.

Names on the wire are English. The engine manager (section 6) uses `snake_case` JSON fields; the agent routes use
single-word fields, and the opencode ones they extend (`sessionID`, `providerID`, `time.completed`) keep their own style.
Human-readable messages (the `error` texts, the `reason` in `service.json`) are meant for the user and are not part of the
contract: never match on them.

## 1. Finding or starting Mango Code

As soon as its agent answers, Mango Code writes `%LOCALAPPDATA%\MangoCode\service.json`, and removes it on exit:

```json
{ "version": 1, "pid": 12345, "agent": "http://127.0.0.1:4096", "engine": "http://127.0.0.1:8080", "control": "http://127.0.0.1:8080", "window": true }
```

The file does not wait for a model: the default model loads after it is written, in the background, and there may be no
model on the computer at all. A request to the agent or to `/v1` waits for the model that is loading; `GET <engine>/engine`
says what is loading (section 6), and `POST <engine>/engine/model` answers when the model you name is ready.

`engine` is `null` when this Mango Code uses the engine of another PC (see "The engine of another PC" below): this PC's
engine runs no model, so there is nothing to release, resume or load; the agent works as always. `control` is the app's
own server on this PC, there in both cases.

- It is running if the file exists, the `pid` process is alive and `GET <agent>/global/health` answers 200 (`find()`).
- If the app is running but its startup failed, the file is there all the same, with `reason` (a readable sentence)
  instead of `agent` and `engine`.
  `notReady()` reads it, and `launch()` stops waiting and reports it as an error instead of waiting until the time limit.
  While the `pid` process lives the file is updated: as soon as the app is ready it rewrites it in the form above.
- If it is not running: `"%LOCALAPPDATA%\Mango Code\mango-code.exe" --service` starts it **without a window** (open one
  from the tray icon); then wait for the file, a couple of seconds (`launch()`).
- If the app is already open with its window, use that one: there is a single instance, and its `service.json` is just as
  valid.

Both servers listen on 127.0.0.1 only. There is no key: whoever can read `service.json` is already the PC's user. Web
pages cannot use either one: a request with an `Origin` is refused (403) unless it comes from the web UI of the same
server or from the app. The agent also refuses (403), whatever the `Origin`, a `Host` that is not `127.0.0.1`, `localhost`
or `[::1]`: a page whose name was made to resolve to 127.0.0.1 does not get in. A client on the PC sends no `Origin`. The web UI on the phone goes through a separate port, off by
default, with its own key, and does not reach the engine (`app/README.md`, "From your phone": entry `GET /phone?key=…`, cookie
`mango_phone`).

Environment variables an app can set when it starts Mango Code (tests, a second instance beside the real one):

| variable | meaning |
|---|---|
| `MANGO_DATA` | the data folder (default `%LOCALAPPDATA%\MangoCode`); `service.json` is written there, and the client reads it from there |
| `MANGO_AGENT_PORT` | port of the agent server (default 4096) |
| `MANGO_ENGINE_PORT` | port of the engine manager (default 8080) |
| `MANGO_PHONE_PORT` | port of the phone service (default 47096) |
| `MANGO_SHARE_PORT` | port of the shared engine (default 47098) |
| `MANGO_ROOM_CHECK_OFF` | development builds only: a model starts on the graphics cards without first checking that other programs leave it room there (the integration tests, whose fake models have a plan on the PC's real cards) |

### The engine of another PC

A PC can share its engine with the user's other PCs ("Lend the engine to my PCs", in the settings under Connections). Off by default, on a port of its own
(47098) opened only on the home network's address and on Tailscale's, never on all the networks. The user copies a **code**,
`mango://<ip>:<port>/<key>` (the key is 48 hex characters); the client splits it into address and key and sends the key on
every request: `Authorization: Bearer <key>`, `Host` the numeric address, no `Origin`. To use that engine, an agent's
provider has `baseURL` `http://<ip>:<port>/v1` and the key as its `apiKey`. Mango Code itself does this from "Use the engine of
another PC of mine" (`app/README.md`): it keeps the code in `<data>\remote-engine.json`, starts the agent with the key in the
environment variable `MANGO_ENGINE_KEY` (the config reads it as `{env:MANGO_ENGINE_KEY}`) and the agent sends it to the engine on
`/v1`, `/engine` and `/slots`.

| request | answer |
|---|---|
| `GET /mango/models` | `200` `{"models": [{"key", "label", "context", "images"}], "running": "<key>"|null}`: the models that are on that PC and fit, and the one that is running. **This is also how the key is checked**: `200` the code is right, `401` the key is wrong (a new one was made, or it is off), `403` the address was not numeric or an `Origin` was sent; a connection that is refused or times out means the PC is off, Mango Code is not open there or sharing is off |
| `POST /v1/chat/completions` (and the other `/v1/*`) | as on the PC's own engine: `"model"` is one of the keys above, the reply streams. The manager adds to every chat request that does not carry them, from the apps of that PC as from other PCs, the sampling values (`temperature`, `top_p`, ...) and `chat_template_kwargs.enable_thinking` the user chose there for that model (a `null` counts as missing); a request that carries them all passes untouched. A model that is not on that PC: `422` with the sentence; another app holds the cards: `503` |
| `GET /health`, `/props`, `/metrics`, `/slots`, `/engine` | the reads of the engine and of the manager (`/engine`: phase, loans) |
| anything else (`/engine/release`, `/engine/resume`, `/engine/model`, `POST /slots`, `POST /props`, a path with `..` or `%`) | `403`: the cards and the engine's writes stay for the apps on that PC |

The key is checked before the body is read, is not passed on to `llama-server`, and a client that does not finish its
head in 10 s or that is the 33rd open connection is closed. If two PCs ask for different models, the engine reloads at each
change.

## 2. Sessions

Every call to the agent carries the working folder: `?directory=<folder>` (Windows path, encoded).

| what | call |
|---|---|
| open | `POST /session` `{ "title"?, "permission"?: [rules] }` → `{ "id": "ses_…", … }` |
| list | `GET /session` → the sessions of the folder (stable id, saved on disk) |
| read | `GET /session/<id>/message` → messages with their parts |
| send a message | `POST /session/<id>/prompt_async` → 204 at once; you can also send while the agent works (it is queued) |
| stop the turn | `POST /session/<id>/abort` |

Resuming a session is just sending it another message: the history is on disk and reaches the model in full.

The message body:

```json
{
  "parts": [
    { "type": "text", "text": "Cut out the subject of scene 3" },
    { "type": "file", "mime": "image/png", "filename": "scene3.png", "url": "data:image/png;base64,…" }
  ],
  "model": { "providerID": "mango", "modelID": "toq" },
  "system": "App instructions added to the system prompt for this message"
}
```

- `model`: the key in `launcher/mango-models.json`; without it, the session's model or the default. The offered models
  (those with weights and engine on disk) are in `GET /config/providers`, provider `mango`, with context and images
  (`models()`).
- An image sent to a model without vision arrives as a file name, not as an image. Of the recommended models,
  LFM2.5, Ling 3.0 Tiny and Qwen3.5-2B do not see images.

## 3. Events

`GET /event?directory=<folder>` is an SSE stream (`data: {json}` per line) with the events of all the sessions of the
folder; each event has `type` and `properties.sessionID`. Open it **before** sending the message. The ones you need:

| `type` | what it carries |
|---|---|
| `message.updated` | a message was born or changed: `info` with `id`, `role` (`user` or `assistant`) and, for the assistant, `finish` (`tool-calls` when the turn continues with the tool, `stop` at the end) and `time.completed`, `tokens` (see "Context used"). It tells **whose** a part is: parts carry `messageID`, and the text of the user's message also arrives as a `message.part.updated` of type `text`: without looking at `role` it is mistaken for the model's answer. The same message arrives several times |
| `message.part.delta` | a piece of text: `messageID`, `partID`, `field: "text"`, `delta`. The part is text or reasoning: the `message.part.updated` with the same id says which (`type: "text"` / `"reasoning"`) |
| `message.part.updated` | a whole part, also several times (`step-start`, `step-finish`, text, reasoning). For tools `part.type: "tool"`, `part.tool` (name), `part.state.status` = `pending` → `running` → `completed` (or `error`): the first `pending` arrives as soon as the model starts naming the tool, with an **empty** `input` (`{}`, sometimes twice); `running` carries the full `input`; `completed` adds `output` (`error` if it fails) |
| `permission.asked` | the agent asks for a permission: `id`, `permission` (e.g. `bash`, `edit`, `skill`, the name of an MCP tool), `patterns` |
| `question.asked` | the agent asks multiple-choice questions: `id`, `questions: [{question, options: [{label}], multiple}]` |
| `session.status` | `status.type`: `busy` while working (repeated at every step), `idle` when it stops |
| `session.compacted` | Mango Code summarized the session: the context used dropped (see "Context used") |
| `session.error` | an error of the turn (`error`); it can arrive more than once |
| `session.idle` | the session is back to idle: the turn is over. It fires at **every** pass to idle, and that pass happens from several places (end of the turn, error, `abort`, even on a session that was already idle): so it can arrive more than once for the same turn. Close the turn at the first and ignore the others until you send another message. The client's `turn()` also ignores one that arrives before the session is `busy` or its user message has arrived |

Other events (`session.updated`, `session.diff`, `plugin.added`, `catalog.updated`, …) describe the agent's internal state
and are ignored. The events of a folder do not always carry `sessionID`: whoever listens for a single session discards
those of another.

The client's `turn()` translates them into steps: `text`, `reasoning`, `tool`, `permission`, `question`, `error`, `end`. It sends the message once the stream has said `server.connected`; if the stream cannot be opened in 10 s, is refused or drops, the steps end with an `error` and then `end`.

### Context used

Every **step** of the turn (one request to the model: a tool call, or the final answer) is an assistant message of its own,
and its `info.tokens` are those of its request: `input` (read, without those already in cache), `output`, `reasoning` (the
reasoning, **not** counted in `output`), `cache.read`, `cache.write`, and `total` (the sum of all). The context used after a
step is `total`, that is `input + cache.read + cache.write + output + reasoning`.

- **When they arrive.** At zero until the step ends; then all together, in the same `message.updated` that carries `finish`
  and `time.completed` (it arrives twice, identical). A turn with several tool calls has one message, and so one value, per
  step, and the tokens of a step arrive before the message of the next step is born. After `session.idle` nothing more
  arrives from the assistant. A turn stopped (`abort`) mid-step leaves that message at zero, with `error`.
- **Which value to read.** The last assistant message with `finish` and without `summary`: a message at zero is not an
  empty context (it is a step in progress or stopped). `GET /session/<id>/message` gives the same numbers.
- **The measure.** `GET /config/providers`, model `limit.context` and `limit.output`: Mango Code summarizes when a step ends
  with `total >= limit.context - limit.output`.
- **The summary** (`compaction.auto`, on). In order: `message.part.updated` with `part.type: "compaction"` (`auto: true`); an
  assistant message with `mode: "compaction"` and `summary: true`, at zero, which when the summary is done carries the
  tokens of the **request that produces it** (the whole session to summarize: it is not the context afterwards, ignore it for
  the context used); then **`session.compacted`** (`properties: { sessionID }`, just one); then the step that resumes, whose
  `total` is the new context. Between `session.compacted` and the end of that step the new context is not yet known.
- **Old tool outputs are not removed** (`compaction.prune`, off): removing them would change the old part of the
  conversation and make the engine re-read everything after it. The context drops only with the summary above.

Test: `integration/tests/token.test.ts`; the fake engine declares the tokens of every step (`fake-engine.rs`).

## 4. Permissions and questions

The app's sessions work on their own. An app that wants to approve actions says so when opening, with the session's rules:
`[{ "permission": "bash", "pattern": "*", "action": "ask" }]` (`action`: `allow`, `deny`, `ask`). Then:

- permission: `POST /permission/<id>/reply` `{ "reply": "once" | "always" | "reject", "message"? }`;
- question: `POST /question/<id>/reply` `{ "answers": [["label"], …] }` (a list of labels per question, in order), or
  `POST /question/<id>/reject`.

## 5. Tools, skills, project instructions

Like Claude Code, Mango Code reads the context of the open folder (and of the folders above it, up to the root of the git
repository if there is one): `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/rules/*.md`, the skills in
`.claude/skills/<name>/SKILL.md`, the MCP servers in `.mcp.json` (`mcpServers`, over stdio or http), which start in the
file's folder. When the agent is started by Mango Code (the app) it reads nothing of what is on the
PC (`~/.claude`, global skills): the app sets `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` and
`OPENCODE_DISABLE_BUILTIN_COMMANDS`. An agent started by hand without them reads them like opencode does.

**Rules by path.** A `.claude/rules/*.md` rule with `paths:` in the frontmatter (a list of globs, relative to the folder that
contains `.claude/`, e.g. `src/**/*.ts`) is not in the prompt: it is appended to the result of `read`, `edit` or `write` on a
matching file, once per session (again after a summary of the session that wipes its text). A rule without `paths:` is always
in the prompt. This also holds for extra folders. A frontmatter that does not read as YAML leaves the rule always loaded (the
log says so). Test: `integration/tests/rules.test.ts`.

### MCP servers, hot

An app can add an MCP server for all the sessions of the folder, as long as Mango Code stays on:
`POST /mcp?directory=<folder>` `{ "name": "animation", "config": { "type": "local", "command": ["bun", "server.mjs"],
"cwd"?: "…", "environment"?: {…}, "enabled": true } }` (or `{ "type": "remote", "url": "…" }`). It answers with the map of
the states of all servers. Tools are named `<name>_<tool>` (e.g. `animation_cutout`).

`GET /mcp?directory=<folder>` gives the map `name → { status, error? }` of the folder's servers (those in `.mcp.json`, those
of Mango Code and those added), with `status`:

| `status` | means |
|---|---|
| `connected` | the server answers and its tools are offered to the model |
| `failed` | it did not start or it closed: `error` says why |
| `disabled` | off (`enabled: false`) |
| `needs_auth`, `needs_client_registration` | remote server that asks for a login (OAuth) |

`POST /mcp` is **idempotent**: if the name is already `connected` with the same configuration it does nothing (the server
does not restart, running calls finish and sessions keep the same connection); simultaneous additions of the same server
start it once. With a different configuration the server is replaced: the new one starts and the old one closes, and
sessions use the new one from the next step (a call in progress on the old one drops). An app can therefore add its server
to every session it starts without checking first; the `GET` tells whether it is connected.

### Extra folders

An app that has its method (`CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills`) in a folder other than the working one
declares it once: `PUT /mango/extra-folders?directory=<working folder>` `{ "folders": ["C:\\Projects\\app"] }` →
`{ "folders": [...], "changed": true | false }`. `GET` with the same `directory` gives the list. For each extra folder,
as for the working folder, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` apply (added to the system prompt at every
request, absolute path at the head) and so do the skills in `.claude/skills/<name>/SKILL.md` (read at every use).
Differences from the working folder: the folders above are not climbed and their `.mcp.json` is not read (servers are added
with `POST /mcp`). A skill of the working folder wins over a namesake in the extra folders.

- The list is **whole**: it replaces the previous one; `[]` removes it. The same list again does nothing (`changed: false`).
  Absolute paths of folders that exist, otherwise 400.
- It applies at once, also to sessions already open, and as long as Mango Code stays on: declare it at every start.
- The client: `setExtraFolders(directory, folders)`. Test: `integration/tests/folders.test.ts`.

### What goes into the prompt

Every entry of the fixed prompt is on or off: the base tools, the MCP servers, the skills, the instruction files
(`MANGO.md`, `CLAUDE.md`, the rules, those of the extra folders) and the plugins. By default everything is on. An entry
that is off does not reach the model and weighs no tokens, from the next message.

- The default lives in Mango Code's data (`<data>\settings.json`; with `MANGO_DATA`, in that folder) and applies to every
  folder. An optional `.mango/settings.json` in the working folder changes only the entries it contains and wins over the
  default. Nobody creates it by themselves: it is born from the settings page, when "only this folder" is chosen. Same
  format for both: only the entries that are off or changed, an absent entry is on. A file that cannot be read stops the
  request with its name, it is not ignored.

  ```json
  { "prompt": { "tools": {"webfetch": false}, "mcp": {"web-search": false}, "skills": {}, "instructions": {}, "plugins": {} } }
  ```

- The name of an entry: the tool (`bash`, `webfetch`); the MCP server; the skill; the plugin, as its file
  (`mango-discipline`); the instruction file, with the path inside the working folder (`CLAUDE.md`,
  `.claude/rules/style.md`), with the name alone if it is Mango Code's (`MANGO.md`), with the full path if it is from an
  extra folder.
- **Apps only add.** The server of `POST /mcp` and the folders of `PUT /mango/extra-folders` become entries like the
  others, on: the app switches nothing off. Settings are changed from the page: `PUT /mango/settings` answers 403 to
  a request without `Origin`, which is every client of an app. This is a rule between apps, not a barrier: a process on
  the PC could send an `Origin` of its own, and it already has the agent's shell.
- `GET /mango/settings?directory=<working folder>` → `{ directory, model, file: { default, folder }, items: [{ type, name,
  tokens, enabled, source }] }`. `type`: `tools`, `mcp`, `skills`, `instructions`, `plugins`, and `base` (the base prompt,
  which cannot be switched off). `source`: `default` or `folder`, from which file the value comes. `PUT` with `{ type, name,
  enabled, scope }` (`scope`: `all` or `folder`) → the changed entry (`{ type, name, enabled, source }`). An agent without
  any model has no request to list: `model` is `null` and `items` empty.
- `tokens` is the weight of the entry, counted by the engine with the model's tokenizer (`POST /tokenize`, which the manager
  forwards to the running engine) with the first request of every session, and written in the agent's log (`opencode.log`,
  line "prompt measured": `total` and every entry, as `type:name=tokens`). An entry that is off also has its weight, if it
  was measured. `null` = not measured: no estimate.
- Off, a skill is no longer in the prompt's list (whoever knows its name can still load it); an MCP server that is off
  brings neither tools nor instructions but stays connected. After a change the engine rereads the prompt base once, at the
  first request of the next session.
- A plugin that is off no longer runs its hooks; what it put in the config when the instance started (the instructions,
  skills and servers of the project) stays, and is switched off with its entries.
- Tests: `integration/tests/settings.test.ts` (the request to the model without and with the entries),
  `settings-page.test.ts` (the page in the window).

### Language

Mango Code speaks Italian and English. The current language is the `language` key (`"it"` or `"en"`) of
`<data>\settings.json`, the same file as the prompt settings: the app and the web UI both read it, and without
it they follow the Windows display language (Italian if Windows is Italian, English otherwise). The texts the user reads
follow it, including the `error` texts of the agent's routes (which, as said above, are not part of the contract).

- `GET /mango/language` → `{ "language": "it" | "en" | null }` (`null`: no choice made, follow the system).
- `PUT /mango/language` `{ "language": "it" | "en" | null }` → `{ "language" }` as saved; `null` removes the choice. Any
  other value answers 400 with `{ error }`; 500 if the settings file cannot be written. The other keys of the file (such as
  `prompt`) stay as they are. It applies from the next message and to the web UI the next time it loads.
- Unlike `PUT /mango/settings`, it does not need an `Origin`: an app can set the language too.
- Test: `integration/tests/language.test.ts`.

### Folders that cannot be projects

A project is a folder with its own git repository, where the agent works and takes snapshots. The agent refuses to make one
(`MANGO_PROJECTS_GIT=1`, set by the app) of a folder that is too broad: a drive root, `C:\Users`, the user's folder, Desktop,
Documents, Downloads, Pictures, Music, Videos, Public, OneDrive (the folders as Windows names them, so also when OneDrive moved them, and
the `OneDrive` variables of the environment). In them `git init` is never run, `POST /session` answers 400 and `project.initGit`
changes nothing. Existing sessions keep working.

- `GET /mango/folder?directory=<folder>` → `{ "broad": true | false }`: the web UI asks it before it adds a folder to the projects,
  and says «this folder is too broad to be a project: choose or create a subfolder».
- `POST /mango/folder` `{ "parent", "name" }` → `{ "directory" }`: creates the folder `name` inside `parent` (a name Windows accepts; 400 with
  `{ error }` in the user's language if not, or if it exists).
- Tests: `packages/opencode/test/project/broad-folder.test.ts`, `ensure-git.test.ts`, `test/server/mango-project-folder.test.ts`.

### The model, the models and the computer

On the agent's address (not the engine's shared `/mango/models`): `GET /mango/state`, `GET /mango/models`,
`GET /mango/computer`, `POST /mango/model/use` `{ "model", "once"? }`, `POST /mango/model/retry`. The agent forwards them
to the app's control server (`MANGO_CONTROL_URL/control/*`, on this PC) and returns its status and body; the shapes are
the types of `packages/app/src/utils/mango-state.ts`. An agent the app did not start, or a control server that does not answer within 10 s, gives
`503`. Test: `test/server/mango-control.test.ts`.

## 6. The engine and the GPUs

The local model holds the GPUs. Whoever needs to do heavy work on the same GPUs borrows them:

| what | call (on the `engine` address) |
|---|---|
| state | `GET /engine` → `{ phase, model, name, context, gpus: [{index, name, memory_used_mib, memory_total_mib}], released_gpus, all_released, loans: [{gpus, pid, who, since}], requests_in_flight, error, loading, failed, chosen }` (`loading`: while `starting`, `{model, name, context, gpus: [names], seconds}`; `failed`: the last start that failed, `{model, reason, taken}`, where `taken` is the sentence that says which card another program holds when the manager did not start the model for that, otherwise null; `chosen`: the model the user picked that has not begun to load yet) |
| release | `POST /engine/release` `{ "gpus": [0, 2], "pid"?: 1234 }` (without `gpus`: all) → the state, when the GPUs are free |
| resume | `POST /engine/resume` → the state, when the model is ready |
| load a model | `POST /engine/model` `{ "model": "toq" }` → the state, when it is ready; a model that does not start (unknown, missing files) leaves the previous one running, with `error` saying why |

`phase`:

| `phase` | means |
|---|---|
| `stopped` | no model running (first request, or before `model`) |
| `starting` | a model is loading: tens of seconds, 300 at most |
| `running` | the model answers |
| `releasing` | `release` is waiting for the running requests to finish, then saves the conversation and stops the engine; new requests wait until the end |
| `released` | the engine is stopped because a GPU it used is on loan; `released_gpus` says which. `error` says why a model does not restart on the remaining GPUs |
| `error` | the last start failed or the engine closed on its own: `error` says why, and the next request restarts it |

`loans[].gpus` is `null` for "all".

**The loan belongs to whoever asks.** `release` ties the loan to the process that makes the call (the manager recognizes it
from the connection): when that process exits without having called `resume` (a crash, an interrupted test), the manager
resumes by itself within a couple of seconds and writes it in the log (`event: "loan_ended"`). With `"pid": n` the loan
belongs to process `n` (a pass-through program working for another one); with `"pid": 0` it belongs to no process and lasts
until `resume`: it is for callers from a command that exits at once, like `curl`. Without `pid`, if the manager does not
recognize the calling process, `release` answers 400 and lends nothing. `loans` in the state says who has the GPUs: `gpus`
(`null` = all), `pid`, `who` (the `User-Agent` of the call), `since` (local time). While the GPUs are lent, the web UI writes
under the session that the model is waiting for the GPUs, lent to `who` since `since`.

The body of `release` is a JSON object with `Content-Length` (a chunked body, `Transfer-Encoding`, is refused with 400 on
every route); `gpus` and `pid` are integers that fit in 32 bits. A body the manager does not understand gives 400 and
releases nothing: never "all the GPUs" by default.

**`release`**, step by step:

1. It marks the GPUs as released. If the running engine uses none of them, it answers at once (`phase` stays `running`, the
   model is not touched).
2. Otherwise it goes to `releasing`: new requests wait; **those in progress continue and finish, for 60 s at most**. A
   generation that does not finish within 60 s drops: the connection closes mid-answer, and the agent retries when the
   engine is running again.
3. It saves the open conversation to the on-disk memory (every model; up to 60 s, usually 1-3 s), stops the engine and
   answers with `phase: "released"`. Until then `phase` stays `releasing` and new requests wait: a model restarting on the
   remaining GPUs before the end of the save would read the old conversation. The same holds for `resume` of a model that
   restarted on fewer GPUs: until the old one is stopped `phase` is `starting`.

Maximum time of a `release` call: 60 s of waiting + the save + the stop, and before all that the end of a start already in
progress (`starting`, up to 300 s) or of another `release`. With no requests in progress and no start: 1-2 s. While it lasts,
`GET /engine` answers at once (it waits for nothing) with `phase: "releasing"` and `requests_in_flight` going down. The model
does **not** restart inside `release`: if it used only some of the released GPUs and can live on the others (a model that
repartitions itself, like Qwen3.6), it restarts at the first request of a session, without the released GPUs (the start is
visible as `starting`); if it does not fit, requests wait for `resume` and `error` says why. Several `release` calls in a row
(one GPU at a time) therefore do not load the model each time.

`resume` gives all the GPUs back to the engine and restarts the wanted model (if it had restarted on fewer, it restarts it on
all), and answers when it is ready, with the saved conversation already reloaded. Requests waiting for a released engine
wait up to 30 minutes, then fail with an error that says to call `resume`; when the engine is running again the conversation
resumes where it was and the engine rereads only the new tokens. GPU indexes are the PCI ones
(`CUDA_DEVICE_ORDER=PCI_BUS_ID`), the same as `nvidia-smi`.

On an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (Qwen3.6 on the three GPUs, a conversation of 109 thousand tokens): **release** 4.7 s, saving 1.65 GiB
included; **resume** 16.9 s, reload included (2.9 s); the next message rereads 34 tokens and the answer starts 2.9 s after
sending (without the memory: 6-8 minutes of rereading).

**On-disk memory**: every model keeps the state of its conversations and of the system prompt in a folder of its own under
the data folder; an engine that restarts (after `release`, a model change, closing) reloads the conversation used last, and
a new conversation in the same folder starts from the system prompt already read. Cap of 6 GiB and age of 24 hours for all
models together: the files used longest ago go out first.

**Log**: every `POST /engine/…` leaves a JSON line in `<data>\logs\manager.log` (`time` local, `route`, `body`, `status`,
`duration_ms`, `error` if not 200, `address` and `user_agent` of the caller): to know who released or resumed and when, a
client sends a `User-Agent` of its own. The manager also writes the engine's events there, with `event`: `save` (before every
stop: `model`, `token` in memory, `written`, `bytes`, `ms`, `error`), `restore` (at every start: `model`, `token` reloaded,
`ms` of the start, of which `load_ms` until the engine answered and `restore_ms` for the conversation), `crash` (the engine closed on its own: `model`, `code`, last lines of its log; the next request restarts
it), `loan_ended` (the process of a loan exited: `pid`, `who`, `since`, `reason`) and `resume_after_loan` (the automatic
restart that follows, with `error` if it failed). Next to it sit the engine's log and TOQ's.

## 7. What Claude Code has that Mango Code does not

- **Subagents**: the `task` tool is off (a local model with one slot gains nothing by splitting itself).
- **Effort / reasoning levels**: the model always reasons; there is no selector.
- **The user's Chrome**: the agent's browser is the app's Preview panel, and the agent opens a page in your Chrome only
  when it asks for it on purpose (`new_page` with `userChrome`), as a new tab. "Use my Chrome" needs a manual step: turn on
  remote debugging at `chrome://inspect/#remote-debugging`, and Chrome asks for confirmation at every connection.
- **One session at a time on the engine**: requests of different sessions queue; two different models do not run together
  (changing model costs 20-80 s of loading).
- **Claude Code hooks** (`.claude/settings.json`): they are not read.

## 8. Example

```ts
import { launch, MangoCode } from "./integration/client/mango-code";

const mc = new MangoCode(await launch());
const directory = "C:\\Projects\\film";
const id = await mc.createSession(directory, { title: "scene 3" });
for await (const s of mc.turn(id, directory, "Which files are here?", { model: "toq" })) {
  if (s.type === "text") process.stdout.write(s.delta);
  if (s.type === "tool" && s.status === "completed") console.log(`\n[${s.name}]`);
  if (s.type === "permission") await mc.replyPermission(directory, s.id, "once");
}
```

From the command line: `bun integration/example-cli.ts <folder> "<message>" [model]`.

## 9. The client

`integration/client/mango-code.ts` exports:

| export | what it does |
|---|---|
| `find(dataDir?)` | the running, ready `Service`, or `null` |
| `notReady(dataDir?)` | the `reason` of a running but not ready Mango Code, or `null` |
| `launch({ exe?, dataDir?, timeoutMs? })` | `find()`, or start with `--service` and wait until ready |
| `dataDir()`, `executable()` | the data folder and the installed executable |
| `new MangoCode(service)` | the session: `createSession`, `sessions`, `messages`, `send`, `abort`, `listen`, `turn`, `replyPermission`, `replyQuestion`, `rejectQuestion`, `addMcp`, `mcpStatus`, `setExtraFolders`, `models`, `engine`, `release`, `resume`, `startModel` |
| types | `Service`, `AgentEvent`, `Step`, `Rule`, `McpServer`, `MessageOptions` |
