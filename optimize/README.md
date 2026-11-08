# optimize: the skill that optimizes Mango Code on your PC

A Claude Code skill, for a frontier model, that finds the best Mango Code setup for **your** GPUs or CPU and the models you choose,
using what we measured over months on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER, and writes it as a profile. It is not for the local model inside Mango Code.

## How to use it

1. Copy this folder (or link it with a junction, `mklink /J`) to `.claude/skills/optimize/` in the project, or to `~/.claude/skills/optimize/`.
2. Open Claude Code (with a frontier model) and ask: "Optimize Mango Code on my PC".
3. The agent asks which models you use and for permission to use the GPUs, measures (`mango-tune`), tries one change at a time and writes the profile and a report.

It needs `mango-tune.exe`: the installed app has it in this folder (`resources\optimize\` in the app's folder); from the repo, `cargo build --release -p engine --bin mango-tune` in `app/`.

## What is in it

- `SKILL.md`: the method and the order of the steps.
- `references/`: working rules, Mango Code seen from outside, tools, roads by hardware type, levers, problems, building.
- `scripts/find.ps1`: what is on the PC.
- The measurement tool is written in Rust, `app/crates/engine` (`mango-tune`).
