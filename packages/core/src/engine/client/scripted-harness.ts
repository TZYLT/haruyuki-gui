/**
 * Scripted fixtures for the edge-case suite (`scripted.test.ts`).
 *
 * Split out of the suite for the repository's file-size limit and to keep one
 * owner per concern: this file is scaffolding, so it belongs to no `describe`
 * block. It does not end in `.test.ts` on purpose - vitest collects by that
 * suffix, so nothing here is ever treated as a test file, and a helper that
 * stops being used cannot silently pass as an empty suite. Same arrangement as
 * `channel-test-support.ts`, whose doubles this file composes rather than
 * copies.
 *
 * ## What these fixtures are for
 *
 * `replay.test.ts` proves the *normal* path: the recorded corpus, in
 * corpus order, arrives intact. This suite proves the *abnormal* paths - the
 * ones a live engine produces but a recording does not contain: frames out of
 * order, the same frame twice, bytes that are not JSON, a type this build does
 * not model, frames before the channel is ready, and a connection that dies
 * mid-stream. Each of those is a scripted sequence, not a replay: the point is
 * to state the sequence exactly.
 *
 * ## Why there is no wire id anywhere in here
 *
 * Wire id literals are forbidden under `client/`, tests included. Three sources
 * are used instead, and each answers a different question:
 *
 * - **Test-owned marker types** ({@link MODELLED}) - `test.delta`, `test.status`
 *   and the answer type the shared reader already routes on. Those are what the
 *   "build models this type" set is made of, so a frame of one of them is a
 *   *known* type and must never be reported.
 * - **The contract's own push types, read at run time** ({@link UNMODELLED_TYPES})
 *   - real engine vocabulary, obtained from `snapshot.json` instead of typed
 *   here. That is what makes the unknown-type cases speak the same names a real
 *   engine would while keeping this directory literal-free.
 * - **A fictional type** ({@link FICTIONAL_TYPE}) that no engine version has
 *   ever sent, for the forward-compatibility case: a newer engine behind an
 *   older host is a normal upgrade order, and the same handling must cover it.
 *
 * ## The one thing this file must not become
 *
 * A second inbound buffer. Frame-before-subscriber is a window `transport.ts` already
 * owns with a single handover queue inside the transport (`B2-D04`, `log-retention-configured`);
 * a queue added here would deliver the same early frame twice once both
 * drained. So {@link wireInbound} installs exactly the two subscriptions the
 * wiring is required to install - `onFrame` to `ingest`, `onClose` to `close` -
 * and nothing else. That wiring is stated here rather than imported because
 * `client/index.ts`  does not exist yet; the drop case tests the contract
 * the wiring has to meet.
 */

import { readFileSync } from "node:fs";

