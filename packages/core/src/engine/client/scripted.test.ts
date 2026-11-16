/**
 * The edge cases: the six abnormal inbound sequences.
 *
 * `replay.test.ts` proves the *normal* path - the recorded corpus arrives
 * in corpus order, every frame intact. This suite proves the paths a recording
 * never contains but a live engine produces: frames out of order, the same frame
 * twice, bytes that are not JSON, a type this build does not model, frames that
 * arrive before the channel is ready, and a connection that dies mid-stream.
 *
 * ## What is being asserted, and on whose authority
 *
 * | case | assertion | authority |
 * |---|---|---|
 * | order | delivery order IS arrival order; `event_seq` is passed through untouched |
 * | duplicates | both copies are delivered, in arrival order; nothing is suppressed |
 * | malformed | no throw, no close, next frame flows, one `malformed` record |
 * | unknown type | no throw, frames still delivered, one `unknown-event` record **per type**, counted per frame |
 * | before ready | frames are **neither buffered nor dropped**: delivered on arrival |
 * | mid-stream drop | what arrived stays, one close notification, later sends `NOT_CONNECTED` |
 *
 * ## The two cases that read like a bug report, and are not
 *
 * **Order.** The server can send a turn's deltas as A, C, B. Re-sorting them by
 * `event_seq` would look helpful and would be a contract breach twice over: it
 * would interpret an envelope field that must be passed through verbatim, and
 * it would take ordering away from C1, the only layer that sees the full
 * sequence and can tell a duplicate from a repeat. So the test asserts the
 * delivered order equals the arrival order - which is *not* the sorted order -
 * and that the sequence numbers came through exactly as sent.
 *
 * **Duplication.** The dedupe table, 4096 entries, is **outbound**: it records ids we
 * sent so a caller bug cannot put one command on the wire twice. Inbound there
 * is no table, and adding one would eat a repetition that really happened - a
 * repeated `event_seq` is a fact about the engine's behaviour, and deciding what
 * it means is C1's job. So the test asserts both copies reach the subscriber,
 * and that the channel counts rather than remembers.
 *
 * ## No wire ids here
 *
 * Wire ids would be leak-prone and brittle. Three sources are used instead:
 * test-owned marker types ({@link MODELLED}), the contract's own push types read
 * from `snapshot.json` at run time ({@link UNMODELLED_TYPES}), and one fictional
 * type no engine has ever sent ({@link FICTIONAL_TYPE}) for the forward
 * compatibility case. `capability-names.test.ts` scans this file with the rest
 * of `client/`, so a literal would fail the gate rather than pass unnoticed.
 *
 * ## Time and teardown
 *
 * Every wait is a fake clock; the only real timers are the 0 ms races inside
 * `expectSettles`, which exist to turn a would-be thirty-second `testTimeout`
 * into an immediate, self-describing failure. `afterEach` releases transports,
 * closes channels and then demands no timer survived - a timer that outlives its
 * test holds a promise that can never settle, and the *next* test pays for it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createTransport } from "./transport";
import { TRACKED, expectSettles, responseFrame } from "./channel-test-support";
import {
  assertScriptedClean,
  FICTIONAL_TYPE,
  FLOOD_FRAMES,
  floodFrames,
  kindsOf,
  MODELLED,
  MODELLED_TYPES,
  makeScripted,
  makeSocketDouble,
  markersOf,
  pushFrame,
  seqsOf,
  trackTransport,
  UNMODELLED_TYPES,
  wireInbound,
} from "./scripted-harness";

/** Close every channel and transport this file built, then prove nothing leaks. */
afterEach(() => {
  assertScriptedClean();
});

/* ------------------------------------------------------------------------- */
/* (1) Frames that arrive out of order                                       */
/* ------------------------------------------------------------------------- */

