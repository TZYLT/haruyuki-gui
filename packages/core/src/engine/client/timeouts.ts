/**
 * Timeout families: how long one command may spend in flight before the channel
 * is entitled to call it a TIMEOUT.
 *
 * This file documents the four families and their default ceilings, how a ceiling
 * is re-measured, and the `timeoutMs` override with its 10x cap. The rule it
 * implements: **one exhaustive `Record<CapabilityName, TimeoutFamily>` aligned
 * with all 68 capability rows**, because a family table spread across `if`/`else`
 * branches always ends up missing a capability, and a missing capability is not
 * a compile error there.
 * Here it is: {@link CAPABILITY_TIMEOUT_FAMILY} is written with `satisfies`, so
 * dropping a row or inventing one is a type error at that exact line.
 *
 * ## What a family is, and what it is not
 *
 * A family groups capabilities by **how fast the engine answers them**, not by
 * the frame's shape and not by its scope. `shape` only says whether a reply
 * exists at all: `message.send`, `device.setState` and `file.watch` are all
 * `one-way`, yet one is answered in 1 ms, one is a device mutation and one never
 * answers; `file.ops` is the single `bidirectional` wire and waits for nothing.
 * `compaction.prepare` is an ordinary `request-response` and is the slowest
 * command in the whole corpus. So neither field is evidence for a ceiling, and
 * this table is not derived from them.
 *
 * The rule actually applied, in one sentence: **a capability is `fast` when the
 * engine can answer it out of its own process, its filesystem or a local store
 * (or does not answer at all); it is at least `normal` when the answer depends on
 * starting, resuming, recompiling or switching a runtime, or on writing a
 * resource that a runtime then depends on; it is `slow` when it makes the engine
 * run a whole model session on the caller's behalf.** The per-domain comments in
 * the table record the specific reasoning for each group, and the tie-break rule
 * below resolves the rows the corpus has no sample for.
 *
 * ## The measurements the ceilings come from
 *
 * Paired c2s -> s2c round trips in `fixtures/engine/recordings/` (23 pairs, 7
 * scenarios; `s2c.at - c2s.at`):
 *
 * - handshake: p50 **24 ms**, max **30 ms** (n = 7). 10 s leaves ~300x.
 * - fast: p50 **1 ms** (`message.send`), max **1574 ms** (`memory.writeFile`).
 *   The 10 s ceiling is ~6x the worst local-I/O answer observed.
 * - normal: p50 **2395 ms**, max **2524 ms** (n = 6, all
 *   `conversation.switch`). 30 s is ~12x that p50.
 * - slow: max **6489 ms** (`compaction.prepare`, n = 1) and **1364 ms**
 *   (`subagent.launch`, n = 1). **That is a lower bound only: the upper bound has
 *   no sample at all** - the full duration of `dream` and `reflect` was never
 *   recorded, because they are not separate capabilities (see below) and the
 *   recordings never dispatch them.
 *
 * ## `slow` = 180 s is a judgement, not a measurement
 *
 * **Do not read 180 s as a measured value.** It is the number that follows from
 * "we must be able to wait 27x the largest slow-family trip ever recorded"
 * (6489 ms x 27.7). It is a judgement, not a derived value: the first
 * implementation that talks to a real engine re-measures, and raises the ceiling
 * to `max x 3` when the measured max exceeds half of it. Nothing measured
 * supports 180 s; nothing measured contradicts it either.
 *
 * ## Why `dream` and `reflect` are not rows here
 *
 * `dream` and `reflect` belong to the slow family. **Neither is a
 * capability of the 68-row contract.** They are remote *slash command ids*
 * (`snapshot.json` -> `special.remoteCommands.advertised`), dispatched through
 * the single capability this package names `slash.exec` (its wire id is not
 * written down here - see the wire-vocabulary note below). A slash command like
 * `/dream`, `/reflect` or `/compact` is a whole model session run inside one
 * request, so the slow family contains `slash.exec` - the row where those two
 * names actually live. Anyone who later adds a real `dream` capability will get
 * a compile error here, which is the intended outcome.
 *
 * ## Wire vocabulary
 *
 * This file names capabilities only (`"conversation.switch"`). The engine's wire
 * ids never appear under `client/`: resolving a name to a wire id belongs to
 * `./capability-names`, and this module needs no wire id at all.
 */

