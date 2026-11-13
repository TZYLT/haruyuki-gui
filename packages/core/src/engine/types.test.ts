/**
 * Contract tests for the frozen engine type surface.
 *
 * This file is the cheap tripwire for the layer above: if a later work package
 * widens a union, drops a spawn field or renames a wire-facing field, these
 * assertions fail before any spawn or socket code runs. Two kinds of check are
 * mixed on purpose:
 *
 * - compile-time, via `satisfies` and exhaustive `Record` tables, so a missing or
 *   extra member is a type error at the exact line that drifted;
 * - runtime, via the exported tuples, so the value lists that tests and logs walk
 *   are verified too, not just their types.
 */

import { describe, expect, it } from "vitest";

import { ENGINE_ERROR_CODES, ENGINE_STATES } from "./types";
import type {
  AppServerInfo,
  EngineError,
  EngineErrorCode,
  EngineEvent,
  EngineSpawnSpec,
  EngineState,
} from "./types";

describe("EngineState", () => {
  it("lists the seven lifecycle states in contract order", () => {
    expect([...ENGINE_STATES]).toEqual([
      "idle",
      "spawning",
      "handshaking",
      "ready",
      "closing",
      "closed",
      "failed",
    ]);
  });

  it("covers every state member exactly once", () => {
    // Compile-time: a missing or extra key is a type error here.
    const covered: Record<EngineState, true> = {
      idle: true,
      spawning: true,
      handshaking: true,
      ready: true,
      closing: true,
      closed: true,
      failed: true,
    };

    expect(Object.keys(covered).sort()).toEqual([...ENGINE_STATES].sort());
    expect(new Set(ENGINE_STATES).size).toBe(ENGINE_STATES.length);
  });
});

describe("EngineErrorCode", () => {
  it("has exactly the five documented codes", () => {
    expect([...ENGINE_ERROR_CODES]).toEqual([
      "SPAWN_FAILED",
      "PORT_NOT_FOUND",
      "AUTH_FAILED",
      "PROTOCOL_MISMATCH",
      "TIMEOUT",
    ]);
    expect(new Set(ENGINE_ERROR_CODES).size).toBe(5);
  });

  it("covers every code member exactly once", () => {
    const covered: Record<EngineErrorCode, true> = {
      SPAWN_FAILED: true,
      PORT_NOT_FOUND: true,
      AUTH_FAILED: true,
      PROTOCOL_MISMATCH: true,
      TIMEOUT: true,
    };

    expect(Object.keys(covered).sort()).toEqual([...ENGINE_ERROR_CODES].sort());
  });

  it("builds one error per code with a non-empty detail", () => {
    const errors = ENGINE_ERROR_CODES.map(
      (code) =>
        ({
          code,
          detail: `simulated ${code}`,
        }) satisfies EngineError,
    );

    expect(errors).toHaveLength(5);
    for (const error of errors) {
      expect(error.detail).not.toBe("");
      // exactOptionalPropertyTypes: the key must be absent, not undefined.
      expect(Object.hasOwn(error, "wireHint")).toBe(false);
    }
  });

  it("keeps the wire hint optional and untouched when supplied", () => {
    const withHint = {
      code: "AUTH_FAILED",
      detail: "unexpected-response status 401",
      wireHint: "unexpected-response statusCode=401",
    } satisfies EngineError;

    expect(withHint.wireHint).toContain("401");
  });
});

describe("AppServerInfo", () => {
  it("accepts a local backend payload and keeps raw opaque", () => {
    const info = {
      protocolVersion: 1,
      engineVersion: "0.6.0",
      backend: "local",
      raw: {
        type: "app_server_info_response",
        request_id: "probe-1",
        success: true,
        capabilities: { agent_management: true },
      },
    } satisfies AppServerInfo;

    expect(info.protocolVersion).toBe(1);
    expect(info.engineVersion).toBe("0.6.0");
    expect(info.backend).toBe("local");
    expect(info.raw).toBeTypeOf("object");
  });

  it("covers both backend modes", () => {
    // Compile-time: adding a backend mode without updating this table fails.
    const covered: Record<AppServerInfo["backend"], true> = {
      local: true,
      api: true,
    };

    expect(Object.keys(covered).sort()).toEqual(["api", "local"]);
  });
});

describe("EngineSpawnSpec", () => {
  const spec = {
    exePath: "C:\\Program Files\\nodejs\\node.exe",
    env: { HARUYUKI_HOME: "C:\\tmp\\isolate", USERPROFILE: "C:\\tmp\\isolate" },
    argvPrefix: ["server", "--listen", "ws://127.0.0.1:0"],
    bundlePath: "C:\\repo\\_research\\engine-0.6.0\\package\\haruyuki.js",
    cwd: "C:\\tmp\\isolate",
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  } satisfies EngineSpawnSpec;

  it("exposes exactly the eight documented fields", () => {
    expect(Object.keys(spec).sort()).toEqual([
      "argvPrefix",
      "bundlePath",
      "cwd",
      "detached",
      "env",
      "exePath",
      "stdio",
      "windowsHide",
    ]);
    expect(Object.keys(spec)).toHaveLength(8);
  });

  it("pins stdio to pipe and keeps the platform flags boolean", () => {
    expect(spec.stdio).toBe("pipe");
    expect(spec.windowsHide).toBe(true);
    expect(spec.detached).toBe(false);
    expect(Array.isArray(spec.argvPrefix)).toBe(true);
    expect(spec.env).toBeTypeOf("object");
  });
});

describe("EngineEvent", () => {
  const events = [
    { type: "state", state: "ready" },
    { type: "error", error: { code: "TIMEOUT", detail: "port discovery timed out" } },
    { type: "frame", at: 1_700_000_000_000 },
  ] satisfies EngineEvent[];

  it("covers the three observable variants", () => {
    // Compile-time: a new event variant without a table entry fails here.
    const covered: Record<EngineEvent["type"], true> = {
      state: true,
      error: true,
      frame: true,
    };

    expect(Object.keys(covered).sort()).toEqual(["error", "frame", "state"]);
  });

  it("narrows on the discriminant", () => {
    for (const event of events) {
      switch (event.type) {
        case "state":
          expect(event.state).toBe("ready");
          break;
        case "error":
          expect(event.error.code).toBe("TIMEOUT");
          break;
        case "frame":
          expect(event.at).toBe(1_700_000_000_000);
          break;
        default: {
          // Exhaustiveness: an unhandled variant makes this line a type error.
          const unreachable: never = event;
          throw new Error(`unhandled engine event: ${String(unreachable)}`);
        }
      }
    }

    expect(events).toHaveLength(3);
  });
});