import { createChannel } from "./channel";
import type { EngineChannel, EngineFrameReader } from "./channel";
import {
  assertNoLeakedTimers,
  makeClock,
  makeProbe,
  makeReader,
  makeWriter,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import type { FakeClock, RecordingWriter } from "./channel-test-support";
import type { EngineTransport } from "./transport";
import type { DiagnosticKind, DiagnosticRecord, EngineEventFrame } from "./types";
import type { EngineSocket, EngineSocketEventMap } from "../connection";

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The types this build is told it models.
 *
 * Named as an object rather than three loose strings so a case that needs one
 * type of the set (the flood, the ready-window status frame) can say which it
 * means. `answer` is the type the shared reader already uses for a correlated
 * frame (`channel-test-support.ts`), and it is modelled on purpose: a duplicate
 * answer that falls through to the event path must not also be
 * reported as an unknown type.
 */
export const MODELLED = {
  delta: "test.delta",
  status: "test.status",
  answer: "known.event",
} as const;

/** The set handed to the channel as `knownEventTypes` in every case here. */
export const MODELLED_TYPES: ReadonlySet<string> = new Set<string>(Object.values(MODELLED));

/**
 * The number of frames used for the flood case.
 *
 * 155 is the documented count of the single highest-volume s2c type in the
 * seven-file recording corpus: one type accounts for more
 * than half of the 295 recorded frames. It is the reason per-type aggregation
 * exists, so the case uses that volume rather than a token handful.
 */
export const FLOOD_FRAMES = 155;

/**
 * A type no engine version has ever sent.
 *
 * Used for "a newer engine behind an older host": the handling must be the same
 * as for a real-but-unmodelled type, because we cannot tell the two apart and
 * must not pretend to.
 */
export const FICTIONAL_TYPE = "future.engine.never.sent";

/* ------------------------------------------------------------------------- */
/* Frames                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Build one inbound frame as it would come off the wire.
 *
 * `fields` is spread as-is, so a case can put the real envelope field on the
 * frame (`event_seq`) and read it back through the channel's passthrough - which
 * is the asserted behaviour in the ordering and duplicate cases - while carrying
 * a test-owned `marker` it can compare order on without relying on content
 * equality.
 *
 * @param type the event type
 * @param fields everything else the frame carries
 * @returns the frame text
 */
export function pushFrame(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

/**
 * Build `count` frames of one type.
 *
 * @param type the event type to flood with
 * @param count how many frames
 * @returns the frame texts, in emission order
 */
export function floodFrames(type: string, count: number): string[] {
  const frames: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    frames.push(pushFrame(type, { marker: `flood-${String(index)}` }));
  }
  return frames;
}

/** The marker each delivered frame carried, in delivery order. */
export function markersOf(events: readonly EngineEventFrame[]): unknown[] {
  return events.map((frame) => (frame.raw as { marker?: unknown }).marker);
}

/** The `event_seq` each delivered frame carried, read from the passthrough. */
export function seqsOf(events: readonly EngineEventFrame[]): (number | undefined)[] {
  return events.map((frame) => frame.envelope?.event_seq);
}

/** The kind of each diagnostic record, in the order it was reported. */
export function kindsOf(records: readonly DiagnosticRecord[]): DiagnosticKind[] {
  return records.map((record) => record.kind);
}

/* ------------------------------------------------------------------------- */
/* Unmodelled vocabulary, from the contract                                  */
/* ------------------------------------------------------------------------- */

/** The one field this file reads off the extracted contract artifact. */
type ContractSnapshot = { readonly messages: readonly { readonly wire: string }[] };

/** Repo-relative location of the wire evidence, from `client/`. */
const SNAPSHOT_URL = new URL("../../../../protocol/src/contract/snapshot.json", import.meta.url);

/**
 * Pick two server-push types the build does not model.
 *
 * A push type is a message wire that is not an answer: the extracted artifact
 * names 136 inbound messages, of which 114 pair with a command and 21 arrive
 * unprompted. The `_response` suffix identifies the 114
 * without naming any of them. One acknowledgement is not spelled that way and
 * therefore stays in the push set, which is harmless here - this file only needs
 * *some* real type the build does not model, and being handed it as an event is
 * the case under test.
 *
 * Sorted, so the choice is stable across runs and platforms: a case that asserts
 * "two buckets, in first-appearance order" must not depend on file order.
 *
 * @returns two distinct unmodelled wire names
 * @throws when the artifact yields fewer than two, which would mean the
 *   extraction changed shape - a fact this suite must not paper over
 */
function deriveUnmodelledTypes(): readonly [string, string] {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, "utf8")) as ContractSnapshot;

  const push = snapshot.messages
    .map((message) => message.wire)
    .filter((wire) => !wire.endsWith("_response") && !MODELLED_TYPES.has(wire))
    .sort();

  const [first, second] = push;

  if (first === undefined || second === undefined) {
    throw new Error(
      "snapshot.json yielded fewer than two unmodelled push types; the unknown-type cases " +
        "need real vocabulary to test against, so this is a scaffold failure rather than a pass",
    );
  }

  return [first, second];
}

/**
 * Two real engine types this build does not model (see {@link deriveUnmodelledTypes}).
 *
 * Derived rather than written down: a literal here would be a wire id under
 * `client/`, which is exactly what this derivation avoids.
 */
export const UNMODELLED_TYPES: readonly [string, string] = deriveUnmodelledTypes();

/* ------------------------------------------------------------------------- */
/* The channel under test                                                    */
/* ------------------------------------------------------------------------- */

