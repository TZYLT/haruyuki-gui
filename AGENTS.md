# Rules for automated collaborators

This repository is public and is maintained by humans who review what you leave
behind. Read `CONTRIBUTING.md` first; this file is the short list of rules an
agent breaks most often, and the checklist to run before you report anything as
done.

English-only, like the other maintainer documents.

## The four hard rules

### 1. Never set a commit identity

Use the machine's global configuration. Do not pass `-c user.name=` or
`-c user.email=` to git, do not export `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, do
not add a `Co-authored-by:` trailer for a tool or an agent, and do not invent an
address such as `agent@local`.

If the global identity is missing, stop and say so. A commit with the wrong
author is worse than no commit.

### 2. Never write an internal identifier

The project keeps private notes; readers cannot open them, so citing them is
noise. Do not write any of these into tracked files — code, comments, test
names, fixture names, READMEs, commit messages, issue text:

- a numbered private note, whether written as a path under a private `docs`
  directory, in angle brackets, or as a bare section reference;
- the short family codes those notes use for work items and findings: a single
  letter, a hyphen and a one- or two-digit number, or a two-letter family
  followed by a hyphen and a number;
- a phase plan, an adjudication record or a review log as a citation.

If a string looks like a private code — a short uppercase prefix, a hyphen, a
number — and you cannot point at a file in this repository that defines it, do
not write it.

Write the constraint instead of pointing at it. "The command table must be
regenerated, never hand-edited" is useful to every reader; a citation of the
private note that decided it is useful to none.

### 3. Do not push, and do not rewrite published history

Commits stay local; publishing is the maintainer's decision. Do not run
`git push`, do not create or move tags, and do not run `reset --hard`,
`checkout --`, `stash`, `rebase` or `filter-branch` on history that has been
published. Do not run `git add -A` or `git add .`: stage explicit paths.

### 4. A stale document is a defect

If your change makes any public document false, the change is incomplete. In
the same change:

- update **both** READMEs (`README.md` and `README.en.md`) — same sections,
  same entries, same meaning; narrative prose may differ;
- regenerate the command table with `node scripts/docs/gen-command-table.mjs`
  after touching a `package.json`;
- append a `CHANGELOG.md` entry for a user-visible change;
- keep the status list honest: `available`, `shell only, not wired`,
  `not started`. "The code exists" is not available.

## Gate checklist

Run these before saying a change is ready. Report the exact commands and their
results; do not summarise a gate you did not run.

```bash
pnpm verify                                  # every default segment
pnpm verify:full                             # file size, cycles, module ownership
node scripts/docs/check-public-docs.mjs      # the docs segment, on its own
node scripts/docs/gen-command-table.mjs --check
```

For a documentation-only change, at minimum:

```bash
node scripts/docs/check-public-docs.mjs
node scripts/docs/gen-command-table.mjs --check
pnpm exec eslint scripts/docs
```

If a command cannot run — no engine, no Docker, no browser — say so, and say
what was therefore not verified. **Never write "verified", "installed",
"passing" or "works" for something you did not execute.** "Not verified" is an
acceptable result; a false claim is not.

## Working area

- Touch only the files the task names. Do not reformat, rename or "clean up"
  files outside it, even when they look wrong; report them instead.
- Do not edit `docs/` (private notes) or build output.
- Do not edit a region between `<!-- BEGIN GENERATED:commands -->` and
  `<!-- END GENERATED:commands -->` by hand. Change the manifest or
  `scripts/docs/command-notes.json`, then regenerate.
- One concern per commit. If the change needs two kinds of edit (a behaviour
  fix plus a documentation update), two commits are easier to review than one.
- If a task and the repository disagree — the file it names does not exist, the
  function moved, the test is not there — stop and report the mismatch. Do not
  invent a path or a claim to make the task fit.

## Reporting

End with: the files changed, the commands run and their real output, the
evidence for any claim about what a user can reach (file and line), and any
place where the task's description and the code disagree.
