/**
 * Tests for the frame-body serializability guard (`./validate`).
 *
 * The cases are grouped by what a producer actually gets wrong: a value class
 * that `JSON.stringify` rewrites or refuses, a violation hidden deep inside an
 * otherwise valid body, and the two structural limits (cycle, depth) that a
 * naive walk fails on. Path assertions are exact strings rather than "contains"
 * checks, because the whole point of the guard is telling an author which field
 * to fix.
 *
 * `toJSON` has its own block that pins the documented decision: the hook is NOT
 * honored. Those tests would fail if somebody "fixed" the validator by calling
 * the hook, which is exactly when the decision needs re-reading.
 */

import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  assertSerializable,
  findSerializationViolation,
  FRAME_NOT_SERIALIZABLE,
  FrameSerializationError,
  MAX_DEPTH,
  type SerializationViolationKind,
} from "./validate";

/** One nested-deep case: how to build it, and the exact violation expected. */
interface ViolationCase {
  readonly label: string;
  readonly make: () => unknown;
  readonly path: string;
  readonly kind: SerializationViolationKind;
}

/**
 * Wrap `value` in `depth` single-element arrays.
 *
 * Used for the depth boundary: the wrapper count is the number of edges to the
 * value, which is what {@link MAX_DEPTH} counts.
 */
function wrapInArrays(value: unknown, depth: number): unknown {
  let current: unknown = value;

  for (let index = 0; index < depth; index += 1) {
    current = [current];
  }

  return current;
}

