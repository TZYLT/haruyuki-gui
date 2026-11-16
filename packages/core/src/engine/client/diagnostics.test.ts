/**
 * Tests for the diagnostic ring, the text fence and the unknown-event tally.
 *
 * Scope sources: docs/26-B2 section 6.5 (record shape and the "no token, no
 * absolute path" rule), -B2 facts 44-45 and decisions `B2-D07` /
 * `B2-D09`.
 *
 * Wiring: every assertion is written so ONE deliberate change to
 * `diagnostics.ts` makes it fail, and the change is named in the test's
 * description. The mutation list that was actually run is reported with the
 * work package; the shapes picked for the redaction cases are real ones
 * (`sk-`, a three-segment JWT, the engine's own 64-hex token, a Windows path
 * with a project tree, a POSIX home path under `.haruyuki`) because a test
 * that feeds `"secret"` to a regex proves nothing about the regex.
 *
 * The last group reads the recorded corpus and pins the corpus arithmetic
 * 44 (295 s2c frames, 155 of them one streaming type, 19 distinct types) as
 * arithmetic over the files, not as a remembered number: that is the fact the
 * "count instead of store" decision rests on, so a corpus change that moves it
 * should be a red test rather than a stale comment.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedRing,
  DiagnosticLog,
  ENDPOINT_FALLBACK,
  ENGINE_TEXT_MAX_BYTES,
  PATH_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
  TRUNCATION_MARKER_PREFIX,
  boundDiagnosticText,
  describeEndpoint,
  redactDiagnosticText,
  sanitizeDiagnosticRecord,
} from "./diagnostics";
import type { DiagnosticRecord, Endpoint } from "./types";

// --- real shapes, copied from the threats the fence exists for ---------------

/** A three-segment JWT; the second segment is short enough to be missed by the
 *  opaque-run rule, so only the dedicated JWT rule can remove it whole. */
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/** The engine's own token shape: 32 random bytes as 64 hex characters. */
const HEX_TOKEN = "9f2c4b8e1a7d3056c9be42f81d6a7053e0c9d8174b2a6f35e8d1c07b49a2e6f3";

/** A provider-style key. */
const PROVIDER_KEY = "sk-live-8c2f14ab77de4e0b9a3f6d5c2e1b7a90";

/** A path under a real project tree; the shape a crash report leaks. */
const WINDOWS_PATH = "J:\\Projects\\Haruyuki-desktop\\packages\\core\\src\\engine\\engine.ts";

/** A POSIX home path, the second shape a crash report leaks. */
const UNIX_PATH = "/home/user/.haruyuki/token";

/** A diagnostic-shaped engine line is short; this one is not. */
const LONG_TEXT = "a".repeat(5000);

/** UTF-8 byte length, the unit both limits are expressed in. */
function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Records `0..count-1`, which makes write order obvious in an assertion. */
function pushRange(ring: BoundedRing<number>, count: number): void {
  for (let index = 0; index < count; index += 1) {
    ring.push(index);
  }
}

describe("BoundedRing: capacity", () => {
  it("holds 512 records by default and no more (V: unbounded ring)", () => {
    // The bound is the protection: a diagnostic buffer that can grow is a leak
    // that only appears after an engine misbehaves for an hour.
    const log = new DiagnosticLog();

    expect(log.capacity).toBe(512);

    for (let index = 0; index < 600; index += 1) {
      log.record({ kind: "timeout", subject: `conversation.sync#${String(index)}` });
    }

    expect(log.size).toBe(512);
    expect(log.entries()).toHaveLength(512);
  });

  it("reports a small custom capacity truthfully, for the reduced-history mode", () => {
    const ring = new BoundedRing<number>(3);

    expect(ring.capacity).toBe(3);
    expect(ring.size).toBe(0);

    pushRange(ring, 2);

    expect(ring.size).toBe(2);
  });

  it("refuses a capacity that is not a positive integer, instead of keeping nothing", () => {
    // A zero-slot ring would accept every push and retain none: a diagnostic
    // buffer that silently discards is worse than no buffer.
    expect(() => new BoundedRing<number>(0)).toThrow(RangeError);
    expect(() => new BoundedRing<number>(-1)).toThrow(RangeError);
    expect(() => new BoundedRing<number>(1.5)).toThrow(RangeError);
  });
});

