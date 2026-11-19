/**
 * The webview's half of the bridge to the extension host.
 *
 * The panel is a browser context. It reaches the host through exactly one
 * channel -- the `acquireVsCodeApi()` handle's `postMessage` -- and it hears the
 * host only through `window` `message` events. This module owns that channel's
 * vocabulary, the handshake verdict that gates everything sent on it, and the
 * routing of incoming frames.
 *
 * Why the API handle is a module singleton
 *   The host page allows `acquireVsCodeApi()` to be called once per session: a
 *   second call throws, and a panel that threw while mounting would be a blank
 *   page. The handle is therefore resolved lazily on the first send and kept for
 *   the life of the module, so every later bridge in the same session posts
 *   through the same object.
 *
 * Why the wire is described here rather than imported
 *   The three envelope channels are a type-level fact (type-imported from the
 *   protocol package), but the message family between a panel and this host is
 *   this shell's own contract. Nothing outside this file may invent a second
 *   spelling of it: the transport and the host-side forwarder speak these
 *   shapes, and the narrowing below is their only reader.
 *
 * Only the JSON subset may be posted
 *   A webview `postMessage` serializes with the host's structured-clone rules. A
 *   `Date`, a `Map`, a `BigInt` or a cycle either throws or silently changes
 *   shape, so every outbound message is checked before it reaches the handle. A
 *   refused message is counted, never posted: a frame that arrived as a mangled
 *   object is worse than a frame that is honestly missing.
 *
 * The version guard is terminal
 *   The two sides announce a bridge version. When they disagree this panel has no
 *   way to render anything the core produces, so the bridge stops: the verdict is
 *   final, every later send is refused, and the transport turns it into the one
 *   notice the user sees. Re-announcing afterwards cannot revive it -- reloading
 *   the panel creates a new module instance, which is the only honest recovery.
 *
 * Terminal bytes never enter the value React reads
 *   `term.output` is the one frame type a panel receives at stream rate. It goes
 *   to the injected terminal sink and nowhere else. In particular it is not part
 *   of {@link WebviewBridge.snapshot}: that value is what a consumer outside
 *   React compares between reads, so a counter that moved per slice would make a
 *   megabyte of output a megabyte of re-renders. The per-slice counters live in
 *   {@link WebviewBridge.stats}, which nobody subscribes to.
 */

import { createFrameEntry, type FrameEntry } from "@haruyuki/ui";

import { narrowStatusFailure, type StatusFailure } from "./errors/fault.js";
import type { CommandCall, CommandReply } from "@haruyuki/core";
import type { FrameChannel } from "@haruyuki/protocol";

/**
 * The bridge protocol version this bundle speaks.
 *
 * Compared for exact equality against the host's expectation and put verbatim in
 * `ready`. It is a build fact, so it is a constant here; the host announces the
 * version it expects in `boot`, and a disagreement stops this bridge.
 */
export const WEBVIEW_BRIDGE_VERSION = "1";

/** The only reject code the version guard produces. */
export const BRIDGE_VERSION_MISMATCH = "BRIDGE_VERSION_MISMATCH";

/** Maximum nesting checked before a value is refused as not-JSON. */
const JSON_DEPTH_LIMIT = 32;

/** The channels a frame can arrive on, in a fixed order. */
const CHANNELS = ["control", "stream", "bulk"] as const satisfies readonly FrameChannel[];

/** The one ability this module needs from the host page. */
export interface VsCodeApi {
  /** Hand one message to the extension host. */
  postMessage(message: unknown): void;
}

/**
 * The page's API handle, cached for the session.
 *
 * `undefined` means "not resolved yet". `null` is a resolved verdict: the page
 * is not a webview (a plain browser, a test without the host global), and every
 * send is then a counted no-op rather than a throw.
 */
let acquired: VsCodeApi | null | undefined;

/** Diagnostic sink: codes and numbers, never a message body. */
export type BridgeLog = (code: string, detail?: Record<string, unknown>) => void;

/**
 * The page's API handle, or `null` when this page is not a webview.
 *
 * The host global is read through `globalThis` so a test can install it, and it
 * is called exactly once: the cached value answers every later request.
 *
 * @returns the handle for this session
 */
export function webviewApi(): VsCodeApi | null {
  if (acquired !== undefined) return acquired;

  const acquire: unknown = Reflect.get(globalThis, "acquireVsCodeApi");

  if (typeof acquire !== "function") {
    acquired = null;

    return acquired;
  }

  try {
    acquired = (acquire as () => VsCodeApi)();
  } catch {
    // The host refused (a second acquire in the same page, a broken template).
    // Caching the failure keeps this from retrying a call the page forbids.
    acquired = null;
  }

  return acquired;
}