describe("out-of-order arrival", () => {
  it("delivers a turn's frames in arrival order, not in event_seq order", () => {
    // Red when: `ingest` collects into a buffer and releases it sorted by
    // `event_seq` (the tempting "helpful" fix). The arrival order below is *not*
    // the sorted order, so any re-sort shows up as B, C, D instead of C, D, B.
    //
    // The four envelope fields are passed through verbatim, and duplicate
    // detection and reordering belong to C1, which is the only layer that sees
    // layer that sees the whole sequence. A channel that reordered here would be
    // answering a question it cannot answer: it has one stream and no authority.
    const h = makeScripted();
    const script = [
      { seq: 1, marker: "delta-one" },
      { seq: 3, marker: "delta-three" },
      { seq: 2, marker: "delta-two" },
    ] as const;

    for (const step of script) {
      h.clock.advance(1);
      h.channel.ingest(pushFrame(MODELLED.delta, { event_seq: step.seq, marker: step.marker }));
    }

    expect(markersOf(h.events)).toEqual(["delta-one", "delta-three", "delta-two"]);
    // And explicitly not the order a sorter would produce. This is the same fact
    // twice; it is written twice because a reader of the failure wants to know
    // which of the two readings broke.
    expect(markersOf(h.events)).not.toEqual(["delta-one", "delta-two", "delta-three"]);
  });

  it("passes the out-of-order sequence numbers through untouched", () => {
    // Red when: `envelopeOf` starts normalising, renumbering or validating
    // `event_seq` on the way through. The numbers below are deliberately not
    // consecutive from 1, so an implementation that renumbered them would be
    // visible rather than accidentally right.
    const h = makeScripted();

    for (const raw of [
      pushFrame(MODELLED.delta, { event_seq: 41, marker: "a" }),
      pushFrame(MODELLED.delta, { event_seq: 39, marker: "b" }),
      pushFrame(MODELLED.delta, { event_seq: 40, marker: "c" }),
      pushFrame(MODELLED.delta, { marker: "no-envelope" }),
    ]) {
      h.channel.ingest(raw);
    }

    expect(seqsOf(h.events)).toEqual([41, 39, 40, undefined]);
    // Absent fields stay absent: the frame carried only one of the four, and
    // inventing the other three would be interpretation.
    // `toStrictEqual` rather than `toEqual` on purpose - `toEqual` treats a key
    // holding `undefined` as absent, which is exactly the difference a
    // "default the missing fields" mutant would slip through.
    expect(h.events[0]?.envelope).toStrictEqual({ event_seq: 41 });
    // And a frame with none of the four has no `envelope` key at all, rather
    // than an empty object: "the engine did not tag this frame" is a different
    // fact from "the engine tagged it with nothing".
    expect(Object.hasOwn(h.events[3] as object, "envelope")).toBe(false);
  });

  it("keeps arrival order across the transport seam, which is where arrival happens", () => {
    // Red when: the transport's delivery loop or its pre-subscriber queue
    // reorders (a `Set` keyed on text, an `unshift`, a sort by a field). The
    // channel-side cases above prove the kernel does not reorder; this one proves
    // the seam in front of it does not either, so the guarantee is about the
    // whole inbound path rather than one function.
    //
    // Frames are written before the wiring subscribes on purpose: the transport
    // captures them in its handover queue , so this also pins that the
    // queue is FIFO. Losing them here would be accept-tick again.
    const h = makeScripted();
    const double = makeSocketDouble();
    const transport = trackTransport(createTransport(double.socket));

    for (const seq of [5, 7, 6]) {
      double.emitMessage(
        pushFrame(MODELLED.delta, { event_seq: seq, marker: `seq-${String(seq)}` }),
      );
    }

    wireInbound(transport, h.channel);

    expect(markersOf(h.events)).toEqual(["seq-5", "seq-7", "seq-6"]);
    expect(seqsOf(h.events)).toEqual([5, 7, 6]);
  });

  it("delivers the pre-subscriber queue once, and never replays it to a later subscriber", () => {
    // Red when: the handover queue is drained without being emptied. With a
    // read-only loop the four frames are delivered correctly to the *first*
    // subscriber and then again to every later one - so an assertion made before
    // the second subscription passes while the defect is live. Two facts are
    // therefore asserted: the first subscriber's count, and that a second sees
    // **nothing** from the queue.
    //
    // This is the seam whose other half `transport.test.ts` already pins
    // ; here it is asserted through the wiring the client actually uses,
    // because "one owner for the early-frame window" is a claim about the two
    // layers together.
    const h = makeScripted();
    const double = makeSocketDouble();
    const transport = trackTransport(createTransport(double.socket));

    for (const marker of ["early-a", "early-b", "early-c"]) {
      double.emitMessage(pushFrame(MODELLED.delta, { marker }));
    }

    wireInbound(transport, h.channel);
    expect(markersOf(h.events)).toEqual(["early-a", "early-b", "early-c"]);

    // A late subscriber on the same transport gets frames from now on, and must
    // not be handed the queue a second time.
    const lateFrames: string[] = [];
    transport.onFrame((frame) => {
      lateFrames.push(frame.raw);
    });

    expect(lateFrames).toEqual([]);
    expect(markersOf(h.events)).toHaveLength(3);

    double.emitMessage(pushFrame(MODELLED.delta, { marker: "live" }));
    expect(lateFrames).toHaveLength(1);
    expect(markersOf(h.events)).toEqual(["early-a", "early-b", "early-c", "live"]);
  });

  it("delivers an out-of-order frame to every subscriber, not just the first", () => {
    // Red when: the fan-out loops over a single subscriber (a `find` instead of a
    // `for`, an early `return` in the loop). Order and multiplicity are the two
    // halves of the same promise - "every subscriber sees the stream as it
    // arrived" - and a `for ... of` narrowed to one element keeps the order
    // assertion green while quietly breaking the second consumer.
    const h = makeScripted();
    const second: string[] = [];
    const off = h.channel.onEvent((frame) => {
      second.push(String((frame.raw as { marker?: unknown }).marker));
    });

    for (const marker of ["c", "a", "b"]) {
      h.channel.ingest(pushFrame(MODELLED.delta, { marker }));
    }

    expect(markersOf(h.events)).toEqual(["c", "a", "b"]);
    expect(second).toEqual(["c", "a", "b"]);

    // Unsubscribe affects only that subscriber, and only future deliveries.
    off();
    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "d" }));
    expect(markersOf(h.events)).toEqual(["c", "a", "b", "d"]);
    expect(second).toEqual(["c", "a", "b"]);
  });

  it("gives each frame the receive time from its own arrival, and reports nothing", () => {
    // Red when: `at` is taken from the frame (the engine's clock, incomparable to
    // ours) or is stamped once per batch. It is also the second half of the
    // ordering claim: the channel's own view of order is the arrival order, and
    // nothing about being out of order is an error, so no diagnostic is produced.
    const h = makeScripted();
    const stamps: number[] = [];

    for (const marker of ["x", "y", "z"]) {
      h.clock.advance(25);
      stamps.push(h.clock.clock.now());
      h.channel.ingest(pushFrame(MODELLED.delta, { marker }));
    }

    expect(h.events.map((frame) => frame.at)).toEqual(stamps);
    expect(kindsOf(h.channel.diagnostics())).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* (2) The same frame twice                                                  */
/* ------------------------------------------------------------------------- */ describe("duplicate arrival", () => {
  it("delivers both copies of one event_seq, in the order they arrived", () => {
    // Red when: an inbound seen-set keyed on `event_seq` or `idempotency_key`
    // is added (the dedupe table is outbound). The two frames
    // share a sequence number and differ in payload precisely so that "both
    // arrived" can be told apart from "one arrived and was counted twice".
    const h = makeScripted();

    h.channel.ingest(pushFrame(MODELLED.delta, { event_seq: 7, marker: "original" }));
    h.channel.ingest(pushFrame(MODELLED.delta, { event_seq: 7, marker: "repeat" }));

    expect(markersOf(h.events)).toEqual(["original", "repeat"]);
    expect(seqsOf(h.events)).toEqual([7, 7]);
    // A repeated frame is not an anomaly the channel reports: it is a fact about
    // the engine that C1 has the information to judge.
    expect(kindsOf(h.channel.diagnostics())).toEqual([]);
  });

  it("counts every copy rather than remembering it was already seen", () => {
    // Red when: the unknown-type tally is replaced by (or backed by) a set of
    // seen frames. The tally is a `Map<type, count>` by design: five
    // copies of one frame are five frames the engine sent, and a count of one
    // would under-report the very thing the diagnostic exists to report.
    const h = makeScripted();
    const frame = pushFrame(UNMODELLED_TYPES[0], { event_seq: 12, marker: "same" });

    for (let copy = 0; copy < 5; copy += 1) {
      h.channel.ingest(frame);
    }

    expect(h.events).toHaveLength(5);
    expect(h.channel.unknownEventCounts().get(UNMODELLED_TYPES[0])).toBe(5);
    expect(h.channel.diagnostics()).toHaveLength(1);
  });

  it("does not swallow a repeated answer, and settles once", async () => {
    // Red when: an inbound dedupe drops the second copy *before* the response
    // check, so the duplicate is neither settled nor delivered. The correct
    // behaviour is both halves at once: the first settles the entry (one result),
    // the second misses the table and therefore becomes an event.
    // Dropping it would be the channel deciding an engine repetition is noise.
    const h = makeScripted();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "dup-1" });
    const answer = responseFrame("dup-1", { data: "first" });

    h.channel.ingest(answer);
    h.channel.ingest(answer);

    const result = await expectSettles(pending);
    expect(result.ok).toBe(true);
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.type).toBe(MODELLED.answer);
  });
});

