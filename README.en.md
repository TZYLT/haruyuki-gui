# haruyuki-gui

English · [Simplified Chinese](README.md)

> **AIGC Statement**: The code and documentation of this project are largely generated with AI assistance and then reviewed, adjudicated, and verified by human maintainers. AI-generated content may contain logic errors, outdated information, or security flaws; this project is provided **"AS IS"**. Before use or redistribution, please review, test, and assess risks yourself. If you find problems, you are welcome to report them in the repository's issues.

## 1. What This Project Is

**Haruyuki-gui is a desktop application based on Haruyuki, along with derivative plugins that provide similar functionality.**

Haruyuki itself is a cost-saving companion agent runtime with complex mechanisms and rich use cases; a TUI can no longer meet the needs of long-term use. Therefore, Haruyuki-gui is dedicated to giving it a usable and beautiful GUI, making long-term and multi-scenario use possible. Our design strives to stay close to everyday scenarios, but there may still be oversights; we ask for your understanding and welcome contributions of different ideas.

This section and the next describe **what you can see once you have the package**, not the internal plan; how to run it, the commands, and the layout are in sections 3 to 6.

### Our Goals

| Goal                                            | Meaning                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All-in-one, easy-to-use desktop application** | Cover the full capabilities needed for daily use, rather than a window that can only chat; its derivative plugins will also strive to do the same.                |
| **Fully local and self-contained**              | No dependence on any cloud service. State, data, and configuration all reside on your own machine.                                                                |
| **Good visual design and visualization**        | The interface itself must be good-looking and the information understandable—turning a powerful runtime into an application people are willing to open every day. |

## 2. Current Status

This section reflects `main@903e27f` on the main branch (version `0.1.0`).

This version is **a foundation that installs and starts**, not a finished application that can chat. Every line below sits in exactly one of three states, and there is no fourth:

- **Available** — you can actually open and use it in the artifact or in a development build;
- **Shell only, not wired** — the code or the surface exists, but the entry point is not connected, so a user cannot reach it or get real data;
- **Not started** — not written yet.

**Available**

- **One command produces the packages**: `node apps/desktop/scripts/release.mjs` chains dependency install, engine fetch, the build, the Windows directory package and zip, and the release manifest with checksums.
- **The Linux single-file package is produced inside a container**: `bash apps/desktop/scripts/verify-linux-package.sh` enters the image, runs the same pipeline and produces the `AppImage`, plus the survival and paint probes. **Without Docker there is no Linux artifact**; the manifest then says `not-built` with a reason instead of pretending.
- **A window that opens**: the artifact is a zip; unzip it into any empty directory and double-click `Haruyuki.exe`. It verifies the bundled engine at start-up and the interface becomes usable once that passes.
- **An about window**: menu "Help → About Haruyuki". It shows the application version, the engine version and where it came from, the result of the last start-up verification, the runtime environment, local entry points to the three licence documents, the repository URL and a feedback link. Everything comes from the package and from this machine's own records, so **it works offline**.
- **Check for updates**: a button in that same window, which **only goes online when you click it**, with five distinguishable outcomes; when the quota is exhausted or the network is down it will **not** say "up to date".
- **The terminal page**: the "Open page" picker in the window lists "Terminal"; each terminal tab is its own session, commands and output travel over the render bridge's command channel and its `stream` frame channel, and a session starts by itself once the engine is ready. **With no engine** the page carries a readable status line rather than a blank surface.
- **The legal documents ship with the package**: the package root carries `LICENSE`, `NOTICE`, `THIRD-PARTY`, `LICENSE.electron.txt` and `LICENSES.chromium.html`, and `resources/engine/` carries the engine's own `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`. Missing any one of them is a defect, not a slimmer package.

**Shell only, not wired**

- **The main window's top bar**: the component is mounted in the main window, but the check-for-updates entry on it is not wired (the renderer entry always passes "no updates"), so the check is reachable only from the "Help" menu for now.
- **The navigation, conversation and file-tree sample pages**: what the frame registers are sample pages whose content is **example data** and says so; they are not connected to a real session, to real files or to any route.

**Not started**

- Real conversation and streaming output, approval surfaces, the file tree and the editor, the settings page — none of them. **Being able to package is not the same as being able to chat.**
- No automatic updates, no automatic downloads, no automatic restarts, and none will be added: the update check runs once, when you click it.

