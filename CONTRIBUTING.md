# Contributing

This repository is public. Everything you add — code, comments, test names,
commit messages, documentation — is read by people who cannot open whatever
private notes the work came from. The rules below exist to keep that boundary
true; they are not style preferences.

English-only document, like `ARCHITECTURE.md`. The two READMEs are the
bilingual exception, because they address users as well as contributors.

## 1. Before you start

| Requirement | Value |
| --- | --- |
| Node.js | `>= 24` (declared by `engines`) |
| pnpm | `10.24.0` (pinned by `packageManager`) |
| corepack | `corepack enable pnpm --install-directory "$(dirname "$(command -v node)")"` |

```bash
git clone https://github.com/TZYLT/haruyuki-gui.git && cd haruyuki-gui
pnpm install --frozen-lockfile
```

The Electron binary is not downloaded by `postinstall`. Fetch it when you need
to run the desktop shell:

```bash
pnpm --filter @haruyuki/desktop setup:electron
```

## 2. Commit identity

**Always use the machine's global `user.name` and `user.email`.**

```bash
git config --get user.name
git config --get user.email
```

- Never pass `-c user.name=...` / `-c user.email=...` to `git commit`.
- Never set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` or
  `GIT_COMMITTER_EMAIL` for a commit in this repository.
- Never add a `Co-authored-by:` trailer naming a tool, an agent or a
  placeholder address.
- A commit whose author is not the person who made it is a defect, not a
  cosmetic one: it makes every later question about provenance unanswerable.

If you are an automated collaborator, see `AGENTS.md`: it repeats this rule
because it is the one most easily broken by an agent.

## 3. Staging discipline

```bash
git status --short          # know what changed
git add README.md           # one explicit path at a time
git add scripts/docs/check-public-docs.mjs
git diff --cached           # read what you are about to commit
git commit
```

- **Stage files one by one.** `git add -A`, `git add .` and `git add --all` are
  forbidden: they sweep in generated artifacts, local scratch files and other
  people's work.
- Do not commit build output (`apps/desktop/dist`, `apps/desktop/release`,
  `apps/desktop/runtime`, `node_modules`, coverage).
- If a file has to be removed from the index, say which file; do not "reset
  everything".
- Never rewrite history that has been published. If a commit needs fixing and
  it is already on `main`, add a follow-up commit.

## 4. Commit messages

Conventional commits, one subject, imperative, lowercase after the type,
no trailing period:

```
fix(terminal): keep the acknowledgement path alive after a reattach
docs(commands): describe every script in the generated table
feat(core): bound the reconnect window from the moment the link was lost
test(vscode): give the bundled child the same runtime dependency
chore: declare the workspace package manager
```

- Type: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `perf`, `build`.
- Scope: the package or area you touched (`core`, `protocol`, `ui`, `desktop`,
  `vscode`, `docs`, `gates`, `release`).
- Body: **why** the change is needed and what would break without it. The diff
  already says what changed.
- **No internal identifiers.** Do not cite private document numbers, work-item
  codes, finding ids or a phase plan. If a constraint matters, write the
  constraint: "a status paragraph that describes another branch's future is a
  lie with a timestamp" beats a citation nobody can open.
- No placeholder identities, no `Signed-off-by` for people who did not sign.

## 5. The gates

There is no CI. The gate set is a local command, and a change is only ready when
it runs clean:

```bash
pnpm verify          # every default segment, one conclusion per segment
pnpm verify:full     # plus file size, cycles and module ownership
```

The aggregator runs every segment even after a failure, so one run reports all
problems. A segment that fails replays its output; a green run leaves one line
per segment. The segments cover, in order:

| Segment | Asks |
| --- | --- |
| typecheck | the workspace packages and the gate scripts compile |
| vscode typecheck | the editor shell compiles on its own, so a failure names it |
| vscode build | the editor shell's bundle is produced; a bundling failure is invisible to tsc |
| lint | ESLint over the whole repository |
| boundaries | every relative path, `require`, dynamic `import` and re-export resolves inside the package rules |
| literals | no private identifier leaks into source, comments, test names or fixture names |
| gate self-test | the gates themselves still go red on their red fixtures and green on their green ones |
| contract | committed contract artifacts match their generators |
| tokens | the design tokens and the palette agree |
| i18n | both catalogues carry the same keys with the same meaning |
| fixtures | recorded fixtures have the right shape and header |
| frame | frame type literals are in the append-only table |
| capabilities | no shell spells a wire command id |
| test | the unit and end-to-end tests, with coverage numbers |
| file size | no hand-written source file is over the line limit |

One more check belongs to the gate set and runs as the `docs` segment:
`node scripts/docs/check-public-docs.mjs`. If the aggregator on your branch
does not list that segment yet, run the script directly. It fails when:

- a README's generated command block is stale;
- the two READMEs disagree on their numbered sections or their command rows;
- a reader-facing file contains a private identifier;
- the status section's `main@<sha>` anchor does not resolve or is not an
  ancestor of `HEAD`.

Two related commands you will use while editing documentation:

```bash
node scripts/docs/gen-command-table.mjs           # rewrite the README command tables
node scripts/docs/check-public-docs.mjs           # what the docs segment runs
```

Changing a `package.json` script requires an entry in
`scripts/docs/command-notes.json` and a regenerated table. A missing note, a
note for a script that no longer exists, or a note registered against a file
that is gone all fail with exit `2` — deliberately, because that is the case
where the gate cannot judge rather than the case where it judges badly.

## 6. The public assets

These files are read by people outside the project. A change that makes any of
them false is an incomplete change:

| Asset | What it promises |
| --- | --- |
| `README.md` (Chinese) | what the project is, the three-state status, environment requirements, how to build and verify, the command reference, the directory map, the licensing statements |
| `README.en.md` | the same, line by line; contract-level items must match the Chinese side exactly |
| `ARCHITECTURE.md` | the three seams, the five packages, frames and state machines |
| `CONTRIBUTING.md` | this document |
| `AGENTS.md` | the hard rules for automated collaborators |
| `CHANGELOG.md` | append-only history, written for readers of the artifact |
| `LICENSE`, `NOTICE`, `THIRD-PARTY` | the licence, third-party attributions, and the components actually distributed |
| the about window | version, engine origin, last verification, runtime, local licence entry points, repository and feedback links |

Rules that follow:

- **Change one README, change the other.** The section structure, the command
  rows and the meaning of each entry are checked; narrative prose may differ.
- **Do not add a feature to the status list without checking that a user can
  reach it.** The three states are `available`, `shell only, not wired` and
  `not started`. "The code exists" is not available; "the entry point is
  hidden" is not available either.
- **Regenerate the command table** after touching a manifest. Never hand-edit
  between the generated markers.
- **No internal identifiers anywhere in these files.** No private document
  numbers, work-item codes or finding ids. The public-docs check enforces the
  pattern on the READMEs and the licence files.
- **Never invent** a version number, a download URL, an issue link, a badge or
  a CI status. If something is unverified, write "unverified".

## 7. Releases and tags

The version lives in the root `package.json` and in the two application
manifests. A release is a human action; the scripts prepare it, the maintainer
publishes it.

1. **Bump the version** in `package.json`, `apps/desktop/package.json` and
   `apps/vscode/package.json`, then update the README artifact examples and
   `CHANGELOG.md`.
2. **Run the gates** (`pnpm verify`) and the desktop build.
3. **Produce the Windows package**:

   ```bash
   node apps/desktop/scripts/release.mjs --win-only
   ```

4. **Produce the Linux package on a Linux machine or in the container**:

   ```bash
   bash apps/desktop/scripts/verify-linux-package.sh
   ```

5. **Check the artifacts before tagging**:

   ```bash
   node apps/desktop/scripts/verify-round-one.mjs    # runtime tree and its lock are in place
   node apps/desktop/scripts/verify-artifacts.mjs    # an unpacked tree and at least one archive exist
   node apps/desktop/scripts/verify-manifest.mjs     # the manifest matches the disk and both hash tables
   ```

   The release command writes the manifest through `manifest.mjs`; these three
   judges are what you point at the finished tree and at the archive. If any of
   them refuses, do not tag.
6. **Create the tag and the Release by hand**, upload the archives and
   `SHA256SUMS`, and use the generated notes for the body. The release command
   prints the steps it refuses to do for you.

Tag discipline:

- **A version that already carries a tag is refused.** Do not delete or move a
  published tag to make a build succeed; bump the version instead.
- One tag per released version, annotated, created only after the artifacts
  pass. Tags are never rewritten.
- If the tag list cannot be read, the release is refused too: "unknown" must be
  louder than "no".
- **`CHANGELOG.md` history is append-only.** Add a section for the new version;
  never edit a section for a version that was already released.

## 8. When a document and the code disagree

The code wins, and the document is the defect. Fix the document in the same
change, or open an issue saying which sentence is wrong. A stale document is
worse than a missing one, because it is read as current.