/** What a case can observe on one scripted channel. */
export interface ScriptedHarness {
  readonly channel: EngineChannel;
  readonly clock: FakeClock;
  readonly writer: RecordingWriter;
  readonly events: EngineEventFrame[];
  readonly records: DiagnosticRecord[];
  /**
   * Move the channel's readiness, latching `everReady`.
   *
   * Latching is what the production port does: a channel that was once usable
   * keeps the "was ready and dropped" wording forever after,
   * because that distinction is what tells B3 whether a replay is worth
   * attempting. A setter that forgot to latch would make every later drop read
   * as "never became ready".
   */
  setReady(ready: boolean): void;
}

/** What a case may override when it builds a scripted channel. */
export interface ScriptedOptions {
  /** Readiness at construction. Defaults to ready (most cases are not about it). */
  readonly ready?: boolean;
  /** The modelled-type set; defaults to {@link MODELLED_TYPES}. */
  readonly knownEventTypes?: ReadonlySet<string>;
  /**
   * Replace the frame reader.
   *
   * One case needs this: proving the channel rejects a not-a-frame *before* the
   * reader sees it. The shared double is total over `unknown` and would therefore
   * swallow a missing object guard; a reader that indexes its input is the
   * realistic shape, and it is what makes that guard load-bearing.
   */
  readonly reader?: EngineFrameReader;
}

/**
 * Build one channel with the shared doubles wired in.
 *
 * Composes `channel-test-support`'s reader, probe, clock and writer rather than
 * re-creating them: those doubles are keyed on test-owned marker fields, which
 * is exactly what keeps this directory free of engine field names, and a second
 * copy would drift from the one the kernel suite is calibrated against.
 *
 * The channel and its clock are registered for teardown here, so
 * {@link assertScriptedClean} can prove `close()` left no timer behind - the
 * failure mode that turns into a thirty-second timeout in an unrelated case.
 *
 * @param options per-case overrides
 * @returns the channel and its observable side effects
 */
export function makeScripted(options: ScriptedOptions = {}): ScriptedHarness {
  const clock = makeClock();
  const writer = makeWriter();
  const events: EngineEventFrame[] = [];
  const records: DiagnosticRecord[] = [];

  const readiness = { ready: options.ready ?? true, everReady: options.ready ?? true };

  const channel = createChannel({
    agentId: "scripted-agent",
    write: writer.write,
    reader: options.reader ?? makeReader(),
    probe: makeProbe(),
    clock: clock.clock,
    knownEventTypes: options.knownEventTypes ?? MODELLED_TYPES,
    readiness: () => ({ ready: readiness.ready, everReady: readiness.everReady }),
  });

  channel.onEvent((frame) => {
    events.push(frame);
  });
  channel.onDiagnostic((record) => {
    records.push(record);
  });

  trackChannel(channel);
  trackClock(clock);

  return {
    channel,
    clock,
    writer,
    events,
    records,
    setReady: (ready) => {
      readiness.ready = ready;
      if (ready) {
        readiness.everReady = true;
      }
    },
  };
}

/* ------------------------------------------------------------------------- */
/* A socket double, whose event stream a case scripts                        */
/* ------------------------------------------------------------------------- */

/** The listener shape the socket double stores; the real signature is generic. */
type RawListener = (...args: unknown[]) => void;

/** A socket whose inbound events a test fires by hand. */
export interface SocketDouble {
  /** The socket, structurally compatible with the adapter's own surface. */
  readonly socket: EngineSocket;
  /** Every text frame written through the socket, in write order. */
  readonly sent: string[];
  /** Deliver one text frame to the socket's listeners, as the engine would. */
  emitMessage(text: string): void;
  /** Fire the close event; firing it twice models a peer that repeats itself. */
  emitClose(reason?: string): void;
}

/**
 * Build an in-memory socket.
 *
 * Written out rather than mocked with `vi.fn` so the cases exercise the same
 * `on` / `once` / `removeListener` contract the real adapter relies on. The type
 * is imported from `../connection` - only the double is local, because
 * `transport.test.ts`'s double is private to a file this work package does not
 * own, and duplicating a *type* is what the no-second-copy rule forbids, not
 * duplicating a stub.
 *
 * @returns the socket and the two emitters a scripted case drives
 */
