/**
 * The desktop `secure*` members: Electron's `safeStorage` plus one file under
 * `userData`.
 *
 * The shape is not defined here. `packages/core/src/port/host-port.ts` is the
 * only definition, and `headless-host-port.ts` is the reference for semantics
 * (a `Map`). What this file adds is the storage half and, in every case, the
 * failure path. Three properties are load bearing and none of them show up in
 * the type:
 *
 *   A missing key is not an empty one. `NOT_FOUND` and `STORAGE_UNAVAILABLE` are
 *   deliberately different answers: the first
 *   means "the user never stored a token, ask them", the second means "the token
 *   is there and we cannot read it". Answering `{ok: true, value: ""}` for a key
 *   nobody set would collapse both into one lie, and no caller could tell.
 *
 *   There is no silent plaintext. On a machine without a usable keyring -
 *   typically Linux on the `basic_text` backend - `safeStorage` still reports
 *   "encryption available" while only obfuscating. The capability answer is
 *   therefore injected as `keyringAvailable` instead of being inferred from
 *   `isEncryptionAvailable()`, and when it is false the store asks the user
 *   before the first plaintext write (doc 29 section 4.4, `D2-Q05`). Denying
 *   writes nothing and answers `STORAGE_UNAVAILABLE`: there is no store that
 *   call may use. Accepting once keeps the value in this process's memory only,
 *   which is what makes the next start ask again.
 *
 *   Every failure is a value, never a throw and never a message. A message would
 *   have to say what failed, and the one thing it must not name is the payload
 *   or its ciphertext - so no path in this module formats a secret into a
 *   string that could reach a log, a thrown error or a test failure.
 *
 * Everything the platform provides is injected (the `userData` path, a
 * `safeStorage`-shaped object, the keyring answer and the consent callback).
 * `apps/desktop` tests run under plain `node`, where `import "electron"` yields
 * `undefined` and `app.getPath` throws, so a module that reached for either
 * would be untestable exactly where the failure paths need testing. The same
 * reason puts the consent *question* outside this file: it needs a window, and
 * `main.ts` owns the wording the user is asked to agree to.
 *
 * Deliberately out of scope (`N-8`, `D2-Q05`): a main password, a hand-rolled
 * KDF, and any way to encrypt without the OS. The informed downgrade is the
 * agreed answer; replacing it with homemade crypto is the one thing the
 * requirement forbids.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HostPort } from "@haruyuki/core";

/**
 * The store's own document.
 *
 * Never `shell-settings.json`: that file belongs to `D1`, its key set is pinned
 * by an assertion, and it travels in the diagnostic bundle - which is exactly
 * where a secret must not go (doc 29 section 4.4 item 5).
 */
const STORE_FILE_NAME = "secrets.json";

/**
 * The user's answer to "this machine has no keyring, store plaintext?".
 *
 * A second document on purpose (doc 29 section 6.5): one file is a decision, the
 * other is the ciphertext or the plaintext. Merging them would mean a corrupt
 * store could be read as "no decision" or a missing decision could silently
 * reinterpret the store.
 */
const CONSENT_FILE_NAME = "secrets-consent.json";

/**
 * The document version this build writes and understands.
 *
 * An unknown version is treated as "unreadable", not as "understand what you
 * can": a newer build may have changed what a field means, and a store that is
 * half read is a store whose values cannot be trusted.
 */
const STORE_VERSION = 1 as const;

/** The consent document version this build understands. */
const CONSENT_VERSION = 1 as const;

/**
 * The storage backend a plaintext decision can only ever be made against.
 *
 * Recorded rather than branched on: the decision only exists in the no-keyring
 * case, so this module never reads the field back. It is written because a
 * reader of the file (a diagnostic, a later settings page) needs to know which
 * backend the user was told about.
 */
const PLAINTEXT_BACKEND = "basic_text";