/* ------------------------------------------------------------------------- */
/* (3) A frame that is not a frame                                           */
/* ------------------------------------------------------------------------- */

describe("malformed frames", () => {
  it("does not throw, does not close, and keeps processing the next frame", () => {
    // Red when: the parse is unguarded, or the failure is promoted to a close.
    // One unreadable frame must not take the connection down; "the connection
    // dropped" stays a separate, visible event that only a real drop may
    // event that only a real drop may produce.
    const h = makeScripted();

    expect(() => {
      h.channel.ingest("this is not json");
    }).not.toThrow();

    expect(markersOf(h.events)).toEqual([]);
    expect(h.channel.isClosed()).toBe(false);

    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "after-the-noise" }));
    expect(markersOf(h.events)).toEqual(["after-the-noise"]);
  });

  it("records one malformed diagnostic and nothing else", () => {
    // Red when: the `malformed` signal is dropped (a silent swallow, which the
    // user-facing rule forbids: every failure needs a visible trace), or is
    // reported under another kind.
    const h = makeScripted();
    const raw = "}not json{";
    h.channel.ingest(raw);

    const records = h.channel.diagnostics();
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("malformed");
    // The subject names what the record is about; a frame that never parsed has
    // no type to be named by, so the channel uses its own placeholder rather than
    // inventing one (and never a raw frame body, which could carry a token).
    expect(records[0]?.subject.length).toBeGreaterThan(0);
    // The body must not be copied into the record: a diagnostic is exported,
    // pasted into an issue and attached to a crash report, and
    // an unparseable frame is exactly the one whose contents nobody has vetted.
    expect(records[0]?.subject).not.toContain("not json");
    expect(records[0]?.engineText).toBeUndefined();
  });

  it("rejects a not-a-frame before any reader sees it", () => {
    // Red when: the object guard is dropped and a reader that indexes fields -
    // the realistic shape, since a response reader will - is handed `null` or an
    // array. The shared double is deliberately *total* over `unknown`, so it
    // would swallow a missing guard and this case would pass vacuously; the
    // reader below is therefore not total, and the assertion is that it is never
    // reached. This is the "the next frame still flows" rule read the other way
    // round: the frame must fail *before* the layer that would throw on it.
    let consulted = 0;
    const h = makeScripted({
      reader: {
        typeOf: (raw) => {
          consulted += 1;
          return (raw as { type: string }).type;
        },
        responseOf: () => undefined,
      },
    });

    for (const raw of ["null", "42", '"a string"', "[]"]) {
      expect(() => {
        h.channel.ingest(raw);
      }).not.toThrow();
    }

    expect(consulted).toBe(0);
    expect(h.events).toHaveLength(0);
    expect(kindsOf(h.channel.diagnostics())).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);

    // And the channel is still usable afterwards.
    h.channel.ingest(pushFrame(MODELLED.status, { marker: "after" }));
    expect(markersOf(h.events)).toEqual(["after"]);
  });

  it("reports an object that parses but carries no usable type", () => {
    // Red when: the frame passes the object guard and the `undefined` type from
    // the reader is then treated as "nothing to do". The frame is *not* a
    // well-formed event either: it has no type to route on, so a consumer could
    // not act on it, and quietly discarding it is the silent failure the user
    // rule forbids (every failure needs a visible trace).
    //
    // Distinguished from the case above on purpose: there the guard rejects
    // before the reader; here the reader itself answered "no type". Both produce
    // `malformed`, and the two are different code paths.
    const h = makeScripted();

    for (const raw of ['{"no_type":true}', '{"type":7}', '{"type":""}', '{"type":null}']) {
      expect(() => {
        h.channel.ingest(raw);
      }).not.toThrow();
    }

    expect(h.events).toHaveLength(0);
    expect(kindsOf(h.channel.diagnostics())).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
  });

  it("handles every not-a-frame shape the same way, then keeps working", () => {
    // Red when: only the `JSON.parse` failure is guarded and the non-object
    // cases (`42`, `null`, `[]`, a bare string) slip through to the reader. A
    // reader that indexes fields would then throw on `null` and take the channel
    // with it. The list is the four malformed shapes the parser must survive plus
    // outside them.
    const h = makeScripted();
    const unrunnable = ["", "not json at all", '{"type":', "42", "[]", "null", '"a string"'];

    for (const raw of unrunnable) {
      expect(() => {
        h.channel.ingest(raw);
      }).not.toThrow();
    }

    expect(kindsOf(h.channel.diagnostics())).toEqual(unrunnable.map(() => "malformed"));
    expect(h.events).toHaveLength(0);

    h.channel.ingest(pushFrame(MODELLED.status, { marker: "still-flowing" }));
    expect(markersOf(h.events)).toEqual(["still-flowing"]);
  });
});

