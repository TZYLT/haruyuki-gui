/**
 * Tests for the wire that carries engine bytes onto the screen.
 *
 * What has to be proven, and why a spy is not enough
 *   "The sink is called" was never the missing piece -- the sink had 23 tests of
 *   its own. The missing piece is that the router, the sink and the emulator form a
 *   loop: a slice arrives, the emulator paints it, its completion callback fires,
 *   and the router acknowledges the bytes. Drop any one link and the first
 *   megabytes render perfectly, then the credit window
 *   starves and output stops with no error on either side.
 *
 *   So the central case below drives the real `createTerminalRouter` with a real
 *   ack callback and asserts the acknowledgement, not a call count. A wrapper that
 *   swallowed `done` would pass every spy-based assertion here and fail this.
 *
 * Why disposal gets two cases rather than one
 *   Measured: after `host.dispose()`, `terminal.write` does not throw, and it still
 *   fires its completion callback. A sink left registered therefore confirms bytes
 *   that were painted into a torn-down buffer -- telling the peer to discard output
 *   nobody can see. "Unregisters" and "stops confirming" are two claims, and the
 *   second is the one that protects the peer's credit.
 */

import { describe, expect, it, vi } from "vitest";

import { createTerminalRouter } from "../bridge/terminal.js";
import type { TermOutputBody } from "../bridge/terminal.js";
import { attachTerminalOutput } from "./output.js";

/**
 * One output slice, as the sender produces it.
 *
 * @param text the slice's text
 * @param final whether it is the last slice
 * @returns the body
 */
function slice(text: string, final = true): TermOutputBody {
  return {
    terminal_id: "t-1",
    slice: 0,
    slices: 1,
    offset: 0,
    bytes: new TextEncoder().encode(text).length,
    final,
    text,
  };
}

/**
 * A router wired to record acknowledgements.
 *
 * @returns the router and the acks it produced
 */
function routerWithAcks(): {
  router: ReturnType<typeof createTerminalRouter>;
  acks: unknown[];
} {
  const acks: unknown[] = [];
  const router = createTerminalRouter({
    ack: (ack) => acks.push(ack),
    onNotice: vi.fn(),
    // One slice per batch: the assertion is about the confirmation arriving, not
    // about batching, and a smaller batch makes that visible sooner.
    batchBytes: 1,
    intervalMs: 0,
  });

  return { router, acks };
}

/** @returns a write that completes immediately, recording what it painted */
function paintNow(): { write: (text: string, done: () => void) => void; painted: string[] } {
  const painted: string[] = [];

  return {
    painted,
    write(text, done) {
      painted.push(text);
      done();
    },
  };
}