**Unverified items** (not "not built", but "not verified") are collected in section 7, including the Linux hands-on experience and the first launch on a clean Windows machine.

## 3. Three Steps to Run It

### If you want to produce the packages yourself (maintainer path)

1. **Clone and enter the directory**

   ```bash
   git clone https://github.com/TZYLT/haruyuki-gui.git && cd haruyuki-gui
   ```

2. **Install dependencies** (Node 24; set corepack up as in section 4 first)

   ```bash
   corepack enable pnpm --install-directory "$(dirname "$(command -v node)")"
   pnpm install --frozen-lockfile
   ```

3. **Run one command** (it fills in the remaining prerequisite steps itself, including downloading the Electron binary)

   ```bash
   node apps/desktop/scripts/release.mjs --win-only        # Windows: artifacts + manifest + checksums
   node apps/desktop/scripts/release.mjs --skip-bundle     # stop at the runtime tree and its lock
   bash apps/desktop/scripts/verify-linux-package.sh       # Linux single-file package (runs in a container)
   ```

   **Do not omit `--win-only` on Windows**: giving no platform flag means "do both", and the Linux half has to be done on Linux, so on this machine it fails with `exit 1` (after about 7 seconds). The Linux artifact comes from the third command, which starts its own container. If this version simply has no Linux package, `--win-only` alone is enough: the manifest records Linux as not required for this version (`skipped`/`not-required`). **Do not add `--linux-not-built=...`** - that flag answers "Linux was asked for and this machine cannot do it", and giving it together with `--win-only` is a usage error (`exit 2`).

   Artifacts land in `apps/desktop/release/`: on Windows `Haruyuki-<version>-win-x64.zip` plus `win-unpacked/`; on Linux `Haruyuki-<version>-linux-x86_64.AppImage` (note `x86_64`).
   Creating the tag, creating the Release and uploading the attachments **is yours to do by hand**; the command prints the upload steps at the end.

### If you only want to use it (user path)

- **Windows**: download `Haruyuki-<version>-win-x64.zip` → unzip into an empty directory → double-click `Haruyuki.exe`. No Node, no terminal. **The first launch is blocked by SmartScreen**; see section 7.
- **Linux**: download `Haruyuki-<version>-linux-x86_64.AppImage` → `chmod +x` → run it. The two equivalent workarounds when `libfuse2` is missing are in section 7.

## 4. Environment Requirements

Everything below is a **measured** finding of this project rather than general knowledge; following it saves a full round of self-doubt.

| Requirement                    | Value                                                                                  | Why it is written here                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                        | `>= 24` (`24.22.3` measured on the development machine)                                | Declared by `engines` in the root `package.json`                                                                                                                                     |
| pnpm                           | `10.24.0`                                                                              | Pinned by `packageManager`; the version wall is a known risk, do not use another version                                                                                             |
| corepack                       | `corepack enable pnpm --install-directory <the directory node lives in>`               | `corepack pnpm` and `pnpm` are not equivalent, and child processes then cannot find pnpm                                                                                             |
| electron                       | the binary is downloaded on first `require`                                            | the `electron` dependency here has no `postinstall`; run `pnpm --filter @haruyuki/desktop setup:electron` when needed, and the release command does it once automatically            |
| electron-builder               | run `pnpm install --frozen-lockfile` on the packaging machine first                    | the main checkout's `node_modules` may not have it, and `pnpm exec electron-builder` then reports not found                                                                          |
| Docker Desktop                 | **must be running for the Linux package**: `27.5.1` or newer, WSL2 backend             | without Docker there is no Linux artifact (the manifest says `not-built` with a reason instead of pretending); with the daemon down, `docker info` reports `Internal Server Error`   |
| Registry mirror                | prefix every image with `docker.m.daocloud.io`                                         | **the official Docker Hub site is not reachable from this project's development network** (measured timeout). It is written here because it saves a person ten minutes of self-doubt |
| Container image                | `docker.m.daocloud.io/library/node:24-bookworm-slim`                                   | digest `sha256:5ba3c1ded6eada2ea16582327a87c672fb3889fca362ee3ac0d78ed742b583c0`; it has Node 24 and glibc                                                                           |
| GUI libraries in the container | `libglib2.0-0`, `libnss3`, `libgbm1`, `libgtk-3-0`, `libxss1`, `libasound2`, `libdrm2` | without any of them the Electron binary does not even get through dynamic linking (it reports that `libglib-2.0.so.0` cannot be found). This was found by a probe                    |
| Build tools in the container   | `python3`, `make`, `g++`                                                               | the terminal component has no prebuilt Linux artifact and must be compiled there; the exit code of `apt-get` only proves "the command succeeded", so check each package              |
| How to start in the container  | an unprivileged user plus `Xvfb :99 -screen 0 1280x800x24`                             | as root, Chromium always refuses to start, and this project does **not** trade `--no-sandbox` for a green line                                                                       |
| User machine (Linux)           | `libfuse2`                                                                             | absent by default since Ubuntu 22.04; without it use `--appimage-extract`, see section 7                                                                                             |
| Network                        | `registry.npmjs.org`, the Electron release page on GitHub, `nodejs.org/dist`           | offline builds are out of scope for this project                                                                                                                                     |