/**
 * Owner-only permissions for the directory and the file.
 *
 * Load bearing on POSIX: the whole point of the informed downgrade is that the
 * user knows the plaintext is readable by anything that can read that path, and
 * handing group/other read access to it would widen what they agreed to. Windows
 * ignores both arguments and inherits the user profile's ACL, which is the same
 * protection Electron's own `userData` has.
 */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** How the entries of one document are stored. */
type StoreMode = "encrypted" | "plaintext";

/**
 * The `safeStorage` surface this module uses, spelled out instead of
 * `typeof safeStorage`.
 *
 * Three members, so a test can pass a three-line stub and a future Electron that
 * grows a fourth method cannot silently change what this module depends on.
 */
export interface SecretsSafeStorage {
  /** Whether a ciphertext produced by this backend can be read back. */
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** What the user may answer when asked about plaintext storage. */
export type PlaintextConsentAnswer = "allow-always" | "allow-once" | "deny";

/**
 * What the user is told they are agreeing to.
 *
 * `storePath` is included because the requirement's wording names the file: the
 * user has to be able to see where the plaintext will sit before saying yes,
 * and only the caller can render that sentence.
 */
export interface PlaintextConsentQuestion {
  /** The key about to be written, so the question can name what it protects. */
  readonly key: string;
  /** The file the plaintext would be written to. */
  readonly storePath: string;
}

/**
 * Ask the user, and return their answer.
 *
 * Injected, never imported: no Electron dialog is reachable from this file, so
 * the module cannot show a prompt on its own (which would also be a prompt with
 * nobody's wording in it) and a test can answer without a window.
 */
export type PlaintextConsent = (
  question: PlaintextConsentQuestion,
) => Promise<PlaintextConsentAnswer>;

/** Everything the store needs that only the shell can answer. */
export interface DesktopSecretsOptions {
  /** `app.getPath("userData")`. The store lives directly in it. */
  readonly userData: string;
  /** `safeStorage`, injected so a test can supply ciphertext it controls. */
  readonly safeStorage: SecretsSafeStorage;
  /**
   * Whether this platform has a usable system keyring.
   *
   * Not derivable from `isEncryptionAvailable()`: on Linux with no keyring that
   * call answers `true` while the backend only obfuscates. `main.ts` derives it
   * from `safeStorage.getSelectedStorageBackend()` (`basic_text` means no) and
   * passes the answer in.
   */
  readonly keyringAvailable: boolean;
  /** Ask the user before the first plaintext write. */
  readonly consent: PlaintextConsent;
  /** Clock, injected so a test can predict the recorded decision time. */
  readonly now?: () => Date;
}

/**
 * The three members this module implements, derived from the frozen contract.
 *
 * A `Pick` rather than a re-spelled interface: the return unions are frozen and
 * three implementations exist, so a second copy of them is a second thing to
 * keep in sync with the header.
 */
export type SecretsPort = Pick<HostPort, "secureGet" | "secureSet" | "secureDelete">;

/** The frozen answers, taken from the contract rather than restated. */
type SecureGetResult = Awaited<ReturnType<SecretsPort["secureGet"]>>;
type SecureSetResult = Awaited<ReturnType<SecretsPort["secureSet"]>>;
type SecureDeleteResult = Awaited<ReturnType<SecretsPort["secureDelete"]>>;

/**
 * One parsed document.
 *
 * `entries` maps a key to its stored form: the ciphertext as base64 in
 * `encrypted` mode, the value itself in `plaintext` mode. The mode lives in the
 * document because it describes what the bytes are, not what this process would
 * like them to be - a profile can meet a machine whose keyring state differs
 * from the one that wrote it.
 */
interface StoredDocument {
  readonly mode: StoreMode;
  readonly entries: Record<string, string>;
}

/**
 * What reading the store produced.
 *
 * "Absent" and "unreadable" are separate cases because they become separate
 * answers (`NOT_FOUND` and `STORAGE_UNAVAILABLE`); merging them here would lose
 * the distinction the module exists to keep.
 */
type StoredDocumentRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "ok"; readonly document: StoredDocument };

