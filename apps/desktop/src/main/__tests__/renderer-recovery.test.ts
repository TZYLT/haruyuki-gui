import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createRendererRecovery,
  reloadNormalPage,
  type RendererRecoveryDeps,
} from "../crash/renderer-recovery.js";
import type { CrashLog } from "../crash/wiring.js";

/** A window whose load/reload outcomes the test scripts. */
class FakeWebContents extends EventEmitter {
  url = "app://haruyuki/index.html?theme=light&locale=en";

  constructor(private readonly reloadOutcome: "ok" | "fail") {
    super();
  }

  getURL(): string {
    return this.url;
  }

  /** Finish the reload on the next microtask, after the listener is attached. */
  emitReloadOutcome(): void {
    queueMicrotask(() => {
      this.emit(this.reloadOutcome === "ok" ? "did-finish-load" : "did-fail-load");
    });
  }
}

class FakeWindow {
  readonly webContents: FakeWebContents;
  readonly loaded: string[] = [];
  reloads = 0;
  destroyed = false;
  private url = "app://haruyuki/index.html?theme=light&locale=en";

  constructor(reloadOutcome: "ok" | "fail" = "ok") {
    this.webContents = new FakeWebContents(reloadOutcome);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.url;
  }

  reload(): void {
    this.reloads += 1;
    this.webContents.emitReloadOutcome();
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    this.url = url;
    this.webContents.url = url;

    return Promise.resolve();
  }
}

function asWindow(window: FakeWindow): RendererRecoveryDeps["window"] {
  return window as unknown as RendererRecoveryDeps["window"];
}

function quietLog(): CrashLog {
  return () => undefined;
}

describe("reloadNormalPage", () => {
  it("resolves true when the normal page finishes loading", async () => {
    const window = new FakeWindow("ok");

    await expect(reloadNormalPage(asWindow(window), quietLog())).resolves.toBe(true);
    expect(window.reloads).toBe(1);
  });

  it("resolves false when the reload fails", async () => {
    const window = new FakeWindow("fail");

    await expect(reloadNormalPage(asWindow(window), quietLog())).resolves.toBe(false);
  });
});

describe("createRendererRecovery", () => {
  it("reloads the normal page on the first crash and does not show the error page", async () => {
    const window = new FakeWindow("ok");
    const showFallback = vi.fn();
    const recover = createRendererRecovery({
      window: asWindow(window),
      appScheme: "app",
      log: quietLog(),
      showFallback,
    });

    recover("crashed", 2);
    await Promise.resolve();
    await Promise.resolve();

    expect(window.reloads).toBe(1);
    expect(window.loaded).toEqual([]);
    expect(showFallback).not.toHaveBeenCalled();
  });

  it("shows the D4 error page on the second crash", async () => {
    const window = new FakeWindow("ok");
    const showFallback = vi.fn();
    const recover = createRendererRecovery({
      window: asWindow(window),
      appScheme: "app",
      log: quietLog(),
      showFallback,
    });

    recover("crashed", 2);
    await Promise.resolve();
    await Promise.resolve();
    recover("crashed", 2);
    await Promise.resolve();

    expect(window.loaded).toHaveLength(1);
    expect(window.loaded[0]).toContain("crash=renderer");
    expect(showFallback).not.toHaveBeenCalled();
  });

  it("uses the static page after the error page has died", async () => {
    const window = new FakeWindow("ok");
    const showFallback = vi.fn();
    const recover = createRendererRecovery({
      window: asWindow(window),
      appScheme: "app",
      log: quietLog(),
      showFallback,
    });

    recover("crashed", 2);
    await Promise.resolve();
    await Promise.resolve();
    recover("crashed", 2);
    await Promise.resolve();
    recover("crashed", 2);
    await Promise.resolve();

    expect(showFallback).toHaveBeenCalledTimes(1);
  });

  it("shows the error page when the first normal reload fails", async () => {
    const window = new FakeWindow("fail");
    const showFallback = vi.fn();
    const recover = createRendererRecovery({
      window: asWindow(window),
      appScheme: "app",
      log: quietLog(),
      showFallback,
    });

    recover("crashed", 2);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(window.loaded).toHaveLength(1);
    expect(window.loaded[0]).toContain("crash=renderer");
  });
});
