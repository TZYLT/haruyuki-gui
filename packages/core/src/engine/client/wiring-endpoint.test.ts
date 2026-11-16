/**
 * `Engine.endpoint` 的验收，以及 token 的泄漏面。
 *
 * 约束：`endpoint` 只在 `ready` 时非 `null`；不能用 `socketState` 代理，因为 socket
 * 会在握手答复前打开；token 不得进入日志、诊断包或崩溃记录。
 *
 * ## 为什么跑在真门面上
 *
 * `endpoint` 是 B2 开第 2..N 条连接**唯一**的数据来源，所以「它何时为 `null`」
 * 有用户可见后果：在尚未确认可用的引擎上开 N 条连接，若握手随后失败，N 条全是
 * 废的，且错误会以「多通道各自失败」的形式出现，掩盖真正的单点原因。
 *
 * 因此这里不构造「看起来像门面」的替身，而是用 `startTracking` 走**真实的
 * `start`**：url 由子进程 stdout 发现、token 由门面自己生成并写盘。替身会让
 * 「token 到底在不在对象上」变成测我自己传进去的值。
 *
 * ## 边界 2 为什么单独成组
 *
 * 「永不进日志、诊断包、崩溃记录」里，崩溃记录最常见的取值方式就是
 * `JSON.stringify`。这条曾经真的破过：字段原来是 TypeScript `private`，运行时
 * 被擦除，明文 token 因此出现在序列化结果里。所以用例必须在 **token 确实已存入**
 * 之后读对象面——一个从未持有 token 的门面会让断言空转通过。
 */

import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_VERSION,
  fakeEngineSource,
  fakeEngineSpec,
  makeRoot,
  releaseFixtures,
  startHandshakeStub,
  startTracking,
} from "../engine-test-support";
import { Engine } from "../engine";
import type { EngineState } from "../types";

afterEach(async () => {
  // Stops every engine this file started and removes the temp roots: a leaked
  // child process outlives the assertion that created it and skews the next case.
  await releaseFixtures();
});

/* --- `endpoint` vs `state`, on the real facade --- */

/**
 * Start a fake engine through the real `start` path and hand back the live facade.
 *
 * The child is the shared launcher, so the facade discovers the URL from stdout
 * exactly as it does in production - which is why the endpoint cannot be
 * reconstructed by the caller and had to be exposed. Every
 * case below starts HERE rather than on a hand-built stub so that the token and
 * URL under test are genuinely inside the facade.
 *
 * @param options stub behaviour, handshake budget, and observers installed before
 *   `start` so they can sample the transitions as they happen
 * @returns the engine and the states it reported, in order
 */
async function startFakeEngine(
  options: {
    readonly answer?: boolean;
    readonly handshakeTimeoutMs?: number;
    readonly onState?: (state: EngineState, engine: Engine) => void;
    readonly onFrame?: (engine: Engine) => void;
  } = {},
): Promise<{ engine: Engine; states: EngineState[] }> {
  const root = await makeRoot();
  const stub = await startHandshakeStub(options.answer === false ? { answer: false } : {});
  const engine = startTracking();
  const states: EngineState[] = [];
  engine.onState((state) => {
    states.push(state);
    options.onState?.(state, engine);
  });
  if (options.onFrame !== undefined) {
    const onFrame = options.onFrame;
    engine.onFrame(() => onFrame(engine));
  }

  await engine.start({
    spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, `${root}/engine.pid`), root),
    tokenDir: root,
    expectedEngineVersion: ENGINE_VERSION,
    portTimeoutMs: 5_000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 2_000,
  });

  return { engine, states };
}

/** One sampled moment: the facade state, the transport state, the endpoint. */
interface Sample {
  readonly state: EngineState;
  readonly socketState: string;
  readonly hasEndpoint: boolean;
}