/**
 * Where the store lives.
 *
 * Exported so a diagnostic, the log module and the tests agree on one path: a
 * second spelling of the location would be a second file that never gets read.
 *
 * @param userData the directory Electron reports for this app
 */
export function secretsPath(userData: string): string {
  return path.join(userData, STORE_FILE_NAME);
}

/**
 * Where the plaintext decision lives.
 *
 * @param userData the directory Electron reports for this app
 */
export function secretsConsentPath(userData: string): string {
  return path.join(userData, CONSENT_FILE_NAME);
}

/** Whether an error is "the file is not there", the one benign read failure. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Parse the store document, or refuse it whole.
 *
 * Refusal is all-or-nothing: a document with one bad entry is a document whose
 * shape this build does not understand, and skipping the bad entry would turn
 * "unreadable" into `NOT_FOUND` for that key - the exact confusion the red
 * red. A reader that guesses is worse than a reader that says it cannot.
 *
 * @param text the file's contents
 */
function parseDocument(text: string): StoredDocument | null {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    // The realistic corruption: a crash mid-write leaves half a document.
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;

  if (record["version"] !== STORE_VERSION) return null;

  // The document's `mode` field is a claim about its own bytes, so it has to be
  // one of the two literals: a missing value or `"ENCRYPTED"` is a document this
  // build does not understand, not one to coerce.
  const mode = record["mode"];

  if (mode !== "encrypted" && mode !== "plaintext") return null;

  const rawEntries = record["entries"];

  // An array would pass a bare `typeof` check and then carry numeric keys.
  if (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries)) {
    return null;
  }

  // `Object.create(null)`, not `{}`. A plain object inherits from `Object.prototype`,
  // so `entries["toString"]` is a function rather than `undefined` -- which made
  // `secureGet("toString")` answer `{ok: true, value: <function>}`, violating the frozen
  // return type and reporting an absent key as present. And `entries["__proto__"] = x`
  // invokes the prototype setter instead of creating an entry, so a key written under
  // that name was silently dropped from the document on the next read.
  //
  // Both are only reachable with keys nobody uses deliberately, which is why they
  // survived: the tests use names like `token`. A store must not depend on its callers
  // avoiding certain strings.
  const entries: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const [key, stored] of Object.entries(rawEntries)) {
    if (typeof stored !== "string") return null;
    entries[key] = stored;
  }

  return { mode, entries };
}

/**
 * Read the consent document.
 *
 * Fails closed like `media-access.ts`: absent, truncated, a future version, or
 * anything other than an explicit `true` means "no decision", so the user is
 * asked rather than assumed to have agreed. A consent that defaulted to yes
 * would turn a one-off answer into a permanent policy the user never gave.
 *
 * @param text the file's contents
 */
function parseConsent(text: string): boolean {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }

  if (typeof raw !== "object" || raw === null) return false;

  const record = raw as Record<string, unknown>;

  if (record["version"] !== CONSENT_VERSION) return false;

  // Strictly `true`: `"true"` and `1` are not a decision this code can honour.
  return record["plaintextAccepted"] === true;
}

/**
 * Create the `secure*` members for one `userData` directory.
 *
 * Synchronous, and it touches no disk: every file operation belongs to a call,
 * so constructing the port cannot create a plaintext candidate before the user
 * has been asked, and cannot fail a launch because a directory was unreadable.
 * The state that lives here is the process-lifetime state - the session-only
 * values and the answers already given - which is why one instance per process
 * is the intended use.
 *
 * @param options the shell answers plus the two store locations
 */
