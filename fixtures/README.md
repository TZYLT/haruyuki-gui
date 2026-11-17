# Fixtures

Data for the replay and bridge-comparison pipelines (docs/18 section 3.1, section 3.4.2).
Everything here is data, not code: one message per line, so a broken fixture can
be reported as `<file>:<line>`.

Two corpora live here:

| Directory | Kind | Producer |
|---|---|---|
| `fixtures/engine/recordings/*.jsonl` | wire recordings (engine to client) | `scripts/engine/record.mjs` plus the redaction pass |
| `fixtures/bridge/*.jsonl` | bridge frame sequences | hand-written or template-generated (docs/18 R-07) |

`fixtures/engine/fake-server.mjs` and `fixtures/engine/replay.mjs` are code, not
corpus; the gate does not read them.

`fixtures/engine/recordings/reconnect/` holds the reconnect item's two
recordings. They sit in a subdirectory on purpose: the seven files at the top
level are one corpus with published totals (frame counts and distinct types
asserted by tests), and adding files beside them would silently invalidate those
numbers.

Inside `reconnect/`, `reconnect-approvals.jsonl` is **hand-written**, and its
header says so (`clock: "synthetic"`, `origin: "hand-written"` with the reason).
An approval is addressed to the **client** — the client supplies the tool being
approved — and the recorder is a bare websocket client with no toolset, so the
engine never asks it for permission. There is no recorder flag that changes that,
because the missing piece is a role, not a setting.

What that file proves is the **counting logic**: which remembered approvals count
as still waiting, which do not, and that a repeated reconcile or a repeated push
does not double the number. What it does **not** prove is that the engine really
re-pushes a waiting approval after a resync. **No recording in this corpus shows
that**, as of the eight files here, so it rests on the observation that a resync
replays state rather than on a frame anyone captured. If somebody does record a
real approval replay, this paragraph and the `originReason` field in that file
both have to change -- otherwise the note keeps claiming a gap that no longer
exists.

**Rule: the top level keeps exactly those seven.** A new recording goes into a
subdirectory of its own. The gate walks subdirectories, so a nested recording is
checked exactly like the rest; only the seven are the "corpus" whose totals other
tests quote. If a top-level file is ever added, the six total assertions in the
client suites and the published corpus numbers have to be updated in the same
change.

## Commands

```bash
pnpm fixtures:check                 # gate the corpus (shape, redaction, V-14 warning)
node scripts/engine/scenarios/index.mjs --emit <name>   # write the --send list
pnpm record --scenario <name> --send _research/engine-raw/<name>.cmd.json
node scripts/redact-fixtures.mjs <raw.jsonl> <out.jsonl>  # redaction pass (r0 -> r2)
```

`pnpm fixtures:check` (or `node scripts/check-fixtures.mjs`) is the `fixtures`
segment of `pnpm verify`. It exits `0` on pass, `1` on violations and `2` when
the script itself is broken.

`pnpm record` is the package-script wrapper around `scripts/engine/record.mjs`,
and `--send` is required: the command list comes from a scenario module, not from
the recorder. The output is written to `<out>.partial` and renamed only when the
session settles on `idle`, so an interrupted run leaves no half fixture behind.
If the wrapper is not wired in the current checkout, run the same command
directly: `node scripts/engine/record.mjs --scenario <name> --send <list.json>`.

Raw recorder output is `redaction: "r0"` and stays under `_research/` (gitignored,
never scanned by the gate). Only a redacted copy (`r1` or later) may be committed
below `fixtures/`.

## Redaction pass (record -> redact -> check)

The workflow is: record a session into `_research/`, redact it with the pass,
then gate the result. The pass is deterministic - the same raw recording always
produces byte-identical output - and only writes the output path it is given.

```bash
node scripts/redact-fixtures.mjs \
  _research/engine-raw/<scenario>.jsonl \
  fixtures/engine/recordings/<scenario>.jsonl [--report]
```

It rewrites the header marker (default `r2`; `--redaction r3` for a later
revision) and replaces every matching value in every string of every line:

| Rule | Replacement |
|---|---|
| absolute Windows path | `C:/work/<last segment>` (an existing synthetic path is kept) |
| absolute POSIX path | `/tmp/x/<last segment>` (an existing synthetic path is kept) |
| local user name | `user` |
| email address | `<redacted-email>` |
| `Bearer ...`, 64-hex, `sk-...` | `<redacted-token>` |
| machine name (`device_status.connection_name` and any other mention) | `synthetic-host` |
| non-synthetic `request_id` | `synthetic-<slug>`, or `synthetic-perm-<slug>` |

`request_id` consistency is one in-memory map for the whole file: the same
original id always gets the same synthetic id, so a response still answers its
request. A `perm-<toolCallId>` approval id becomes
`synthetic-perm-<slugified toolCallId>` while the `tool_call_id` field is left
alone, which keeps the approval linked to its tool call. Synthetic ids already
present are reserved; collisions get a `-2`/`-3` suffix.

One summary line on stderr reports the file pair and a count per gate rule;
`--report` adds per-line counts and the request-id map size. Offending values
are never echoed.

> The gate rejects every email-shaped string, including `alice@example.com`, so
> the pass emits the non-email placeholder `<redacted-email>`. If the gate ever
> allows example.com addresses, change `EMAIL_PLACEHOLDER` in
> `scripts/redact-fixtures.mjs`.

## Wire recording format

Line 1 is the header; every later line is one engine message, in emission order
(docs/18 INV-A3-1).