describe("endpoint: non-null only in ready", () => {
  it("is null on a fresh facade", () => {
    const engine = startTracking();

    expect(engine.state).toBe("idle");
    expect(engine.endpoint).toBeNull();
  });

  it("exposes nothing in spawning or handshaking, and everything in ready", async () => {
    const samples: Sample[] = [];
    await startFakeEngine({
      onState: (state, engine) => {
        samples.push({
          state,
          socketState: engine.socketState,
          hasEndpoint: engine.endpoint !== null,
        });
      },
    });

    // Every non-ready state is closed: a
    // `socketState`-proxy getter answers non-null for `handshaking` because the
    // socket opens before the handshake answer arrives.
    const beforeReady = samples.filter((row) => row.state !== "ready");
    expect(beforeReady.length).toBeGreaterThan(0);
    for (const row of beforeReady) {
      expect(row.hasEndpoint, `state "${row.state}" must not expose an endpoint`).toBe(false);
    }

    const ready = samples.filter((row) => row.state === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.hasEndpoint).toBe(true);
  });

  it("is null at the moment the socket opens but the handshake has not answered", async () => {
    // The window this case is about, sampled from inside it. A frame listener runs when
    // the raw frame arrives: after `openSocket` set `socketState = "open"` and
    // before the handshake promise resumes the continuation that reaches `ready`.
    // It is the only place a test can stand in that gap without racing a timer.
    const gap: Sample[] = [];
    const { engine } = await startFakeEngine({
      onFrame: (live) => {
        if (live.state === "handshaking") {
          gap.push({
            state: live.state,
            socketState: live.socketState,
            hasEndpoint: live.endpoint !== null,
          });
        }
      },
    });

    // The sampled shape is what proves which gate the getter uses: transport says
    // "open", facade says "handshaking", endpoint says "not yet". Mutating the gate
    // to `socketState` makes this the failing assertion.
    expect(gap.length).toBeGreaterThan(0);
    for (const row of gap) {
      expect(row.socketState).toBe("open");
      expect(row.hasEndpoint).toBe(false);
    }
    expect(engine.endpoint).not.toBeNull();
  });

  it("reports the discovered url and a real token, stable and frozen", async () => {
    const { engine } = await startFakeEngine();
    const endpoint = engine.endpoint;

    expect(endpoint).not.toBeNull();
    if (endpoint === null) {
      return;
    }

    // The URL is the one the child printed: a wrong URL never completes the
    // handshake against this stub, so reaching `ready` proves it. `generateToken()`
    // is 32 bytes of random material, so a short value would not be the token.
    expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(endpoint.token.length).toBeGreaterThan(12);
    expect(endpoint.token).not.toContain(" ");

    // One object per ready attempt, so a caller can compare or cache it; frozen,
    // because the value is a report and not a control.
    expect(engine.endpoint).toBe(endpoint);
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(() => {
      (endpoint as { url: string }).url = "ws://127.0.0.1:1/nope";
    }).toThrow();
  });

  it("returns to null after stopGraceful and after kill", async () => {
    const graceful = await startFakeEngine();
    expect(graceful.engine.endpoint).not.toBeNull();
    await graceful.engine.stopGraceful(1_000);
    expect(graceful.engine.state).toBe("closed");
    expect(graceful.engine.endpoint).toBeNull();

    const killed = await startFakeEngine();
    expect(killed.engine.endpoint).not.toBeNull();
    killed.engine.kill();
    expect(killed.engine.endpoint).toBeNull();
  });

  it("never exposes an endpoint during a start that fails in handshaking", async () => {
    // The stub accepts the upgrade and never answers, so the socket reaches
    // `"open"` while the facade is still `handshaking` - §3.6.2.1 driven end to
    // end, including the `failed` state that follows.
    const samples: Sample[] = [];
    await expect(
      startFakeEngine({
        answer: false,
        handshakeTimeoutMs: 150,
        onState: (state, engine) => {
          samples.push({
            state,
            socketState: engine.socketState,
            hasEndpoint: engine.endpoint !== null,
          });
        },
      }),
    ).rejects.toThrow();

    expect(samples.length).toBeGreaterThan(0);
    for (const row of samples) {
      expect(row.hasEndpoint, `state "${row.state}" must not expose an endpoint`).toBe(false);
    }
  });
});

