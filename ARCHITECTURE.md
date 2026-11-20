# Architecture

This document is for someone who has to change this repository, not for someone
who wants to use it. The user-facing picture is in the two READMEs; this one
explains **where the seams are, what crosses them, and which invariants each
side is allowed to assume**.

It is English-only on purpose. The same fact written twice in two languages
usually becomes two facts of different ages.

## 1. The shape of the system

One engine, two shells, three shared packages.

```
                 ┌──────────────────────────────┐
                 │ Haruyuki engine (separate    │
                 │ program: WebSocket + token)  │
                 └──────────────┬───────────────┘
                                │ seam 1: engine boundary
        ┌───────────────────────┴───────────────────────┐
        │ @haruyuki/core  (engine host + client,        │
        │ command dispatch, session folding, layout)    │
        └───────┬───────────────────────────────┬───────┘
                │ seam 2: HostPort              │ seam 3: render bridge frames
   ┌────────────┴────────────┐        ┌─────────┴──────────────┐
   │ Electron main process   │        │ renderer (React)       │
   │ VS Code extension host  │        │ VS Code webview        │
   │ headless test runner    │        │                        │
   └─────────────────────────┘        └────────────────────────┘
```

The three seams are the only places where one side may assume anything about
the other:

| Seam | Between | Crosses as | Enforced by |
| --- | --- | --- | --- |
| 1. Engine boundary | the shells' core and the engine program | WebSocket frames, a spawn spec, a token file | `packages/core/src/engine/**`, the capability table |
| 2. HostPort | the core's engine host and whatever runs it | nine synchronous/async capabilities supplied by the host | `packages/core/src/port/host-port.ts` and its contract tests |
| 3. Render bridge | the core's producer and a renderer | JSON frames on three channels | `packages/protocol/src/frame/**`, `packages/core/src/bridge/**` |

A change that reaches across a seam without going through the seam is a defect
even if it works: it makes the other side's assumptions unverifiable.

## 2. The five packages

| Package | Owns | Deliberately does not |
| --- | --- | --- |
| `@haruyuki/protocol` | Transport-neutral contracts: the frame envelope and its append-only type table, the layout document, the session entity shapes, the conversation block union, and the generated capability-name ↔ wire-id map | Contain behaviour, validation or an SDK type in its public surface. It is types and data, so both a renderer and a plain Node process can import it. |
| `@haruyuki/core` | Everything that needs to talk to the engine: process start, port discovery, token, handshake, watchdog, shutdown; the engine client's channels and command dispatch; session folding and approvals; layout persistence; supervision; the producer half of the frame contract | Know about Electron, VS Code, React or the DOM. It runs in plain Node, which is what makes it testable without a desktop shell. |
| `@haruyuki/ui` | The renderer's building blocks: components, the dockable frame and page registry, the terminal panel, the i18n catalogues, the design tokens | Import Node builtins, or read files/config itself. Everything it needs arrives as props or through the frame host. |
| `@haruyuki/desktop` | The Electron shell: main process (host port, engine host, command service, bridge transport, about window, update check, diagnostics), preload, renderer entry and page registry, and the release scripts | Re-implement core logic. Its renderer talks to the main process and nothing else. |
| `@haruyuki/vscode` | The editor shell: extension host, the core child process it forks, the webview host, and the webview's renderer | Share the desktop shell's IPC. Both shells consume the same core and the same frame contract, which is the point. |

Two dependency rules follow from the table and are checked mechanically:

- `protocol` is imported by everyone and imports no workspace package.
- `ui` may import `protocol` and `core` types, but never the other way round;
  `core` never imports `ui` or either shell.

## 3. Seam 1 — the engine boundary

The engine is a separate program. It is not a library, it is not embedded, and
no shell ever spawns it directly.

**What the core owns.** Starting the process from a spawn spec the host
produces; reading the port line from its stdout; writing and later removing an
authentication token; opening the WebSocket and completing the handshake;
watching the process for silence, unexpected exit and orphaned children;
classifying every failure into a small taxonomy that a surface can render
(`SPAWN_FAILED`, `PORT_NOT_FOUND`, `AUTH_FAILED`, `PROTOCOL_MISMATCH`,
`TIMEOUT`); and shutting down in an order that leaves nothing behind.

**What callers see.** A capability name, never a wire id. The mapping is
generated into `protocol` and resolved by the client's send path. A shell that
spells a wire id is a defect: the gate that scans the shells for capability
names exists exactly because that mistake is invisible at runtime — the command
works until the engine renames it.

