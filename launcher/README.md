# mango-code in the terminal

A coding agent (opencode) against a **local, offline model**, with one command:
`mango-code`. This folder is also the tree the desktop app installs as its resources.

## How to use it

From any folder, in a new terminal:
```powershell
mango-code                     # opens the agent in the current folder, on the local model
mango-code -p "do X"           # a single request, then exits
mango-code -Models             # lists the models, * = the one loaded now
mango-code -Model 3.6 -Install # ...downloading the missing engine and weights first
mango-code -Model 3.8          # switches model (reloads the engine); the choice sticks
mango-code -Web                # opencode with its web UI, on 127.0.0.1
mango-code -EngineOnly         # starts only the engine
mango-code -Chrome             # checks/unlocks the integration with YOUR Chrome
mango-code -Chrome -Sandbox    # ...or opens mango-code's separate browser
mango-code -Team               # cloud manager + local dev + up to 4 cloud agents
```

The `mango-code` function lives in the PowerShell profile (`$PROFILE`, installed by `setup.ps1`) and always calls
`launcher\mango-code.ps1`. Installation and everything else: [`MANGO-CODE.md`](MANGO-CODE.md).

```powershell
.\setup.ps1                     # once: engines, agent, models, dependencies, command
```

From a second PC on the same network: `mango-code -Lan` on the PC that holds the model, `mango-code -Remote <its-ip>`
on the other; there neither GPU nor GGUF is needed. Details and the security price:
[`MANGO-CODE.md`](MANGO-CODE.md#from-another-pc-on-the-wifi--lan---remote).

## Architecture

```
opencode  ──provider mango, /v1 OpenAI-compatible──►  llama-server (prism or toq)
                                                         model from mango-models.json
```

- **The engine** (`mango-engine.ps1`) starts the `llama-server` of the chosen model and doesn't know who talks to it.
  What to start is decided by the app's logic, which the terminal calls (`mango-launch.exe`, `setup.ps1 -Only launch`):
  the PC's profile if it applies, otherwise the official llama.cpp with arguments computed from the hardware. With the
  app open the engine is the app's, and the terminal asks it for the engine. A profile declares its engine: `prism`
  (PrismML's fork of llama.cpp: 3.6, 3.8, bonsai2, lfm) or `toq` (ik_llama.cpp: TOQ-v1), both from our forks
  [mango-prism](https://github.com/Federico-Anastasi/mango-prism) and [mango-toq](https://github.com/Federico-Anastasi/mango-toq). Models, numbers and the reason for every argument: [repo README](../README.md) and
  `mango-models.json`.
- **The opencode agent** is a single binary for app and terminal (`<opencode>\web\mango-code.exe`, by default
  `launcher/opencode`, built from the sources in `packages/`): web UI inside the binary, answering only local pages,
  prefill and decode t/s in the bar.
- **With the agent:** the skills (`mango-plugin/skills`), the MCPs (home-made web search, browser, documents) and the
  discipline against drift (`opencode-home/plugin/mango-discipline.js`).
- **The Team** (`-Team`): manager, dev and agents talk to each other through `opencode-home/plugin/mango-team.js`, the
  same plugin as the app (where dev and agents are hidden processes: [`app/README.md`](../app/README.md)). Here the
  OpenRouter key lives in `mango-secrets.json` (template `mango-secrets.example.json`); the app keeps it in the Windows
  Credential Manager.

## The browser

`mango-chrome-mcp.mjs` chooses which browser to attach the agent to, in this order:

0. **your Chrome**, if in the app you turned on "Use my Chrome" and Chrome's remote debugging is active;
1. the app's **preview panel**;
2. **mango-code's browser** on 9333, if already running;
3. mango-code's browser started now, if its profile is **seeded** (it holds your logins);
4. **your Chrome**, if you turned on remote debugging from `chrome://inspect/#remote-debugging`;
5. otherwise mango-code's browser, without logins.

Which one it chose is written to `mcp-chrome.log` ("browser: …"). A port that shows Mango Code's own window (the
app page or the web UI) is never used: driving it would replace the app with the page.

When the agent finishes a site it opens it in the panel, which opens by itself: first with a local server (`bun
index.html`, port 3000; Bun is part of Mango Code), or the project's own dev server. In your own browser only if you
ask.

### The banner, and how to remove it

Attaching to your profile makes "Allow remote debugging?" appear at every connection: Chrome shows it on purpose on the
default profile. On a profile started by us it isn't there. To have the logins without the banner, the cookies are
copied from your Chrome to ours, via the protocol (with Chrome open the files are locked):

```powershell
mango-code -Chrome -Sandbox      # if needed, imports the logins and opens the browser
node mango-cookie-import.mjs     # the import only
```

`Storage.getCookies` on the real Chrome, `Storage.setCookies` on ours: httpOnly cookies arrive too. The banner is paid
once, at the import; from there the cascade stops at level 3.

## Ports

8080 engine (**do not kill**: it is the model) · 9333 mango-code's Chrome. Full table:
[`MANGO-CODE.md`](MANGO-CODE.md#ports).