## 5. Command List

This table is **generated; do not edit it by hand**: the command names and whether a script still exists come from the `scripts` of the root and `apps/*` `package.json` files, while the purpose and the exit code come from `scripts/docs/command-notes.json`. After changing a manifest, run `node scripts/docs/gen-command-table.mjs`; the `docs` segment of `pnpm verify` judges whether the table is stale. A new script with no note, a note naming a removed script, or a note whose registered file is gone all turn the gate red.

<!-- BEGIN GENERATED:commands -->

**Package scripts (the `scripts` of the root `package.json` and of every `apps/*/package.json`, in declaration order)**

| Command                                                   | Purpose                                                                                                                                                                                | Exit code                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                          | type-checking for every workspace package plus the gate scripts                                                                                                                        | `0` clean; non-zero type or config errors (tsc's own code)                                                                        |
| `pnpm lint`                                               | ESLint over the whole repository                                                                                                                                                       | `0` clean; `1` warnings or errors; `2` ESLint's own config or argument error                                                      |
| `pnpm verify`                                             | every gate, the default segments, in one run                                                                                                                                           | `0` all green; `1` at least one segment failed; `2` the aggregator itself is broken                                               |
| `pnpm verify:full`                                        | adds the three repository discipline checks (file size, cycles, module ownership)                                                                                                      | same as `verify`                                                                                                                  |
| `pnpm contract:update`                                    | regenerate the contract snapshot from an engine tree; it needs an explicit `--engine <dir>`, and the alias in `package.json` supplies none, so running it as-is exits as a usage error | `0` written and self-checked; `2` bad input, a missing flag or a degraded snapshot (nothing written)                              |
| `pnpm contract:check`                                     | contract artifacts still match their truth sources (`contract:diff` and `contract:generate` also exist)                                                                                | `0` consistent; `1` a drift was found; `2` bad input or a usage error                                                             |
| `pnpm tokens:check`                                       | design-token and palette consistency                                                                                                                                                   | `0` clean; `1` a violation; `2` the gate itself is broken                                                                         |
| `pnpm i18n:check`                                         | catalogue completeness and consistency                                                                                                                                                 | `0` clean; `1` a violation; `2` the gate itself is broken                                                                         |
| `pnpm fixtures:check`                                     | shape and header of the recorded fixtures                                                                                                                                              | `0` clean; `1` a violation; `2` the gate itself is broken (`--help` exits `0`)                                                    |
| `pnpm ui:e2e`                                             | layout and localisation checks in a browser                                                                                                                                            | `0` clean; `1` a violation; `2` no usable browser, or the script is broken                                                        |
| `pnpm perf:check`                                         | five performance baselines; over 1.5x the target is a warning, over 2x is a failure                                                                                                    | `0` nothing over 2x; `1` a measurement is over 2x; `2` the script itself is broken                                                |
| `pnpm contract:diff`                                      | print the difference between two contract snapshots; one argument compares against the committed one                                                                                   | `0` no difference; `1` a difference; `2` bad input or a usage error                                                               |
| `pnpm contract:generate`                                  | regenerate the capability-to-wire-id map from the committed contract inputs                                                                                                            | `0` written; `2` the capability table is invalid or the input is broken (nothing written)                                         |
| `pnpm test`                                               | unit tests (vitest)                                                                                                                                                                    | `0` all passed; `1` a test failed                                                                                                 |
| `pnpm desktop:smoke:supervision`                          | run the supervision probe on a real machine (forwards to `smoke:supervision` in `@haruyuki/desktop`)                                                                                   | `0` every required id passed; `1` a failure or a skip; `2` an artifact is missing (Electron binary, engine bundle, ...)           |
| `pnpm release:verify`                                     | judge whether a packaged artifact starts, paints a window and brings the engine to ready                                                                                               | `0` judged and passed; `1` judged and failed; `2` the script or its inputs are broken; `3` there is no packaged artifact to judge |
| `pnpm vscode:build`                                       | build the editor extension (forwards to `build` in `@haruyuki/vscode`)                                                                                                                 | `0` every target wrote its artifacts; `1` at least one target failed                                                              |
| `pnpm vscode:test`                                        | run only the editor extension's tests                                                                                                                                                  | `0` all passed; `1` a test failed                                                                                                 |
| `pnpm hooks:install`                                      | point git at the versioned commit hooks (running it twice is a no-op)                                                                                                                  | `0` installed or already present; `1` not in a repository or the hook directory is unusable; `2` broken environment               |
| `pnpm record`                                             | record one real engine session as a replay fixture (needs a local engine and credentials)                                                                                              | `0` recorded; `1` the run failed or stayed incomplete; `2` a usage error or a missing artifact                                    |
| `pnpm b2:demo`                                            | run the engine client's acceptance demo (one scripted end-to-end scenario)                                                                                                             | `0` passed; `1` failed                                                                                                            |
| `pnpm terminal:probe`                                     | the terminal stack's version and wiring regression probe (the four xterm packages, the stylesheet, scrollback)                                                                         | `0` every claim held; `1` one did not                                                                                             |
| `pnpm --filter @haruyuki/desktop setup:electron`          | download the Electron binary by hand (the dependency here has no postinstall)                                                                                                          | `0` in place; non-zero the download failed                                                                                        |
| `pnpm --filter @haruyuki/desktop build`                   | build all three targets: main process, renderer and probe                                                                                                                              | `0` all three written; non-zero at least one failed                                                                               |
| `pnpm --filter @haruyuki/desktop build:main`              | build only the main process (esbuild)                                                                                                                                                  | `0` written; non-zero the build failed                                                                                            |
| `pnpm --filter @haruyuki/desktop build:renderer`          | build only the renderer (vite)                                                                                                                                                         | `0` written; non-zero the build failed                                                                                            |
| `pnpm --filter @haruyuki/desktop start`                   | open the window from a local build (developer path)                                                                                                                                    | the Electron process exit code                                                                                                    |
| `pnpm --filter @haruyuki/desktop typecheck`               | type-check this application alone                                                                                                                                                      | `0` clean; non-zero type or config errors (tsc's own code)                                                                        |
| `pnpm --filter @haruyuki/desktop build:probe`             | build only the supervision probe                                                                                                                                                       | `0` written; non-zero the build failed                                                                                            |
| `pnpm --filter @haruyuki/desktop package:dir`             | produce the Windows directory package with electron-builder (no archive, no manifest)                                                                                                  | `0` succeeded; anything else is electron-builder's own code                                                                       |
| `pnpm --filter @haruyuki/desktop smoke:engine`            | judge whether the bundled engine can be found and started                                                                                                                              | `0` passed; `1` failed; `2` the engine artifact is missing                                                                        |
| `pnpm --filter @haruyuki/desktop smoke:supervision`       | build and run the supervision probe on a real machine, judging the cleanup after an engine exit                                                                                        | `0` every required id passed; `1` a failure or a skip; `2` an artifact is missing                                                 |
| `pnpm --filter @haruyuki/desktop verify:gui-host`         | run the host-API assertions inside a real main process                                                                                                                                 | `0` all passed; `1` one failed; `2` an artifact is missing                                                                        |
| `pnpm --filter @haruyuki/desktop verify:bridge-transport` | judge whether the render bridge delivers on all three channels frame by frame                                                                                                          | `0` all passed; `1` one failed; `2` an artifact is missing                                                                        |
| `pnpm --filter @haruyuki/desktop verify:bootstrap-error`  | judge whether the error surface holds and the window survives a failed start                                                                                                           | `0` it held; `1` it did not; `2` an artifact is missing                                                                           |
| `pnpm --filter @haruyuki/desktop verify:media`            | run the media and content-surface assertions in a real main process, without screenshots                                                                                               | `0` all passed; `1` one failed; `2` an artifact is missing                                                                        |
| `pnpm --filter @haruyuki/desktop verify:host-port`        | judge the host-port implementation in a real main process (directories, notifications, paths)                                                                                          | `0` all passed; `1` one failed; `2` an artifact is missing                                                                        |
| `pnpm --filter @haruyuki/vscode typecheck`                | type-check the editor extension alone                                                                                                                                                  | `0` clean; non-zero type or config errors (tsc's own code)                                                                        |
| `pnpm --filter @haruyuki/vscode build`                    | build the extension bundle and its webview artifacts                                                                                                                                   | `0` every target wrote its artifacts; `1` at least one target failed                                                              |
| `pnpm --filter @haruyuki/vscode test`                     | run the extension's tests only                                                                                                                                                         | `0` all passed; `1` a test failed                                                                                                 |

**Repository script files (not reached through `package.json`; registered in `command-notes.json`)**

| Command                                             | Purpose                                                                                          | Exit code                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `node apps/desktop/scripts/manifest.mjs`            | rewrite the release manifest and the checksums alone (the single producer)                       | `0` written and both tables agree; `2` the inputs cannot describe a build                    |
| `node apps/desktop/scripts/release.mjs`             | one command, artifacts plus manifest (the exit-code semantics are in the prose below)            | `0` / `1` / `2` / `3`                                                                        |
| `node apps/desktop/scripts/verify-artifacts.mjs`    | judge whether there is an unpacked tree and at least one archive                                 | `0` present; `1` absent; `2` the release directory does not exist                            |
| `bash apps/desktop/scripts/verify-linux-package.sh` | produce the Linux single-file package inside a container, then run the survival and paint probes | `0` passed; `1` the artifact does not start; `3` this machine cannot do it (no Docker, etc.) |
| `node apps/desktop/scripts/verify-manifest.mjs`     | judge that the manifest matches the disk claim by claim and that both hash tables agree          | `0` they agree; `1` they do not; `2` there is no manifest to judge                           |
| `node apps/desktop/scripts/verify-round-one.mjs`    | judge whether the runtime tree and its lock are in place                                         | the same set as `release.mjs`                                                                |

<!-- END GENERATED:commands -->

**Exit code semantics of `release.mjs`** (the three commands share one set; a judge script never invents its own):

- `0` every requested target succeeded, or was skipped for lack of a capability;
- `1` a target was attempted and failed;
- `2` **nothing was attempted**: a prerequisite failed, the command line was bad, or this version number already carries a tag. Three sources share one code, but **each writes its own fixed first-line prefix**, so the exit code alone cannot tell them apart and the log can:
  - `error: prerequisite failed` — installing dependencies or fetching the engine did not finish;
  - `error: usage` — the command line cannot be acted on;
  - `error: version conflict: tag exists` / `error: version conflict: tag list unreadable` — the version has been published, or the tag list could not be read (unknown also refuses, because "unknown" has to be louder than "no").
- `3` the only requested target cannot be done on this machine.

Options: `--win-only`, `--linux-only` (mutually exclusive; neither means both), `--skip-install`, `--skip-fetch`, `--skip-bundle`, `--linux-not-built=<docker-unavailable|machine-offline|toolchain-missing>` (**only meaningful for a requested target**: giving it with `--win-only` is a usage error). A version that already carries a tag is **refused, and leaves no file behind**.

## 6. Directory Structure

One level only, enough to decide roughly where things live.

- `apps/` — the two application shells: `desktop/` (the Electron desktop app) and `vscode/` (the editor extension)
- `packages/` — the three shared packages: `core/` (sessions and engine conversation), `protocol/` (messages and contracts), `ui/` (components and styles)
- `scripts/` — every gate script and their self-tests; this is what `pnpm verify` runs
- `fixtures/` — fixed samples for the gate self-tests (red and green in pairs), not product data
- repository root — the workspace declaration (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`), configuration (`tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.mts`), the three legal documents and these two READMEs
- maintainer documents — `ARCHITECTURE.md` (the three seams, the five packages, frames and state machines), `CONTRIBUTING.md` (gates, commit and release discipline), `AGENTS.md` (hard rules for collaborating agents), `CHANGELOG.md` (history is append-only)

Artifacts never enter the repository: `apps/desktop/release/`, `apps/desktop/dist/` and `apps/desktop/runtime/` are all generated locally.

## 7. Artifacts and Verification

**Artifact names** (the version changes; copy the architecture segment, do not rewrite it):

- Windows: `Haruyuki-<version>-win-x64.zip`, with `Haruyuki.exe` at the package root once unzipped;
- Linux: `Haruyuki-<version>-linux-x86_64.AppImage` (it is `x86_64`, not `x64`).

**Windows SmartScreen**: this package is **not signed**. The first double-click shows "Windows protected your PC"; click "More info → Run anyway". That is **expected friction, not a fault**, and the application will not prompt again.

**Linux missing `libfuse2`** (absent by default since Ubuntu 22.04): install `sudo apt install libfuse2`; or take the equivalent path without unpacking it:

```bash
./Haruyuki-<version>-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

**Verifying a downloaded package**: each Release body carries a hash table and the same content is shipped as a `SHA256SUMS` file; the two are identical line by line.

```bash
# Linux
sha256sum -c SHA256SUMS
```

```powershell
# Windows: compare line by line with SHA256SUMS
Get-FileHash .\Haruyuki-<version>-win-x64.zip -Algorithm SHA256
```

A hash proves "these two things have the same bytes"; it does **not** prove "who published them" — a signature would, and this project does not sign. So it cannot defend against the download page itself being changed. That is a premise, not an omission.

**Linux unverified list** (registered as **unverified**, not as "supported"):

- **Double-click launch**: unverified. The build container has no desktop environment and no FUSE.
- **Desktop integration** (icon, menu entry, file association): unverified.
- **Rendering on a real display**: unverified. Inside the container only process survival and artifact unpacking were checked; there is no screenshot tool to prove "the window was actually painted".
- **Multiple distributions**: unverified. It has only been run in the Debian bookworm build image, never on a second or third distribution.

In addition, **the first launch on another clean Windows machine** is also unverified — start-up has only been checked from another directory on the packaging machine.

## 8. This Project's Documentation Policy

This README is for people who want to use the project or take part in it, and assumes no internal reading. It holds itself to six rules:

1. **What this project is** — section 1 describes what you get; section 3 onward is hands-on.
2. **Environment requirements** — every line in section 4 was learned by running into it, not by general knowledge; Docker and the registry mirror in particular, without which there is no Linux artifact.
3. **How to run it after cloning** — section 3, within three steps; the user path (double-click the artifact) is there too.
4. **Command list** — section 5 is generated from the `package.json` files: every script in the root and `apps/*`, plus the repository's release scripts, none missing; the exit-code semantics sit below the table.
5. **Directory structure** — section 6, one level only.
6. **No internal identifiers** — this document cites no internal design documents, adjudication records, phase plans, work package codes or internal terminology; if a statement is unclear, ask in an issue, there is no other document to read first.

The maintainer documents (`ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md`) exist in English only: the same fact written twice usually yields two truths of different ages. The README is the exception, because it addresses users and contributors at once.

The two READMEs **correspond line by line** on contract-level content: environment requirements, installation steps, command list, directory structure, and licence and statements have the same number of entries with the same meaning and allow their own prose elsewhere. If the two sides disagree, the side with fewer entries is the defect.

## 9. Licence and Statements

Released under the Apache License 2.0; see [LICENSE](LICENSE) for the full text.

- [NOTICE](NOTICE) records third-party attributions that must travel with distributions and specifies when new entries need to be added.
- [THIRD-PARTY](THIRD-PARTY) is the list and registration rules for third-party components actually distributed with artifacts; dev-only dependencies are not listed.
- The package root also carries Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`; `resources/engine/` also carries the engine's own `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`, shipped unchanged.
- The three buttons in the about window open those three **local files** (not web pages); they work offline as well.

To the extent required by applicable law, unless otherwise agreed in writing, all contributions are provided "AS IS", without any express or implied warranties.