/* --- no token in a crash record --- */

/**
 * Everything a crash reporter, a structured log line or a debugger would read.
 *
 * Three surfaces, because they traverse differently: `JSON.stringify` walks own
 * enumerable properties (what a crash handler serialises), `util.inspect` also
 * shows non-enumerable and typed-array/Map contents (what a terminal dump and many
 * loggers print), and the spread copies own enumerable properties into a new plain
 * object (what a hand-written "just the fields" log line does). `Reflect.ownKeys`
 * is the superset that catches a symbol or non-enumerable field.
 *
 * @param engine the facade to read
 * @returns the text of every surface, concatenated
 */
function inspectableSurface(engine: Engine): string {
  return [
    JSON.stringify(engine) ?? "",
    inspect(engine, { depth: 8, showHidden: true }),
    JSON.stringify({ ...engine }) ?? "",
    Reflect.ownKeys(engine)
      .map((key) => String(key))
      .join(","),
  ].join("\n");
}

describe("the facade does not leak the endpoint", () => {
  // The endpoint never enters a log, a diagnostic bundle
  // or a crash record. A crash record is `JSON.stringify` of whatever the process
  // held, so the token must not be reachable through the ordinary object surface.
  //
  // This was a real defect: the field was a TypeScript `private`, which is erased
  // at runtime, so `JSON.stringify(engine)` printed the plaintext token. The tests
  // below therefore start a REAL engine and read its surface only once the token
  // is genuinely stored - a facade that never held one would pass trivially and
  // prove nothing.

  it("keeps a stored token and url off json, inspect, spread and ownKeys", async () => {
    const { engine } = await startFakeEngine();
    const endpoint = engine.endpoint;
    expect(endpoint).not.toBeNull();
    if (endpoint === null) {
      return;
    }

    // The premise: the secret really is inside the facade at this moment, so a
    // passing assertion cannot be explained by an empty object.
    const surface = inspectableSurface(engine);
    expect(endpoint.token.length).toBeGreaterThan(12);

    // The assertion, in two halves so a failure names the surface.
    expect(JSON.stringify(engine), "a crash record must not carry the token").not.toContain(
      endpoint.token,
    );
    expect(inspect(engine, { depth: 8 }), "an inspect dump must not carry it").not.toContain(
      endpoint.token,
    );
    expect(JSON.stringify({ ...engine }), "a spread must not carry it").not.toContain(
      endpoint.token,
    );

    // And no key names it, so a reader cannot even find the field to ask for it.
    const keys = Reflect.ownKeys(engine).map(String);
    expect(keys, "no own key names the endpoint").not.toContain("readyEndpoint");
    expect(keys).not.toContain("#readyEndpoint");
    expect(keys).not.toContain("endpoint");
    expect(surface).not.toContain("token-that-must-not-be-printed");
  });

  it("is genuinely private: no outside assignment can plant an endpoint", async () => {
    // A `#private` field cannot be reached from outside, and that is asserted
    // rather than assumed - if the field were ever softened back to `private`, a
    // crash reporter could serialise it AND a test could plant one. Here the plant
    // must fail, and a probe property must not become a back door.
    const { engine } = await startFakeEngine();
    const planted = { url: "ws://127.0.0.1:1/planted", token: "planted-token-value-123456" };

    // Assigning the old field name creates an ordinary own property - the point is
    // that this is all it can do, and that it is NOT the field the getter reads.
    Object.defineProperty(engine, "readyEndpoint", { value: planted, configurable: true });
    expect(engine.endpoint).not.toEqual(planted);
    expect(engine.endpoint?.token).not.toBe(planted.token);

    // Whatever an attacker plants is visible (it is a plain property); what must
    // never be visible is the real value. Both halves are asserted.
    expect(inspectableSurface(engine)).not.toContain(engine.endpoint?.token ?? "\u0000");
  });
});