/**
 * Forget the resolved handle.
 *
 * A test hook, and the only way to observe the acquisition rule: the rule is
 * "called once per session", so a test that has already resolved the handle in
 * an earlier case has to be able to start a new session.
 */
export function resetWebviewApi(): void {
  acquired = undefined;
}

/** One `term.output` slice body, with the fields a sink writes. */
export interface TerminalSlice {
  readonly terminal_id: string;
  readonly slice: number;
  readonly slices: number;
  readonly offset: number;
  readonly bytes: number;
  readonly final: boolean;
  readonly text: string;
}

/** Host to webview: the version facts the panel builds its entry from. */
export interface BootMessage {
  readonly kind: "boot";
  /** Renderer build version, diagnostic only. */
  readonly appVersion: string;
  /** The bridge protocol version the host expects. Compared exactly. */
  readonly bridgeVersion: string;
  /** The frame envelope version the host serializes; injected into the entry. */
  readonly frameProtocolVersion: number;
}

/** Host to webview: one serialized frame. The payload is opaque on the wire. */
export interface FrameMessage {
  readonly kind: "frame";
  readonly channel: FrameChannel;
  /** The core's JSON text, byte for byte. */
  readonly payload: string;
}

/** Host to webview: the answer to one `command.invoke`. */
export interface ReplyMessage {
  readonly kind: "command.reply";
  readonly callId: string;
  readonly reply: CommandReply;
}

/**
 * Host to webview: the core's phase, as the host last observed it.
 *
 * The failure fields are the same ones `RuntimeFailure` carries, re-declared
 * here rather than imported: this module speaks the panel's message family, and
 * the family is a wire contract with its own narrowing. What matters is that
 * they are carried at all -- a page that learns only `failed` can say something
 * went wrong and nothing else, and "nothing else" is the state this was fixed
 * from.
 */
export interface StatusMessage {
  readonly kind: "status";
  readonly phase: string;
  /** Why the phase is `failed`. Absent for every other phase. */
  readonly failure?: StatusFailure;
}

/** Every message this panel accepts from its host. */
export type HostMessage = BootMessage | FrameMessage | ReplyMessage | StatusMessage;

/** Webview to host: the panel announces itself, and announces its version. */
export interface ReadyMessage {
  readonly kind: "ready";
  readonly appVersion: string;
  readonly bridgeVersion: string;
}

/** Webview to host: one command to run in the core. */
export interface InvokeMessage {
  readonly kind: "command.invoke";
  readonly callId: string;
  readonly call: CommandCall;
}

/** Webview to host: bytes that a terminal sink has rendered. */
export interface TerminalAckMessage {
  readonly kind: "terminal.ack";
  readonly terminal_id: string;
  readonly bytes: number;
}

/** Webview to host: a user action the host owns (a menu, a command, a file). */
export interface ActionMessage {
  readonly kind: "action";
  readonly action: string;
  readonly params?: unknown;
}

/** Every message this panel sends to its host. */
export type WebviewMessage = ReadyMessage | InvokeMessage | TerminalAckMessage | ActionMessage;

/** One frame that was routed, after the entry admitted it. */
export interface RoutedFrame {
  readonly channel: FrameChannel;
  readonly type: string;
  /** The core's JSON text; consumers decode only what they own. */
  readonly payload: string;
}

/**
 * What a consumer outside React compares between reads.
 *
 * Deliberately small and slow-moving: the verdict and the core phase. Everything
 * that moves per frame -- the routed counters, terminal slices, refusals -- is in
 * {@link BridgeStats} instead, because this value wakes React up and a screen
 * that re-rendered once per frame would be unusable at stream rate.
 */
export interface BridgeSnapshot {
  readonly state: "waiting" | "accepted" | "rejected";
  /** The reject code when {@link BridgeSnapshot.state} is `rejected`. */
  readonly code: string | null;
  /**
   * The two versions a rejection compared, when it compared any.
   *
   * `expected` is what this bundle speaks and `actual` is what the host
   * announced, in that order, because a reader cannot tell which is which from
   * the values alone.
   */
  readonly versions: { readonly expected: string; readonly actual: string } | null;
  /** The core phase the host last reported. */
  readonly status: StatusMessage | null;
}