import type { CapabilityName } from "@haruyuki/protocol";

import { CAPABILITY_NAMES } from "./capability-names";

/**
 * The four families, as a walkable tuple.
 *
 * A tuple rather than a bare union so a consumer can iterate every family (a
 * settings screen, a table, a test that must cover all four) and so that adding a
 * family without handling it everywhere is a compile error in the places that
 * build an exhaustive `Record` from it - the same technique as
 * `ENGINE_CLIENT_ERROR_CODES` in `./errors`.
 *
 * The tuple runs cheapest family first. Nothing in this module depends on the
 * order.
 */
export const TIMEOUT_FAMILIES = ["handshake", "fast", "normal", "slow"] as const;

/** The closed set of timeout families (see {@link TIMEOUT_FAMILIES}). */
export type TimeoutFamily = (typeof TIMEOUT_FAMILIES)[number];

/**
 * Default ceiling per family, in milliseconds.
 *
 * These are **upper bounds, not expected waits**: a command that answers in 1 ms
 * still costs nothing under a 10 s ceiling, while a ceiling that is too tight
 * manufactures a false TIMEOUT on a command that was working. That asymmetry is
 * why every number below is the generous one, and why the tie-break rule in
 * {@link CAPABILITY_TIMEOUT_FAMILY} sends an unmeasured row to the more generous
 * family.
 *
 * - `handshake` 10 s - only the post-auth handshake. Measured max 30 ms; 10 s is
 *   the same order as the engine host's own port timeout, so a handshake that
 *   cannot finish in 10 s is a broken engine, not a slow one.
 * - `fast` 10 s - local answers. Measured max 1574 ms.
 * - `normal` 30 s - everything that starts or touches a runtime. Measured p50
 *   2395 ms; 30 s is ~12x.
 * - `slow` 180 s - maintenance that runs a model session. Measured lower bound
 *   6489 ms; **the 180 s itself is a judgement, not a measurement** (see the
 *   header).
 *
 * `satisfies` keeps each value a literal type, so {@link resolveTimeout} works in
 * real arithmetic while a missing family is still a compile error.
 */
export const FAMILY_TIMEOUT_MS = {
  handshake: 10_000,
  fast: 10_000,
  normal: 30_000,
  slow: 180_000,
} as const satisfies Record<TimeoutFamily, number>;

/**
 * How far a caller's `timeoutMs` may exceed its family ceiling: 10x.
 *
 * The cap exists so a defensive `timeoutMs` cannot pin an in-flight table entry
 * for an hour. 10x is generous on purpose - the point is to stop a typo
 * (`3_600_000`) from becoming a leak, not to second-guess a caller who
 * legitimately needs a longer wait than the family default (a bulk operation, a
 * slow disk).
 */
export const TIMEOUT_CAP_MULTIPLIER = 10;

/**
 * The capability -> family table. **Every one of the 68 capabilities, or this
 * file does not compile.**
 *
 * `satisfies Record<CapabilityName, TimeoutFamily>` is the whole point of the
 * file: the annotation form would let a missing row slide, and an `if`/`else`
 * chain would miss one silently. A new capability in the contract arrives here
 * as a type error, not as a command that silently waits the wrong amount.
 *
 * Rows are grouped by domain, in the lexicographic order of the generated union,
 * and every group carries the reason for its classification. The tie-break rule
 * used where the corpus has no sample: **go to the more generous family**. A
 * ceiling that is too generous costs a slower TIMEOUT; one that is too tight
 * costs a false TIMEOUT on a command that was working, which is the expensive
 * direction.
 *
 * Two facts worth keeping in mind while reading it:
 *
 * - Several `fast` rows never wait at all (`message.send` and the four
 *   `terminal.*` commands are one-way with no correlated answer). Their family is
 *   still assigned by the same rule rather than left out, because the table must
 *   be total and because a `fast` ceiling is the honest fallback if the send path
 *   ever does start tracking them.
 * - `compaction.cancel` is a cheap lookup in the engine, yet it is filed under
 *   `slow` with the rest of its domain: the domain is what the ceiling covers,
 *   and an over-generous ceiling here costs nothing measurable.
 */