export function createDesktopSecrets(options: DesktopSecretsOptions): SecretsPort {
  const storePath = secretsPath(options.userData);
  const consentPath = secretsConsentPath(options.userData);
  const clock = options.now ?? (() => new Date());

  /**
   * Values that exist only for the life of this process.
   *
   * This is where `allow-once` writes and where nothing else does. Keeping them
   * here rather than on disk is what makes the next start ask again: a value
   * that was only permitted "this time" must not be found by a later process,
   * because that process never asked.
   */
  const session = new Map<string, string>();

  /**
   * The answer the user gave during this process.
   *
   * Cached so a refusal or a one-off consent is not re-asked on every write; a
   * store that prompts on each token refresh is a store whose prompt is clicked
   * away without being read. Only `allow-always` is written to disk - `deny` and
   * `allow-once` are deliberately not persisted (doc 29 section 4.4 item 3).
   */
  let answered: PlaintextConsentAnswer | null = null;

  /**
   * Serialises the read-modify-write cycle.
   *
   * Each write replaces the whole document, so two concurrent sets would each
   * read the old one and the second would silently drop the first key. A promise
   * chain is enough here (the same shape `log.ts` uses) and keeps the ordering
   * visible instead of hiding it in a lock abstraction.
   */
  let writeQueue: Promise<void> = Promise.resolve();

  function serialised<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);

    // The chain's own rejection is swallowed: the failure belongs to the caller
    // that got `result`, and one failed write must not poison every later one.
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  /**
   * Replace a file in one step.
   *
   * A direct `writeFile` would leave a truncated document if the process died
   * mid-write, and a truncated store reads as `STORAGE_UNAVAILABLE` from then on
   * - the user's tokens would be stranded behind a file that fails to parse.
   * Writing a sibling and renaming it means a reader sees either the old
   * document or the new one; `rename` replaces the target on Windows as well as
   * on POSIX.
   */
  async function writeAtomically(target: string, text: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: DIRECTORY_MODE });

    const temporary = `${target}.tmp`;

    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: FILE_MODE });
      await rename(temporary, target);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // A leftover temporary file is inert: it is never read and never
        // mistaken for the store, which has a different name.
      }

      throw error;
    }
  }

  /**
   * Encode one value for the chosen mode.
   *
   * @throws when `safeStorage` cannot encrypt; the caller turns that into
   *   `STORAGE_UNAVAILABLE` rather than letting it escape
   */
  function encodeValue(value: string, mode: StoreMode): string {
    if (mode === "plaintext") return value;

    return options.safeStorage.encryptString(value).toString("base64");
  }

  /**
   * Decode one stored entry, or answer `null` when it cannot be read.
   *
   * `null` is not "absent": a stored entry that will not decode is an unreadable
   * secret, and the caller turns it into `STORAGE_UNAVAILABLE`. Returning `""`
   * or throwing from here is how a key would either look empty or take down the
   * caller.
   */
  function decodeValue(stored: string, mode: StoreMode): string | null {
    if (mode === "plaintext") return stored;

    // A profile copied from another machine, or a keyring that was reset: the
    // ciphertext is intact and this process holds the wrong key for it.
    if (!options.safeStorage.isEncryptionAvailable()) return null;

    try {
      return options.safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }

  async function loadDocument(): Promise<StoredDocumentRead> {
    let text: string;

    try {
      text = await readFile(storePath, "utf8");
    } catch (error) {
      // Absent is the normal first-run state. Any other read failure means the
      // store exists and is unreachable, which is not the same answer.
      return isAbsent(error) ? { kind: "absent" } : { kind: "unreadable" };
    }

    const document = parseDocument(text);

    return document === null ? { kind: "unreadable" } : { kind: "ok", document };
  }

  async function writeDocument(document: StoredDocument): Promise<void> {
    await writeAtomically(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        mode: document.mode,
        entries: document.entries,
      }),
    );
  }

  /**
   * Re-encode every existing entry for the mode this write will use.
   *
   * Needed because the mode can differ from run to run: a keyring that appeared
   * after the plaintext period means the next write upgrades the document to
   * ciphertext, and it must carry the older entries with it instead of dropping
   * them. `null` means at least one entry could not be converted, and the caller
   * must refuse rather than write a document that lost a key.
   */
  async function convertedEntries(
    document: StoredDocument | null,
    mode: StoreMode,
  ): Promise<Record<string, string> | null> {
    // Null-prototype for the same reason the read side is: a key literally named
    // `__proto__` must become an entry, and on a plain object that assignment invokes
    // the prototype setter instead. Losing one entry during a mode conversion would
    // silently drop a token the user had stored.
    if (document === null) return Object.create(null) as Record<string, string>;

    const converted: Record<string, string> = Object.create(null) as Record<string, string>;

    for (const [key, stored] of Object.entries(document.entries)) {
      const value = decodeValue(stored, document.mode);

      if (value === null) return null;

      converted[key] = encodeValue(value, mode);
    }

    return converted;
  }

  /** Whether the user has already accepted plaintext storage on this machine. */
  async function plaintextAlreadyAccepted(): Promise<boolean> {
    try {
      return parseConsent(await readFile(consentPath, "utf8"));
    } catch {
      // No decision file yet, or one that cannot be read: both mean "not yet
      // answered", and asking again is the safe direction.
      return false;
    }
  }

  /**
   * Record an `allow-always` answer.
   *
   * Best effort: if the file cannot be written, the answer still holds for this
   * process and the next start simply asks once more. Failing the write instead
   * would reject a store the user just authorised over a file that is not the
   * secret store - the wrong thing to make load bearing.
   */
  async function recordConsent(): Promise<void> {
    try {
      await writeAtomically(
        consentPath,
        JSON.stringify({
          version: CONSENT_VERSION,
          plaintextAccepted: true,
          decidedAt: clock().toISOString(),
          backend: PLAINTEXT_BACKEND,
        }),
      );
    } catch {
      // Documented above: the in-process answer survives, the next start asks.
    }
  }

  /**
   * The user's answer about plaintext storage, asking only if nobody has.
   *
   * A persisted `allow-always` wins over the callback so a machine that has
   * already been told does not ask again. A throw from the callback is not
   * consent: an unanswered question is a refusal, and caching it would be wrong
   * because the prompt never reached the user.
   */
  async function plaintextAnswer(key: string): Promise<PlaintextConsentAnswer> {
    if (answered !== null) return answered;

    if (await plaintextAlreadyAccepted()) {
      answered = "allow-always";

      return answered;
    }

    let answer: PlaintextConsentAnswer;

    try {
      answer = await options.consent({ key, storePath });
    } catch {
      return "deny";
    }

    answered = answer;

    if (answer === "allow-always") await recordConsent();

    return answer;
  }

  /**
   * Where this write may put the value, or `null` when there is no store it may
   * use.
   *
   * `"session"` is the `allow-once` answer: the value is held for this process
   * and not written. `null` is `deny` and also "the OS says encryption is
   * unavailable": both mean the caller is told `STORAGE_UNAVAILABLE` and nothing
   * is written anywhere.
   */
  async function writeModeFor(key: string): Promise<StoreMode | "session" | null> {
    if (options.keyringAvailable) {
      // Evaluated per call, not once at construction: a Linux session can gain
      // a keyring after unlock, and a cached "no" would keep this process on the
      // downgrade path for its whole life.
      return options.safeStorage.isEncryptionAvailable() ? "encrypted" : null;
    }

    const answer = await plaintextAnswer(key);

    if (answer === "allow-always") return "plaintext";
    if (answer === "allow-once") return "session";

    return null;
  }

  const unavailable = (): SecureSetResult => ({ ok: false, code: "STORAGE_UNAVAILABLE" });

  return {
    async secureGet(key: string): Promise<SecureGetResult> {
      // Session first: a value written under `allow-once` is newer than anything
      // on disk, and it must stay readable for the life of this process.
      const held = session.get(key);

      if (held !== undefined) return { ok: true, value: held };

      const read = await loadDocument();

      if (read.kind === "absent") return { ok: false, code: "NOT_FOUND" };
      if (read.kind === "unreadable") return { ok: false, code: "STORAGE_UNAVAILABLE" };

      // An *own* property, not merely a non-`undefined` one. The distinction is what
      // `Map.get` gives the headless store, and `=== undefined` does not reproduce it:
      // an inherited member answers with a function, which is neither absent nor a
      // string. `hasOwn` is the check that means "this document has this key".
      //
      // The container is null-prototype too (see `parseDocument`), so this is belt and
      // braces -- but the check is the one that states the intent, and it stays correct
      // if the container ever changes back.
      if (!Object.hasOwn(read.document.entries, key)) {
        return { ok: false, code: "NOT_FOUND" };
      }

      const stored = read.document.entries[key] as string;

      const value = decodeValue(stored, read.document.mode);

      // Stored but not decodable: unreadable, not absent.
      if (value === null) return { ok: false, code: "STORAGE_UNAVAILABLE" };

      return { ok: true, value };
    },

    async secureSet(key: string, value: string): Promise<SecureSetResult> {
      return serialised(async () => {
        // The store is read *before* the user is asked anything. A question is
        // only honest if the answer can be honoured, and a corrupt store or an
        // encrypted document this run cannot re-encode would refuse the write
        // after the user had already agreed to a downgrade.
        const read = await loadDocument();

        // A corrupt store is not overwritten. Replacing it would silently
        // discard every other secret in it, which is worse than telling the
        // caller the store is unusable.
        if (read.kind === "unreadable") return unavailable();

        // A ciphertext document cannot receive a plaintext entry: this run has no
        // keyring, so it could not re-encode the older entries, and leaving them
        // as ciphertext inside a file marked plaintext would produce a document
        // no single reader understands. Refused before asking, because no answer
        // would make the write possible without losing the earlier secret.
        if (!options.keyringAvailable && read.kind === "ok" && read.document.mode === "encrypted") {
          return unavailable();
        }

        const mode = await writeModeFor(key);

        if (mode === null) return unavailable();

        if (mode === "session") {
          session.set(key, value);

          // Success, not `STORAGE_UNAVAILABLE`: the value is available to the
          // caller for as long as this process lives, which is what the user
          // allowed. Nothing is written, so nothing outlives the process.
          return { ok: true };
        }

        try {
          const converted = await convertedEntries(read.kind === "ok" ? read.document : null, mode);

          if (converted === null) return unavailable();

          // Built by assignment rather than a spread with a computed key: spreading into
          // an object literal creates a *plain* object, so a `__proto__` key was applied
          // as the prototype setter and vanished from the document.
          const next: Record<string, string> = Object.create(null) as Record<string, string>;

          for (const [existingKey, stored] of Object.entries(converted)) {
            next[existingKey] = stored;
          }

          next[key] = encodeValue(value, mode);

          await writeDocument({ mode, entries: next });
        } catch {
          // Encryption or the disk failed. The payload is not formatted into the
          // answer, which is why this is a bare code.
          return unavailable();
        }

        // The persisted value is now the newest one for this key; a stale
        // session copy would win a later `secureGet`.
        session.delete(key);

        return { ok: true };
      });
    },

    async secureDelete(key: string): Promise<SecureDeleteResult> {
      return serialised(async (): Promise<SecureDeleteResult> => {
        // The session copy always goes, whatever the disk says: leaving a value
        // readable after the caller asked for it to be deleted is the one thing
        // delete must not do.
        session.delete(key);

        const read = await loadDocument();

        if (read.kind !== "ok") return { ok: true };

        if (read.document.entries[key] === undefined) return { ok: true };

        const remaining = { ...read.document.entries };

        delete remaining[key];

        try {
          await writeDocument({ mode: read.document.mode, entries: remaining });
        } catch {
          // The frozen union gives delete no failure code, so a failed write is
          // unreportable here. The session copy is already gone; the persisted
          // one may remain, and the next delete or set rewrites the document
          // from whatever state it is in. Silently answering `{ok: true}` for a
          // write that did not happen is the price of the contract's idempotent
          // delete, and it is the narrower evil next to throwing a code the
          // union does not carry.
        }

        return { ok: true };
      });
    },
  };
}