/** Counters for a diagnostic. Nothing subscribes to these. */
export interface BridgeStats {
  /** Messages this bridge put on the wire. */
  readonly sent: number;
  /** Messages received from the host, of every kind. */
  readonly received: number;
  /** Messages refused before or after the wire (malformed, or after a stop). */
  readonly refused: number;
  /** `term.output` slices handed to the terminal sink. */
  readonly terminalSlices: number;
  /**
   * Frames forwarded to {@link WebviewBridgeOptions.onFrame}, per channel.
   *
   * Terminal slices are not included: they never take that path.
   */
  readonly routed: Record<FrameChannel, number>;
  /** What the frame entry itself observed, including terminal frames. */
  readonly admitted: {
    readonly lastSeq: number;
    readonly perChannel: Record<FrameChannel, number>;
  };
}

/** What the consumer of this bridge injects. */
export interface WebviewBridgeOptions {
  /**
   * The page handle. Omitted means "resolve the host global"; `null` means "this
   * page has no host" and makes every send a counted no-op.
   */
  readonly api?: VsCodeApi | null;
  /** Where `term.output` slices go. They never enter this module's state. */
  readonly onTerminal?: (slice: TerminalSlice) => void;
  /** Every admitted frame that is not terminal output. */
  readonly onFrame?: (frame: RoutedFrame) => void;
  /** Where a refusal or a version disagreement is reported. */
  readonly log?: BridgeLog;
}

/** The bridge one webview session owns. */
export interface WebviewBridge {
  /**
   * Take one raw host message.
   *
   * @param raw whatever the host delivered, unvalidated
   */
  receive(raw: unknown): void;
  /**
   * Run one command in the core.
   *
   * The host answers exactly once per call id; a reply for an unknown id is
   * refused rather than resurrecting a settled promise.
   *
   * @param call the validated command
   * @returns the core's answer, or a failure arm when the command never left
   */
  invoke(call: CommandCall): Promise<CommandReply>;
  /**
   * Acknowledge bytes a terminal sink has rendered.
   *
   * @param ack the terminal and the number of bytes
   */
  ackTerminal(ack: { readonly terminal_id: string; readonly bytes: number }): void;
  /**
   * Send a user action the host owns.
   *
   * @param action the action name
   * @param params its JSON parameters, when it takes any
   */
  sendAction(action: string, params?: unknown): void;
  /** The receiver of incoming frames; `null` until the first `boot`. */
  readonly entry: FrameEntry | null;
  /** The slow-moving value a React consumer reads. Stable between changes. */
  snapshot(): BridgeSnapshot;
  /** The per-message counters a diagnostic reads. */
  stats(): BridgeStats;
  /**
   * Observe changes to {@link WebviewBridge.snapshot}.
   *
   * @param listener called synchronously after an observable change
   * @returns a function that removes this listener; calling it twice is safe
   */
  subscribe(listener: () => void): () => void;
  /** Settle every pending command as unreachable and ignore anything later. */
  dispose(): void;
}

/**
 * Create the bridge for one webview session.
 *
 * Nothing is sent until the host announces itself in `boot`: before that the
 * panel has no protocol version to build an entry from, and a `ready` without one
 * would be a claim this module cannot support.
 *
 * @param options the injected sinks and the optional page handle
 * @returns the bridge, waiting for its first message
 */