```json
{"kind":"wire","schemaVersion":1,"engine":{"version":"0.6.0","commit":"1641a4f"},"scenario":"tool-call","redaction":"r2","clock":"virtual","recordedAt":"2026-11-14T00:00:00.000Z"}
{"dir":"s2c","at":0,"msg":{"type":"app_server_info_response"}}
{"dir":"c2s","at":3,"msg":{"type":"input","request_id":"r-1"}}
```

Header fields:

| Field | Meaning |
|---|---|
| `kind` | `"wire"` |
| `schemaVersion` | `1`; the only version this gate reads |
| `engine.version` / `engine.commit` | the engine that produced the frames; compared with the contract pin (warning only) |
| `scenario` | the scenario name, matching the file name |
| `redaction` | `"r0"` = not redacted yet (never in the corpus); `"r1"`+ = redacted (current revision: `"r2"`) |
| `clock` | `"real"` for recorder output, `"virtual"` for replayed timing |
| `recordedAt` | ISO timestamp; informational, never asserted |
| `synthetic` | optional `true`; see below |

Body line fields:

| Field | Meaning |
|---|---|
| `dir` | `"s2c"` (server to client) or `"c2s"` (client to server) |
| `at` | offset in milliseconds on the fixture clock |
| `msg` | the wire message; `msg.type` is required |

Replay only emits `s2c`; `c2s` lines are kept because they show what the client
did, and a fixture without them cannot explain its own responses.

## Bridge frame format

Line 1 is the header; every later line is one `Frame` envelope (docs/18 section 3.4.2).

```json
{"kind":"frames","schemaVersion":1,"bridgeVersion":1,"clock":"virtual","note":"t vocabulary pending C5"}
{"v":1,"ch":"control","seq":1,"t":"bridge.ready","body":{"appVersion":"0.1.0","bridgeVersion":1}}
```

Header fields:

| Field | Meaning |
|---|---|
| `kind` | `"frames"` |
| `schemaVersion` | `1` |
| `bridgeVersion` | the bridge protocol version the frames target |
| `clock` | `"virtual"` for fixture-driven replay |
| `note` | free text; keep it short and ASCII |

The frames header has no `redaction` field: bridge frames are hand-written from
the frozen vocabulary, not captured, so there is nothing to redact. If a header
does carry a `redaction` marker, it must still be `r1` or later.

Frame `t` values are limited to the vocabulary already written in docs/01-3
section 3.1; C5 owns the final word list, so do not invent new values here.

## What `synthetic: true` means

Some scenarios cannot be driven without a UI (docs/18 section 7 R-01: approval,
subagent and compaction may fail the probe). When that happens the frames are
written by hand from the shapes in docs/18 section 2.6, not captured from a real
engine. The header then carries `synthetic: true`, and the deviation is
registered in docs/16.

So `synthetic: true` means: the line shapes are frozen and valid, but the
content is hand-made and is not evidence that a real engine produced it. Do not
cite such a fixture as a real-session recording. The gate accepts the optional
field and does not otherwise validate it; setting it is the writer's duty.

## Redaction rules

The corpus is public, so a fixture never contains real content (docs/17 A3-Q12).
Redaction happens at record time and is irreversible (docs/18 R-06); this gate
only re-checks it.

| Rule id | Fires on |
|---|---|
| `redaction-state` | the header marker is missing on a wire fixture, or is not `r1`+ (including `r0`) |
| `redaction-path` | an absolute path outside the synthetic roots: Windows `X:\...` / `X:/...` or POSIX `/...` |
| `redaction-username` | the local user name from the deny-list (`os.userInfo().username`, `%USERNAME%`, `$USER`) |
| `redaction-email` | any `name@example.tld` address |
| `redaction-token` | `Bearer <token>`, a 64-hex token-like string or a provider API key (`sk-...`) |
| `redaction-host` | a `device_status.connection_name` that is not `synthetic-host` |
| `redaction-request-id` | a `request_id` outside the synthetic vocabulary |

Allowed synthetic values:

- Paths: `C:/work/...` (or `C:\work\...`) and `/tmp/x/...`. A path is synthetic
  when it equals one of those roots or sits below it; `C:/workstation` is not.
- Request ids: `r-<n>` (the frozen example is `"r-1"`), `req-<n>`, or
  `synthetic-<slug>` such as `synthetic-perm-allow`.
- Device name: `synthetic-host`, the only value accepted in
  `device_status.connection_name`. The engine echoes the machine name there, and
  a machine name says where a recording was made. The rule is an allow-list, not
  a deny-list of local host names, so the verdict does not depend on the machine
  running the gate.

Everything else observed in a real session - home directories, workspace paths,
machine names, account names, prompts, tool output with local data - is replaced with synthetic
text before the file enters the corpus. Structure and token counts stay; content
does not.

Violation lines are `<file>:<line> <rule> <message>`. The gate deliberately does
not echo the offending value: its output is public too.

## Version alignment (V-14)

Each wire header's `engine.version` / `engine.commit` is compared with the pair
pinned in `packages/protocol/src/contract/snapshot.json`. A drift prints a
`WARN` line and does not change the exit code (docs/18 R-09): a hard failure
would force a full re-record on every engine bump. A wire fixture with no
readable pin is a configuration error (exit `2`).

## Adding a fixture

1. Record into `_research/` (`pnpm record --scenario <name>`), or write the
   JSONL by hand from the frozen shapes.
2. Redact with `node scripts/redact-fixtures.mjs <raw> <out>` (or by hand:
   synthetic paths and request ids, no user name, machine name, email or token,
   and `redaction: "r2"` in the header).
3. Put the file under the right corpus directory.
4. Run `pnpm fixtures:check`; it must print `PASS` (warnings are fine, violations
   are not). A red gate means the fixture does not get committed (docs/18
   INV-A3-9).
