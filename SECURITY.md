# Security

## Reporting a vulnerability

Report it privately with GitHub's "Report a vulnerability" button, in this repository's Security tab. Please don't
open a public issue for a vulnerability.

## What Mango Code protects, and what it doesn't

Mango Code runs a coding agent on your computer with access to the shell, your files and the web. It has **no
sandbox**: the permission prompts help you see what the agent does, they are not an isolation boundary. If you need
isolation, run it in a virtual machine.

- The agent server and the engine manager listen on `127.0.0.1` only, without a key: whoever can reach them is already
  a user of the PC. Requests that carry an `Origin` other than Mango Code's own web interface are refused, so a web page
  you visit cannot drive the agent or the model.
- Access from your phone is off by default. When you turn it on, it uses a separate port on the addresses the settings show
  (your home network and Tailscale, never all the networks), a random key, a session cookie and numeric addresses only. If
  Windows calls the home network public (a café's), the settings say so. A session there controls an agent with a shell, so it
  is worth as much as the computer: share the link only with yourself.
- Sharing the engine with your other PCs is off by default ("Lend the engine to my PCs", in the settings under Connections). When you
  turn it on, the app opens a separate port on the addresses the settings show (your home network and Tailscale, never all
  the networks) and a PC that pastes the code (address and random key) can use your models: it cannot see your files,
  run commands, drive the agent or take the graphics cards, and only the routes of the model are open. Turning it off
  closes the port and removes the key; "New key" invalidates the code at once. At home the code and the requests travel
  unencrypted on the Wi-Fi (on Tailscale they are encrypted): give the code only to your own PCs. Whoever has it can also
  make your model busy or reload it, and every refusal is a line in `logs\manager.log`, never the key.
- Using the engine of another PC ("Use the engine of another PC of mine", same page) keeps that PC's code in
  `remote-engine.json` in the Mango Code data folder, **in the clear**, like the phone's and the sharing's keys: it is in your
  Windows profile, readable by whoever can read your files. The key travels to that PC in a header, in the clear on the home Wi-Fi
  (encrypted on Tailscale), and reaches the agent only through its environment, never in `opencode.json`. It is not written in
  the logs, in an error text, in a problem report or on the screen (the field that takes the code hides it). "Back to the engine
  of this PC" deletes the file.
- Every connection the app makes to the internet is checked against the certificates Windows trusts and goes through the proxy
  Windows is set to use (or `HTTPS_PROXY` / `NO_PROXY`), never for this computer's or the local network's addresses. The app never installs a
  certificate and has no option to skip the check: behind a company filter whose certificate Windows does not know, downloads
  stop with a message instead of continuing unchecked.
- The app stores your OpenRouter and Hugging Face keys in the Windows Credential Manager. It hands the OpenRouter key to
  the agent in an environment variable, only when the Team is in use; it is never written in a config file. The agent's
  commands can read it, as they can read anything else your user can.
- The preview panel also shows a PDF, a picture or a web page of a project when you click its card: only a file inside a project (or
  in `Documents\Mango Code`), at most 50 MB. An SVG is drawn as a picture by a page that allows no script, never opened as a
  page; a web page runs in the panel like the ones the agent opens; the files the server hands out stay inert downloads. From the phone the same files are shown from memory by the web UI.
- The agent's browser: it is the preview panel, with a profile of its own and none of your logins. "Use my Chrome" lets
  the agent open a page in a new tab of your own Chrome, logged in wherever you are, when it asks for it for a page that
  needs your sign-ins, and it does not take a tab of yours to another address with `navigate_page`. While it is
  connected it can still list and read your other tabs, as with any use of your Chrome. Nothing copies the cookies of your Chrome.