/* ------------------------------------------------------------------------- */
/* (4) A type this build does not model                                      */
/* ------------------------------------------------------------------------- */

describe("unknown event types", () => {
  it("delivers all 155 frames of one unmodelled type, and reports it once", () => {
    // Red when: the `first arrival` guard is dropped, so every frame writes a
    // record - 155 of them would spend 30% of the 512-record ring on a single
    // answer to "what is this engine sending that we do not model?".
    // Red also when the frame is treated as a parse failure and dropped: unknown
    // means unmodelled, not discarded (the user sees nothing, but
    // the frames still flow to whatever does model them).
    const h = makeScripted();
    const type = UNMODELLED_TYPES[0];

    for (const frame of floodFrames(type, FLOOD_FRAMES)) {
      h.channel.ingest(frame);
    }

    expect(h.events).toHaveLength(FLOOD_FRAMES);

    const records = h.channel.diagnostics();
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("unknown-event");
    expect(records[0]?.subject).toBe(type);

    // The count is where the volume lives: one record, 155 frames.
    expect(h.channel.unknownEventCounts().get(type)).toBe(FLOOD_FRAMES);
  });

  it("keeps two unmodelled types in separate buckets, in first-appearance order", () => {
    // Red when: the tally keys on a constant, or the aggregation is keyed on the
    // record instead of the type. Two types must not share a bucket, and the
    // order must be the order they were first seen - a `Map` gives that for free,
    // and a sort would lose the answer to "what did this engine start sending?".
    const h = makeScripted();
    const [first, second] = UNMODELLED_TYPES;

    h.channel.ingest(pushFrame(second));
    h.channel.ingest(pushFrame(first));
    h.channel.ingest(pushFrame(second));

    const counts = h.channel.unknownEventCounts();
    expect(counts.get(second)).toBe(2);
    expect(counts.get(first)).toBe(1);
    expect([...counts.keys()]).toEqual([second, first]);
    expect(h.channel.diagnostics().map((record) => record.subject)).toEqual([second, first]);
  });

  it("reports nothing for a type this build models", () => {
    // Red when: the membership test is inverted or forgotten, so every frame is
    // reported unknown and the tally stops distinguishing anything.
    const h = makeScripted();

    for (const type of Object.values(MODELLED)) {
      h.channel.ingest(pushFrame(type, { marker: type }));
    }

    expect(h.events).toHaveLength(Object.values(MODELLED).length);
    expect(h.channel.unknownEventCounts().size).toBe(0);
    expect(kindsOf(h.channel.diagnostics())).toEqual([]);
  });

  it("treats a type no engine has ever sent exactly the same way", () => {
    // Red when: the handling depends on the name being one the contract knows.
    // A newer engine behind an older host is a normal upgrade order, so "I do not
    // recognise this" must not be a different code path from "I know this type
    // exists but do not model it" - we cannot tell those apart, and pretending to
    // would make the first frame from a new engine behave unpredictably.
    const h = makeScripted();

    h.channel.ingest(pushFrame(FICTIONAL_TYPE, { marker: "future" }));
    h.channel.ingest(pushFrame(FICTIONAL_TYPE, { marker: "future-again" }));

    expect(markersOf(h.events)).toEqual(["future", "future-again"]);
    expect(h.channel.unknownEventCounts().get(FICTIONAL_TYPE)).toBe(2);
    const records = h.channel.diagnostics();
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("unknown-event");
    expect(records[0]?.subject).toBe(FICTIONAL_TYPE);
  });
});

