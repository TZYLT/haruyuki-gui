# Changelog

All notable changes to this project are recorded here.

## How this file is maintained

- **Newest first, one section per version.** A version gets its section when it
  is released; `Unreleased` collects work that is already on the main line but
  not part of a released version yet.
- **Released sections are append-only.** Never edit the entries of a version
  that has already been published; add a new section instead. Rewriting history
  here defeats the purpose of keeping it.
- **Write for a reader of the artifact.** Describe what a user can now do, or
  what was broken and is no longer. Internal identifiers, private notes and
  commit-level detail do not belong here.
- **Never invent** links, dates, issue numbers or release locations. If a
  version has no tag or download yet, say so.
- The version in this file must match `version` in the root `package.json`.

The format follows the spirit of Keep a Changelog. The sections are `Added`,
`Changed`, `Fixed`, `Removed`, `Security` and `Not yet`; use only the ones a
release needs.

## [0.1.0] — unreleased

The version the current build produces. No tag has been created for it yet:
this section was written when the file was introduced and summarises the
history up to `903e27f` (2026-11-19). It is the only section that is a summary
rather than a release note; every later section is appended at release time.

### Added

- **Desktop shell (Electron).** Opens a window that verifies its bundled engine
  at start-up; a dockable page frame whose layout survives a restart, with panes
  registered for navigation, conversation, files and terminal (the first three
  are samples with example content); a crash page and a diagnostics surface; a
  menu with the standard edit and help entries.
- **Terminal page.** Each terminal tab is one engine session; input and output
  travel over the render bridge's command channel and its stream channel, and a
  session starts when the engine is ready. With no engine the page says so
  instead of showing a blank surface.
- **About window.** Application version, engine version and origin, the result
  of the last start-up verification, the runtime environment, local entry
  points for the licence documents, and the repository and feedback links. It
  works offline.
- **Check for updates.** A button in the about window that goes online only
  when clicked and distinguishes its outcomes, including "quota exhausted" and
  "network unavailable"; neither of those is reported as "up to date".
- **Engine hosting.** Spawn or attach to the engine program, discover its port,
  authenticate with a short-lived token, complete the handshake, watch it for
  silence and unexpected exit, and shut it down without leaving orphans.
  Failures are classified (spawn, port, authentication, protocol, timeout) so a
  surface can say what happened.
- **Reconnect and replay.** A bounded reconnect state machine per agent, with a
  replay pass after a resync, a visible gap record when content may be missing,
  and a degraded state that allows reading while refusing sends.
- **Command dispatch.** Callers name a capability; the wire command id is
  resolved from a generated map, so a shell never spells one.
- **Render bridge.** A flat JSON frame envelope on three channels (control,
  stream, bulk), a single sequencer, a handshake, and a byte-count
  acknowledgement path for terminal output.
- **Session model.** One immutable store folding engine events into entity
  maps, read through selectors; idempotent ingestion and stale-frame rejection;
  an approval table keyed by request id with pending, decided and expired rows.
- **Editor shell (VS Code).** An activity-bar view, a panel, a webview host and
  a forked core child process that owns the engine; a fault surface that says
  why the panel has no engine and keeps the frame; editor theme and locale are
  followed.
- **Design system and localisation.** Shared components, design tokens, and two
  translation catalogues checked for completeness and agreement.
- **Packaging and release.** One command builds the Windows directory package
  and zip; the Linux single-file package is produced inside a container with
  survival and paint probes; a manifest records every artifact and two hash
  tables that must agree; a packaged build can be verified end to end.
- **Gates.** Package boundaries, import direction, module ownership and cycles,
  private-identifier leaks, frame type literals, capability ids in shells,
  contract artifacts against their generators, design tokens, catalogues,
  recorded fixtures, file size, coverage numbers, and the gates' own red/green
  fixtures.
- **Public documentation.** Bilingual READMEs, and the maintainer documents
  this file belongs to: `ARCHITECTURE.md`, `CONTRIBUTING.md` and `AGENTS.md`,
  with the generated command tables and the public-docs check behind them.

### Fixed

- The editor shell answers the panel's handshake, keeps a dead engine visible
  instead of leaving the frame silent, offers a retry when a stopped engine
  comes back, and gives a refused folder its own kind of failure.
- The application menu no longer opens with a divider, and there is one way into
  the about window instead of two.
- The release command refuses contradictory platform flags instead of producing
  a manifest that answers the same question twice.

### Not yet

- Real conversation and streaming output, approval surfaces, the file tree and
  editor, and the settings page.
- The main window's top bar is mounted, but its check-for-updates entry is not
  wired; the check is reachable from the Help menu.
- The navigation, conversation and file-tree pages are sample pages with
  example content, not real data.
- The editor shell's webview keeps its layout in memory only; a reload returns
  to the default document.
- Automatic updates, automatic downloads and automatic restarts are not
  implemented and are not planned; the update check runs once, on request.
- The Linux single-file package is unverified on a real desktop: only the
  container build, process survival and unpacking have been checked.
