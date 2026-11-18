/**
 * The extension host's secret store, and the handler that answers the core
 * child's secret requests.
 *
 * Secrets live in `context.secrets`, which VS Code keeps encrypted per machine
 * and never syncs. `globalState` is plain text on disk, so nothing here touches
 * it and no caller may copy a value into it.
 *
 * Three rules hold for every line of this module:
 *
 * 1. A secret exists only in the memory of one call. It is never placed in a log
 *    line, an error message, a thrown error or a reply field other than the one
 *    that carries it. A store failure is answered with a fixed code instead of
 *    the store's own message, because that message is not under this module's
 *    control and may quote the value it failed on.
 * 2. An absent key and an unreadable store are different answers. An absent key
 *    is a reply with no value; a failure is a reply with an error. A caller can
 *    therefore tell "the user never stored a token" from "we cannot read it".
 * 3. A message this module does not recognise is a value, not a throw. A child
 *    that sends garbage degrades one feature instead of the extension host.
 * 4. A store call that never settles is answered with its own code, not with the
 *    failure code. A caller that timed out may retry; a caller whose store
 *    cannot be read may not, and the two send a reader to different places.
 *
 * The two wire shapes are not declared here: `../core/ipc.ts` owns them, and
 * this file only binds them to storage. Deriving them keeps one source of truth,
 * so a change to the pipe cannot leave a second, drifting copy behind.
 *
 * The pipe itself is `./core-host.ts`. {@link createSecureInboundAnswerer} is
 * the seam between the two, and it lives here because the one ordering rule it
 * encodes is about this message family: the core is the asker on that leg, so a
 * request travels in the host-to-core shape while an answer travels in the
 * core-to-host one. Nothing else about the pipe is decided in this file.
 */

import { isRecord, SECURE_OPS, type CoreToHost, type SecureOp } from "../core/ipc.js";

/**
 * The host's answer to one `secure.request` from the core.
 *
 * The request side has no alias here: this handler receives raw pipe traffic and
 * reads it field by field, so an alias would only describe a shape it trusts.
 */
export type SecureReplyMessage = Extract<CoreToHost, { kind: "secure.reply" }>;

/**
 * What a caller of the port may do with a secret.
 *
 * Three operations, because that is what the core is injected with: a shell
 * store that offered a fourth would be a fourth thing the core cannot ask for.
 */
