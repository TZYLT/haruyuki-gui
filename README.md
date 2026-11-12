# haruyuki-gui

A desktop GUI project built around one shared core: a single Electron desktop
shell and a single VS Code extension shell, both sitting on the same TypeScript
packages.

> **Status: P0 -- foundation under construction. This project does not run yet.**
>
> The repository currently holds the workspace skeleton only: package manifests,
> empty source entry points, and repository tooling. There is no working
> application, no release artifact, and no supported way to build or launch it.
> Everything below describes intended structure, not shipped behaviour.

## Repository layout

```
packages/
  protocol/   shared protocol and contract definitions
  core/       core logic shared by both shells
  ui/         shared UI layer
apps/
  desktop/    Electron desktop shell
  vscode/     VS Code extension shell
scripts/      repository automation and verification tooling
fixtures/     sample trees used by the gate self-tests
```

`fixtures/` and `pnpm-lock.yaml` are intentionally tracked: the lockfile pins the
build, and the fixture trees exist precisely so the self-test gate has stable
input. Do not add ignore rules that match them.

## License

Licensed under the Apache License, Version 2.0 (see [LICENSE](LICENSE)).

- [NOTICE](NOTICE) records third-party attributions that must travel with
  distributions, and states when an entry has to be added.
- [THIRD-PARTY](THIRD-PARTY) is the inventory of third-party components that
  actually ship, plus the rules for adding entries.

Unless required by applicable law or agreed to in writing, all contributions are
provided on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

## Getting started

### Prerequisites

- Node.js `>=24` (the current development machine runs 24.22.3).
- `corepack`, which ships with Node: do not install pnpm by hand. The root
  `package.json` pins `packageManager: pnpm@10.24.0`, and `corepack enable`
  exposes exactly that version.

### Install

```sh
corepack enable   # once per machine
pnpm install      # the first run downloads about 250 packages
```

If a bare `pnpm` fails with `Cannot find module .../pnpm.cjs`, corepack fell
back to pnpm 12 instead of the pinned 10.24.0. Check that the root
`package.json` still has its `packageManager` field: that field is what pins
the version, so without it corepack has nothing to resolve.

### Git hooks

```sh
pnpm hooks:install                      # write the hook configuration
node scripts/install-hooks.mjs --check  # report only, exit 1 when not installed
```

`pnpm hooks:install` runs `git config core.hooksPath .githooks`, one
repository-local setting, and it is idempotent. The `pre-commit` hook then runs
three fast checks - eslint and `prettier --check` over the staged
`.ts/.mts/.cts/.js/.mjs/.cjs` files, plus the 1000-line per-file limit - and
refuses the commit when one of them fails. `git commit --no-verify` bypasses it
for a single commit. The slow checks (typecheck, unit tests, cycle detection)
deliberately stay out of the hook, so a commit stays under a few seconds.

### Common commands

| Command                            | What it covers                                        |
| ---------------------------------- | ----------------------------------------------------- |
| `pnpm verify`                      | **the full gate in one command** (see below)          |
| `pnpm verify:full`                 | `verify` plus the three repository-discipline checks  |
| `pnpm typecheck`                   | `pnpm -r typecheck`, every workspace package          |
| `pnpm exec eslint .`               | the lint gate, including the package-boundary rules   |
| `node scripts/check-file-size.mjs` | the 1000-line per-file limit and its ratchet baseline |
| `node scripts/check-cycles.mjs`    | circular imports, via madge                           |

### What `pnpm verify` runs

| Segment          | What it checks                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 typecheck      | `pnpm -r typecheck`                                                                                                                                                                   |
| 2 lint           | package-boundary rules, on the raw import strings                                                                                                                                     |
| 3 boundaries     | the same rules on the **resolved dependency graph** - this is the authoritative check, and it catches relative-path, `require()` and dynamic-`import()` bypasses that lint cannot see |
| 4 gate self-test | fixture pairs proving each rule still fails when it should - **a failure here means the gate is broken, not your code**                                                               |
| 5 test           | the remaining unit tests                                                                                                                                                              |
| 6 coverage       | reported only, never a threshold                                                                                                                                                      |

`pnpm verify:full` appends the file-size ratchet, cycle detection and module
ownership checks. Those are repository discipline rather than package
boundaries, so they live outside `verify` - but they also run in the pre-commit
hook.

Use `git commit --no-verify` to escape a false positive, never to land a real
violation.
