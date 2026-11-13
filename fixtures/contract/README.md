# Contract gate fixtures (W-10)

Inputs for `scripts/contract-gate.test.ts`, which drives
`scripts/check-contract.mjs` as a child process. Nothing here is imported by
the gate itself; the fixture trees only exist so the gate can be exercised
red-to-green.

The whole directory is excluded from ESLint, Prettier and the file-size gate
(`fixtures/` is on every ignore list), so malformed or long-but-under-2000-line
data stays exactly as written.

## `expected-commands.txt`

The pinned V-1 human checklist: the 124 wire command ids of the committed
snapshot (`packages/protocol/src/contract/snapshot.json`), one per line,
lexicographic order, three `#` header lines. Regenerate only when the pinned
engine version changes; `scripts/contract-gate.test.ts` asserts the list still
equals the committed snapshot.

## `mini-engine/`

A miniature engine checkout that the committed extractors
(`extract-commands.mjs`, `extract-messages.mjs`, `extract-parity.mjs`) parse
without special casing:

| Path | Contents |
|---|---|
| `src/types/protocol_v2.ts` | `WsProtocolCommand` (3 members -> 4 wires via a union alias and a namespace member), `WsProtocolMessage` (2 members) |
| `src/types/agent-protocol.ts` | `AgentListCommand` / `AgentCancelCommand` + the `AgentLifecycleCommand` union alias |
| `src/types/queue-protocol.ts` | `QueueProtocol.ResumeQueueCommand` namespace member |
| `src/types/file-ops-protocol.ts` | shared `file_ops` interface, a member of both unions (one home, two directions) |
| `src/types/message-protocol.ts` | `StreamDeltaMessage` |
| `src/websocket/listener/protocol-inbound.ts` | `parseServerMessage` OR chain, 3 guards |
| `src/websocket/listener/listener-constants.ts` | 3 / 1 / 1 parity constants |
| `src/websocket/listener/commands.ts` | `handleExecuteCommand` `switch (command.command_id)`, 3 cases |
| `src/cli/subcommands/app-server.ts` | two required startup lines + one behind `if (openaiApi)` |
| `package.json` | `{"version": "0.0.1"}` |

`node scripts/contract/cli.mjs update --engine fixtures/contract/mini-engine
--out <tmp>` produces a clean snapshot: union 3, wires 4, messages 2, inbound 3,
inboundOnly 0, advertised 3, dispatch 3, `health.degraded = false`.

The commit field comes from `git rev-parse --short HEAD`, so a run inside this
checkout resolves it through the parent repository. The mutation self-tests copy
this tree to the OS temp directory, which is outside the checkout; they set
`GIT_DIR` to this checkout's git directory so the commit read-back still
succeeds instead of degrading the snapshot (a degraded snapshot makes
`contract:update` exit 2 and write nothing).

## `repos/`

Ten miniature repository trees, each with only
`packages/protocol/src/contract/{snapshot.json,capabilities.json,command-map.generated.ts}`.
`green` is a byte-for-byte copy of the three committed artifacts. Every other
tree changes exactly one thing, so the gate must report exactly one violation.

| Tree | One change | Expected rule | Exit |
|---|---|---|---|
| `green` | none (real data) | - | 0 |
| `red-map-missing` | capability declared, absent from the artifact | `contract-map` / `missing-capability` | 1 |
| `red-map-duplicate` | same capability name twice | `contract-map` / `duplicate-name` | 1 |
| `red-map-fallback` | `fallback` points at an undeclared name | `contract-map` / `dangling-fallback` | 1 |
| `red-map-wire` | `wire` is not a snapshot command | `contract-map` / `unknown-wire` | 1 |
| `red-map-since` | `since` newer than the pinned engine | `contract-map` / `since-ahead` | 1 |
| `red-map-pending` | `pending` without a proposal id | `contract-map` / `pending-without-proposal` | 1 |
| `red-stale` | one hand-edited artifact line (line 36) | `contract-stale` / `stale-artifact` | 1 |
| `red-cover` | field-level snapshot command with no `detail` capability | `contract-cover` / `fields-without-detail` | 1 |
| `red-degraded` | `health.degraded = true` | `contract-health` / `degraded-snapshot` | 1 |
| `red-missing-truth` | no `snapshot.json` | - | 2 |

The red trees use a minimal snapshot (engine version + command set + health);
`checkMap` consumes only those keys. The artifact in each red-map tree is
generated from a valid sibling table, so the expected rule is the only
violation and the stale check stays out of the way (generation errors skip it).
`green` carries the real snapshot's one `coarse` health entry on purpose: it
must stay a warning, never a failure.