export const CAPABILITY_TIMEOUT_FAMILY = {
  /* Agents ------------------------------------------------------------------
   * Resource CRUD against the engine's own registry. Reads by id or list are
   * local and cheap, so they are `fast`. The writes are `normal`: they persist a
   * resource the rest of the process depends on, and none of them has a sample,
   * so the tie-break rule applies. The two secret rows are here for the same
   * reason rather than because they are writes - `agent.secretList` only reads,
   * but it refreshes the secrets cache on the way, and neither row is measured.
   */
  "agent.create": "normal",
  "agent.createPreset": "normal",
  "agent.delete": "normal",
  "agent.get": "fast",
  "agent.list": "fast",
  "agent.secretApply": "normal",
  "agent.secretList": "normal",
  "agent.update": "normal",

  /* Compaction --------------------------------------------------------------
   * The slow family's measured core. `compaction.prepare` produced the corpus
   * maximum (6489 ms) because it builds a topic report over the conversation;
   * `compaction.commit` lands that same report and is assumed to cost the same
   * order - it has no sample, so it inherits the domain's ceiling rather than a
   * `normal` one. `compaction.cancel` is cheap in the engine but is kept with its
   * domain (see the note on the table).
   */
  "compaction.cancel": "slow",
  "compaction.commit": "slow",
  "compaction.prepare": "slow",

  /* Conversations -----------------------------------------------------------
   * `conversation.get` / `conversation.list` read rows before or without a
   * runtime, so they are `fast`. The rest either create, copy, delete or
   * recompile a conversation's state. `conversation.switch` is the runtime start
   * itself and is the row the 2395 ms p50 comes from; `conversation.sync` replays
   * runtime state, which is the same lifecycle cost spread over frames.
   */
  "conversation.create": "normal",
  "conversation.delete": "normal",
  "conversation.fork": "normal",
  "conversation.get": "fast",
  "conversation.list": "fast",
  "conversation.recompile": "normal",
  "conversation.switch": "normal",
  "conversation.sync": "normal",
  "conversation.update": "normal",

  /* Device ------------------------------------------------------------------
   * `device.info` is the handshake: the one command with a family of its own,
   * measured at 30 ms max. `device.setState` mutates the current device status
   * and answers immediately (it is one-way, so it is not even waited on).
   */
  "device.info": "handshake",
  "device.setState": "fast",

  /* Files -------------------------------------------------------------------
   * Local filesystem work, read or write, all `fast`: the observed maximum for a
   * local edit is 1574 ms, so 10 s is ~6x the worst local write in the corpus.
   * `file.watch` / `file.unwatch` are fire-and-forget - they declare a request id
   * and never answer - so their family is a fallback, not a wait.
   * `file.ops` is the one duplex wire and waits for nothing either.
   */
  "file.edit": "fast",
  "file.ops": "fast",
  "file.read": "fast",
  "file.unwatch": "fast",
  "file.watch": "fast",
  "file.write": "fast",

  /* Git ---------------------------------------------------------------------
   * `git.searchBranches` filters an in-memory branch list - `fast`. A checkout
   * mutates the working tree and can take tens of seconds on a large repository,
   * and it has no sample; the tie-break rule sends it to `normal`.
   */
  "git.checkoutBranch": "normal",
  "git.searchBranches": "fast",

  /* Memory ------------------------------------------------------------------
   * The agent memory worktree: local reads, one measured at 34 ms, a history
   * walk at 653 ms and a commit-bearing write at 1574 ms. All `fast` except
   * `memory.enable`, which creates and seeds the store on first use (git init
   * plus an initial commit) and has no sample.
   */
  "memory.commitDiff": "fast",
  "memory.deleteFile": "fast",
  "memory.enable": "normal",
  "memory.fileAtRef": "fast",
  "memory.history": "fast",
  "memory.list": "fast",
  "memory.readFile": "fast",
  "memory.writeFile": "fast",

  /* Messages ----------------------------------------------------------------
   * `message.send` is the 1 ms row: the engine acknowledges the write and the
   * turn itself is observed through stream frames, so the ceiling covers an
   * acknowledgement, not a generation. `message.abort` interrupts and
   * `message.list` pages rows from the local store.
   */
  "message.abort": "fast",
  "message.list": "fast",
  "message.send": "fast",

  /* Model -------------------------------------------------------------------
   * Both rows touch the provider layer: `model.list` reads the catalog (and can
   * bypass the local listener cache) and `model.update` switches the model on a
   * conversation runtime. `normal`.
   */
  "model.list": "normal",
  "model.update": "normal",

  /* Providers ---------------------------------------------------------------
   * All three edit or read the **local** provider store; `provider.connect` only
   * *returns* the refreshed list, it does not validate against the provider. So
   * none of them leaves the machine, and none has a sample. `provider.connect`
   * writes the store (and can add an alias), which is why it takes `normal` while
   * the other two - one read, one removal - stay `fast`.
   */
  "provider.connect": "normal",
  "provider.disconnect": "fast",
  "provider.listConnected": "fast",

  /* Queue -------------------------------------------------------------------
   * `queue.remove` drops one parked item. `queue.resume` releases the parked
   * items, which lets turns start again, and `queue.stopMonitor` kills a running
   * background process - both belong to the runtime lifecycle, so `normal`.
   */
  "queue.remove": "fast",
  "queue.resume": "normal",
  "queue.stopMonitor": "normal",

  /* Settings ----------------------------------------------------------------
   * Four flag reads and writes against local state. None of them starts work, so
   * none needs more than `fast`.
   */
  "settings.getExperiments": "fast",
  "settings.getReflection": "fast",
  "settings.setExperiment": "fast",
  "settings.setReflection": "fast",

  /* Slash commands ----------------------------------------------------------
   * The row that carries `dream` and `reflect` (see the header): a
   * slash command is a model session executed inside the engine, so its duration
   * is unbounded by anything this build can predict.
   */
  "slash.exec": "slow",

  /* Subagents ---------------------------------------------------------------
   * Starting a child agent. Measured at 1364 ms, and the child then runs on its
   * own - the slow family is the honest home for a command whose work is
   * starting another agent.
   */
  "subagent.launch": "slow",

  /* Terminals ---------------------------------------------------------------
   * Four PTY commands, all one-way: they are waited on by nobody, and their
   * effects arrive as `terminal_*` frames. `fast` is the fallback ceiling.
   */
  "terminal.input": "fast",
  "terminal.kill": "fast",
  "terminal.resize": "fast",
  "terminal.spawn": "fast",

  /* Toolsets ----------------------------------------------------------------
   * Setting the toolset preference on a conversation runtime: it may recompile
   * the runtime's tool surface, so `normal`.
   */
  "toolset.update": "normal",

  /* Usage -------------------------------------------------------------------
   * `usage.aggregate` reads ledger totals and per-run buckets over an open range
   * (agent, run, session, or all of it) - a scan whose cost the caller controls
   * through the range, so `normal`. `usage.chatgpt` reads plan usage from the
   * local or api store; the contract calls it "a usage read, not a provider
   * write", and neither row has a sample, so the tie-break rule keeps both at
   * `normal`.
   */
  "usage.aggregate": "normal",
  "usage.chatgpt": "normal",

  /* Workspace ---------------------------------------------------------------
   * Six local filesystem queries: directory listing, path search, content grep,
   * the persisted cwd map and a depth-bounded subtree. All `fast` - this is the
   * "read-only file" class. `workspace.grep` is the row to watch when the
   * ceilings are re-measured: it walks a tree, so a very large repository is the
   * one case where 10 s could be tight.
   */
  "workspace.cwdMap": "fast",
  "workspace.grep": "fast",
  "workspace.list": "fast",
  "workspace.search": "fast",
  "workspace.setBootCwd": "fast",
  "workspace.tree": "fast",
} as const satisfies Record<CapabilityName, TimeoutFamily>;

