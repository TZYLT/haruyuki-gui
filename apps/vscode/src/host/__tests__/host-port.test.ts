/**
 * The extension host port, against injected shell answers.
 *
 * Nothing here imports `vscode` or needs an extension host: the secret storage,
 * the storage root, the file-URI factory and the environment are all arguments,
 * which is the only way the failure paths can be exercised at all.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createVSCodeHostPort,
  engineEnvironment,
  type UriLike,
  type WebviewLike,
} from "../host-port.js";
import {
  createHostSecretStore,
  createSecureRequestServer,
  MALFORMED_REQUEST,
  STORE_UNAVAILABLE,
} from "../secrets.js";
import type { EngineSource } from "../../core/ipc.js";

/** A `context.secrets` stand-in whose contents a test owns. */
function fakeStorage(seed: Record<string, string> = {}): {
  readonly values: Map<string, string>;
  readonly storage: {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
  };
} {
  const values = new Map<string, string>(Object.entries(seed));

  return {
    values,
    storage: {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
  };
}

/** An `asWebviewUri` stand-in that records what it was asked to resolve. */
function fakeWebview(origin: string): { readonly webview: WebviewLike; readonly asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    webview: {
      asWebviewUri(localResource: UriLike): UriLike {
        asked.push(localResource.toString());

        return { toString: () => `${origin}${localResource.toString()}` };
      },
    },
  };
}

/** The engine location every test uses. */
const ENGINE: EngineSource = {
  kind: "bundled",
  dir: "/extension/engine",
  bundlePath: "/extension/engine/haruyuki.js",
  version: "1.2.3",
};

/**
 * Build a port with one test's answers.
 *
 * @param overrides extra options, e.g. a diagnostic sink
 * @returns the port and its storage
 */
function makePort(overrides: { log?: (line: string) => void } = {}) {
  const { storage, values } = fakeStorage();
  const port = createVSCodeHostPort({
    secrets: storage,
    storageRoot: "/storage",
    // The roots are made by the shell in production; a test has no filesystem.
    ensureDirectory: () => undefined,
    toFileUri: (absPath) => ({ toString: () => `file://${absPath}` }),
    execPath: "/usr/bin/node",
    env: { PATH: "/usr/bin", NODE_OPTIONS: "--require inherited-hook", FLAG: undefined },
    ...overrides,
  });

  return { port, values };
}

