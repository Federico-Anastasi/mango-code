# Contributing to Mango Code

Thanks for helping. Mango Code is a small project: the fastest way to get a change in is to talk about it first.

## Issues

- **Bugs**: open an issue with what you did, what you expected and what happened. In the app, Settings > Help >
  "Report a problem" sends an anonymized report with the logs; mention it in the issue if you used it.
- **Security problems**: never in a public issue, see [SECURITY.md](SECURITY.md).
- **Ideas and larger changes**: open an issue before writing code, so we can agree on the direction.

## Pull requests

- One change per pull request, with a short description of what it does and how you tested it.
- Commit messages and PR titles follow `type(scope): summary`, with `feat`, `fix`, `docs`, `chore`, `refactor` or
  `test` (for example `fix(app): keep the panel visible on small screens`).
- Code, comments, identifiers and documentation are in English. Text shown to the user is in English and Italian
  (`tr!` in Rust, the dictionaries in `packages/app/src/i18n/` for the web interface).
- The coding style is in [AGENTS.md](AGENTS.md).

## Build and test

How to build is in the README, under [Build from source](README.md#build-from-source). Before opening a pull request:

```powershell
cd app; cargo test --workspace                     # the app and its crates
cd packages/app; bun run test:unit                 # the web interface
cd integration; bun test                           # end-to-end, with a fake engine (no graphics card used)
cd launcher/mango-documents; bun test              # the document tools
```

Tests don't run from the repository root: run them from the folders above. On a fresh clone `cargo test --workspace`
stops until the installer's resources folder exists (the build script creates it with the installer; for the tests an
empty one is enough): `New-Item -ItemType Directory -Force app/scripts/staging/resources`.

## License

By contributing you agree that your contribution is licensed under the project's license, AGPL-3.0-or-later (see
[NOTICE.md](NOTICE.md)). There is no CLA.