/**
 * The members of one family, in capability-name order.
 *
 * Built from {@link CAPABILITY_NAMES} rather than from this table's keys, so the
 * list can only ever contain real capability names, and built once so callers
 * cannot cause a rebuild per render.
 *
 * @param family the family to collect
 * @returns the frozen name list for that family
 */
function collectFamily(family: TimeoutFamily): readonly CapabilityName[] {
  const members = CAPABILITY_NAMES.filter((name) => CAPABILITY_TIMEOUT_FAMILY[name] === family);
  return Object.freeze(members);
}

/**
 * Family -> its capability names.
 *
 * Frozen at every level: one entry per family, one frozen array per entry. A
 * caller that got a mutable array could hide a capability from the counts, and
 * the counts are the thing the coverage test pins.
 */
const FAMILY_MEMBERS: Readonly<Record<TimeoutFamily, readonly CapabilityName[]>> = Object.freeze({
  handshake: collectFamily("handshake"),
  fast: collectFamily("fast"),
  normal: collectFamily("normal"),
  slow: collectFamily("slow"),
});

/**
 * One row of the grouped view: a family, its ceiling, its members and how many.
 *
 * `count` is **derived** from `capabilities.length`, never authored: a hand-typed
 * number is a second source of truth that drifts the first time a row moves
 * family. It exists because "how many capabilities are in each family" is a
 * question a settings screen and the coverage test both ask directly.
 */
