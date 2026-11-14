/**
 * Tests for the snapshot normaliser.
 *
 * Requirement source: docs/17-A3 section 5.1 `V-8` (a golden file is byte-equal
 * across two runs and volatile fields are normalised); contract source:
 * docs/18-A3 section 3.4.5 and section 1.2 `R-05`.
 *
 * The cases pin the four ways a snapshot goes unstable: timestamps and ids,
 * machine-specific paths, object key insertion order, and values JSON cannot
 * carry. `undefined` is proved distinct from `null`, and a cycle is proved to
 * become a string instead of throwing.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFramesFixture } from "./fixture";
import { reduce } from "./reducer";
import {
  CYCLE_PLACEHOLDER,
  PATH_PLACEHOLDER,
  UNDEFINED_PLACEHOLDER,
  VOLATILE_PLACEHOLDER,
  normalizeForSnapshot,
} from "./snapshot";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Absolute path of one bridge corpus member. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/bridge/${name}`, import.meta.url));
}

/* ------------------------------------------------------------------ */
/* two runs, same bytes                                                */
/* ------------------------------------------------------------------ */

describe("normalizeForSnapshot", () => {
  it("turns one fixture snapshot into the same bytes on two runs", async () => {
    const fixture = await loadFramesFixture(fixturePath("three-channels.jsonl"));
    const payload = {
      header: fixture.header,
      frames: fixture.frames,
      state: reduce(fixture.frames),
      emitted_at: "2024-03-01T10:30:00.000Z",
      idempotency_key: "idem-1",
      request_id: "req-1",
      pid: 4242,
      at: 1709289000000,
      recordedFrom: fixturePath("three-channels.jsonl"),
      scratch: path.join(tmpdir(), "haruyuki-snapshot", "frames.jsonl"),
    };

    const first = JSON.stringify(normalizeForSnapshot(payload));
    const second = JSON.stringify(normalizeForSnapshot(payload));
    const normalized = normalizeForSnapshot(payload) as Record<string, unknown>;

    expect(second).toBe(first);
    expect(normalized.emitted_at).toBe(VOLATILE_PLACEHOLDER);
    expect(normalized.idempotency_key).toBe(VOLATILE_PLACEHOLDER);
    expect(normalized.request_id).toBe(VOLATILE_PLACEHOLDER);
    expect(normalized.pid).toBe(VOLATILE_PLACEHOLDER);
    expect(normalized.at).toBe(VOLATILE_PLACEHOLDER);
    expect(normalized.recordedFrom).toBe(PATH_PLACEHOLDER);
    expect(normalized.scratch).toBe(PATH_PLACEHOLDER);
    // Volatile values and machine paths must not survive into the golden text.
    expect(first).not.toContain("2024-03-01T10:30:00.000Z");
    expect(first).not.toContain("req-1");
    expect(first).not.toContain(String(4242));
    expect(first).not.toContain(tmpdir());
  });

  it("sorts object keys and preserves array order", () => {
    const normalized = normalizeForSnapshot({
      b: 1,
      a: { d: 4, c: 3 },
      list: [3, 1, 2],
    });

    expect(JSON.stringify(normalized)).toBe('{"a":{"c":3,"d":4},"b":1,"list":[3,1,2]}');
    expect(normalizeForSnapshot({ a: { c: 3, d: 4 }, b: 1, list: [3, 1, 2] })).toEqual(normalized);
  });

  it("keeps undefined distinct from null and still returns JSON-able data", () => {
    const normalized = normalizeForSnapshot({
      missing: undefined,
      empty: null,
      list: [undefined, null],
    }) as Record<string, unknown>;

    expect(normalized.missing).toBe(UNDEFINED_PLACEHOLDER);
    expect(normalized.empty).toBeNull();
    expect(normalized.list).toEqual([UNDEFINED_PLACEHOLDER, null]);
    expect(() => JSON.stringify(normalized)).not.toThrow();
    expect(JSON.stringify(normalized)).toContain(`"${UNDEFINED_PLACEHOLDER}"`);
  });

  it("reports a cycle as a string instead of throwing", () => {
    const node: Record<string, unknown> = { name: "root", list: [] };
    const child: Record<string, unknown> = { parent: node };
    const list = node.list as unknown[];

    node.child = child;
    list.push(node);

    const normalized = normalizeForSnapshot(node);

    expect(normalized).toEqual({
      child: { parent: CYCLE_PLACEHOLDER },
      list: [CYCLE_PLACEHOLDER],
      name: "root",
    });
    expect(JSON.stringify(normalized)).toBe(
      '{"child":{"parent":"<cycle>"},"list":["<cycle>"],"name":"root"}',
    );
  });

  it("replaces values JSON cannot carry with named strings", () => {
    const normalized = normalizeForSnapshot({
      when: new Date("2024-01-02T03:04:05.000Z"),
      map: new Map([["a", 1]]),
      set: new Set([1]),
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
    });

    expect(normalized).toEqual({
      infinite: "<number:Infinity>",
      map: "<map>",
      nan: "<number:NaN>",
      set: "<set>",
      when: "2024-01-02T03:04:05.000Z",
    });
  });

  it("replaces a volatile value at any depth", () => {
    const normalized = normalizeForSnapshot({
      outer: { at: 1, keep: "value", inner: { request_id: "req-2" } },
    });

    expect(normalized).toEqual({
      outer: {
        at: VOLATILE_PLACEHOLDER,
        inner: { request_id: VOLATILE_PLACEHOLDER },
        keep: "value",
      },
    });
  });
});