export function createWebviewBridge(options: WebviewBridgeOptions = {}): WebviewBridge {
  const resolveApi = (): VsCodeApi | null =>
    options.api === undefined ? webviewApi() : options.api;

  const pending = new Map<string, (reply: CommandReply) => void>();
  const listeners = new Set<() => void>();

  let state: "waiting" | "accepted" | "rejected" = "waiting";
  let code: string | null = null;
  let versions: { expected: string; actual: string } | null = null;
  let entry: FrameEntry | null = null;
  let appVersion = "";
  let lastStatus: StatusMessage | null = null;
  let routed: Record<FrameChannel, number> = { control: 0, stream: 0, bulk: 0 };
  let sent = 0;
  let received = 0;
  let refused = 0;
  let terminalSlices = 0;
  let callSeq = 0;
  let revision = 0;
  let cached: { readonly at: number; readonly value: BridgeSnapshot } | null = null;
  let disposed = false;

  /**
   * Mark a change to the value a consumer watches.
   *
   * The cached snapshot is dropped here rather than in the read, so that a read
   * with no change in between hands back the same object: a consumer compares
   * the two with `Object.is` and would otherwise see a change on every read.
   */
  function touch(): void {
    revision += 1;
    cached = null;
  }

  /** Tell every listener that the value they read has changed. */
  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing consumer must not skip the others; there is no log here.
      }
    }
  }

  /**
   * Count one message that was not acted on.
   *
   * Deliberately does not wake a consumer up: a malformed message or a duplicate
   * reply changes nothing anybody renders, and a peer that keeps sending junk
   * must not be able to drive re-renders.
   */
  function refuse(): void {
    refused += 1;
  }

  /** Stop the bridge for good, with the code the notice reads. */
  function reject(reason: string, compared?: { expected: string; actual: string }): void {
    if (state === "rejected") return;

    state = "rejected";
    code = reason;
    versions = compared ?? null;
    touch();
  }

  /** Accept what the core announced. */
  function accept(): void {
    if (state !== "waiting") return;

    state = "accepted";
    touch();
  }

  /**
   * Put one message on the wire.
   *
   * @param message the message to send
   * @returns whether it was sent
   */
  function post(message: WebviewMessage): boolean {
    if (disposed || state === "rejected") {
      refuse();

      return false;
    }

    if (!isJsonValue(message)) {
      refuse();

      return false;
    }

    const api = resolveApi();

    if (api === null) {
      refuse();

      return false;
    }

    try {
      api.postMessage(message);
    } catch {
      // A disposed panel is normal; the message is already lost either way.
      refuse();

      return false;
    }

    sent += 1;

    return true;
  }

  /** Announce this panel. Sent once per `boot`, which is also the replay. */
  function announce(): void {
    if (post({ kind: "ready", appVersion, bridgeVersion: WEBVIEW_BRIDGE_VERSION })) {
      options.log?.("WEBVIEW_READY_SENT", {});
    }
  }

  /** Apply the host's version facts, then announce this panel. */
  function onBoot(message: BootMessage): void {
    if (state === "rejected" || disposed) return;

    if (message.bridgeVersion !== WEBVIEW_BRIDGE_VERSION) {
      // The host speaks a version this bundle cannot render. There is no partial
      // mode: the bridge stops here, and the shell turns the verdict into the one
      // notice the user sees.
      const compared = { expected: WEBVIEW_BRIDGE_VERSION, actual: message.bridgeVersion };

      reject(BRIDGE_VERSION_MISMATCH, compared);
      options.log?.("WEBVIEW_BRIDGE_VERSION_MISMATCH", { ...compared });

      return;
    }

    if (!Number.isFinite(message.frameProtocolVersion)) {
      // Nothing can be admitted without an envelope version. A malformed boot is a
      // wiring bug, not a version disagreement, so it is counted and ignored.
      refuse();

      return;
    }

    appVersion = message.appVersion;

    entry ??= createFrameEntry({
      expectedBridgeVersion: WEBVIEW_BRIDGE_VERSION,
      frameProtocolVersion: message.frameProtocolVersion,
    });

    announce();
  }

  /** Route one serialized frame: the guard first, then the type. */
  function onFrame(message: FrameMessage): void {
    if (state === "rejected" || disposed) {
      refuse();

      return;
    }

    if (entry === null) {
      // A frame before the boot has no envelope version to judge it against.
      refuse();

      return;
    }

    entry.handle(message.payload);

    const verdict = entry.status();

    if (verdict.state === "rejected") {
      reject(verdict.code ?? BRIDGE_VERSION_MISMATCH);
      options.log?.("WEBVIEW_BRIDGE_REJECTED", { code: verdict.code ?? BRIDGE_VERSION_MISMATCH });

      return;
    }

    if (verdict.state === "accepted") accept();

    const frame = readFrame(message.payload);

    if (frame === null) {
      refuse();

      return;
    }

    if (frame.type === "bridge.accept") {
      accept();

      return;
    }

    if (frame.type === "bridge.reject") {
      reject(readRejectCode(frame.body));
      options.log?.("WEBVIEW_BRIDGE_REJECTED", { code });

      return;
    }

    // Terminal bytes take their own road: counted for a diagnostic, handed to
    // the terminal router, and never part of the value a consumer watches. A
    // megabyte of output must not become a megabyte of state updates, which is
    // the one rule this module exists to keep.
    if (frame.type === "term.output") {
      const slice = readTerminalSlice(frame.body);

      if (slice === null) {
        refuse();

        return;
      }

      terminalSlices += 1;
      options.onTerminal?.(slice);

      return;
    }

    routed[message.channel] += 1;
    options.onFrame?.({ channel: message.channel, type: frame.type, payload: message.payload });
  }

  /** Answer one pending command, if the id is one this bridge is waiting for. */
  function onReply(message: ReplyMessage): void {
    const settle = pending.get(message.callId);

    if (settle === undefined) {
      refuse();

      return;
    }

    pending.delete(message.callId);
    settle(message.reply);
  }

  function receive(raw: unknown): void {
    if (disposed) return;

    const before = revision;
    received += 1;

    const message = narrowHostMessage(raw);

    if (message === null) {
      refuse();
    } else {
      switch (message.kind) {
        case "boot":
          onBoot(message);
          break;
        case "frame":
          onFrame(message);
          break;
        case "command.reply":
          onReply(message);
          break;
        case "status":
          lastStatus = message;
          touch();
          break;
      }
    }

    if (revision !== before) emit();
  }

  function invoke(call: CommandCall): Promise<CommandReply> {
    if (disposed || state === "rejected") {
      return Promise.resolve(failure("NOT_CONNECTED", "the bridge is not accepting commands"));
    }

    callSeq += 1;

    const callId = `wv-${String(callSeq)}`;

    if (!post({ kind: "command.invoke", callId, call })) {
      return Promise.resolve(failure("SEND_FAILED", "the command could not be sent"));
    }

    return new Promise<CommandReply>((resolve) => {
      pending.set(callId, resolve);
    });
  }

  function ackTerminal(ack: { readonly terminal_id: string; readonly bytes: number }): void {
    post({ kind: "terminal.ack", terminal_id: ack.terminal_id, bytes: ack.bytes });
  }

  function sendAction(action: string, params?: unknown): void {
    if (action.length === 0) {
      refuse();

      return;
    }

    post(params === undefined ? { kind: "action", action } : { kind: "action", action, params });
  }

  function snapshot(): BridgeSnapshot {
    const current = cached;

    if (current !== null && current.at === revision) return current.value;

    const value: BridgeSnapshot = { state, code, versions, status: lastStatus };

    cached = { at: revision, value };

    return value;
  }

  function stats(): BridgeStats {
    const admitted = entry?.snapshot();

    return {
      sent,
      received,
      refused,
      terminalSlices,
      routed: { control: routed.control, stream: routed.stream, bulk: routed.bulk },
      admitted: {
        lastSeq: admitted?.lastSeq ?? 0,
        perChannel: {
          control: admitted?.perChannel.control ?? 0,
          stream: admitted?.perChannel.stream ?? 0,
          bulk: admitted?.perChannel.bulk ?? 0,
        },
      },
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    let subscribed = true;

    return () => {
      if (!subscribed) return;

      subscribed = false;
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    if (disposed) return;

    disposed = true;

    for (const settle of pending.values()) {
      settle(failure("NOT_CONNECTED", "the panel was disposed before the reply arrived"));
    }

    pending.clear();
    listeners.clear();
  }

  return {
    receive,
    invoke,
    ackTerminal,
    sendAction,
    get entry(): FrameEntry | null {
      return entry;
    },
    snapshot,
    stats,
    subscribe,
    dispose,
  };
}

/* ------------------------------------------------------------------ */
/* narrowing                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read one inbound message.
 *
 * Every field is rebuilt, so a message that carried unknown keys cannot smuggle
 * them into this module's state. A refusal is `null`, never a throw: the host is
 * another process and a malformed message must degrade the feature only.
 *
 * @param raw the untrusted value
 * @returns the narrowed message, or `null` when it is not one
 */
function narrowHostMessage(raw: unknown): HostMessage | null {
  if (!isRecord(raw)) return null;

  switch (raw["kind"]) {
    case "boot": {
      const appVersion = raw["appVersion"];
      const bridgeVersion = raw["bridgeVersion"];
      const frameProtocolVersion = raw["frameProtocolVersion"];

      if (typeof appVersion !== "string" || appVersion.length === 0) return null;
      if (typeof bridgeVersion !== "string" || bridgeVersion.length === 0) return null;
      if (typeof frameProtocolVersion !== "number") return null;

      return { kind: "boot", appVersion, bridgeVersion, frameProtocolVersion };
    }

    case "frame": {
      const channel = raw["channel"];
      const payload = raw["payload"];

      if (!isChannel(channel) || typeof payload !== "string") return null;

      return { kind: "frame", channel, payload };
    }

    case "command.reply": {
      const callId = raw["callId"];
      const reply = raw["reply"];

      if (typeof callId !== "string" || callId.length === 0) return null;
      if (!isRecord(reply) || typeof reply["ok"] !== "boolean") return null;

      return { kind: "command.reply", callId, reply: reply as CommandReply };
    }

    case "status": {
      const phase = raw["phase"];

      if (typeof phase !== "string" || phase.length === 0) return null;

      const failure = narrowStatusFailure(raw["failure"]);

      // A `failed` phase with no readable failure is refused rather than carried
      // without one: the page would have a heading and nothing under it, and
      // whatever arrives next would be explained by a phase it no longer matches.
      if (phase === "failed" && failure === undefined) return null;

      return failure === undefined ? { kind: "status", phase } : { kind: "status", phase, failure };
    }

    default:
      return null;
  }
}

/** The parts of one frame this layer routes on. */
interface ReadFrame {
  readonly type: string;
  readonly body: unknown;
}

/**
 * Read the type and body out of one frame payload.
 *
 * The payload is parsed only to route: nothing here is re-serialized, so the
 * bytes a consumer receives are still the core's.
 *
 * @param payload the frame's JSON text
 * @returns the routing fields, or `null` when it is not a frame
 */
function readFrame(payload: string): ReadFrame | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const type = parsed["t"];

  if (typeof type !== "string" || type.length === 0) return null;

  return { type, body: parsed["body"] };
}