export interface TimeoutFamilySummary {
  /** The family. */
  readonly family: TimeoutFamily;
  /** Its default ceiling in milliseconds, from {@link FAMILY_TIMEOUT_MS}. */
  readonly timeoutMs: number;
  /** Its members, in capability-name order. */
  readonly capabilities: readonly CapabilityName[];
  /** `capabilities.length`, derived. */
  readonly count: number;
}

/**
 * The four families with their ceilings, members and counts, in
 * {@link TIMEOUT_FAMILIES} order.
 *
 * This is the grouped answer the table exists to provide: iterating it answers "how
 * many capabilities per family", "what is each ceiling" and "does it cover 68" in
 * one pass, without a second table to keep in sync.
 */
export const TIMEOUT_FAMILY_SUMMARIES: readonly TimeoutFamilySummary[] = Object.freeze(
  TIMEOUT_FAMILIES.map((family) => {
    const capabilities = FAMILY_MEMBERS[family];
    return Object.freeze({
      family,
      timeoutMs: FAMILY_TIMEOUT_MS[family],
      capabilities,
      count: capabilities.length,
    });
  }),
);

/**
 * The family a capability belongs to.
 *
 * Total by construction: the table is a `Record<CapabilityName, TimeoutFamily>`,
 * so this cannot miss. It exists as a function because business code holds a
 * capability value it did not write literally (it came out of a request or a
 * config file), and a bare index expression at each call site would need its own
 * non-null assertion under `noUncheckedIndexedAccess`.
 *
 * @param name the capability name
 * @returns its timeout family
 */
export function timeoutFamilyOf(name: CapabilityName): TimeoutFamily {
  return CAPABILITY_TIMEOUT_FAMILY[name];
}

/**
 * The default ceiling for one capability, in milliseconds.
 *
 * @param name the capability name
 * @returns the family ceiling from {@link FAMILY_TIMEOUT_MS}
 */
export function defaultTimeoutMs(name: CapabilityName): number {
  return FAMILY_TIMEOUT_MS[CAPABILITY_TIMEOUT_FAMILY[name]];
}