/* ------------------------------------------------------------------------- */
/* (5) Frames that arrive before the channel is ready                        */
/* ------------------------------------------------------------------------- */

describe("frames before readiness", () => {
  it("delivers frames that arrive before ready, without buffering or dropping them", () => {
    // Red when: `ingest` gains a readiness gate (the plausible "do not hand
    // frames to a consumer that is not ready yet" guard), or a queue that drains
    // on `ready` - either the frames vanish or they arrive twice.
    //
    // Neither would be right. Readiness is about whether a command may be
    // **written**; the inbound path has no such question. The
    // three answers, in order of preference:
    //   1. deliver on arrival      - what the channel does; the consumer is
    //                                already subscribed and C1 gives it the only
    //                                only ordering authority there is;
    //   2. buffer until ready     - needs a release point, and the transport's
    //                                handover queue is already the one
    //                                owner of "frames that arrived early". A
    //                                second queue is how the same frame gets
    //                                delivered twice once both drain;
    //   3. drop and report        - loses data the engine really sent, which
    //                                the no-rollback rule forbids for displayed
    //                                which B3 cannot recover (these were not lost
    //                                to a disconnect).
    // So the test pins (1), and the assertion that the frames are *still* there,
    // exactly once, after readiness flips is what rules out (2).
    const h = makeScripted({ ready: false });
    const script = ["early-one", "early-two", "early-three"];

    for (const marker of script) {
      h.channel.ingest(pushFrame(MODELLED.delta, { marker }));
    }

    expect(markersOf(h.events)).toEqual(script);
    // Nothing was wrong, so nothing is reported: a diagnostic here would tell a
    // user "something failed" about a frame that was handled correctly.
    expect(kindsOf(h.channel.diagnostics())).toEqual([]);

    h.setReady(true);

    expect(markersOf(h.events)).toEqual(script);
  });

  it("refuses a send before ready instead of writing it to nothing", () => {
    // Red when: the readiness check moves after the write, or is skipped. The
    // contrast is the point of the case: an inbound frame is accepted while a
    // command is not, because one has an owner already and the other has no
    // connection to write on yet. Both facts are about the same instant.
    const h = makeScripted({ ready: false });

    return expectSettles(h.channel.send({ capability: TRACKED, body: {} })).then((result) => {
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.code).toBe("NOT_CONNECTED");
      // The wording tells B3 which side of the window this is: nothing to resume.
      expect(result.error.detail).toContain("has not become ready");

      expect(h.writer.calls).toHaveLength(0);
      expect(h.channel.inFlightCount()).toBe(0);
      // No timer was started for a command that never went out. A leaked timer
      // here would be a false TIMEOUT waiting to fire.
      expect(h.clock.pending()).toBe(0);
    });
  });

  it("carries the pre-ready frames through the transition, then follows the new state", () => {
    // Red when: readiness is latched one way only - frames arriving after the
    // flip are dropped, or the flip is ignored so sends stay refused forever.
    // This is the "and then what" half of the previous case: the window closes,
    // and the channel has to be fully usable from that moment on.
    const h = makeScripted({ ready: false });

    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "before" }));
    h.setReady(true);

    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "after-ready" });
    expect(h.channel.inFlightCount()).toBe(1);

    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "after" }));
    h.channel.ingest(responseFrame("after-ready", { data: "answered" }));

    return expectSettles(pending).then((result) => {
      expect(result.ok).toBe(true);
      // The answer settled the entry and was not also delivered as an event.
      expect(markersOf(h.events)).toEqual(["before", "after"]);
      expect(h.channel.inFlightCount()).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------------- */
/* (6) The connection dies in the middle of a stream                         */
/* ------------------------------------------------------------------------- */

describe("disconnect mid-stream", () => {
  it("keeps what arrived, reports the close once, and refuses later sends", () => {
    // Red when: close clears the delivered-stream state, fires per close event
    // instead of once, stops settling in-flight requests, or leaves `ingest`
    // accepting frames. This is the mid-stream drop read from the dropped side:
    // the *neighbour* keeps finishing (that is `multichannel.test.ts`'s), and
    // connection has to say plainly that it is gone and that nothing it already
    // already delivered was rolled back.
    const h = makeScripted();
    const double = makeSocketDouble();
    const transport = trackTransport(createTransport(double.socket));
    const wiring = wireInbound(transport, h.channel);

    for (const marker of ["delta-1", "delta-2", "delta-3"]) {
      double.emitMessage(pushFrame(MODELLED.delta, { marker }));
    }

    expect(markersOf(h.events)).toEqual(["delta-1", "delta-2", "delta-3"]);

    const inFlight = h.channel.send({ capability: TRACKED, body: {}, requestId: "mid-7" });
    expect(h.channel.inFlightCount()).toBe(1);

    double.emitClose("engine restarted");
    // A peer that repeats its own close (or a second transport event racing the
    // first) must not produce a second notification: the wiring closes the
    // channel once, and `close()` is idempotent.
    double.emitClose("engine restarted");

    expect(wiring.closes).toEqual(["engine restarted"]);
    expect(h.channel.isClosed()).toBe(true);
    expect(transport.isOpen).toBe(false);

    // No rollback: the three deltas that arrived are still exactly the three the
    // subscriber saw, in order. Clearing them would be the channel editing the
    // conversation because the transport died.
    expect(markersOf(h.events)).toEqual(["delta-1", "delta-2", "delta-3"]);

    return expectSettles(inFlight).then((settled) => {
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error.code).toBe("NOT_CONNECTED");
        // This channel *was* ready, so the wording points at a reconnect, not at
        // a startup failure.
        expect(settled.error.detail).toContain("ready and dropped");
      }

      // A frame arriving after the close is not delivered, and does not throw:
      // the peer may still be flushing when the close reaches us. This is what
      // makes "the channel stops accepting frames" observable at all - without
      // it, an `ingest` that kept running after `close()` would look identical
      // from every other angle, because the subscriber set is already empty.
      const beforeLateFrame = h.events.length;
      double.emitMessage(pushFrame(MODELLED.delta, { marker: "after-close" }));
      expect(h.events.length).toBe(beforeLateFrame);
      expect(markersOf(h.events)).toEqual(["delta-1", "delta-2", "delta-3"]);

      // And directly, without going through a socket: a frame handed to a closed
      // channel is ignored rather than delivered, even if a caller holds the
      // reference and calls it anyway.
      h.channel.ingest(pushFrame(MODELLED.delta, { marker: "direct-after-close" }));
      expect(markersOf(h.events)).toEqual(["delta-1", "delta-2", "delta-3"]);

      return expectSettles(h.channel.send({ capability: TRACKED, body: {} })).then((later) => {
        expect(later.ok).toBe(false);
        if (!later.ok) {
          expect(later.error.code).toBe("NOT_CONNECTED");
          expect(later.error.detail).toContain("closed");
        }
        expect(h.channel.inFlightCount()).toBe(0);
      });
    });
  });

  it("stops gathering anything once closed, because nothing can act on it", () => {
    // Red when: `ingest` keeps running after `close()`. The delivered-stream
    // half of that is invisible - `close()` empties the subscriber sets, so a
    // frame after the close reaches nobody either way - but the *diagnostic
    // ring* is still readable through `diagnostics()`, and that is where the
    // difference shows: a frame ingested after the close would file a record
    // that no panel can ever be told about, at a timestamp after the channel
    // died. A support bundle built from a closed channel would then show a
    // failure that no user-facing surface ever saw.
    const h = makeScripted();
    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "while-open" }));
    expect(h.events).toHaveLength(1);

    h.channel.close();
    const afterClose = h.channel.diagnostics().length;

    h.channel.ingest("not json after close");
    h.channel.ingest(pushFrame(UNMODELLED_TYPES[0], { marker: "after" }));

    expect(h.channel.diagnostics()).toHaveLength(afterClose);
    expect(h.channel.unknownEventCounts().size).toBe(0);
    expect(h.events).toHaveLength(1);
  });

  it("leaves no timer behind for the request the drop settled", () => {
    // Red when: `close()` settles the entry without cancelling its timer (or
    // takes an entry out of the table without clearing it). The promise resolves,
    // so nothing fails visibly - but the timer stays scheduled, and it is the
    // *next* test that pays for it with a thirty-second timeout. This is the
    // leaked-timer defect class, asserted directly instead of waiting for the
    // for the leak detector to notice.
    const h = makeScripted();
    const double = makeSocketDouble();
    const transport = trackTransport(createTransport(double.socket));
    wireInbound(transport, h.channel);

    h.channel.ingest(pushFrame(MODELLED.delta, { marker: "before" }));
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "leak-check" });
    expect(h.clock.pending()).toBe(1);

    double.emitClose("gone");

    // `close()` runs while the frame is being delivered, so the settlement is
    // synchronous with it: by the time the emit returns, the timer must be gone.
    expect(h.channel.isClosed()).toBe(true);
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Scaffold: make the above impossible to satisfy vacuously                  */
/* ------------------------------------------------------------------------- */

describe("scripted scaffold", () => {
  it("derives two real, distinct, unmodelled type names from the contract", () => {
    // Red when: `snapshot.json` stops yielding push types, in which case the
    // unknown-type cases would be testing a name nothing knows - a test that
    // passes for the wrong reason. Derived rather than written down because a
    // literal here would be a wire id under `client/`.
    const [first, second] = UNMODELLED_TYPES;

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
    expect(MODELLED_TYPES.has(first)).toBe(false);
    expect(MODELLED_TYPES.has(second)).toBe(false);
    expect(first).not.toBe(FICTIONAL_TYPE);
  });

  it("floods with the documented high-volume frame count", () => {
    // Red when: the flood shrinks to a token handful, at which point per-frame
    // recording would still fit in the 512-record ring and the aggregation case
    // would pass without proving anything. 155 is the measured count of the
    // highest-volume s2c type in the seven-file corpus.
    expect(FLOOD_FRAMES).toBe(155);
    expect(FLOOD_FRAMES * 2).toBeLessThan(512);
    expect(FLOOD_FRAMES).toBeGreaterThan(1);
  });
});