export function makeSocketDouble(): SocketDouble {
  const listeners = new Map<string, Set<RawListener>>();
  const sent: string[] = [];
  let closed = false;

  const add = (event: string, listener: RawListener): void => {
    const set = listeners.get(event) ?? new Set<RawListener>();
    set.add(listener);
    listeners.set(event, set);
  };

  const remove = (event: string, listener: RawListener): void => {
    listeners.get(event)?.delete(listener);
  };

  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(...args);
    }
  };

  const socket: EngineSocket = {
    readyState: 1,
    send(data: string): void {
      if (closed) {
        throw new Error("the scripted socket is closed");
      }
      sent.push(data);
    },
    close(): void {
      closed = true;
      fire("close", 1000, Buffer.from("", "utf8"));
    },
    terminate(): void {
      closed = true;
    },
    on<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      add(event, listener as unknown as RawListener);
      return socket;
    },
    once<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      const wrapper: RawListener = (...args: unknown[]): void => {
        remove(event, wrapper);
        (listener as unknown as RawListener)(...args);
      };
      add(event, wrapper);
      return socket;
    },
    removeListener<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      remove(event, listener as unknown as RawListener);
      return socket;
    },
  };

  return {
    socket,
    sent,
    emitMessage: (text) => {
      fire("message", Buffer.from(text, "utf8"), false);
    },
    emitClose: (reason = "") => {
      closed = true;
      fire("close", 1000, Buffer.from(reason, "utf8"));
    },
  };
}

/* ------------------------------------------------------------------------- */
/* The wiring production installs, and the teardown that proves nothing leaked */
/* ------------------------------------------------------------------------- */

/** What {@link wireInbound} installed, plus the close reasons it saw. */
export interface InboundWiring {
  /** Reasons the transport reported, in order; one per observed close. */
  readonly closes: string[];
  /** Remove the frame subscription. */
  readonly offFrame: () => void;
  /** Remove the close subscription. */
  readonly offClose: () => void;
}

/**
 * Wire one transport to one channel.
 *
 * Exactly the two subscriptions the production wiring owns:
 * every inbound frame is ingested, and a transport close closes the channel. The
 * second one is what makes a dropped connection visible at all - in-flight
 * requests are settled and later sends are refused - so a harness that skipped
 * it would leave the drop case unable to assert anything about the promise a
 * caller was waiting on.
 *
 * @param transport the transport to subscribe to
 * @param channel the channel to feed
 * @returns the installed wiring and the reported close reasons
 */
export function wireInbound(transport: EngineTransport, channel: EngineChannel): InboundWiring {
  const closes: string[] = [];

  const offFrame = transport.onFrame((frame) => {
    channel.ingest(frame.raw);
  });

  const offClose = transport.onClose((reason) => {
    closes.push(reason);
    channel.close();
  });

  return { closes, offFrame, offClose };
}

/** Transports built during the current test, so teardown can release them. */
const liveTransports: EngineTransport[] = [];

/**
 * Register a transport for teardown.
 *
 * A transport left open holds a socket and a close listener. That is a handle
 * vitest waits on, and it is invisible to every assertion in the case that
 * created it - so registration is explicit here and enforced by
 * {@link assertScriptedClean}.
 *
 * @param transport the transport to close at teardown
 * @returns the same transport, for use in one expression
 */
export function trackTransport<T extends EngineTransport>(transport: T): T {
  liveTransports.push(transport);
  return transport;
}

/**
 * Teardown for every case in this suite: release transports, close channels,
 * then demand no fake clock still holds a timer.
 *
 * Two jobs, in this order, because the guard in `assertNoLeakedTimers` is only
 * meaningful *after* the closes have run: it settles every in-flight entry and
 * cancels its timer, and a timer that survives that is the real defect (it holds
 * a promise that can never settle, and the next test pays for it by timing out).
 *
 * @throws when a channel left a timer scheduled after closing
 */
export function assertScriptedClean(): void {
  while (liveTransports.length > 0) {
    const transport = liveTransports.pop();
    try {
      transport?.close();
    } catch {
      // Teardown must not fail the case it is cleaning up after.
    }
  }

  assertNoLeakedTimers();
}