/* ------------------------------------------------------------------ */
/* paths from another machine                                          */
/* ------------------------------------------------------------------ */

describe("path normalisation", () => {
  it("gives one placeholder to the same temp path on different machines", () => {
    const posix = normalizeForSnapshot({ file: "/var/folders/ab/T/haruyuki-run/frames.jsonl" });
    const windows = normalizeForSnapshot({
      file: "C:\\Users\\John Doe\\AppData\\Local\\Temp\\haruyuki-run\\frames.jsonl",
    });
    const local = normalizeForSnapshot({
      file: path.join(tmpdir(), "haruyuki-run", "frames.jsonl"),
    });

    expect(windows).toEqual(posix);
    expect(local).toEqual(posix);
    expect(posix).toEqual({ file: PATH_PLACEHOLDER });
  });

  it("normalises home directories and absolute paths in values and keys", () => {
    const home = normalizeForSnapshot({
      linux: "/home/alice/project/file.ts",
      mac: "/Users/John Doe/project/file.ts",
      windowsHome: "C:\\Users\\alice\\project\\file.ts",
      absolute: "/opt/haruyuki/fixtures/bridge/three-channels.jsonl",
    });

    expect(home).toEqual({
      absolute: PATH_PLACEHOLDER,
      linux: PATH_PLACEHOLDER,
      mac: PATH_PLACEHOLDER,
      windowsHome: PATH_PLACEHOLDER,
    });

    const keyed = normalizeForSnapshot({ [fixturePath("three-channels.jsonl")]: 1, b: 2 });

    expect(keyed).toEqual({ [PATH_PLACEHOLDER]: 1, b: 2 });
  });

  it("leaves a URL alone, so a snapshot does not hide an endpoint", () => {
    expect(normalizeForSnapshot("endpoint https://example.com/a/b")).toBe(
      "endpoint https://example.com/a/b",
    );
  });

  it("uses caller rules instead of the defaults when they are supplied", () => {
    const rules = { volatileKeys: [], pathPatterns: [/secret-[a-z0-9]+/g] };

    expect(normalizeForSnapshot({ at: 1, token: "secret-abc" }, rules)).toEqual({
      at: 1,
      token: PATH_PLACEHOLDER,
    });
  });
});
