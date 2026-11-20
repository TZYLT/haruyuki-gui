/**
 * The differential suite, part two: what the frozen contract does not pin, and
 * the guard rails that keep the comparison honest.
 *
 * Split from `alternate-channel.test.ts` when that file reached the line ceiling.
 * The split is by subject, not by size: everything here is about behaviour the
 * contract deliberately leaves open, or about the harness proving it can fail.
 *
 * ## What a differential suite cannot do
 *
 * Agreement is not correctness. See the long note at the top of
 * `alternate-channel.test.ts`; a green run here licenses "swapping the pool
 * changes nothing above it" and never "the pool is correct".
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CLOSED_PHRASE,
  expectSettlesNow,
  expectStillWaiting,
  makeDual,
  teardownDifferential,
  TRACKED,
} from "./alternate-harness";
import { AlternateChannelPool } from "./alternate-channel";
import { EngineChannel, createChannel } from "./channel";
import { ChannelPoolReentryError, createChannelPool } from "./pool";
import {
  makeClock,
  makeReader,
  makeWriter,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import type { Channel, ChannelPool, CommandResult } from "./types";

afterEach(() => {
  teardownDifferential();
});

describe("behaviour the frozen contract does not pin", () => {
  /**
   * Divergence 1 is **gone**: the readiness prefix of a handle closed before first
   * use (production `was ready and dropped`, the lazy pool `has not become ready`).
   * Fixed by making the facade report the right half, not by redefining the
   * wording - an enrolled slot is one `getChannel` found an
   * endpoint for, and `degraded` is set only by a build that produced nothing.
   */
  it("agree on the readiness prefix of a handle closed before first use", async () => {
    const req = { capability: TRACKED, body: {}, requestId: "req-never" } as const;
    const detailOf = (result: CommandResult): string => (result.ok ? "" : result.error.detail);

    // A handle fetched and closed without a single use. The alternate pool built
    // nothing, so this is the one shape where the facade has to supply the
    // readiness half itself; production built eagerly and got it from the kernel.
    const dual = makeDual();
    const production = dual.production.pool.getChannel("a");
    const alternate = dual.alternate.pool.getChannel("a");
    production.close();
    alternate.close();
    const alternateResult = await expectSettlesNow(alternate.send(req), "the alternate send");
    const productionResult = await expectSettlesNow(production.send(req), "the production send");

    expect(detailOf(alternateResult)).toBe(detailOf(productionResult));
    expect(detailOf(alternateResult)).toContain("channel was ready and dropped");
    // The positive control for assertion 3, reached without a prior use.
    expect(detailOf(alternateResult)).toContain(CLOSED_PHRASE);

    // The no-endpoint shape is asserted by the scripted battery above; here only
    // the contrast that makes the assertion above non-vacuous.
    const degraded = makeDual();
    degraded.production.setEndpoint(() => null);
    degraded.alternate.setEndpoint(() => null);
    const degradedResult = await expectSettlesNow(
      degraded.alternate.pool.getChannel("a").send(req),
      "the alternate send with no endpoint",
    );
    expect(detailOf(degradedResult)).toContain("engine has not become ready");
    expect(detailOf(degradedResult)).not.toBe(detailOf(alternateResult));

    dual.production.pool.closeAll();
    dual.alternate.pool.closeAll();
    degraded.production.pool.closeAll();
    degraded.alternate.pool.closeAll();
  });

  /**
   * Divergence 2 is **gone** ("when is the channel constructed"): both pools return
   * an unremembered stand-in when there is no endpoint, so a fetch before readiness
   * no longer pins the agent to a dead channel. Kept live because this is the
   * sequence that used to differ.
   */
  it("agree that an agent fetched before readiness connects once the endpoint appears", async () => {
    const dual = makeDual();
    dual.production.setEndpoint(() => null);
    dual.alternate.setEndpoint(() => null);

    // 1. Two fetches while the engine has no endpoint: distinct objects, and
    // neither is a connection, so `channels()` is empty.
    const productionEarly = dual.production.pool.getChannel("a");
    const productionEarlyAgain = dual.production.pool.getChannel("a");
    const alternateEarly = dual.alternate.pool.getChannel("a");
    const alternateEarlyAgain = dual.alternate.pool.getChannel("a");
    expect(productionEarlyAgain).not.toBe(productionEarly);
    expect(alternateEarlyAgain).not.toBe(alternateEarly);
    expect(dual.production.pool.channels()).toEqual([]);
    expect(dual.alternate.pool.channels()).toEqual([]);

    // 2. The engine becomes ready and a fresh fetch enrols a real channel - the
    // claim being that the earlier attempts left nothing behind to block it.
    dual.production.setEndpoint(null);
    dual.alternate.setEndpoint(null);
    dual.production.pool.getChannel("a");
    dual.alternate.pool.getChannel("a");
    expect(dual.production.pool.channels()).toHaveLength(1);
    expect(dual.alternate.pool.channels()).toHaveLength(1);

    dual.production.pool.closeAll();
    dual.alternate.pool.closeAll();
  });

  /**
   * The narrowest shape of the bug, and the one a differential suite is worst at:
   * the endpoint is there when `getChannel` enrols the slot and gone when first use
   * constructs. Caching that degraded attempt would leave the agent answering
   * `NOT_CONNECTED` for the session after its endpoint came back, with nothing on
   * the handle to reveal it.
   *
   * Only the alternate pool can reach this - production resolves once, in
   * `getChannel` - which is why it is asserted against one pool rather than
   * compared: a comparison would cover a path only one side has.
   */
  it("does not remember a build that degraded when the endpoint vanished", async () => {
    const dual = makeDual();
    const alternate = dual.alternate;
    // Never enrolled: with no endpoint from the start, a send refuses and leaves
    // the registry empty, so it cannot become a verdict either.
    alternate.setEndpoint(() => null);
    const neverEnrolled = await expectSettlesNow(
      alternate.pool.getChannel("a").send({ capability: TRACKED, body: {}, requestId: "req-none" }),
      "the unenrolled send",
    );
    expect(neverEnrolled.ok).toBe(false);
    expect(alternate.pool.channels()).toEqual([]);

    // Enrolled while the endpoint is live, so `getChannel` has already succeeded.
    alternate.setEndpoint(null);
    alternate.pool.getChannel("a");
    expect(alternate.pool.channels()).toHaveLength(1);

    // The endpoint disappears before the pool constructs.
    alternate.setEndpoint(() => null);
    const ask = (): Promise<CommandResult> =>
      alternate.pool
        .getChannel("a")
        .send({ capability: TRACKED, body: {}, requestId: "req-vanish" });
    const refused = await expectSettlesNow(ask(), "the degraded send");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("NOT_CONNECTED");
      expect(refused.error.detail).toContain("engine has not become ready");
    }
    // The pool no longer claims a connection it does not have.
    expect(alternate.pool.channels()).toEqual([]);

    // Subscribe while the slot is degraded but not yet rebuilt.
    const late: string[] = [];
    alternate.pool.getChannel("a").onEvent((frame) => {
      late.push((frame.raw as { who: string }).who);
    });
    expect(alternate.pool.channels()).toEqual([]);

    // The endpoint returns: the same slot connects, which is impossible if the
    // failed attempt had been remembered.
    alternate.setEndpoint(null);
    const retry = ask();
    await expectStillWaiting(retry, "the retry");
    alternate.ingest(
      "a",
      JSON.stringify({
        type: "known.event",
        reply: { requestId: "req-vanish", ok: true, data: { back: true } },
      }),
    );
    expect((await expectSettlesNow(retry, "the retry answer")).ok).toBe(true);
    expect(alternate.pool.channels()).toHaveLength(1);

    // A subscriber that attached *while the pool was degraded* must still receive
    // frames once it recovers: the failed attempt must not have consumed the one
    // attach the facade is allowed, or every event would be lost in exactly the
    // state that recovers.
    alternate.ingest("a", JSON.stringify({ type: "known.event", who: "after-recovery" }));
    expect(late).toEqual(["after-recovery"]);

    dual.production.pool.closeAll();
    dual.alternate.pool.closeAll();
  });

  /**
   * Divergence 3: a factory that re-enters the pool for the agent it is building.
   *
   * `pool.ts` refuses with `ChannelPoolReentryError`, which the comparison
   * cannot see (not part of the frozen surface, and not on the exported barrel).
   * The alternate pool enrols the slot before building, so the re-entrant call gets
   * the same facade and no error; a send from inside the factory gets a
   * not-connected stand-in rather than recursing.
   *
   * **This is the finding**: the contract says a factory must not do this but
   * nothing about what happens when it does, so two implementations can differ on
   * both the error and the returned object.
   */
  it("differ on what a re-entrant factory call gets (production: throws)", () => {
    const clock = trackClock(makeClock());

    let productionPool: ChannelPool | undefined;
    let productionReentry: Error | null = null;
    let productionSeen: Channel | null = null;
    productionPool = createChannelPool({
      createChannel: (context) => {
        try {
          productionSeen = productionPool?.getChannel(context.agentId) ?? null;
        } catch (error) {
          productionReentry = error as Error;
        }
        const channel = createChannel({
          agentId: context.agentId,
          write: makeWriter().write,
          reader: makeReader(),
          clock: clock.clock,
        });
        trackChannel(channel);
        return channel;
      },
      endpointOf: () => ({ url: "ws://127.0.0.1:1/a", token: "t" }),
      clock: clock.clock,
    });

    const productionChannel = productionPool.getChannel("a");
    expect(productionReentry).toBeInstanceOf(ChannelPoolReentryError);
    expect(productionSeen).toBeNull();
    expect(productionChannel.agentId).toBe("a");

    let alternateSeen: Channel | null = null;
    let alternateReentry: Error | null = null;
    const alternatePool = new AlternateChannelPool({
      createChannel: (context) => {
        try {
          alternateSeen = alternatePool.getChannel(context.agentId);
        } catch (error) {
          alternateReentry = error as Error;
        }
        const channel = createChannel({
          agentId: context.agentId,
          write: makeWriter().write,
          reader: makeReader(),
          clock: clock.clock,
        });
        trackChannel(channel);
        return channel;
      },
      endpointOf: () => ({ url: "ws://127.0.0.1:1/a", token: "t" }),
      clock: clock.clock,
    });

    // Force materialization for the alternate pool, which happens on first use.
    void alternatePool.getChannel("a").capabilities();

    expect(alternateReentry).toBeNull();
    expect(alternateSeen).not.toBeNull();
    // The re-entrant call saw the slot's own facade, which is a *stable* answer:
    // it is the same object the outer call returns.
    expect(alternateSeen).toBe(alternatePool.getChannel("a"));

    // And the divergence itself: one implementation raised, the other answered.
    expect(productionReentry).not.toBeNull();
    expect(alternateReentry).toBeNull();

    productionPool.closeAll();
    alternatePool.closeAll();
  });
});

