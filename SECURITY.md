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
- Access from your phone is off by default. When you turn it on, it uses a separate port, a random key, a session
  cookie and numeric addresses only. A session there controls an agent with a shell, so it is worth as much as the
  computer: share the link only with yourself.
- `mango-code -Lan` in the terminal opens the model engine (not the agent) to the other devices on your network,
  without a key. Use it only on a network you trust.
- The app stores your OpenRouter and Hugging Face keys in the Windows Credential Manager; the terminal reads the
  OpenRouter key from `launcher\mango-secrets.json`. The agent's commands can read the OpenRouter key, as they can read
  anything else your user can.