/**
 * Read the reject code out of a `bridge.reject` body.
 *
 * @param body the frame body, unvalidated
 * @returns the announced code, or the mismatch code when the body is unusable
 */
function readRejectCode(body: unknown): string {
  if (!isRecord(body)) return BRIDGE_VERSION_MISMATCH;

  const announced = body["code"];

  return typeof announced === "string" && announced.length > 0
    ? announced
    : BRIDGE_VERSION_MISMATCH;
}

/**
 * Read one `term.output` body.
 *
 * @param body the frame body, unvalidated
 * @returns the slice, or `null` when it cannot be rendered
 */
function readTerminalSlice(body: unknown): TerminalSlice | null {
  if (!isRecord(body)) return null;

  const terminalId = body["terminal_id"];
  const text = body["text"];

  if (typeof terminalId !== "string" || terminalId.length === 0) return null;
  if (typeof text !== "string") return null;

  return {
    terminal_id: terminalId,
    text,
    slice: readNumber(body["slice"]),
    slices: readNumber(body["slices"]),
    offset: readNumber(body["offset"]),
    bytes: readNumber(body["bytes"]),
    final: body["final"] === true,
  };
}

/**
 * The failure arm of a command this bridge could not run.
 *
 * @param code the classified reason
 * @param detail one English sentence for the log
 * @returns a reply the caller can branch on
 */
