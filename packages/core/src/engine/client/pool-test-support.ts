/**
 * Shared harness for the `ChannelPool` suites.
 *
 * Three files cover one class:
 *
 * - `pool.test.ts` - identity, lifetime and the frozen surface: which instance an
 *   agent gets, what `channels()` says, what a close rebuilds, arguments, clocks.
 * - `pool-failure.test.ts` - the reason the pool exists at all: one agent's
 *   connection failing must not disturb its neighbours, and a connection that
 *   a connection that cannot be built must still yield a channel.
 * - this file - what both need: the fake-clock pool harness, the channel double,
 *   and teardown.
 *
 * The split is not cosmetic. "A broken agent does not poison the others" is the
 * whole value the one-connection-per-agent ruling buys, so it gets a file where a
 * reviewer looking for that evidence lands directly instead of scrolling a
 * thousand lines. The three files together must stay under the 1000-line gate with
 * room to add a case, so the shared parts live here once rather than twice.
 *
 * Time is never real: `makePool` builds every channel on a tracked fake clock, so
 * the one in-flight request the failure suite leaves waiting costs no wall-clock
 * time. Every suite ends with {@link teardownPools}, which closes what it built and
 * then demands the clocks are silent.
 */

import {
  assertNoLeakedTimers,
  makeClock,
  makeProbe,
  makeReader,
  makeWriter,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import type { FakeClock, RecordingWriter } from "./channel-test-support";
import { EngineChannel, createChannel } from "./channel";
import type { ChannelFactory, ChannelOpenContext, EngineChannelPool } from "./pool";
import { createChannelPool } from "./pool";
import type { Channel, ChannelPool, CommandResult, DiagnosticRecord, Endpoint } from "./types";
import type { EngineEventFrame } from "./types";

/* Compile-time checks */

/** `true` only when the two types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the build unless its argument is `true`. */
type Expect<T extends true> = T;

/**
 * `getChannel` is synchronous. An `async` method cannot satisfy `Equal`, so
 * changing the signature is a compile error here.
 */
type GetChannelReturnsChannel = Expect<Equal<ReturnType<ChannelPool["getChannel"]>, Channel>>;

/** The class must satisfy the frozen interface, not merely resemble it. */
type PoolIsAChannelPool = Expect<Equal<EngineChannelPool extends ChannelPool ? true : false, true>>;

/** Keeps the compile-time assertions above from being reported as unused. */
export const COMPILE_TIME_CHECKS: [GetChannelReturnsChannel, PoolIsAChannelPool] = [true, true];
/* Harness */

/** What one built channel's test side can see. */
export interface AgentView {
  readonly channel: Channel;
  readonly writer: RecordingWriter;
  readonly events: EngineEventFrame[];
  readonly records: DiagnosticRecord[];
}

/** The structured form of a pool under test. */
export interface PoolHarness {
  readonly pool: EngineChannelPool;
  readonly clock: FakeClock;
  /** Every factory invocation's context, in creation order. */
  readonly contexts: ChannelOpenContext[];
  factoryCalls(): number;
  viewOf(agentId: string): AgentView | undefined;
  /** Feed one raw frame to one agent's channel. */
  ingest(agentId: string, raw: string): void;
}

/** The pools this file built, so teardown can close them. */
export const livePools: EngineChannelPool[] = [];

/**
 * Build a pool whose channels are real kernels with the doubles wired.
 *
 * The default factory stands where the transport will: handed no endpoint it
 * throws, so the pool degrades that agent. `ingest` reaches the kernel's own
 * entry point, so a test asserts on what a consumer would see.
 *
 * @param overrides test-specific factory or endpoint resolver
 * @returns the pool plus the observable side effects
 */
export function makePool(
  overrides: {
    readonly createChannel?: ChannelFactory;
    readonly endpointOf?: (agentId: string) => Endpoint | null;
  } = {},
): PoolHarness {
  const clock = trackClock(makeClock());
  const contexts: ChannelOpenContext[] = [];
  const views = new Map<string, AgentView>();
  let factoryCalls = 0;

  const defaultFactory: ChannelFactory = (context) => {
    factoryCalls += 1;
    contexts.push(context);
    if (context.endpoint === null) {
      throw new Error("the transport cannot open a connection with no endpoint");
    }
    const writer = makeWriter();
    const events: EngineEventFrame[] = [];
    const records: DiagnosticRecord[] = [];
    const channel = createChannel({
      agentId: context.agentId,
      write: writer.write,
      reader: makeReader(),
      probe: makeProbe(),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    });
    channel.onEvent((frame) => {
      events.push(frame);
    });
    channel.onDiagnostic((record) => {
      records.push(record);
    });
    views.set(context.agentId, { channel, writer, events, records });
    trackChannel(channel);
    return channel;
  };

  const pool = createChannelPool({
    createChannel: overrides.createChannel ?? defaultFactory,
    endpointOf:
      overrides.endpointOf ??
      ((agentId) => ({ url: `ws://127.0.0.1:1/${agentId}`, token: `token-for-${agentId}` })),
    clock: clock.clock,
  });
  livePools.push(pool);

  return {
    pool,
    clock,
    contexts,
    factoryCalls: () => factoryCalls,
    viewOf: (agentId) => views.get(agentId),
    ingest: (agentId, raw) => {
      const view = views.get(agentId);
      if (view === undefined) throw new Error(`no channel built for ${agentId}`);
      (view.channel as EngineChannel).ingest(raw);
    },
  };
}

/**
 * A `Channel` double whose `close()` a test controls, for the cases where only
 * the pool's bookkeeping is under test: counting closes, and proving a throwing
 * `close()` cannot strand a neighbour.
 *
 * @param agentId the agent this double reports
 * @param onClose what `close()` should do
 * @returns a `Channel`-shaped object
 */
export function stubChannel(agentId: string, onClose: () => void): Channel {
  return {
    agentId,
    send: () => Promise.resolve<CommandResult>({ ok: true, data: undefined, raw: undefined }),
    onEvent: () => () => undefined,
    onDiagnostic: () => () => undefined,
    capabilities: () => ({ state: "unknown" }),
    close: onClose,
  };
}

/**
 * A pool over stub channels, for tests that only count closes.
 *
 * @param onClose receives each agent id whose channel was closed
 * @param clock the fake clock to pass through
 * @returns the pool, registered for teardown
 */
export function stubPool(onClose: (agentId: string) => void, clock: FakeClock): EngineChannelPool {
  const pool = createChannelPool({
    createChannel: (context) => stubChannel(context.agentId, () => onClose(context.agentId)),
    // A stub pool is about bookkeeping, but the endpoint still has to resolve:
    // under the pool's contract a `null` endpoint means "cannot build yet", so a
    // null resolver here would mean these stubs were never built at all.
    endpointOf: (agentId) => ({ url: `ws://127.0.0.1:1/${agentId}`, token: `token-${agentId}` }),
    clock: clock.clock,
  });
  livePools.push(pool);
  return pool;
}

/**
 * Await a promise that must *not* settle yet - the mirror of `expectSettles`.
 * Asserting "still waiting" with a bare `await` is impossible and proving it by
 * not awaiting proves nothing; one macrotask lets every microtask run, so a
 * promise still pending after it is genuinely awaiting an answer.
 *
 * @param promise the promise under test
 * @param what a short description for the failure message
 * @throws when the promise settled
 */
export async function expectPending(promise: Promise<CommandResult>, what: string): Promise<void> {
  const stillPending = Symbol("still-pending");
  const raced = await Promise.race([
    promise,
    new Promise<typeof stillPending>((resolve) => {
      setTimeout(() => {
        resolve(stillPending);
      }, 0);
    }),
  ]);
  if (raced !== stillPending) {
    throw new Error(`${what} settled, but it should still be waiting for its answer`);
  }
}

/**
 * Close every pool this suite built, then demand the clocks are silent.
 *
 * `closeAll` runs first on purpose: the invariant is "closing releases everything",
 * and {@link assertNoLeakedTimers} would make the check vacuous if it did the
 * closing itself before inspecting the clocks. A timer that survives `closeAll` is
 * the real defect - it holds a promise that can never settle, and in a full run the
 * *next* suite pays for it by timing out.
 *
 * Every suite must register this as its `afterEach`; a suite that forgets it loses
 * the leak detector, which is why it is one exported function rather than a
 * copy-pasted block.
 *
 * @throws when the pool left a timer scheduled, or a channel unclosed
 */
export function teardownPools(): void {
  while (livePools.length > 0) {
    livePools.pop()?.closeAll();
  }
  assertNoLeakedTimers();
}