**Three version axes exist and must not be conflated:** the application version
(the artifact name), the engine's own version (reported in the about window),
and the wire/frame protocol version (the envelope's `v`). A change to one does
not imply a change to the others.

**Why the engine is the core's child, even in the editor.** The VS Code
extension host forks a core child process; the core child spawns the engine.
The extension host therefore never sees `WebSocket:` output and never owns an
engine process, and a crashed extension host leaves handles the child is
already watching. On the desktop shell the core lives inside the Electron main
process, so the engine is the main process's child.

## 4. Seam 2 — the HostPort

The core's engine host needs things only a host can provide: where user data,
logs, cache and temporary files go; how to resolve a spawn instruction for this
machine; whether the host can raise a notification, read a dropped file's path,
pop a panel out, or float a window; and a few more lifecycle details. All of
that is one interface — **the host port**.

Its contract is nine items, and it is implemented three times:

| Adapter | Where | Notes |
| --- | --- | --- |
| Electron main process | `apps/desktop/src/main/host-port.ts` | real paths, real dialogs, real notifications |
| VS Code extension host | `apps/vscode/src/host/host-port.ts` | proxied across the pipe to the core child |
| Headless | `packages/core/src/port/headless-host-port.ts` | a plain `node` process; every capability answers `false` |

The rule that makes the adapter set honest: **the core degrades instead of
assuming**. A capability the host does not have is answered `false` and the
feature is absent, not attempted and crashed. That is why the headless adapter
can run every test the desktop adapter runs, minus the parts that need a
window.

A parity suite runs one call sequence against the three port shapes (the
headless implementation and the two shell doubles) and asserts that data shapes
and failure codes agree, while asserting the legitimate differences instead of
normalising them away. The semantic table asserts that each documented failure
mode is reachable and returns the frozen code. A new requirement that only the
Electron adapter can satisfy is not a port requirement; it belongs to that
shell.

## 5. Seam 3 — the render bridge

Renderer and core exchange **frames**: flat, self-describing JSON envelopes,
never classes and never binary side channels.

```ts
interface Frame<T extends string = string, B = unknown> {
  v: 1;                       // wire version
  ch: "control" | "stream" | "bulk";
  seq: number;                // global monotonic counter, assigned by one sequencer
  t: T;                       // frame type; the table is append-only
  body: B;                    // decoded per type, `unknown` until narrowed
}
```

Three details are load-bearing:

- **The channel is in the envelope, not the body.** A router decides where a
  frame goes without decoding it. `control` carries ordered request/response
  traffic and a `reqId`; `stream` carries byte progress where dropping a frame
  is a correctness bug; `bulk` carries paged snapshot content and travels with
  a watermark plus a token so a read can resume.
- **The type table is append-only and open.** A host may inject a frame type
  this package does not know; an unknown `t` is carried, not refused. Adding a
  type is a table row, not a version bump. A meaning change is a version bump.
- **Nothing in `protocol` validates.** Parsing and rejection belong to `core`,
  where the single sequencer, the queue and the handshake live. The renderer
  type-imports the envelope; it does not get to decide what is valid.

The desktop shell carries frames on IPC channels selected by `ch`; the editor
shell carries them on the webview's `postMessage` vocabulary. The transport
differs, the frames do not. Terminal bytes are the one stream that also has a
transport-level acknowledgement path (a byte-count ack), because ignoring a
rendered chunk is how a terminal stalls.

## 6. Frames and state machines

### 6.1 The engine lifecycle

```
idle → spawning → handshaking → ready ─┬→ closing → closed
                                        └→ failed
```

`failed` is terminal for that engine lifetime. `ready` is the gate for control
traffic: a command with no live connection is answered `NOT_CONNECTED` rather
than held forever. `reconnecting` is deliberately **not** a state of this
machine: a process that is alive but whose connection was lost is a different
problem, owned by its own machine below.

### 6.2 The reconnect machine

```
ready → reconnecting → replaying → ready
   ↑          │
   └──────────┴→ degraded          (bounded window, then stop promising)
```

One machine per agent, and the only place that answers two questions: when to
stop retrying, and whether a command may be sent right now. A second derivation
of either answer elsewhere is a second answer. The window is measured from the
moment the connection was lost, and a degraded connection can still be read
while sends are refused.

### 6.3 Approvals

One row per request id, three states: `pending`, `decided`, `expired`. The id
is the only key, because the same request genuinely arrives more than once (the
live request, the device snapshot, and a replay after a resync). A decision is
final: a replayed id never turns a resolved row back into a waiting one. Only
`pending` rows count toward a badge; resolved rows are kept, bounded, and
evicted after waiting ones.

### 6.4 Session folding

The renderer never computes domain state. One store folds engine events into
nine immutable entity maps, keyed by id, and renderers read through selectors.
Folding is idempotent per event sequence number and drops stale frames by
sequence, which is what makes a replay safe. A computation that a view "just
does" is usually a selector that has not been written yet.

### 6.5 Layout

The layout document is versioned and transport-neutral. A page id the current
build does not know is preserved as a placeholder rather than dropped, so an
older or newer document survives a round trip. A document that cannot be
validated falls back to the first-run default rather than presenting a broken
frame. What the frame registers and what the default document names are
deliberately allowed to differ: the samples exist to prove the registry, not to
be the product.

## 7. Where the promises are enforced

Each invariant above has a cheap check, and the checks are the actual contract:

- package boundaries and import directions — `scripts/check-boundaries.mjs`,
  plus module ownership and cycle checks in the full run;
- frame type literals against the append-only table — `scripts/check-frame.mjs`;
- no capability id in a shell — `scripts/check-capabilities.mjs`;
- contract artifacts against their generators — `scripts/check-contract.mjs`;
- the public documents and the generated command tables —
  `scripts/docs/check-public-docs.mjs`.

`pnpm verify` runs the code and contract gates and prints one conclusion per
segment. The public-docs check is designed to run as its `docs` segment; on a
branch where that segment is not wired yet, run
`node scripts/docs/check-public-docs.mjs` directly. `CONTRIBUTING.md` says how
to run the gate set and what a contributor owes it.

## 8. What this document does not claim

This is a description of the structure that exists, not a promise that every
surface is finished. The three-state status list in the READMEs is the
authoritative answer to "can a user reach this"; the page samples, the missing
settings page and the un-wired top-bar update entry are known and recorded
there. When the code and this document disagree, the code wins and this
document is the defect.