function failure(code: "NOT_CONNECTED" | "SEND_FAILED", detail: string): CommandReply {
  return { ok: false, code, detail };
}

/**
 * @param value any value
 * @returns whether it is a non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param value any value
 * @returns whether it names one of the three frame channels
 */
function isChannel(value: unknown): value is FrameChannel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/**
 * @param value any value
 * @returns it when it is a finite number, else zero
 */
function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Whether a value survives the host's serialization unchanged.
 *
 * A local copy of the rule the host pipe applies, kept local because this module
 * runs in the browser and must not pull the host's pipe contract into the panel
 * bundle. The check is about what can cross the channel at all: functions,
 * symbols, bigints, class instances and cycles cannot, and a non-finite number
 * arrives as `null`.
 *
 * @param value candidate
 * @returns `true` when the value is JSON
 */
function isJsonValue(value: unknown): boolean {
  return walkJsonValue(value, 0, new Set<object>());
}

/**
 * Recursion body of {@link isJsonValue}.
 *
 * @param value candidate
 * @param depth current nesting
 * @param ancestors objects on the current path, to detect cycles
 * @returns whether the value is JSON
 */
function walkJsonValue(value: unknown, depth: number, ancestors: Set<object>): boolean {
  if (value === null || value === undefined) return true;
  if (depth > JSON_DEPTH_LIMIT) return false;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;

  if (ancestors.has(object)) return false;

  ancestors.add(object);

  try {
    if (Array.isArray(object)) {
      return object.every((item) => walkJsonValue(item, depth + 1, ancestors));
    }

    const prototype: unknown = Object.getPrototypeOf(object);

    if (prototype !== Object.prototype && prototype !== null) return false;

    return Object.values(object as Record<string, unknown>).every((item) =>
      walkJsonValue(item, depth + 1, ancestors),
    );
  } finally {
    ancestors.delete(object);
  }
}