describe("BoundedRing: overflow", () => {
  it("overwrites the oldest record when full, instead of clearing the history", () => {
    // 600 pushes into 512 slots: the first 88 are gone and the newest 512 stay.
    // A `clear()` implementation would leave exactly one record here.
    const ring = new BoundedRing<number>(512);

    pushRange(ring, 600);

    expect(ring.size).toBe(512);
    expect(ring.at(0)).toBe(88);
    expect(ring.at(511)).toBe(599);
  });

  it("keeps the newest record readable, so the symptom is never the evicted one", () => {
    const ring = new BoundedRing<number>(4);

    pushRange(ring, 4);
    expect(ring.toArray()).toEqual([0, 1, 2, 3]);

    ring.push(4);

    // One record older, one record newer: the count does not jump, and the
    // evicted value is the oldest, not the newest.
    expect(ring.toArray()).toEqual([1, 2, 3, 4]);
  });

  it("survives many wraps without drifting off the write order", () => {
    const ring = new BoundedRing<number>(5);

    pushRange(ring, 5 * 7 + 2);

    expect(ring.toArray()).toEqual([32, 33, 34, 35, 36]);
  });
});

describe("BoundedRing: read order", () => {
  it("reads oldest to newest after wrapping, so a reader never needs the head", () => {
    const ring = new BoundedRing<number>(3);

    pushRange(ring, 5);

    const values = ring.toArray();

    expect(values).toEqual([2, 3, 4]);
    // Strictly increasing is the property, not just the first element: a
    // reversed implementation that happens to keep `at(0)` would still fail.
    expect([...values]).toEqual([...values].sort((left, right) => left - right));
    expect([...ring]).toEqual([2, 3, 4]);
  });

  it("returns a fresh array, so a caller cannot reorder the ring", () => {
    const ring = new BoundedRing<number>(3);

    pushRange(ring, 3);

    const first = ring.toArray() as number[];
    first.reverse();

    expect(ring.toArray()).toEqual([0, 1, 2]);
  });

  it("refuses an out-of-range read instead of returning a plausible undefined", () => {
    const ring = new BoundedRing<number>(2);

    ring.push(7);

    expect(ring.at(0)).toBe(7);
    expect(() => ring.at(1)).toThrow(RangeError);
    expect(() => ring.at(-1)).toThrow(RangeError);
  });
});