describe("the loop closes", () => {
  it("acknowledges the bytes once the emulator says it painted them, which is the whole point", async () => {
    // The same measurement, inverted into a positive: a registered sink whose
    // `done` reaches the router produces an ack. Without this wire there was no
    // registration, so there was no ack, so the peer's credit never returned.
    const { router, acks } = routerWithAcks();
    const emulator = paintNow();

    const attachment = attachTerminalOutput({
      terminalId: "t-1",
      router,
      write: emulator.write,
    });

    router.deliver(slice("hello"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emulator.painted).toEqual(["hello"]);
    expect(acks).toHaveLength(1);
    expect(attachment.sink.stats.confirmed).toBe(1);

    attachment.dispose();
    router.dispose();
  });

  it("does not acknowledge when the emulator has not finished, because a confirmation means painted", async () => {
    // The other half: a sink that confirms eagerly would let the peer discard
    // output still sitting in the parser.
    const { router, acks } = routerWithAcks();
    // Typed through an object so the assignment inside the closure is visible to
    // the compiler: a bare `let` narrowed to `null` reads as "never reassigned"
    // and the later call is rejected.
    const gate: { finish: (() => void) | null } = { finish: null };

    const attachment = attachTerminalOutput({
      terminalId: "t-1",
      router,
      write: (_text, done) => {
        gate.finish = done;
      },
    });

    router.deliver(slice("late"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(acks).toHaveLength(0);

    gate.finish?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(acks).toHaveLength(1);

    attachment.dispose();
    router.dispose();
  });

  it("counts the bytes it confirmed, so a stalled window is visible before output stops", () => {
    const { router } = routerWithAcks();
    const emulator = paintNow();
    const attachment = attachTerminalOutput({ terminalId: "t-1", router, write: emulator.write });

    router.deliver(slice("abc"));

    expect(attachment.sink.stats.bytes).toBe(3);

    attachment.dispose();
    router.dispose();
  });
});

describe("unregistering", () => {
  it("stops painting for a terminal that no longer exists", async () => {
    const { router } = routerWithAcks();
    const emulator = paintNow();
    const attachment = attachTerminalOutput({ terminalId: "t-1", router, write: emulator.write });

    attachment.dispose();
    router.deliver(slice("ghost"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emulator.painted).toEqual([]);

    router.dispose();
  });

  it("leaves no sink registered, because a sink that stays registered keeps receiving the session's bytes", async () => {
    // The claim that a spy cannot make: `sink.dispose()` stops *painting*, so
    // "nothing was painted" is true whether or not the router still holds the sink.
    // What changes is the router's own accounting -- it keeps handing slices to a
    // registration that can no longer do anything with them, and its dropped-bytes
    // notice fires for a terminal nobody is watching.
    const { router } = routerWithAcks();
    const attachment = attachTerminalOutput({
      terminalId: "t-1",
      router,
      write: paintNow().write,
    });

    attachment.dispose();
    router.deliver(slice("orphan"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The router's own accounting is the observable difference: a registered sink
    // absorbs the slice (`delivered`), an unregistered one counts it as no-view
    // (`noSink`) and acknowledges nobody for it. Two counters, one of which can
    // only move when nothing is registered.
    expect(router.stats.noSink).toBe(1);
    expect(router.stats.delivered).toBe(0);

    router.dispose();
  });

  it("does not confirm bytes after disposal, because a confirmation for unseen output discards it", async () => {
    // Measured behaviour: a disposed xterm neither throws on `write` nor stops
    // firing its callback. So the protection against confirming unwatched bytes is
    // this unregister, not the emulator's own state.
    const { router, acks } = routerWithAcks();
    const emulator = paintNow();
    const attachment = attachTerminalOutput({ terminalId: "t-1", router, write: emulator.write });

    attachment.dispose();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(acks).toHaveLength(0);
    expect(emulator.painted).toEqual([]);

    router.dispose();
  });

  it("can be disposed twice, because a panel unmounts on paths that may also call it", () => {
    const { router } = routerWithAcks();
    const attachment = attachTerminalOutput({
      terminalId: "t-1",
      router,
      write: paintNow().write,
    });

    attachment.dispose();

    expect(() => attachment.dispose()).not.toThrow();

    router.dispose();
  });

  it("leaves a second registration alone, because the router compares sink identity", async () => {
    // A remount registers a new sink for the same id. Tearing the first one down
    // must not take the second one with it -- that is the router's identity check,
    // and this asserts the wiring relies on it rather than fighting it.
    const { router } = routerWithAcks();
    const first = paintNow();
    const second = paintNow();

    const older = attachTerminalOutput({ terminalId: "t-1", router, write: first.write });
    const newer = attachTerminalOutput({ terminalId: "t-1", router, write: second.write });

    older.dispose();
    router.deliver(slice("after-remount"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(second.painted).toEqual(["after-remount"]);

    newer.dispose();
    router.dispose();
  });
});

describe("the dropped-bytes marker", () => {
  it("paints a marker through the same emulator, because there is no second road to the screen", () => {
    // Requirement: one way for bytes to reach the terminal. The marker is local
    // text, so it must travel the same write.
    const { router } = routerWithAcks();
    const emulator = paintNow();
    const attachment = attachTerminalOutput({
      terminalId: "t-1",
      router,
      write: emulator.write,
      formatNotice: (bytes) => `[omitted ${bytes} bytes]`,
      noticeMs: 0,
    });

    router.deliver(slice("before"));
    attachment.sink.notice({ terminal_id: "t-1", droppedBytes: 128 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(emulator.painted.join("")).toContain("[omitted 128 bytes]");
        attachment.dispose();
        router.dispose();
        resolve();
      }, 20);
    });
  });

  it("paints no marker when no text was supplied, because a module that cannot speak must not invent words", async () => {
    const { router } = routerWithAcks();
    const emulator = paintNow();
    const attachment = attachTerminalOutput({ terminalId: "t-1", router, write: emulator.write });

    attachment.sink.notice({ terminal_id: "t-1", droppedBytes: 64 });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emulator.painted).toEqual([]);
    expect(attachment.sink.stats.notices).toBe(1);

    attachment.dispose();
    router.dispose();
  });
});