/* 8. Guard rails */

describe("guard rails", () => {
  it("exposes the same frozen members on both implementations", () => {
    const dual = makeDual();
    for (const channel of [
      dual.production.pool.getChannel("a"),
      dual.alternate.pool.getChannel("a"),
    ]) {
      expect(channel.agentId).toBe("a");
      expect(typeof channel.send).toBe("function");
      expect(typeof channel.onEvent).toBe("function");
      expect(typeof channel.onDiagnostic).toBe("function");
      expect(typeof channel.capabilities).toBe("function");
      expect(typeof channel.close).toBe("function");
    }
    // The type-level assertions live with their definitions in alternate-channel.test.ts.
  });

  it("is not reachable from any barrel", async () => {
    // The comparison pool must stay a test-local artifact. Every barrel that could
    // carry it - the package root and the engine facade - is checked, and each one
    // has to exist: a missing file would make this assertion vacuous, which is the
    // failure mode a path-typo would otherwise produce.
    const { readFileSync } = await import("node:fs");
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const barrels = [
      // packages/core/src/index.ts - the package barrel.
      fileURLToPath(new URL("../../index.ts", import.meta.url)),
      // packages/core/src/engine/index.ts - the engine facade.
      fileURLToPath(new URL("../index.ts", import.meta.url)),
    ];
    for (const barrel of barrels) {
      expect(existsSync(barrel)).toBe(true);
      expect(readFileSync(barrel, "utf8")).not.toMatch(/alternate/i);
    }
  });

  it("is imported only by the differential suite", async () => {
    // The comparison pool and its rig must stay test-local. A file elsewhere
    // importing either one would mean the artifact escaped into production, so
    // the set of importers is asserted exactly rather than merely inspected.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    const clientDir = fileURLToPath(new URL(".", import.meta.url));

    const importersOf = (module: string, except: string): string[] => {
      const found: string[] = [];
      for (const file of readdirSync(clientDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".ts") || file.name === except) {
          continue;
        }
        const source = readFileSync(join(clientDir, file.name), "utf8");
        if (source.includes(`from "./${module}"`)) {
          found.push(file.name);
        }
      }
      return found.sort();
    };

    // The split of the differential suite into two files is visible here on
    // purpose: the set is asserted exactly, so a new importer has to be added
    // deliberately rather than slipping in with a refactor.
    expect(importersOf("alternate-channel", "alternate-channel.ts")).toEqual([
      "alternate-channel.test.ts",
      "alternate-harness.ts",
      "alternate-unpinned.test.ts",
    ]);
    expect(importersOf("alternate-harness", "alternate-harness.ts")).toEqual([
      "alternate-channel.test.ts",
      "alternate-unpinned.test.ts",
    ]);
  });

  it("keeps both pools free of engine wire vocabulary", async () => {
    // The directory-wide gate in `capability-names.test.ts` already scans these
    // files; this asserts that the scan is not vacuous for *these* names, and that
    // the two implementation files never name a frame field. The test file itself
    // is exempt from this one assertion: it has to spell the forbidden words to
    // search a string for them, which is the sanctioned-prose case the directory
    // gate handles by scanning for whole dot-delimited tokens instead.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    for (const name of ["alternate-channel.ts", "alternate-harness.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
      expect(source.length).toBeGreaterThan(1000);
      expect(source).not.toMatch(/request_id|conversation_id|agent_id/);
    }
    // The capability this suite sends is named the sanctioned way, from the
    // generated union rather than as a wire id.
    expect(TRACKED).toContain(".");
  });
});