describe("illegal value classes", () => {
  const cases: readonly ViolationCase[] = [
    {
      label: "a Date instance",
      make: () => ({ createdAt: new Date(0) }),
      path: "createdAt",
      kind: "date",
    },
    {
      label: "a Map instance",
      make: () => ({ lookup: new Map([["a", 1]]) }),
      path: "lookup",
      kind: "map",
    },
    {
      label: "a Set instance",
      make: () => ({ seen: new Set([1, 2]) }),
      path: "seen",
      kind: "set",
    },
    {
      label: "a BigInt built with the BigInt function",
      make: () => ({ count: BigInt(10) }),
      path: "count",
      kind: "bigint",
    },
    {
      label: "a BigInt literal",
      make: () => ({ count: 10n }),
      path: "count",
      kind: "bigint",
    },
    {
      label: "an undefined object property",
      make: () => ({ present: 1, missing: undefined }),
      path: "missing",
      kind: "undefined",
    },
    {
      label: "an undefined array element",
      make: () => [1, undefined],
      path: "[1]",
      kind: "undefined",
    },
    {
      // A hole is not a value, but every read of it yields undefined, and
      // JSON.stringify writes it as null, so the guard has to reject it.
      label: "an array hole, which reads as undefined",
      make: () => [, 1],
      path: "[0]",
      kind: "undefined",
    },
    {
      label: "a function property",
      make: () => ({ onClick: () => undefined }),
      path: "onClick",
      kind: "function",
    },
    {
      label: "a symbol property value",
      make: () => ({ tag: Symbol("tag") }),
      path: "tag",
      kind: "symbol",
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.label} at ${testCase.path}`, () => {
      expect(findSerializationViolation(testCase.make())).toEqual({
        path: testCase.path,
        kind: testCase.kind,
      });
    });
  }

  it("reports a top-level illegal value at the empty path", () => {
    expect(findSerializationViolation(new Date(0))).toEqual({ path: "", kind: "date" });
    expect(findSerializationViolation(undefined)).toEqual({ path: "", kind: "undefined" });
    expect(findSerializationViolation(1n)).toEqual({ path: "", kind: "bigint" });
  });

  it("keeps function, symbol and undefined in separate classes", () => {
    const kinds = [
      findSerializationViolation(() => undefined),
      findSerializationViolation(Symbol("s")),
      findSerializationViolation(undefined),
    ].map((violation) => violation?.kind);

    expect(kinds).toEqual(["function", "symbol", "undefined"]);
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("precise paths", () => {
  it("names the field of a violation buried in a valid body", () => {
    const body = {
      body: {
        deep: {
          items: [
            { ok: 1, at: "2024-01-01" },
            { ok: 2, when: new Date(0) },
          ],
        },
      },
    };

    expect(findSerializationViolation(body)).toEqual({
      path: "body.deep.items[1].when",
      kind: "date",
    });
  });

  it("joins object properties with a dot and array positions with [n]", () => {
    const body = {
      root: {
        list: [{ nested: [{ fine: true }] }, { nested: [{ broken: new Map() }] }],
      },
    };

    expect(findSerializationViolation(body)?.path).toBe("root.list[1].nested[0].broken");
  });

  it("reports the first violation in walk order", () => {
    const body = {
      first: undefined,
      second: new Date(0),
    };

    expect(findSerializationViolation(body)).toEqual({ path: "first", kind: "undefined" });
  });

  it("walks class instances as their plain serializable shape", () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }

    expect(findSerializationViolation({ point: new Point(1, 2) })).toBeNull();
  });
});

describe("cycles", () => {
  it("reports a self-reference at the field that points back", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(findSerializationViolation(node)).toEqual({ path: "self", kind: "cycle" });
  });

  it("reports a mutual reference at the second hop", () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    first.peer = second;
    second.peer = first;

    expect(findSerializationViolation(first)).toEqual({ path: "peer.peer", kind: "cycle" });
  });

  it("reports a cycle inside an array element", () => {
    const node: Record<string, unknown> = {};
    node.children = [node];

    expect(findSerializationViolation(node)).toEqual({
      path: "children[0]",
      kind: "cycle",
    });
  });

  it("allows the same object in two sibling fields, which is a copy on the wire", () => {
    const shared = { value: 1 };

    expect(findSerializationViolation({ left: shared, right: shared })).toBeNull();
  });
});

describe("depth", () => {
  it("has the documented cap", () => {
    expect(MAX_DEPTH).toBe(64);
  });

  it("accepts a value that is exactly MAX_DEPTH edges deep", () => {
    expect(findSerializationViolation(wrapInArrays(1, MAX_DEPTH))).toBeNull();
  });

  it("rejects a value that is MAX_DEPTH + 1 edges deep", () => {
    expect(findSerializationViolation(wrapInArrays(1, MAX_DEPTH + 1))).toEqual({
      path: "[0]".repeat(MAX_DEPTH + 1),
      kind: "depth",
    });
  });

  it("reports depth rather than crashing the stack on a very deep chain", () => {
    const violation = findSerializationViolation(wrapInArrays(1, 10_000));

    expect(violation?.kind).toBe("depth");
  });
});

describe("legal values", () => {
  const legal: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["true", true],
    ["false", false],
    ["an integer", 42],
    ["negative zero", -0],
    ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["an empty string", ""],
    ["a unicode string", "\u00e9\u4e2d\u6587 \u{1f600}"],
    ["an empty object", {}],
    ["an empty array", []],
    ["a plain object", { a: 1, b: "two", c: true, d: null }],
    ["a nested array", [1, [2, [3, []]]]],
    ["a nested combination", { a: [{ b: { c: [null, true, "x", 0] } }], d: [] }],
  ];

  for (const [label, value] of legal) {
    it(`accepts ${label}`, () => {
      expect(findSerializationViolation(value)).toBeNull();
      expect(() => assertSerializable(value)).not.toThrow();
    });
  }

  it("accepts a real frame-shaped body", () => {
    const body = {
      v: 1,
      ch: "control",
      seq: 7,
      t: "control.ready",
      body: { items: [{ id: "a", tags: ["x", "y"], score: 1.5 }] },
    };

    expect(() => assertSerializable(body)).not.toThrow();
  });
});

describe("assertSerializable", () => {
  it("throws a coded error carrying the path and kind", () => {
    let caught: unknown;

    try {
      assertSerializable({ a: { b: [{ c: new Set() }] } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FrameSerializationError);
    expect(caught).toBeInstanceOf(Error);

    const error = caught as FrameSerializationError;
    expect(error.code).toBe(FRAME_NOT_SERIALIZABLE);
    expect(error.name).toBe("FrameSerializationError");
    expect(error.path).toBe("a.b[0].c");
    expect(error.kind).toBe("set");
    expect(error.message).toContain("a.b[0].c");
    expect(error.message).toContain("set");
  });

  it("names the root when the value itself is the violation", () => {
    let caught: unknown;

    try {
      assertSerializable(new Date(0));
    } catch (error) {
      caught = error;
    }

    expect((caught as FrameSerializationError).path).toBe("");
    expect((caught as FrameSerializationError).message).toContain("<root>");
  });

  it("never throws for a legal value", () => {
    expect(() => assertSerializable({ ok: [1, "two", null, { three: true }] })).not.toThrow();
  });
});

/*
 * `toJSON` is not honored: see the module comment. `JSON.stringify` would call
 * these hooks and produce text, but the guard refuses the hook itself, because
 * honoring it would run arbitrary code, could return another illegal value, and
 * would make a `Date` -- the first rejected class -- look valid. A producer that
 * wants a `toJSON` shape must call it before handing the value over.
 */
describe("toJSON is not honored", () => {
  it("refuses an object that defines toJSON, where JSON.stringify would succeed", () => {
    const value = {
      createdAt: {
        toJSON: () => "2024-01-01T00:00:00.000Z",
      },
    };

    expect(JSON.stringify(value)).toBe('{"createdAt":"2024-01-01T00:00:00.000Z"}');

    // `to-json`, not `function`: the path names the value that carries the hook
    // rather than the method inside it. Reporting the method was an accident of
    // walking own keys, and it stopped being accurate once the prototype chain
    // is checked too (a class method has no own-key path to name).
    expect(findSerializationViolation(value)).toEqual({
      path: "createdAt",
      kind: "to-json",
    });
  });

  it("refuses a toJSON inherited from a class prototype", () => {
    // `Object.keys` never sees a prototype method, so the own-key walk let this
    // through while `JSON.stringify` rewrote the payload to whatever the method
    // returned. A class is the shape that actually appears in a codebase.
    class Money {
      constructor(private readonly cents: number) {}

      toJSON(): string {
        return `MONEY:${String(this.cents)}`;
      }
    }

    const value = { price: new Money(100) };

    expect(JSON.stringify(value)).toBe('{"price":"MONEY:100"}');
    expect(findSerializationViolation(value)).toEqual({ path: "price", kind: "to-json" });
  });

  it("reports a throwing toJSON as a violation instead of letting it escape", () => {
    class Exploding {
      toJSON(): unknown {
        throw new TypeError("toJSON blew up");
      }
    }

    const value = { x: new Exploding() };

    expect(() => JSON.stringify(value)).toThrow(TypeError);
    expect(findSerializationViolation(value)).toEqual({ path: "x", kind: "to-json" });
  });

  it("keeps rejecting a Date even though it defines toJSON", () => {
    const date = new Date(0);

    expect(JSON.stringify({ at: date })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
    expect(findSerializationViolation({ at: date })).toEqual({ path: "at", kind: "date" });
  });

  it("accepts the already-serialized shape a producer computed itself", () => {
    const value = { createdAt: new Date(0).toISOString() };

    expect(findSerializationViolation(value)).toBeNull();
  });
});

describe("values JSON.stringify rewrites", () => {
  it("refuses a non-finite number, which would become null on the wire", () => {
    // `NaN` and both infinities are inside JSON's *grammar* but not its
    // information: the peer cannot tell "not a number" from "absent". The
    // transport double's faithful-copy check rejects them too, so a producer
    // that let one through would order the two halves of the layer differently.
    expect(JSON.stringify({ percent: Number.NaN })).toBe('{"percent":null}');
    expect(findSerializationViolation({ percent: Number.NaN })).toEqual({
      path: "percent",
      kind: "non-finite",
    });

    expect(findSerializationViolation({ elapsed: Number.POSITIVE_INFINITY })).toEqual({
      path: "elapsed",
      kind: "non-finite",
    });

    expect(findSerializationViolation({ elapsed: Number.NEGATIVE_INFINITY })).toEqual({
      path: "elapsed",
      kind: "non-finite",
    });

    // `1e400` overflows to Infinity at parse time, so the literal spelling of a
    // huge number reaches this check as the same value.
    expect(findSerializationViolation(1e400)).toEqual({ path: "", kind: "non-finite" });
  });

  it("refuses the object types that flatten to {} on the wire", () => {
    const cases: readonly { label: string; make: () => Record<string, unknown>; json: string }[] = [
      { label: "a RegExp", make: () => ({ pattern: /a+/g }), json: '{"pattern":{}}' },
      { label: "an Error", make: () => ({ failure: new Error("x") }), json: '{"failure":{}}' },
      { label: "an ArrayBuffer", make: () => ({ raw: new ArrayBuffer(4) }), json: '{"raw":{}}' },
      {
        label: "a typed array",
        make: () => ({ bytes: new Uint8Array([1, 2, 3]) }),
        json: '{"bytes":{"0":1,"1":2,"2":3}}',
      },
    ];

    for (const testCase of cases) {
      const value = testCase.make();

      // The wire value is demonstrably not the value handed in, which is what
      // makes these violations rather than a matter of taste.
      expect(JSON.stringify(value), testCase.label).toBe(testCase.json);
      expect(findSerializationViolation(value), testCase.label).toEqual({
        path: Object.keys(value)[0],
        kind: "lossy-object",
      });
    }
  });

  it("still accepts plain objects and arrays", () => {
    expect(findSerializationViolation({ a: 1, b: [2, 3] })).toBeNull();
    expect(findSerializationViolation(Object.create(null))).toBeNull();
  });

  it("distinguishes an empty property name from the root", () => {
    // `{"": value}` is legal JSON and a real field. Reporting it at "" made the
    // error say "<root>", pointing the reader at the wrong level entirely.
    const value = { "": new Date(0) };

    expect(findSerializationViolation(value)).toEqual({ path: '[""]', kind: "date" });
  });
});

describe("cross-realm values", () => {
  it("refuses a Date, Map and Set created in another realm", () => {
    // `instanceof` compares constructors, and a foreign realm has different
    // ones. The renderer is a separate realm, so a value that crossed a
    // structuredClone or a worker boundary fails every instanceof here. Before
    // the tag check these were walked as empty objects and called valid, while
    // JSON.stringify quietly flattened them.
    const foreign = runInNewContext(
      "({ d: new Date(0), m: new Map([[1, 2]]), s: new Set([1]) })",
    ) as {
      d: object;
      m: object;
      s: object;
    };

    expect(foreign.d instanceof Date).toBe(false);

    expect(findSerializationViolation({ at: foreign.d })).toEqual({ path: "at", kind: "date" });
    expect(findSerializationViolation({ at: foreign.m })).toEqual({ path: "at", kind: "map" });
    expect(findSerializationViolation({ at: foreign.s })).toEqual({ path: "at", kind: "set" });
  });
});

describe("hostile accessors", () => {
  it("reports a throwing getter as a violation instead of throwing out", () => {
    // The module promises a verdict for every input, and the caller can only
    // branch on a coded error. A getter is caller code running inside the walk.
    const value = Object.defineProperty({}, "boom", {
      enumerable: true,
      get(): never {
        throw new Error("getter ran");
      },
    });

    expect(findSerializationViolation(value)).toEqual({ path: "boom", kind: "hostile" });
  });

  it("reports a throwing ownKeys trap as a violation", () => {
    const value = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("trap ran");
        },
      },
    );

    expect(findSerializationViolation(value)).toEqual({ path: "", kind: "hostile" });
  });
});

describe("shared subtrees are walked once", () => {
  it("validates a legal DAG without exponential time", () => {
    // Every level doubles the number of paths to the leaf while the node count
    // grows linearly. Walking per path instead of per node took over eight
    // seconds at depth 26, which is far inside MAX_DEPTH: a reducer that shares
    // one subtree between two fields could stall the send path for seconds.
    const build = (levels: number): unknown => {
      let node: unknown = { leaf: true };

      for (let level = 0; level < levels; level += 1) {
        node = { a: node, b: node };
      }

      return node;
    };

    const started = performance.now();
    const verdict = findSerializationViolation(build(26));
    const elapsed = performance.now() - started;

    expect(verdict).toBeNull();
    // Loose on purpose: the unprotected walk needs ~8 s at this size and doubles
    // per level, while the memoised one is sub-millisecond. The bound only has to
    // separate "linear in nodes" from "exponential in depth" without flaking on
    // a loaded machine.
    expect(elapsed).toBeLessThan(1000);
  });

  it("still reports a real cycle that shares a prefix with a clean subtree", () => {
    const clean = { ok: true };
    const cycle: Record<string, unknown> = { clean, self: null };

    cycle["self"] = cycle;

    expect(findSerializationViolation({ cycle, clean })).toEqual({
      path: "cycle.self",
      kind: "cycle",
    });
  });
});
