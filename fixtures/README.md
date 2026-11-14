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

## Commands

```bash
pnpm fixtures:check                 # gate the corpus (shape, redaction, V-14 warning)
pnpm record --scenario <name>       # record a real session into _research/engine-raw/
```

`pnpm fixtures:check` (or `node scripts/check-fixtures.mjs`) is the `fixtures`
segment of `pnpm verify`. It exits `0` on pass, `1` on violations and `2` when
the script itself is broken.

`pnpm record` is the package-script wrapper around `scripts/engine/record.mjs`.
If the wrapper is not wired in the current checkout, run the same command
directly: `node scripts/engine/record.mjs --scenario <name>`.

Raw recorder output is `redaction: "r0"` and stays under `_research/` (gitignored,
never scanned by the gate). Only a redacted copy (`r1` or later) may be committed
below `fixtures/`.

## Wire recording format

Line 1 is the header; every later line is one engine message, in emission order
(docs/18 INV-A3-1).

```json
{"kind":"wire","schemaVersion":1,"engine":{"version":"0.6.0","commit":"1641a4f"},"scenario":"tool-call","redaction":"r1","clock":"virtual","recordedAt":"2026-11-14T00:00:00.000Z"}
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
| `redaction` | `"r0"` = not redacted yet (never in the corpus); `"r1"`+ = redacted |
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
| `redaction-token` | `Bearer <token>` or a 64-hex token-like string |
| `redaction-request-id` | a `request_id` outside the synthetic vocabulary |

Allowed synthetic values:

- Paths: `C:/work/...` (or `C:\work\...`) and `/tmp/x/...`. A path is synthetic
  when it equals one of those roots or sits below it; `C:/workstation` is not.
- Request ids: `r-<n>` (the frozen example is `"r-1"`), `req-<n>`, or
  `synthetic-<slug>` such as `synthetic-perm-allow`.

Everything else observed in a real session - home directories, workspace paths,
account names, prompts, tool output with local data - is replaced with synthetic
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
2. Redact: synthetic paths and request ids, no user name, email or token, and
   `redaction: "r1"` in the header.
3. Put the file under the right corpus directory.
4. Run `pnpm fixtures:check`; it must print `PASS` (warnings are fine, violations
   are not). A red gate means the fixture does not get committed (docs/18
   INV-A3-9).
