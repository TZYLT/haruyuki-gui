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
 *
 * The two wire shapes are not declared here: `../core/ipc.ts` owns them, and
 * this file only binds them to storage. Deriving them keeps one source of truth,
 * so a change to the pipe cannot leave a second, drifting copy behind.
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

/** The answer to a request whose own fields do not describe an operation. */
export const MALFORMED_REQUEST = "the secret request is malformed";

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

/** Options of {@link createSecureRequestServer}. */
export type SecureRequestServerOptions = {
  readonly store: HostSecretStore;
  /** Diagnostic sink. Lines name the operation; never the key, never a value. */
  readonly log?: (line: string) => void;
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

  return async (raw: unknown): Promise<SecureReplyMessage | null> => {
    const request = narrowRequest(raw);

    if (request === null) return null;

    if (!request.ok) {
      log?.("refused a malformed secret request");

      return { kind: "secure.reply", requestId: request.requestId, error: MALFORMED_REQUEST };
    }

    const { requestId, operation } = request;

    try {
      if (operation.op === "get") {
        const value = await store.get(operation.key);

        // An absent key is an answer with no value, never an invented empty
        // string: the core must be able to tell that it has to ask the user.
        return value === undefined
          ? { kind: "secure.reply", requestId }
          : { kind: "secure.reply", requestId, value };
      }

      if (operation.op === "set") {
        await store.set(operation.key, operation.value);

        return { kind: "secure.reply", requestId };
      }

      await store.delete(operation.key);

      return { kind: "secure.reply", requestId };
    } catch {
      // The store's own message is dropped on purpose; see rule 1 above.
      log?.(`the secret store failed the ${operation.op} request`);

      return { kind: "secure.reply", requestId, error: STORE_UNAVAILABLE };
    }
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