/**
 * The largest value a caller's `timeoutMs` can be honoured at for one capability:
 * the family ceiling times {@link TIMEOUT_CAP_MULTIPLIER}.
 *
 * Exported so a caller can clamp its own value, or explain the cap, without
 * re-deriving the multiplication.
 *
 * @param name the capability name
 * @returns the effective upper bound for an override, in milliseconds
 */
export function maxTimeoutMs(name: CapabilityName): number {
  return defaultTimeoutMs(name) * TIMEOUT_CAP_MULTIPLIER;
}

/**
 * A timeout resolved for one request.
 *
 * `clamped` is the fact the caller needs and cannot compute itself: `ms` is
 * already the value to hand to the timer, and `clamped` says whether it is the
 * caller's number or the cap. A caller that logs a diagnostic when `clamped` is
 * `true` is explaining a real decision instead of guessing from a comparison.
 */
export interface ResolvedTimeout {
  /** The budget to use, in milliseconds. Always positive and finite. */
  readonly ms: number;
  /**
   * `true` when the caller's `timeoutMs` exceeded {@link maxTimeoutMs} and was
   * cut down to it. `false` covers both "the caller's value was used" and "no
   * usable value was given, so the family default applies" - neither is a clamp.
   */
  readonly clamped: boolean;
}

/**
 * The budget for one request: the caller's `timeoutMs` if given and usable, else
 * the family default - and never more than the family ceiling times
 * {@link TIMEOUT_CAP_MULTIPLIER}.
 *
 * Three behaviours, each deliberate:
 *
 * 1. **No value -> the family default.** `undefined` means "unspecified".
 * 2. **A usable value -> used as given, above or below the default.** A caller
 *    may legitimately shorten a wait (a picker that wants 2 s) or lengthen it
 *    within the cap; second-guessing either would make the override useless.
 * 3. **Over the cap -> cut to the cap, `clamped: true`, no error.** The rule is
 *    explicit: the caller passed a defensive parameter and must not see a
 *    failure because of it. A rejection here would turn "your value was too large"
 *    into a lost command.
 *
 * A value that is not a positive finite number (`0`, `-1`, `NaN`, `Infinity`) is
 * treated as unspecified rather than clamped: it names no budget at all, so there
 * is nothing to cut, and the family default is the only safe reading. `clamped`
 * stays `false` so the flag keeps meaning exactly one thing.
 *
 * @param name the capability being sent
 * @param requestedMs the caller's `CommandRequest.timeoutMs`, if any
 * @returns the budget to use and whether the 10x cap applied
 */
export function resolveTimeout(name: CapabilityName, requestedMs?: number): ResolvedTimeout {
  const ceiling = FAMILY_TIMEOUT_MS[CAPABILITY_TIMEOUT_FAMILY[name]];

  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return { ms: ceiling, clamped: false };
  }

  const cap = ceiling * TIMEOUT_CAP_MULTIPLIER;
  if (requestedMs > cap) {
    return { ms: cap, clamped: true };
  }

  return { ms: requestedMs, clamped: false };
}

/**
 * The capability names in one family.
 *
 * @param family the family to list
 * @returns the frozen member list, in capability-name order
 */
export function capabilitiesInFamily(family: TimeoutFamily): readonly CapabilityName[] {
  return FAMILY_MEMBERS[family];
}

/**
 * How many capabilities one family holds.
 *
 * @param family the family to count
 * @returns its member count
 */
export function familyCapabilityCount(family: TimeoutFamily): number {
  return FAMILY_MEMBERS[family].length;
}

/**
 * How many capabilities exist in total: the sum over the four families.
 *
 * Derived, and equal to 68 while the contract holds. Exported because "are all 68
 * assigned?" is a question a reviewer asks, and the honest answer is a number
 * computed from the table rather than a literal someone typed.
 *
 * @returns the total number of capabilities with a family
 */
export function totalFamilyCapabilityCount(): number {
  return TIMEOUT_FAMILIES.reduce((sum, family) => sum + FAMILY_MEMBERS[family].length, 0);
}