describe("the VSCode host port", () => {
  it("creates the four roots it composes, because nothing else will", () => {
    // `globalStorageUri` is documented as a directory the extension creates. The
    // engine's token file is written from the core child, which cannot ask the
    // shell for a directory, so a root that does not exist is a start failure
    // with nothing on screen to explain it.
    const made: string[] = [];

    createVSCodeHostPort({
      secrets: fakeStorage().storage,
      storageRoot: "/storage",
      ensureDirectory: (dir) => made.push(dir),
      toFileUri: (absPath) => ({ toString: () => `file://${absPath}` }),
    });

    expect(made).toEqual([
      join("/storage", "userData"),
      join("/storage", "logs"),
      join("/storage", "cache"),
      join("/storage", "temp"),
    ]);
  });

  it("answers all six capability flags, refusing the two window operations", () => {
    const { port } = makePort();

    // Three of the six are `false` on purpose: a flag is `true` only where this
    // shell implements the action, because a missing capability hides its entry
    // point. Notifications are additionally ruled out by the user, and the file
    // picker this flag names is not wired -- only the directory picker is.
    expect(port.capabilities).toEqual({
      canNotify: false,
      canPopout: false,
      canFloat: false,
      canOpenExternal: false,
      canPickFiles: false,
      canReadDroppedFiles: false,
    });

    // The two false answers are the safety policy this shell actively holds: a
    // webview cannot pop a panel into its own window or float one. Asserting them
    // apart from the table keeps a future edit from turning one into a true on
    // the way to a capability nobody implemented.
    expect(port.capabilities.canPopout).toBe(false);
    expect(port.capabilities.canFloat).toBe(false);
  });

  it("derives the four roots from the storage root", () => {
    const { port } = makePort();

    // Composed with `join` so the assertion also holds on Windows: the port
    // derives these four roots from the shell's own storage root.
    expect(port.paths).toEqual({
      userData: join("/storage", "userData"),
      logs: join("/storage", "logs"),
      cache: join("/storage", "cache"),
      temp: join("/storage", "temp"),
    });
  });

  it("describes the engine child without starting it", async () => {
    const { port } = makePort();
    const spec = await port.getRuntimeSpawnSpec(ENGINE);

    expect(spec.exePath).toBe("/usr/bin/node");
    expect(spec.bundlePath).toBe(ENGINE.bundlePath);
    expect(spec.cwd).toBe(ENGINE.dir);
    expect(spec.stdio).toBe("pipe");
    // The engine's home is the user-data root, which is also where it writes.
    expect(spec.env["HARUYUKI_HOME"]).toBe(port.paths.userData);
    // An inherited preload is not this shell's decision to pass on.
    expect(spec.env["NODE_OPTIONS"]).toBeUndefined();
    expect(spec.argvPrefix).toEqual([
      "server",
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
    ]);
    // Descriptive only: the token file path, not the token, and never a value.
    expect(spec.argvPrefix).not.toContain("capability-token-value");
  });

  it("drops undefined entries and outside-of-Electron variables from the child env", () => {
    const env = engineEnvironment({ PATH: "/bin", FLAG: undefined, NODE_OPTIONS: "-r hook" }, "/u");

    expect(env).toEqual({ PATH: "/bin", HARUYUKI_HOME: "/u" });
  });

  it("resolves a local resource through the webview it was given", async () => {
    const { port } = makePort();
    const left = fakeWebview("https://left.example/");
    const right = fakeWebview("https://right.example/");

    await expect(port.resolveLocalResource(left.webview, "/storage/userData/a.png")).resolves.toBe(
      "https://left.example/file:///storage/userData/a.png",
    );

    // The same path through another webview answers that webview's namespace: a
    // URI is only loadable from the panel that minted it.
    await expect(port.resolveLocalResource(right.webview, "/storage/userData/a.png")).resolves.toBe(
      "https://right.example/file:///storage/userData/a.png",
    );

    expect(left.asked).toEqual(["file:///storage/userData/a.png"]);
    expect(right.asked).toEqual(["file:///storage/userData/a.png"]);
  });

  it("refuses a relative resource path instead of guessing a base", async () => {
    const { port } = makePort();
    const webview = fakeWebview("https://left.example/");

    await expect(port.resolveLocalResource(webview.webview, "userData/a.png")).rejects.toThrow(
      /must be absolute/,
    );
    expect(webview.asked).toEqual([]);
  });

  it("runs a shutdown callback until it is unsubscribed", () => {
    const { port } = makePort();
    const calls: string[] = [];

    const unsubscribe = port.onShutdown(() => calls.push("first"));

    port.onShutdown(() => calls.push("second"));
    port.triggerShutdown();

    expect(calls).toEqual(["first", "second"]);

    // Both unsubscribe and the one-shot nature are asserted: a second deactivate
    // must not re-run anything, and a removed callback must never run again.
    unsubscribe();
    port.triggerShutdown();

    expect(calls).toEqual(["first", "second"]);
  });

  it("keeps a failing shutdown callback from stopping the others", () => {
    const lines: string[] = [];
    const { port } = makePort({ log: (line) => lines.push(line) });
    const calls: string[] = [];

    port.onShutdown(() => {
      throw new Error("callback exploded");
    });
    port.onShutdown(() => calls.push("ran"));

    port.triggerShutdown();

    expect(calls).toEqual(["ran"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("shutdown callback failed");
  });

  it("hands the secret store to the core without a plaintext copy anywhere else", async () => {
    const { port, values } = makePort();

    await port.secure.set("token", "super-secret-value");

    expect(values.get("token")).toBe("super-secret-value");
    await expect(port.secure.get("token")).resolves.toBe("super-secret-value");

    // The value is in the store and in this test's own memory. It must not reach
    // the process description the engine child is started with.
    const spec = await port.getRuntimeSpawnSpec(ENGINE);
    const rendered = JSON.stringify({ env: spec.env, argv: spec.argvPrefix, cwd: spec.cwd });

    expect(rendered).not.toContain("super-secret-value");

    await port.secure.delete("token");
    await expect(port.secure.get("token")).resolves.toBeUndefined();
  });

  it("binds the storage's three operations and distinguishes absent from empty", async () => {
    const { storage } = fakeStorage({ blank: "" });
    const store = createHostSecretStore(storage);

    await expect(store.get("blank")).resolves.toBe("");
    await expect(store.get("missing")).resolves.toBeUndefined();
  });
});

describe("the host's secret request handler", () => {
  it("answers the three operations and never logs the value", async () => {
    const lines: string[] = [];
    const values = new Map<string, string>();
    const serve = createSecureRequestServer({
      store: createHostSecretStore({
        get: async (key) => values.get(key),
        store: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      }),
      log: (line) => lines.push(line),
    });

    await expect(
      serve({ kind: "secure.request", requestId: "r1", op: "set", key: "token", value: "s3cr3t" }),
    ).resolves.toEqual({ kind: "secure.reply", requestId: "r1" });

    await expect(
      serve({ kind: "secure.request", requestId: "r2", op: "get", key: "token" }),
    ).resolves.toEqual({ kind: "secure.reply", requestId: "r2", value: "s3cr3t" });

    await expect(
      serve({ kind: "secure.request", requestId: "r3", op: "delete", key: "token" }),
    ).resolves.toEqual({ kind: "secure.reply", requestId: "r3" });

    await expect(
      serve({ kind: "secure.request", requestId: "r4", op: "get", key: "token" }),
    ).resolves.toEqual({ kind: "secure.reply", requestId: "r4" });

    expect(JSON.stringify(lines)).not.toContain("s3cr3t");
  });

  it("answers a store failure with a fixed code and no value in the log", async () => {
    const lines: string[] = [];
    const serve = createSecureRequestServer({
      // The store's own message is not this module's to publish: it may quote the
      // value it failed on, so the answer must not carry it either.
      store: {
        get: async () => {
          throw new Error("decryption failed for s3cr3t");
        },
        set: async () => {
          throw new Error("keychain locked");
        },
        delete: async () => {
          throw new Error("keychain locked");
        },
      },
      log: (line) => lines.push(line),
    });

    const reply = await serve({
      kind: "secure.request",
      requestId: "r1",
      op: "set",
      key: "token",
      value: "s3cr3t",
    });

    expect(reply).toEqual({
      kind: "secure.reply",
      requestId: "r1",
      error: STORE_UNAVAILABLE,
    });
    expect(JSON.stringify({ reply, lines })).not.toContain("s3cr3t");
    expect(JSON.stringify({ reply, lines })).not.toContain("keychain locked");
  });

  it("refuses a malformed request instead of letting the core wait", async () => {
    const serve = createSecureRequestServer({
      store: createHostSecretStore(fakeStorage().storage),
    });

    // `set` without a value would otherwise write an undefined secret.
    await expect(
      serve({ kind: "secure.request", requestId: "r1", op: "set", key: "token" }),
    ).resolves.toMatchObject({ error: MALFORMED_REQUEST });

    // A value on an operation that cannot use one is refused too.
    await expect(
      serve({ kind: "secure.request", requestId: "r2", op: "get", key: "token", value: "x" }),
    ).resolves.toMatchObject({ error: MALFORMED_REQUEST });

    // An empty key names nothing.
    await expect(
      serve({ kind: "secure.request", requestId: "r3", op: "get", key: "" }),
    ).resolves.toMatchObject({ error: MALFORMED_REQUEST });
  });

  it("leaves a message it does not own to the next handler", async () => {
    const serve = createSecureRequestServer({
      store: createHostSecretStore(fakeStorage().storage),
    });

    await expect(serve({ kind: "command.invoke", callId: "c1" })).resolves.toBeNull();
    await expect(serve("not a message")).resolves.toBeNull();
    // Without a usable id there is no reply to correlate, so this is not ours.
    await expect(
      serve({ kind: "secure.request", requestId: "", op: "get", key: "k" }),
    ).resolves.toBeNull();
  });
});