export type HostSecretStore = {
  /** @returns the stored value, or `undefined` when the key is absent */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * The subset of `vscode.SecretStorage` this module uses.
 *
 * `PromiseLike` rather than `Promise` on purpose: the VS Code members return
 * `Thenable`, which has no `catch`/`finally`, so a `Promise` annotation would
 * refuse the real object at the composition root.
 */
export type SecretStorageLike = {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
};

/** The answer to a request whose operation cannot be performed at all. */
export const STORE_UNAVAILABLE = "the secret store is unavailable";

/** The answer to a request the store did not settle before its budget. */
export const STORE_TIMEOUT = "the secret store did not answer in time";

/** The answer to a request whose own fields do not describe an operation. */
export const MALFORMED_REQUEST = "the secret request is malformed";

/**
 * Budget for one store call.
 *
 * Deliberately below the core proxy's own budget (`../core/host-port-proxy.ts`
 * waits ten seconds): this answer is the precise one, and a caller that gets it
 * knows the store is slow rather than that the pipe is gone. The two numbers
 * live in two processes and cannot share a constant, so they are stated in both
 * places instead of being derived in one.
 */
const DEFAULT_STORE_TIMEOUT_MS = 5_000;

/** One operation, with the fields that operation may carry. */
type SecureOperation =
  | { readonly op: "get"; readonly key: string }
  | { readonly op: "delete"; readonly key: string }
  | { readonly op: "set"; readonly key: string; readonly value: string };

/** A request that could be read, or the id of one that could not. */
type NarrowedRequest =
  | { readonly ok: true; readonly requestId: string; readonly operation: SecureOperation }
  | { readonly ok: false; readonly requestId: string };

/**
 * Answer one raw message, or `null` when it is not a secret request.
 *
 * `null` is how the caller knows to offer the message to the next handler: the
 * pipe carries several message families and this handler owns exactly one.
 */
export type SecureRequestServer = (raw: unknown) => Promise<SecureReplyMessage | null>;

/**
 * Offer one raw child message, synchronously, and say whether it was owned.
 *
 * The pipe's message loop is synchronous and cannot await a store, so ownership
 * has to be decided before the answer exists. `deliver` is the host's own write
 * to the child: it is passed per call because the pipe that owns it is also the
 * only thing that can say whether the child is still there.
 */
export type SecureInboundAnswerer = (
  raw: unknown,
  deliver: (message: SecureReplyMessage) => boolean,
) => boolean;

/** Options of {@link createSecureRequestServer}. */
export type SecureRequestServerOptions = {
  readonly store: HostSecretStore;
  /** Diagnostic sink. Lines name the operation; never the key, never a value. */
  readonly log?: (line: string) => void;
  /** Per-call budget; see {@link DEFAULT_STORE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Wrap a `context.secrets`-shaped storage as a {@link HostSecretStore}.
 *
 * Deliberately thin: no cache, no plaintext fallback, no second copy. Every call
 * is the VS Code call, so a token the user replaced in another window is not a
 * stale read.
 *
 * @param storage the extension's secret storage
 * @returns the three-operation store
 */
export function createHostSecretStore(storage: SecretStorageLike): HostSecretStore {
  return {
    async get(key: string): Promise<string | undefined> {
      return await storage.get(key);
    },
    async set(key: string, value: string): Promise<void> {
      await storage.store(key, value);
    },
    async delete(key: string): Promise<void> {
      await storage.delete(key);
    },
  };
}

/** One store call's result, in the reply's own vocabulary. */
type StoreOutcome =
  { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: string };

/**
 * What a store call produced once its budget is applied.
 *
 * The rejection is kept in a field rather than as a thrown error so both
 * branches below stay on one code path; nothing reads it except the boolean.
 */
type SettledCall = { readonly ok: true; readonly value?: string } | { readonly ok: false };

/** The budget expired before the store answered. */
const TIMED_OUT = "timed-out" as const;

/**
 * Await a store call, or give up after its budget.
 *
 * @param call the store's promise
 * @param timeoutMs the budget
 * @returns the value, the rejection, or {@link TIMED_OUT}
 */
async function settleWithin(
  call: Promise<string | undefined | void>,
  timeoutMs: number,
): Promise<SettledCall | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  try {
    // The store's rejection is converted here and nowhere else, so no caller
    // can accidentally put its message into a reply or a log line.
    const settled = await Promise.race([
      call.then(
        (value): SettledCall => (typeof value === "string" ? { ok: true, value } : { ok: true }),
        (): SettledCall => ({ ok: false }),
      ),
      timeout,
    ]);

    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the handler that answers the core child's secret requests.
 *
 * A request whose fields are unusable is still answered, with an error: the core
 * is waiting on a correlated reply, and silence would turn a host bug into a
 * timeout at the caller. Only a message that is not a secret request at all
 * answers `null`.
 *
 * @param options the store and the diagnostic sink
 * @returns the handler
 */
export function createSecureRequestServer(
  options: SecureRequestServerOptions,
): SecureRequestServer {
  const { store, log } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;

  /**
   * Run one store call, bounded by the budget.
   *
   * Only the operation name reaches a log line. The key and the value are
   * arguments of the call and are never rendered, on any branch, including the
   * two failure ones below.
   *
   * @param operation the narrowed request
   * @returns the outcome, already in the reply's own vocabulary
   */
  async function perform(operation: SecureOperation): Promise<StoreOutcome> {
    const call =
      operation.op === "get"
        ? store.get(operation.key)
        : operation.op === "set"
          ? store.set(operation.key, operation.value)
          : store.delete(operation.key);

    const settled = await settleWithin(call, timeoutMs);

    if (settled === TIMED_OUT) {
      log?.(`the secret store did not answer the ${operation.op} request in time`);

      return { ok: false, error: STORE_TIMEOUT };
    }

    if (!settled.ok) {
      // The store's own message is dropped on purpose; see rule 1 above. It is
      // not even read: reading it is what a `describe()` call would do, and the
      // rejection is the one value this module refuses to look at.
      log?.(`the secret store failed the ${operation.op} request`);

      return { ok: false, error: STORE_UNAVAILABLE };
    }

    return settled.value === undefined ? { ok: true } : { ok: true, value: settled.value };
  }

  return async (raw: unknown): Promise<SecureReplyMessage | null> => {
    const request = narrowRequest(raw);

    if (request === null) return null;

    if (!request.ok) {
      log?.("refused a malformed secret request");

      return { kind: "secure.reply", requestId: request.requestId, error: MALFORMED_REQUEST };
    }

    const { requestId, operation } = request;
    const outcome = await perform(operation);

    if (!outcome.ok) return { kind: "secure.reply", requestId, error: outcome.error };

    // An absent key is an answer with no value, never an invented empty string:
    // the core must be able to tell that it has to ask the user.
    return outcome.value === undefined
      ? { kind: "secure.reply", requestId }
      : { kind: "secure.reply", requestId, value: outcome.value };
  };
}

/**
 * Check one raw message.
 *
 * `set` requires a value and the other two operations must not carry one, so a
 * sender bug cannot leave a secret behind as the side effect of an operation
 * that was never meant to write.
 *
 * @param raw whatever the core sent
 * @returns the request, a refusal carrying its id, or `null` for a non-request
 */
function narrowRequest(raw: unknown): NarrowedRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "secure.request") return null;

  const requestId = raw.requestId;

  // Without a usable id there is no request to answer: a reply could not be
  // correlated with the call that is waiting on it.
  if (typeof requestId !== "string" || requestId === "") return null;

  const op = raw.op;
  const key = raw.key;
  const value = raw.value;

  if (typeof op !== "string" || !isSecureOp(op)) return { ok: false, requestId };
  if (typeof key !== "string" || key === "") return { ok: false, requestId };
  if (value !== undefined && typeof value !== "string") return { ok: false, requestId };

  if (op === "set") {
    return value === undefined
      ? { ok: false, requestId }
      : { ok: true, requestId, operation: { op, key, value } };
  }

  if (op === "get" || op === "delete") {
    if (value !== undefined) return { ok: false, requestId };

    return { ok: true, requestId, operation: { op, key } };
  }

  return { ok: false, requestId };
}

/**
 * @param value candidate operation name
 * @returns whether it is one of the three operations
 */
function isSecureOp(value: string): value is SecureOp {
  return (SECURE_OPS as readonly string[]).includes(value);
}

/**
 * Build the pipe's one secret-request handler.
 *
 * The message loop runs synchronously and cannot await a store, so the handler
 * decides ownership first and answers afterwards: `true` means "this module owns
 * the message" and the answer will follow, `false` lets the caller offer it to
 * the next handler. Narrowing happens once, here, so a message this module does
 * not own costs one shallow check rather than a store call.
 *
 * Failure policy, chosen once so the caller can rely on it:
 *
 * - A message that is not a well-formed request is refused, not ignored, when it
 *   carried an id: the core is waiting on a correlated answer, and dropping it
 *   would turn a sender bug into a timeout at the caller.
 * - A message with no usable id is not owned at all: no answer could be
 *   correlated with anything, so there is nothing to send.
 * - A closed pipe is a silent drop. The reply has nowhere to go, the core
 *   already sees the closing handle, and a log line per request after a crash
 *   would be the loudest thing in the log.
 *
 * @param options the store and its diagnostic sink
 * @returns the handler the message loop installs
 */
export function createSecureInboundAnswerer(
  options: SecureRequestServerOptions,
): SecureInboundAnswerer {
  const serve = createSecureRequestServer(options);
  const log = options.log;

  return (raw: unknown, deliver: (message: SecureReplyMessage) => boolean): boolean => {
    // Ownership is decided here so the message loop can move on; the answer is
    // built after, because a store call cannot be awaited in that loop.
    if (narrowRequest(raw) === null) return false;

    // `serve` narrows again, which is deliberate: it is the only entry point
    // that has to be safe when called directly, and a second shallow check is
    // cheaper than two readers of one message shape.
    void serve(raw)
      .then((reply) => {
        if (reply === null) return;

        if (!deliver(reply)) log?.("dropped a secret reply: the core pipe is closed");
      })
      .catch(() => {
        // `serve` answers rather than rejecting, so this is a store that threw
        // from outside the awaited call. It is reported by code, never by value.
        log?.("failed to answer a secret request");
      });

    return true;
  };
}
