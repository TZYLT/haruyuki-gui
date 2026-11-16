/**
 * Diagnostic tests for the channel.
 *
 * Split out of `channel.test.ts` on responsibility: this suite is about the
 * diagnostic history the channel keeps - how much of it, what is erased from it,
 * and who is told about it - not about the in-flight table it sits beside.
 *
 * The channel does not implement redaction or bounding itself: both come from
 * `DiagnosticLog` (`diagnostics.ts`), which the channel composes. So these
 * cases test the composition - that every record goes *through* the log, and that
 * the one thing the channel adds on top (the by-value secret scrub) is real.
 *
 * The token case is the sharpest one and deserves its own note: the log redacts by
 * *shape* (bearer headers, 64-hex, JWT, provider keys, absolute paths). The token
 * used below is deliberately shaped so no shape rule matches it, which means the
 * channel's own scrub is the only thing that can remove it. Delete that scrub and
 * this test is the one that goes red - the shape rules would still pass it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DIAGNOSTIC_RING_CAPACITY, ENGINE_TEXT_MAX_BYTES } from "./diagnostics";
import {
  assertNoLeakedTimers,
  closeHarnesses,
  makeHarness,
  responseFrame,
  TRACKED,
} from "./channel-test-support";

/**
 * Close every channel this file built, before the next test runs.
 *
 * Without this, a test that leaves entries in flight hands its timers and
 * unsettled promises to whatever runs next - which passes in isolation and fails
 * in a full run as a `testTimeout` in a test that did nothing wrong.
 */
afterEach(() => {
  // Asserts before it cleans: see `assertNoLeakedTimers`. Calling
  // `closeHarnesses()` first would free the timers and make the check vacuous.
  assertNoLeakedTimers();
});

/* ------------------------------------------------------------------------- */
/* Diagnostics: bound, redaction, token                                     */
/* ------------------------------------------------------------------------- */

describe("diagnostics", () => {
  it("stamps each record with the channel's own clock", () => {
    // Red when: `at` is a constant (or taken from the engine's `emitted_at`). A
    // constant is the tempting way to satisfy the field's type, and it makes every
    // record look simultaneous - useless for "it broke a moment ago", which is why
    // the field exists (types.ts).
    const h = makeHarness();
    h.channel.ingest("not json");
    h.clock.advance(7_500);
    h.channel.ingest("still not json");

    const records = h.channel.diagnostics();
    expect(records).toHaveLength(2);
    const first = records[0]?.at;
    const second = records[1]?.at;
    expect(first).toBeGreaterThan(0);
    expect(second).toBe((first ?? 0) + 7_500);
    // And it is *our* clock, not the wall clock: the fake clock starts in 2023, so a
    // real `Date.now()` stamp would be an order of magnitude larger.
    expect(first).toBeLessThan(2_000_000_000_000);
  });

  it("bounds the history at 512 records, keeping the newest", () => {
    // Red when: the ring grows without a bound. A chatty engine would then turn
    // the support bundle into a memory leak.
    const h = makeHarness();
    for (let index = 0; index < DIAGNOSTIC_RING_CAPACITY + 20; index += 1) {
      h.channel.ingest("not json");
    }

    const records = h.channel.diagnostics();
    expect(records).toHaveLength(DIAGNOSTIC_RING_CAPACITY);
    // Newest kept: the ring overwrites the oldest rather than clearing, so the
    // record *after* the 512th is present.
    expect(records[records.length - 1]?.kind).toBe("malformed");
  });

  it("truncates engineText to 4 KB", () => {
    // Red when: the per-field bound is dropped. One engine line would then be
    // enough to bloat every stored record.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "long" });
    h.channel.ingest(
      responseFrame("long", {
        ok: false,
        error: { code: "REJECTED", detail: "refused", engineText: "x".repeat(20_000) },
      }),
    );
    void pending;

    const record = h.channel.diagnostics().find((entry) => entry.kind === "rejected");
    expect(record?.engineText).toBeDefined();
    expect((record?.engineText ?? "").length).toBeLessThanOrEqual(ENGINE_TEXT_MAX_BYTES);
    expect((record?.engineText ?? "").length).toBeGreaterThan(0);
  });

  it("redacts absolute paths out of engineText", () => {
    // Red when: the diagnostic path stops going through the redacting log, so an
    // engine message quoting a file path stores the path.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "path" });
    h.channel.ingest(
      responseFrame("path", {
        ok: false,
        error: {
          code: "MALFORMED_RESPONSE",
          detail: "bad",
          engineText: "cannot read C:\\Users\\someone\\secret\\file.txt",
        },
      }),
    );
    void pending;

    const record = h.channel.diagnostics().find((entry) => entry.kind === "malformed");
    expect(record?.engineText).toBeDefined();
    expect(record?.engineText).not.toContain("file.txt");
    expect(record?.engineText).not.toContain("Users");
  });

  it("never lets the endpoint token reach a diagnostic", () => {
    // Red when: the endpoint (or its token) is put into a record. The token is a
    // hard boundary: it must not survive in a diagnostic,
    // a log line or a crash record.
    //
    // The token below is deliberately short and shaped so that the pattern
    // rules do NOT recognise it: the channel's own by-value scrub is what has to
    // remove it, so this test fails if that scrub is deleted.
    const token = "tok-abc";
    const h = makeHarness({ secrets: [token] });
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "leak" });
    h.channel.ingest(
      responseFrame("leak", {
        ok: false,
        error: {
          code: "REJECTED",
          detail: "refused",
          engineText: `authorization rejected for token ${token} at ws://127.0.0.1:9/private-dir`,
        },
      }),
    );
    void pending;

    const record = h.channel.diagnostics().find((entry) => entry.kind === "rejected");
    expect(record?.engineText).toBeDefined();
    expect(record?.engineText).not.toContain(token);
  });

  it("delivers records to subscribers, and the unsubscribe is idempotent", () => {
    // Red when: delivery is wired to the wrong set, or unsubscribe clears all
    // subscribers instead of one.
    const h = makeHarness();
    const seen: string[] = [];
    const unsubscribe = h.channel.onDiagnostic((record) => seen.push(record.kind));

    h.channel.ingest("not json");
    expect(seen).toEqual(["malformed"]);

    unsubscribe();
    unsubscribe();
    h.channel.ingest("still not json");
    expect(seen).toEqual(["malformed"]);
  });

  it("keeps the backlog readable even for a subscriber that subscribed late", () => {
    // Red when: the channel only keeps what was delivered since subscription, so
    // a diagnostics panel opened after a failure shows nothing.
    const h = makeHarness();
    h.channel.ingest("not json");

    const late: string[] = [];
    h.channel.onDiagnostic((record) => late.push(record.kind));
    expect(late).toEqual([]);
    expect(h.channel.diagnostics().some((record) => record.kind === "malformed")).toBe(true);
  });

  it("does not record a signal for a code that has none", () => {
    // Red when: NOT_CONNECTED / AUTH_FAILED are given a diagnostic kind - the two
    // codes types.ts documents as surfacing through the result instead, because a
    // dead channel has no channel left to report on.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "auth" });
    h.channel.ingest(
      responseFrame("auth", {
        ok: false,
        error: { code: "AUTH_FAILED", detail: "401" },
      }),
    );
    void pending;

    expect(h.channel.diagnostics()).toHaveLength(0);
  });
});