describe("BoundedRing: subscription", () => {
  it("notifies on every stored value, in storage order", () => {
    const ring = new BoundedRing<number>(2);
    const seen: number[] = [];

    ring.subscribe((value) => seen.push(value));
    pushRange(ring, 3);

    // The evicted value is still delivered: notification is "stored", not
    // "still retained", so a live view never misses an event.
    expect(seen).toEqual([0, 1, 2]);
  });

  it("lets a subscriber read the record it was notified about", () => {
    const ring = new BoundedRing<string>(2);
    let sizeAtDelivery = -1;

    ring.subscribe(() => {
      sizeAtDelivery = ring.size;
    });
    ring.push("first");

    expect(sizeAtDelivery).toBe(1);
  });

  it("stops delivery after unsubscribe, and unsubscribing twice is harmless", () => {
    const ring = new BoundedRing<number>(4);
    const seen: number[] = [];
    const unsubscribe = ring.subscribe((value) => seen.push(value));

    ring.push(1);
    unsubscribe();
    ring.push(2);

    // A second call must not throw: teardown paths run twice in practice (a
    // component unmount plus a channel close), and a throwing unsubscribe turns
    // a clean shutdown into a crash.
    expect(() => unsubscribe()).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it("leaves other subscribers alone when one unsubscribes during delivery", () => {
    const ring = new BoundedRing<number>(2);
    const second: number[] = [];

    const off = ring.subscribe(() => {
      off();
    });
    ring.subscribe((value) => second.push(value));

    ring.push(1);
    ring.push(2);

    expect(second).toEqual([1, 2]);
  });
});

describe("truncation", () => {
  it("bounds a long field to 4 KB and says so, so a reader knows text was cut", () => {
    const bounded = boundDiagnosticText(LONG_TEXT);

    expect(bytesOf(bounded)).toBeLessThanOrEqual(ENGINE_TEXT_MAX_BYTES);
    // The notice is the difference between "the engine said this" and "the
    // engine said this and more": a silent cut is a lie about engine output.
    expect(bounded).toContain(TRUNCATION_MARKER_PREFIX);
    expect(bounded).toContain("5000 bytes total");
    expect(bounded.length).toBeLessThan(LONG_TEXT.length);
  });

  it("publishes the 4 KB budget as a constant, so the number is not duplicated", () => {
    // 4 KB, spelled once. A test that hard-coded 4096 and a source that changed
    // to 8192 would agree only by accident.
    expect(ENGINE_TEXT_MAX_BYTES).toBe(4096);
    expect(ENGINE_TEXT_MAX_BYTES).toBe(4 * 1024);
  });

  it("leaves a field that already fits exactly as it was", () => {
    const exact = "b".repeat(ENGINE_TEXT_MAX_BYTES);

    expect(boundDiagnosticText(exact)).toBe(exact);
    expect(boundDiagnosticText("short")).toBe("short");
    expect(boundDiagnosticText("")).toBe("");
  });

  it("cuts on a code-point boundary, so a multi-byte character is not split", () => {
    // 2000 emoji are 8000 UTF-8 bytes: a naive `slice(0, 4096)` would keep 4096
    // UTF-16 units (8192 bytes) and could end inside a surrogate pair.
    const bounded = boundDiagnosticText("😀".repeat(2000));

    expect(bytesOf(bounded)).toBeLessThanOrEqual(ENGINE_TEXT_MAX_BYTES);
    expect(bounded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(bounded).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("reports the byte total of the text it was actually given", () => {
    // `boundDiagnosticText` is the bound only, not the fence: it reports what it
    // received. The composition test below is what pins "redaction happens
    // first". The filler is `z` rather than a hex letter, so the 64-hex rule
    // cannot match the padding itself.
    const text = `prefix ${"z".repeat(5000)}`;
    const reported = /\[truncated: (\d+) bytes total\]/.exec(boundDiagnosticText(text));

    expect(reported?.[1]).toBeTypeOf("string");
    expect(Number(reported?.[1])).toBe(bytesOf(text));
  });

  it("counts the post-redaction length through the composition, not the raw one", () => {
    // Through `sanitizeDiagnosticRecord` the credential is gone before the cut,
    // so the notice must not claim a length that included it: the number is
    // what a reader could have seen.
    const raw = `prefix ${HEX_TOKEN} ${"z".repeat(5000)}`;
    const sanitized = sanitizeDiagnosticRecord({
      at: 1_700_000_000_000,
      kind: "malformed",
      subject: "conversation.sync",
      engineText: raw,
    });
    const reported = /\[truncated: (\d+) bytes total\]/.exec(sanitized.engineText ?? "");

    expect(Number(reported?.[1])).toBeLessThan(bytesOf(raw));
    expect(sanitized.engineText).not.toContain(HEX_TOKEN);
  });
});

describe("redaction: credentials", () => {
  it("removes a JWT-shaped token, keeping the sentence around it", () => {
    const redacted = redactDiagnosticText(`handshake refused for ${JWT}`);

    expect(redacted).not.toContain("eyJ");
    expect(redacted).not.toContain(JWT);
    expect(redacted).toContain(TOKEN_PLACEHOLDER);
    expect(redacted).toContain("handshake refused");
  });

  it("removes a Bearer credential while keeping the header it was in", () => {
    // The header with `Authorization:` in front is how it appears in a captured
    // request, which is exactly how it reaches a diagnostic.
    const redacted = redactDiagnosticText(`Authorization: Bearer ${JWT} rejected`);

    expect(redacted).not.toContain(JWT);
    expect(redacted).not.toContain("eyJ");
    // The header name survives: "which header" is diagnosis, the value is not.
    expect(redacted).toContain("Authorization: Bearer <redacted-token>");
    expect(redacted).toContain("rejected");
  });

  it("removes a SHORT Bearer value too, which no shape rule would recognize", () => {
    // Eight characters: below the opaque-run floor and not a JWT or hex, so only
    // the Bearer rule can remove it. A suite that only fed a JWT here would stay
    // green with the Bearer rule deleted, because the JWT rule would cover it.
    const redacted = redactDiagnosticText("Authorization: Bearer abc12345 sent");

    expect(redacted).not.toContain("abc12345");
    expect(redacted).toBe("Authorization: Bearer <redacted-token> sent");
  });

  it("removes the engine's own 64-hex capability token", () => {
    const redacted = redactDiagnosticText(`token file holds ${HEX_TOKEN}`);

    expect(redacted).not.toContain(HEX_TOKEN);
    expect(redacted).not.toContain(HEX_TOKEN.slice(0, 24));
    expect(redacted).toContain(TOKEN_PLACEHOLDER);
  });

  it("removes a long hex-only run, which the digit-guarded safety net leaves alone", () => {
    // 40 `abcdef` characters: hex, 32+ long, and containing no digit - so the
    // opaque-run rule deliberately skips it and only the hex rule can fire. The
    // shape is what a lowercase-hex key of a non-random segment looks like, and
    // without this case deleting the hex rule would go unnoticed.
    const hexOnly = "abcdefabcdefabcdefabcdefabcdefabcdefab";

    const redacted = redactDiagnosticText(`key=${hexOnly}`);

    expect(hexOnly).toHaveLength(38);
    expect(redacted).not.toContain(hexOnly);
    expect(redacted).toContain(TOKEN_PLACEHOLDER);
  });

  it("removes a provider key and leaves the rest of the line alone", () => {
    const redacted = redactDiagnosticText(`provider key ${PROVIDER_KEY} is invalid`);

    expect(redacted).not.toContain(PROVIDER_KEY);
    expect(redacted).not.toContain("sk-live");
    expect(redacted).toContain(TOKEN_PLACEHOLDER);
    expect(redacted).toContain("is invalid");
  });

  it("removes a credential in an endpoint query string, keeping the parameter name", () => {
    // An endpoint URL is a credential carrier: the token may be in the query
    // rather than in the header, and it may be shorter than any shape rule.
    const redacted = redactDiagnosticText(
      "connecting to ws://127.0.0.1:47821/ws?token=abc123&agent=agent-7",
    );

    expect(redacted).not.toContain("abc123");
    expect(redacted).toContain("?token=<redacted-token>");
    // The remaining, non-secret query parameter is still readable.
    expect(redacted).toContain("agent=agent-7");
  });
});

describe("redaction: absolute paths", () => {
  it("removes a Windows absolute path with a real project tree in it", () => {
    const redacted = redactDiagnosticText(`could not read ${WINDOWS_PATH}`);

    expect(redacted).not.toContain(WINDOWS_PATH);
    // A surviving fragment would still leak a user name or a tree shape.
    expect(redacted).not.toContain("Haruyuki-desktop");
    expect(redacted).not.toContain("Projects");
    expect(redacted).toContain(PATH_PLACEHOLDER);
  });

  it("removes a Unix home path, the credential-file shape", () => {
    const redacted = redactDiagnosticText(`could not read ${UNIX_PATH}`);

    expect(redacted).not.toContain(UNIX_PATH);
    expect(redacted).not.toContain(".haruyuki");
    expect(redacted).not.toContain("/home/user");
    expect(redacted).toContain(PATH_PLACEHOLDER);
  });

  it("removes a file URL as one path, rather than one of its segments", () => {
    const redacted = redactDiagnosticText(`reading file:///home/user/.haruyuki/token failed`);

    expect(redacted).not.toContain("/home/user");
    expect(redacted).not.toContain(".haruyuki");
    expect(redacted).toBe(`reading file://${PATH_PLACEHOLDER} failed`);
  });

  it("removes a Windows UNC path", () => {
    const redacted = redactDiagnosticText(String.raw`loaded \\build-host\share\agent\token`);

    expect(redacted).not.toContain("build-host");
    expect(redacted).toContain(PATH_PLACEHOLDER);
  });

  it("removes the whole path even when a segment looks like a credential", () => {
    // Order matters: the path rule runs before the bare credential rules, so the
    // random-looking directory is replaced as part of the path instead of
    // leaving a `<path>` that has one segment swapped for `<redacted-token>`.
    const redacted = redactDiagnosticText(`C:\\Users\\alice\\cache\\${HEX_TOKEN}\\x.json`);

    expect(redacted).toBe(PATH_PLACEHOLDER);
  });
});

describe("redaction: what must survive", () => {
  it("leaves a loopback WebSocket URL readable", () => {
    // The host is the ONE endpoint fact a diagnostic may carry (see
    // describeEndpoint), and the path rules must not eat it.
    expect(redactDiagnosticText("ws://127.0.0.1:47821/ws closed")).toBe(
      "ws://127.0.0.1:47821/ws closed",
    );
  });

  it("leaves capability names, event type names and versions alone", () => {
    for (const text of [
      "conversation.sync",
      "unknown event type: opaque_reply_type",
      "engine 0.6.0",
      "opaque_stream_type",
    ]) {
      expect(redactDiagnosticText(text)).toBe(text);
    }
  });

  it("leaves a long all-letter identifier alone, and this is a stated residual gap", () => {
    // A 32+ run with no digit is far more likely to be an identifier a reader
    // needs than a random key. The documented credential shapes are covered by
    // their own rules; this is the one hole, and it is deliberate.
    const identifier = "unmodelled_stream_chunk_and_the_parser_was_not_ready";

    expect(redactDiagnosticText(identifier)).toBe(identifier);
  });

  it("is total: any string in, a string out, and no rule throws", () => {
    for (const text of ["", "\n", "///", "C:", "?token=", "Bearer ", "eyJ", "sk-"]) {
      expect(redactDiagnosticText(text)).toBeTypeOf("string");
    }
  });
});

describe("record sanitising", () => {
  it("redacts the subject as well as the engine text", () => {
    // `subject` names what the record is about, and a caller that passes a path
    // there would otherwise leak it on the one field nobody thinks to check.
    const sanitized = sanitizeDiagnosticRecord({
      at: 1_700_000_000_000,
      kind: "malformed",
      subject: WINDOWS_PATH,
      engineText: `bad frame near ${UNIX_PATH}`,
      engineVersion: "0.6.0",
    });

    expect(sanitized.subject).toBe(PATH_PLACEHOLDER);
    expect(sanitized.engineText).toBe(`bad frame near ${PATH_PLACEHOLDER}`);
    expect(sanitized.engineVersion).toBe("0.6.0");
  });

  it("drops the optional fields when they were absent, rather than inventing empties", () => {
    const sanitized = sanitizeDiagnosticRecord({
      at: 1_700_000_000_000,
      kind: "timeout",
      subject: "conversation.sync",
    });

    expect(Object.keys(sanitized).sort()).toEqual(["at", "kind", "subject"]);
  });

  it("keeps a timestamp through sanitising, so the redaction pass cannot erase it", () => {
    const sanitized = sanitizeDiagnosticRecord({
      at: 1_700_000_000_123,
      kind: "timeout",
      subject: "conversation.sync",
    });

    expect(sanitized.at).toBe(1_700_000_000_123);
  });

  it("redacts before bounding, so a credential is never cut into a surviving prefix", () => {
    // A 64-hex token starts 16 bytes before the 4 KB cut. Bounding first would
    // leave 16 characters of the token in the stored field: too short for the
    // token rule to recognize, long enough to be a leak.
    const text = `${"x".repeat(4080)}${HEX_TOKEN}`;

    const sanitized = sanitizeDiagnosticRecord({
      at: 1_700_000_000_000,
      kind: "rejected",
      subject: "conversation.sync",
      engineText: text,
    });

    expect(sanitized.engineText).not.toContain(HEX_TOKEN.slice(0, 16));
    expect(sanitized.engineText).not.toMatch(/[0-9a-f]{16}/);
  });

  it("freezes the record, so a subscriber cannot rewrite stored history", () => {
    const log = new DiagnosticLog(1);

    log.record({ kind: "timeout", subject: "conversation.sync" });

    const stored = log.entries()[0];

    expect(stored).toBeDefined();
    expect(Object.isFrozen(stored)).toBe(true);
  });
});

describe("endpoint: the token never enters a diagnostic", () => {
  /** An endpoint whose URL carries the token in BOTH the path and the query. */
  const endpoint: Endpoint = {
    url: `ws://127.0.0.1:47821/session/${JWT}?token=${HEX_TOKEN}`,
    token: HEX_TOKEN,
  };

  it("describes the engine by host:port and nothing else", () => {
    const description = describeEndpoint(endpoint);

    expect(description).toBe("127.0.0.1:47821");
    expect(description).not.toContain(HEX_TOKEN);
    expect(description).not.toContain(JWT);
    expect(description).not.toContain("eyJ");
    // No path, no query, no scheme: any of them can carry a secret or a tree.
    expect(description).not.toContain("/");
    expect(description).not.toContain("?");
    expect(description).not.toContain("ws:");
  });

  it("keeps the token out even when a caller stuffs the whole endpoint into a record", () => {
    // The bad-but-plausible call: `engineText: JSON.stringify(endpoint)`. The
    // fence must still leave neither secret in the stored record.
    const log = new DiagnosticLog(4);

    log.record({
      kind: "send-failed",
      subject: "conversation.sync",
      engineText: JSON.stringify(endpoint),
    });

    const stored = log.entries()[0];

    expect(stored?.engineText).not.toContain(HEX_TOKEN);
    expect(stored?.engineText).not.toContain(JWT);
    expect(stored?.engineText).not.toContain("eyJ");
  });

  it("falls back to a placeholder for an unparsable URL instead of echoing it", () => {
    // A URL that will not parse is the one whose secret may sit where no rule
    // looks; echoing it is the one answer that cannot be checked.
    const broken: Endpoint = { url: `not a url ${HEX_TOKEN}`, token: HEX_TOKEN };

    expect(describeEndpoint(broken)).toBe(ENDPOINT_FALLBACK);
    expect(describeEndpoint(broken)).not.toContain(HEX_TOKEN);
  });
});

describe("unknown events: aggregate by type, never per frame", () => {
  it("counts each type, so 155 streaming frames cost one map entry", () => {
    // The names are opaque placeholders on purpose: this file must contain no
    // wire id literal, and the count is what the test is about, not the
    // engine's spelling. The 155/53 pair is the shape of the real corpus (see
    // the corpus group below), where one streaming type is 155 of 295 frames.
    const log = new DiagnosticLog(4);

    for (let index = 0; index < 155; index += 1) {
      log.recordUnknownEvent("opaque_stream_type");
    }

    for (let index = 0; index < 53; index += 1) {
      log.recordUnknownEvent("opaque_loop_type");
    }

    expect(log.unknownEventCount("opaque_stream_type")).toBe(155);
    expect(log.unknownEventCount("opaque_loop_type")).toBe(53);
    expect(log.unknownEventTotal()).toBe(208);
  });

  it("does not grow the ring, because the count is the record", () => {
    // The bug this prevents costs 30% of the buffer: one recording has 155
    // frames of a single high-volume type, and storing them per frame would
    // evict the failures the buffer exists for.
    const log = new DiagnosticLog(512);

    for (let index = 0; index < 155; index += 1) {
      log.recordUnknownEvent("opaque_stream_type");
    }

    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  it("lists the types it saw, in first-appearance order", () => {
    const log = new DiagnosticLog(4);

    log.recordUnknownEvent("topic_report");
    log.recordUnknownEvent("opaque_stream_type");
    log.recordUnknownEvent("topic_report");

    expect(log.unknownEventTypes()).toEqual(["topic_report", "opaque_stream_type"]);
    // A fresh array: a caller sorting the list must not reorder the tally.
    const types = log.unknownEventTypes() as string[];
    types.reverse();
    expect(log.unknownEventTypes()).toEqual(["topic_report", "opaque_stream_type"]);
  });

  it("answers 0 for a type it never saw, instead of an absent value to branch on", () => {
    expect(new DiagnosticLog().unknownEventCount("never_seen")).toBe(0);
  });
});

describe("subscription through the diagnostic log", () => {
  it("delivers the sanitised record, so a live view cannot show a secret", () => {
    const log = new DiagnosticLog(2);
    const seen: DiagnosticRecord[] = [];

    log.onRecord((record) => seen.push(record));
    log.record({ kind: "rejected", subject: "conversation.sync", engineText: `at ${UNIX_PATH}` });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.engineText).toBe(`at ${PATH_PLACEHOLDER}`);
    // The delivered object is the stored one, not the caller's draft.
    expect(seen[0]).toBe(log.entries()[0]);
  });

  it("unsubscribing twice is harmless and stops later delivery", () => {
    const log = new DiagnosticLog(2);
    const seen: DiagnosticRecord[] = [];
    const off = log.onRecord((record) => seen.push(record));

    log.record({ kind: "timeout", subject: "a" });
    off();
    log.record({ kind: "timeout", subject: "b" });

    expect(() => off()).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("timestamp: the log stamps, the caller does not", () => {
  /**
   * A controllable clock: `tick()` advances it by a fixed step.
   *
   * Driving the clock instead of sleeping keeps the monotonicity assertion
   * deterministic: a real `Date.now()` can return the same millisecond twice,
   * which would make a "strictly increasing" expectation flaky rather than
   * wrong.
   */
  function fakeClock(start: number, step: number): { now: () => number; tick: () => void } {
    let current = start;

    return {
      now: () => current,
      tick: () => {
        current += step;
      },
    };
  }

  it("stamps a record whose draft omitted `at`", () => {
    // The whole point of stamping in `record()`: a caller that had to supply a
    // time would write a placeholder. Without the clock read, `at` would be
    // `undefined` here - which `tsc` catches, and which this reads at runtime.
    const clock = fakeClock(1_700_000_000_000, 1);
    const log = new DiagnosticLog(4, clock.now);

    log.record({ kind: "timeout", subject: "conversation.sync" });

    expect(log.entries()[0]?.at).toBe(1_700_000_000_000);
  });

  it("keeps `at` monotonically non-decreasing as the clock advances", () => {
    // RED IF: `record()` stops reading the clock (every stamp becomes the same
    // constant), skips the stamp on some paths, or the guard that keeps a
    // backwards clock from reordering the history is removed.
    const clock = fakeClock(1_700_000_000_000, 250);
    const log = new DiagnosticLog(8, clock.now);

    for (let index = 0; index < 5; index += 1) {
      log.record({ kind: "timeout", subject: `subject-${String(index)}` });
      clock.tick();
    }

    const stamps = log.entries().map((record) => record.at);

    expect(stamps).toHaveLength(5);
    expect(stamps).toEqual([...stamps].sort((left, right) => left - right));
    // Not merely sorted: the clock actually advanced, so the stamps are NOT a
    // repeated constant. A "stamp once, reuse forever" bug passes a sort check
    // and fails this.
    expect(new Set(stamps).size).toBe(5);
    expect(stamps[4]! - stamps[0]!).toBe(4 * 250);
  });

  it("never lets a backwards clock reorder the history", () => {
    // A real clock steps backwards (NTP correction, a resumed suspended
    // machine). Stamps that follow it would make `entries()` unorderable by
    // time, and a reader would conclude the later record happened first.
    let current = 1_700_000_000_000;
    const log = new DiagnosticLog(4, () => current);

    log.record({ kind: "timeout", subject: "before" });

    current -= 5_000; // the clock jumps back five seconds

    log.record({ kind: "timeout", subject: "after" });

    const [first, second] = log.entries();

    expect(second!.at).toBeGreaterThanOrEqual(first!.at);
  });

  it("honours an explicit finite `at`, for a caller that already observed the instant", () => {
    // A caller may hand over a record it already timed; re-stamping it here would move
    // the timestamp away from the frame that produced it.
    const clock = fakeClock(2_000_000_000_000, 1);
    const log = new DiagnosticLog(4, clock.now);

    log.record({ at: 1_700_000_000_042, kind: "rejected", subject: "conversation.sync" });

    expect(log.entries()[0]?.at).toBe(1_700_000_000_042);
  });

  it("replaces an unusable explicit `at` with the clock instead of storing it", () => {
    // `NaN` reaches a renderer as "Invalid Date" and a sort as an unorderable
    // value: a stamp that is not a finite number is worse than a late one.
    const clock = fakeClock(1_700_000_000_000, 1);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const log = new DiagnosticLog(2, clock.now);

      log.record({ at: bad, kind: "timeout", subject: "conversation.sync" });

      expect(log.entries()[0]?.at).toBe(1_700_000_000_000);
    }
  });

  it("clamps an explicit `at` that would go backwards, so the history stays orderable", () => {
    // An explicit stamp is honoured (previous test) up to the point where it
    // contradicts the one guarantee a reader uses: `entries()` is in time order.
    // A caller that hands over an earlier instant than the record already stored
    // has a bug; silently reordering the buffer would hide it and break sorting.
    const log = new DiagnosticLog(4, () => 1_700_000_000_000);

    log.record({ at: 1_700_000_500_000, kind: "timeout", subject: "later" });
    log.record({ at: 1_700_000_100_000, kind: "timeout", subject: "earlier" });

    const [first, second] = log.entries();

    expect(first?.at).toBe(1_700_000_500_000);
    // Clamped up to the newest stamp already stored, not accepted as given.
    expect(second?.at).toBe(1_700_000_500_000);
    expect(second!.at).toBeGreaterThanOrEqual(first!.at);
  });

  it("gives every stored record a readable time, so 'it broke just now' is answerable", () => {
    // The diagnostic surface must carry code, operation, TIME
    // and engine version. This is the one that had nowhere to live before.
    const log = new DiagnosticLog(4);

    log.record({ kind: "malformed", subject: "conversation.sync" });

    const [record] = log.entries();

    expect(record?.at).toBeTypeOf("number");
    expect(Number.isInteger(record?.at)).toBe(true);
    expect(Number.isFinite(record?.at)).toBe(true);
  });

  it("carries `at` through redaction and truncation unchanged", () => {
    // A number is not engine text, so there is nothing in it to redact; a pass
    // that dropped it would silently strip the one field a report needs.
    const log = new DiagnosticLog(2);
    const stamp = 1_700_000_000_777;

    log.record({
      at: stamp,
      kind: "rejected",
      subject: WINDOWS_PATH,
      engineText: `${UNIX_PATH} ${"z".repeat(5000)}`,
    });

    const [record] = log.entries();

    expect(record?.at).toBe(stamp);
    expect(record?.subject).toBe(PATH_PLACEHOLDER);
  });
});

// --- the corpus fact the aggregation decision rests on ----------------------

/** Repo root, resolved from this file rather than from the process cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The recorded wire corpus. */
const RECORDINGS_DIR = path.join(REPO_ROOT, "fixtures", "engine", "recordings");

/** One wire line: a direction and a decoded message. */
type WireLine = { readonly dir: "s2c" | "c2s"; readonly msg: { readonly type: string } };

/** True for a JSON object, the only shape a recording line may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a decoded line is a wire frame with a typed message. */
function isWireLine(value: unknown): value is WireLine {
  return (
    isObject(value) &&
    (value["dir"] === "s2c" || value["dir"] === "c2s") &&
    isObject(value["msg"]) &&
    typeof value["msg"]["type"] === "string"
  );
}

describe("recorded corpus arithmetic", () => {
  it("has 295 s2c frames, one type at 155 of them, and 19 distinct types", async () => {
    // Deliberately name-free (no wire id literal under `client/`). The
    // fact under test is arithmetic - one type is more than half the corpus -
    // and that is also the fact the "count, do not store" decision rests on, so
    // asserting the MAXIMUM is stricter than naming a particular type: a corpus
    // where a different type became the dominant one would still fail.
    //
    // HISTORY, so nobody "fixes" this back: this assertion originally read
    // `expect(counts.get(<the engine's dominant streaming type name>)).toBe(155)`
    // - i.e. it spelled the wire id of the dominant event type. That is a wire
    // id literal, and one is forbidden anywhere under `client/`, tests included.
    // It was rewritten to assert the maximum frequency instead, which is
    // semantically equivalent for the fact being pinned (155 of 295, i.e. one
    // dominant type) and strictly stronger as a regression guard (a different
    // type becoming dominant fails too). Do not restore the literal: the name is
    // deliberately NOT reproduced here, because writing it in a comment is the
    // same violation as writing it in code.
    const names = (await readdir(RECORDINGS_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
    const counts = new Map<string, number>();
    let s2c = 0;

    for (const name of names) {
      const text = await readFile(path.join(RECORDINGS_DIR, name), "utf8");

      for (const line of text.split("\n")) {
        if (line.trim() === "") {
          continue;
        }

        const record: unknown = JSON.parse(line);

        if (!isWireLine(record) || record.dir !== "s2c") {
          continue;
        }

        s2c += 1;
        counts.set(record.msg.type, (counts.get(record.msg.type) ?? 0) + 1);
      }
    }

    const frequencies = [...counts.values()].sort((left, right) => right - left);

    expect(names).toHaveLength(7);
    expect(s2c).toBe(295);
    expect(frequencies[0]).toBe(155);
    expect(counts.size).toBe(19);
    // 155 of 295: more than half the corpus is one streaming type, which is why
    // storing it per frame would consume 30% of a 512-record buffer.
    expect(frequencies[0]! / s2c).toBeGreaterThan(0.5);
  });

  it("costs the ring nothing to replay the whole corpus through the tally", async () => {
    // Feeding every s2c frame through `recordUnknownEvent` is the design's core
    // claim: 295 frames, 0 records retained, per-type counts intact.
    const names = (await readdir(RECORDINGS_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
    const log = new DiagnosticLog();

    for (const name of names) {
      const text = await readFile(path.join(RECORDINGS_DIR, name), "utf8");

      for (const line of text.split("\n")) {
        if (line.trim() === "") {
          continue;
        }

        const record: unknown = JSON.parse(line);

        if (isWireLine(record) && record.dir === "s2c") {
          log.recordUnknownEvent(record.msg.type);
        }
      }
    }

    const perType = log.unknownEventTypes().map((type) => log.unknownEventCount(type));

    expect(log.size).toBe(0);
    expect(log.unknownEventTotal()).toBe(295);
    expect(log.unknownEventTypes()).toHaveLength(19);
    expect(Math.max(...perType)).toBe(155);
  });
});

describe("knob pinning: the exported vocabulary is the documented one", () => {
  it("pins the placeholder strings, so a rewrite is a failing test not a silent change", () => {
    // If these move, every archived diagnostic file changes meaning; a test that
    // used the constants on both sides would follow the change silently.
    expect(TOKEN_PLACEHOLDER).toBe("<redacted-token>");
    expect(PATH_PLACEHOLDER).toBe("<path>");
    expect(ENDPOINT_FALLBACK).toBe("<unparsable-endpoint>");
  });

  it("keeps the ring capacity at 512", () => {
    expect(new DiagnosticLog().capacity).toBe(512);
    expect(new BoundedRing<number>(512).capacity).toBe(512);
  });

  it("notifies exactly once per stored record, never twice", () => {
    const log = new DiagnosticLog(4);
    const listener = vi.fn();

    log.onRecord(listener);
    log.record({ kind: "timeout", subject: "a" });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
