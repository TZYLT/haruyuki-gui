/**
 * The desktop secure store: absent is not empty, and plaintext is never silent.
 *
 * The requirement states two red conditions, and they fail
 * differently, which is why the tests are grouped by them:
 *
 *   **Distinguishable answers** -- a key nobody stored is `NOT_FOUND`, a store
 *   that cannot be read is `STORAGE_UNAVAILABLE`, and an empty string is a
 *   *value*. Collapsing any two of those is how a caller ends up overwriting a
 *   good token with a blank one, or telling the user "no token configured" when
 *   the truth is "your keyring was reset".
 *
 *   **Informed downgrade** -- on a machine with no keyring the store asks before
 *   the first plaintext write, writes only if the user agreed, and keeps an
 *   `allow-once` answer out of every later process. A silent fallback would be a
 *   policy the user never gave, which is the one thing `D2-Q05` forbids.
 *
 * Every collaborator is injected: a reversible `safeStorage` stand-in, the
 * keyring answer, the consent callback and the clock. "Restart" is therefore a
 * second `createDesktopSecrets` over the same directory -- the actual property
 * under test, because "survives a restart" and "asks again after a restart" are
 * claims about a *new process* and nothing else can express them.
 *
 * Where a store file's bytes matter, the assertions are written on a boolean
 * (`contents.includes(value)`) rather than on the contents, so a failure message
 * cannot print a secret.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDesktopSecrets,
  secretsConsentPath,
  secretsPath,
  type DesktopSecretsOptions,
  type PlaintextConsent,
  type PlaintextConsentAnswer,
  type PlaintextConsentQuestion,
  type SecretsPort,
  type SecretsSafeStorage,
} from "../secrets.js";

/** Directories created by a test, removed afterwards. */
const created: string[] = [];

/** A fresh directory that will be cleaned up. */
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "d2-secrets-"));
  created.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A reversible stand-in for `safeStorage`, tagged like one machine's key.
 *
 * The tag is what makes "a keyring was reset" and "this profile came from
 * another machine" expressible: the second stand-in produces ciphertext the
 * first one cannot read, exactly as a new key would.
 *
 * The encoding is deliberately trivial (a prefix, not real crypto): these tests
 * are about which bytes reach which file and what the caller is told, and a
 * stub whose output cannot be inspected would make the "no mixed plaintext and
 * ciphertext" claim unassertable.
 */
function fakeKeyring(tag: string): SecretsSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`${tag}:${plainText}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString("utf8");
      const prefix = `${tag}:`;

      if (!text.startsWith(prefix)) {
        // What `safeStorage` does when the OS key changed: it throws. The store
        // must turn that into `STORAGE_UNAVAILABLE`, never into an empty value.
        throw new Error(`cannot decrypt with key ${tag}`);
      }

      return text.slice(prefix.length);
    },
  };
}

/** A keyring whose OS-level encryption is not available at all. */
function noEncryption(): SecretsSafeStorage {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("encryption unavailable");
    },
    decryptString: () => {
      throw new Error("encryption unavailable");
    },
  };
}

/** The questions a consent callback was asked, plus the answer it gave. */
interface ConsentSpy {
  readonly consent: PlaintextConsent;
  readonly asked: PlaintextConsentQuestion[];
}

/** A consent callback that records the question and always answers `answer`. */
function consentAnswering(answer: PlaintextConsentAnswer): ConsentSpy {
  const asked: PlaintextConsentQuestion[] = [];

  return {
    asked,
    consent: async (question) => {
      asked.push(question);

      return answer;
    },
  };
}

/**
 * A consent callback that must not be called.
 *
 * Returning `deny` would make a missing question indistinguishable from a
 * delivered one, so this throws: a test that asserts "the question is not asked
 * again" has to fail on the call, not on the answer.
 */
function consentForbidden(): ConsentSpy {
  const asked: PlaintextConsentQuestion[] = [];

  return {
    asked,
    consent: async (question) => {
      asked.push(question);

      throw new Error("consent must not be requested here");
    },
  };
}

/** Build one store, as `main.ts` will, with a keyring-backed default. */
function build(
  userData: string,
  overrides: {
    safeStorage?: SecretsSafeStorage;
    keyringAvailable?: boolean;
    consent?: PlaintextConsent;
  } = {},
): SecretsPort {
  const options: DesktopSecretsOptions = {
    userData,
    safeStorage: overrides.safeStorage ?? fakeKeyring("machine-a"),
    keyringAvailable: overrides.keyringAvailable ?? true,
    consent: overrides.consent ?? (async () => "deny"),
    // Fixed so the recorded decision is predictable; nothing branches on it.
    now: () => new Date("2026-11-16T00:00:00.000Z"),
  };

  return createDesktopSecrets(options);
}

describe("where the store lives", () => {
  it("is its own document, not a section of shell-settings.json", () => {
    // `D1`'s file has its key set pinned by an assertion and travels in the
    // diagnostic bundle, so a secret in it would be a leak by packaging. Doc 29
    // section 4.4 item 5 states it as a red condition.
    expect(path.basename(secretsPath("/home/u"))).toBe("secrets.json");
    expect(secretsPath("/home/u")).not.toContain("shell-settings");
  });

  it("keeps the decision apart from what the decision is about", () => {
    // Doc 29 section 6.5: one file is a decision, the other is the payload. Two
    // files mean a corrupt store cannot be read as "no decision" and a missing
    // decision cannot reinterpret the store.
    expect(secretsConsentPath("/home/u")).not.toBe(secretsPath("/home/u"));
    expect(path.basename(secretsConsentPath("/home/u"))).toBe("secrets-consent.json");
  });
});

describe("an absent key is not an empty one", () => {
  it("answers NOT_FOUND for a key nobody stored, not an empty string", async () => {
    // The absent-versus-empty red condition. A caller that got `""` could not tell "the user has
    // no token" from "the token is empty", and would overwrite the first case.
    const store = build(scratch());

    await expect(store.secureGet("capability-token")).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("answers NOT_FOUND for the missing key when other keys exist", async () => {
    const store = build(scratch());
    await store.secureSet("one", "value-one");

    await expect(store.secureGet("two")).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("stores an empty value as a value, so it cannot be mistaken for absent", async () => {
    // The other half of the distinction: presence is a fact about the document,
    // not about the string's length. Collapsing this would make an intentionally
    // blank setting unrepresentable.
    const store = build(scratch());
    await store.secureSet("blank", "");

    await expect(store.secureGet("blank")).resolves.toEqual({ ok: true, value: "" });
  });
});

describe("writing", () => {
  it("overwrites an existing key, because a refreshed token is the normal case", async () => {
    // The contract spells this out: refreshing a token must not require a
    // delete-then-set dance, and the stale read path must not win.
    const store = build(scratch());

    await expect(store.secureSet("token", "stale")).resolves.toEqual({ ok: true });
    await expect(store.secureSet("token", "fresh")).resolves.toEqual({ ok: true });
    await expect(store.secureGet("token")).resolves.toEqual({ ok: true, value: "fresh" });
  });

  it("keeps one key's value when another is written", async () => {
    // The document is replaced whole on every write, so a lost older entry is
    // the failure mode this asserts against.
    const store = build(scratch());
    await store.secureSet("one", "value-one");
    await store.secureSet("two", "value-two");

    await expect(store.secureGet("one")).resolves.toEqual({ ok: true, value: "value-one" });
    await expect(store.secureGet("two")).resolves.toEqual({ ok: true, value: "value-two" });
  });

  it("answers OK once the value is readable back by a new process", async () => {
    // "Success" is only meaningful as "durable": a `{ok:true}` for a write that
    // a restart cannot find would be the worst possible answer.
    const dir = scratch();
    await build(dir).secureSet("token", "value");

    await expect(build(dir).secureGet("token")).resolves.toEqual({ ok: true, value: "value" });
  });
});

describe("deleting", () => {
  it("answers OK for a key that was never there, so cleanup needs no read", async () => {
    // Idempotence is the whole value: a sign-out path deletes every token it
    // might have written, and it must not branch on which ones exist.
    const store = build(scratch());

    await expect(store.secureDelete("never-stored")).resolves.toEqual({ ok: true });
  });

  it("removes one key and leaves the others alone", async () => {
    const store = build(scratch());
    await store.secureSet("one", "value-one");
    await store.secureSet("two", "value-two");

    await store.secureDelete("one");

    await expect(store.secureGet("one")).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    await expect(store.secureGet("two")).resolves.toEqual({ ok: true, value: "value-two" });
  });

  it("answers OK on the second delete too", async () => {
    const dir = scratch();
    const store = build(dir);
    await store.secureSet("token", "value");

    await store.secureDelete("token");

    await expect(store.secureDelete("token")).resolves.toEqual({ ok: true });
    await expect(build(dir).secureGet("token")).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("no keyring, and the user accepts plaintext", () => {
  it("writes the value in plaintext and asks exactly once", async () => {
    const dir = scratch();
    const spy = consentAnswering("allow-always");
    const store = build(dir, { keyringAvailable: false, consent: spy.consent });

    await expect(store.secureSet("token", "plain-value")).resolves.toEqual({ ok: true });

    expect(spy.asked).toHaveLength(1);
    // The question has to name the file, because that is what the user is being
    // asked to accept: doc 29 section 4.4 item 1 quotes the path to them.
    expect(spy.asked[0]?.storePath).toBe(secretsPath(dir));
    expect(spy.asked[0]?.key).toBe("token");

    // Plaintext on disk is the informed decision, so this is the one place the
    // bytes are asserted - and on a boolean, so a failure cannot print it.
    await expect(store.secureGet("token")).resolves.toEqual({ ok: true, value: "plain-value" });
    const contents = await readFile(secretsPath(dir), "utf8");

    expect(contents.includes("plain-value")).toBe(true);
  });

  it("survives a restart and does not ask again", async () => {
    // After accepting, ask no more. A second prompt after the user already decided is
    // how a consent dialog becomes something people click through.
    const dir = scratch();
    const first = consentAnswering("allow-always");

    await build(dir, { keyringAvailable: false, consent: first.consent }).secureSet(
      "token",
      "plain-value",
    );

    const second = consentForbidden();
    const restarted = build(dir, { keyringAvailable: false, consent: second.consent });

    await expect(restarted.secureGet("token")).resolves.toEqual({
      ok: true,
      value: "plain-value",
    });
    // A later write in the new process must not re-ask either.
    await expect(restarted.secureSet("other", "other-value")).resolves.toEqual({ ok: true });
    expect(second.asked).toHaveLength(0);
  });

  it("records the decision in the consent document, not in the store", async () => {
    // A record anywhere else would be either a leak (a store entry) or a file
    // this module does not own.
    const dir = scratch();

    await build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    }).secureSet("token", "plain-value");

    expect(existsSync(secretsConsentPath(dir))).toBe(true);

    const storeContents = await readFile(secretsPath(dir), "utf8");

    expect(storeContents.includes("plaintextAccepted")).toBe(false);
  });
});

describe("no keyring, and the user allows it once", () => {
  it("keeps the value readable for this process and writes nothing", async () => {
    const dir = scratch();
    const store = build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("allow-once").consent,
    });

    await expect(store.secureSet("token", "session-value")).resolves.toEqual({ ok: true });
    await expect(store.secureGet("token")).resolves.toEqual({
      ok: true,
      value: "session-value",
    });
    // No decision was made, so no decision file may exist: doc 29 section 4.4
    // item 3 (「下一轮仍会问」) depends on this file being absent.
    expect(existsSync(secretsConsentPath(dir))).toBe(false);
    expect(existsSync(secretsPath(dir))).toBe(false);
  });

  it("asks again after a restart, because the answer was never persisted", async () => {
    // The property that distinguishes `allow-once` from `allow-always`: a
    // `restart` that found the value would be a session-only permission
    // silently promoted to a permanent one.
    const dir = scratch();

    await build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("allow-once").consent,
    }).secureSet("token", "session-value");

    const second = consentAnswering("deny");
    const restarted = build(dir, { keyringAvailable: false, consent: second.consent });

    await expect(restarted.secureGet("token")).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    await restarted.secureSet("token", "again");

    expect(second.asked).toHaveLength(1);
  });
});

describe("no keyring, and the user refuses", () => {
  it("answers STORAGE_UNAVAILABLE and writes nothing anywhere", async () => {
    // The other red condition: an unconsented plaintext write. Both files
    // are asserted absent because "nothing written" has to include the decision
    // record - a refusal is not a decision to persist.
    const dir = scratch();
    const store = build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("deny").consent,
    });

    await expect(store.secureSet("token", "refused-value")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
    expect(existsSync(secretsPath(dir))).toBe(false);
    expect(existsSync(secretsConsentPath(dir))).toBe(false);
    await expect(store.secureGet("token")).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("does not let a refusal hide a value that was already on disk", async () => {
    // A refusal governs writes. Turning it into "the store is unreachable" for
    // reads would make a user who once said no lose access to what they had
    // already allowed - a different decision than the one they made.
    const dir = scratch();
    await build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    }).secureSet("token", "plain-value");

    const refused = build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("deny").consent,
    });

    await expect(refused.secureGet("token")).resolves.toEqual({
      ok: true,
      value: "plain-value",
    });
  });
});

describe("a store that cannot be reached says so", () => {
  it("answers STORAGE_UNAVAILABLE for a corrupt document, never plaintext", async () => {
    // The realistic corruption: a crash mid-write leaves half a document. The
    // temptation is to treat it as absent and start a fresh plaintext store -
    // which would silently discard every other secret in the file.
    const dir = scratch();
    writeFileSync(secretsPath(dir), '{"version": 1, "mode": "plaintext", "entries": {"a": "t');

    const spy = consentForbidden();
    const store = build(dir, { keyringAvailable: false, consent: spy.consent });
    const before = await readFile(secretsPath(dir), "utf8");

    await expect(store.secureGet("a")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(store.secureSet("b", "new-value")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });

    // Not a plaintext fallback, not a rewrite, and not a question: the store is
    // unusable, which is not a reason to ask the user for a downgrade.
    expect(spy.asked).toHaveLength(0);
    expect(await readFile(secretsPath(dir), "utf8")).toBe(before);
  });

  it("keeps the corrupt file's payload out of the answer it returns", async () => {
    // The answer is what a caller may log or surface. A store error that quoted
    // the ciphertext would put a secret in the log by way of the failure path.
    const dir = scratch();
    writeFileSync(secretsPath(dir), '{"version": 1, "entries": oops');

    const store = build(dir);
    const result = await store.secureSet("token", "secret-value");

    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(Object.keys(result)).not.toContain("message");
  });

  it("answers STORAGE_UNAVAILABLE when the store path is a directory", async () => {
    // "Present but unreadable" is a different event from "absent", and this is
    // the cheapest way to produce it: `readFile` fails with EISDIR.
    const dir = scratch();
    mkdirSync(secretsPath(dir));

    const store = build(dir);

    await expect(store.secureGet("token")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("answers STORAGE_UNAVAILABLE -- not a plaintext write -- when encryption is off", async () => {
    // Doc 29 section 4.4 row 1: Windows/macOS (and Linux with a keyring) answer
    // STORAGE_UNAVAILABLE when `isEncryptionAvailable()` is false. The store must
    // not treat that as the informed-downgrade case, because the user was never
    // asked.
    const dir = scratch();
    const spy = consentForbidden();
    const store = build(dir, { safeStorage: noEncryption(), consent: spy.consent });

    await expect(store.secureSet("token", "value")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
    expect(spy.asked).toHaveLength(0);
    expect(existsSync(secretsPath(dir))).toBe(false);
  });

  it("answers STORAGE_UNAVAILABLE when the ciphertext cannot be decrypted", async () => {
    // A reset keyring or a profile copied between machines. The entry exists, so
    // this is "unreadable", not `NOT_FOUND`, and certainly not `""`.
    const dir = scratch();
    await build(dir, { safeStorage: fakeKeyring("machine-a") }).secureSet("token", "value");

    const store = build(dir, { safeStorage: fakeKeyring("machine-b") });

    await expect(store.secureGet("token")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("resolves STORAGE_UNAVAILABLE when encryption throws instead of rejecting", async () => {
    // Every documented failure is a value. A `safeStorage` that throws must not
    // become a rejected promise, or every caller needs a try/catch the contract
    // says it does not need.
    const dir = scratch();
    const throwing: SecretsSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error("keyring locked");
      },
      decryptString: () => "unused",
    };

    const store = build(dir, { safeStorage: throwing });

    await expect(store.secureSet("token", "value")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });
    expect(existsSync(secretsPath(dir))).toBe(false);
  });
});

describe("plaintext and ciphertext are never mixed in one document", () => {
  it("refuses a plaintext write over an encrypted store instead of copying its ciphertext", async () => {
    // The failure this prevents is subtle and would only show up later: a
    // document marked `plaintext` that carries another key's *ciphertext* is a
    // document no single reader understands, and the older secret would become
    // unreadable the moment the mode was trusted. The store therefore refuses
    // the write rather than downgrading a decision it can no longer re-encode.
    const dir = scratch();
    await build(dir, { safeStorage: fakeKeyring("machine-a") }).secureSet("one", "value-one");

    const before = await readFile(secretsPath(dir), "utf8");
    const downgraded = build(dir, {
      safeStorage: fakeKeyring("machine-a"),
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    });

    await expect(downgraded.secureSet("two", "value-two")).resolves.toEqual({
      ok: false,
      code: "STORAGE_UNAVAILABLE",
    });

    // Byte-identical: no partial conversion, and the second key's plaintext is
    // nowhere in the file.
    expect(await readFile(secretsPath(dir), "utf8")).toBe(before);
    expect(before.includes("value-two")).toBe(false);

    // The earlier, stronger decision still holds: the original value is readable
    // with the key that wrote it.
    await expect(
      build(dir, { safeStorage: fakeKeyring("machine-a") }).secureGet("one"),
    ).resolves.toEqual({ ok: true, value: "value-one" });
  });

  it("carries a plaintext store into ciphertext when a keyring appears, losing no key", async () => {
    // The other direction of the same rule: an upgrade must re-encode every
    // entry, because the document's mode covers all of them. Dropping the older
    // entry would be a silent loss on the day the keyring starts working.
    const dir = scratch();
    await build(dir, {
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    }).secureSet("one", "value-one");

    await build(dir, { safeStorage: fakeKeyring("machine-a") }).secureSet("two", "value-two");

    const upgraded = build(dir, { safeStorage: fakeKeyring("machine-a") });

    await expect(upgraded.secureGet("one")).resolves.toEqual({ ok: true, value: "value-one" });
    await expect(upgraded.secureGet("two")).resolves.toEqual({ ok: true, value: "value-two" });

    const contents = await readFile(secretsPath(dir), "utf8");

    expect(contents.includes("value-one")).toBe(false);
  });

  it("writes every entry of a plaintext document as plaintext, with no ciphertext beside it", async () => {
    // The specific mixture worth guarding: an accepted downgrade that wrote only
    // *new* keys as plaintext while carrying the earlier ones across as
    // ciphertext blobs. The file would still parse, still answer, and be
    // readable by nothing. Asserted on the ciphertext this stub would have
    // produced, so the check is about the encoding rather than about a field name.
    const dir = scratch();
    const keyring = fakeKeyring("machine-a");
    const ciphertext = keyring.encryptString("value-one").toString("base64");
    const store = build(dir, {
      safeStorage: keyring,
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    });

    await store.secureSet("one", "value-one");
    await store.secureSet("two", "value-two");

    const contents = await readFile(secretsPath(dir), "utf8");

    expect(contents.includes(ciphertext)).toBe(false);
    expect(contents.includes("value-one")).toBe(true);
    expect(contents.includes("value-two")).toBe(true);
  });
});

describe("a key is a key, whatever its name", () => {
  /**
   * A store that will write plaintext without asking.
   *
   * The default `build` refuses, because that is the safe default -- these cases are
   * about key names, not about consent, so the answer is fixed here rather than repeated.
   */
  function plaintextStore(userData: string): SecretsPort {
    return build(userData, {
      keyringAvailable: false,
      consent: consentAnswering("allow-always").consent,
    });
  }

  // A caller must be able to tell "absent" from "unreadable", and the frozen
  // union says a value is a string. A plain object container broke both: `entries
  // ["toString"]` inherited a function, so `secureGet("toString")` answered
  // `{ok: true, value: <function>}` -- absent reported as present, and a return type
  // violated in a way TypeScript could not see because the annotation said
  // `Record<string, string>`.
  //
  // Reachable only with names nobody types on purpose, which is exactly why it survived:
  // every other case in this file uses `token`, `added`, `empty`. A store that works only
  // for callers who avoid certain strings is not a store.

  it("answers NOT_FOUND for a name the prototype happens to own", async () => {
    const store = plaintextStore(scratch());
    await store.secureSet("token", "abc");

    for (const inherited of ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__"]) {
      if (inherited === "__proto__") continue;

      const answer = await store.secureGet(inherited);

      // Not "truthy but odd": the frozen union has no shape for a non-string value.
      expect(answer, inherited).toEqual({ ok: false, code: "NOT_FOUND" });
    }
  });

  it("round-trips a key literally named __proto__", async () => {
    // The prototype setter used to swallow the entry on read: `secureSet` reported
    // `{ok: true}`, `secureGet` reported a different value, and the next write dropped it
    // from the document entirely. A success that no read can confirm is the failure this
    // contract's third rule forbids by name.
    const dir = scratch();
    const store = plaintextStore(dir);

    await expect(store.secureSet("__proto__", "SECRET-42")).resolves.toEqual({ ok: true });
    await expect(store.secureGet("__proto__")).resolves.toEqual({ ok: true, value: "SECRET-42" });
  });

  it("still has it after a restart, and after another write", async () => {
    // The loss was silent and deferred: the key disappeared from disk on the *next*
    // write, so a single set-and-get in one process would have looked fine.
    const dir = scratch();

    await plaintextStore(dir).secureSet("__proto__", "SECRET-42");
    await plaintextStore(dir).secureSet("other", "xyz");

    const reopened = plaintextStore(dir);

    await expect(reopened.secureGet("__proto__")).resolves.toEqual({
      ok: true,
      value: "SECRET-42",
    });
    await expect(reopened.secureGet("other")).resolves.toEqual({ ok: true, value: "xyz" });
  });

  it("does not pollute the prototype of anything", async () => {
    // The narrower failure mode worth ruling out explicitly: `parseDocument` refuses a
    // document whose values are not strings, so the setter could only ever be handed a
    // string -- but "could not" written down is worth more than "did not happen".
    const dir = scratch();
    const store = plaintextStore(dir);

    await store.secureSet("__proto__", "polluted?");

    expect(({} as Record<string, unknown>)["polluted?"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("the files are owner-only on POSIX", () => {
  // **Unverified on this machine, and marked so rather than silently passing.**
  //
  // `it.skipIf` is used instead of an early `return` for a specific reason: an early
  // return reports the test as *passed*, and a reader of the suite would conclude that
  // 0700/0600 had been checked. They have not -- there is no POSIX host here. The
  // This is meant to be verified by a unit test, so the honest state is
  // "skipped, pending a POSIX run", and `it.skipIf` is what says exactly that.
  it.skipIf(process.platform === "win32")(
    "creates the directory 0700 and the document 0600",
    async () => {
      // The user agreed to plaintext that "anything able to read that directory
      // can read". Handing group or other a read bit would widen what they agreed
      // to, so it is asserted rather than assumed. Windows ignores both modes and
      // inherits the profile ACL, so this claim is POSIX-only.

      const root = scratch();
      // A nested directory, so the store's own `mkdir` is what creates it and the
      // mode is this module's, not `mkdtemp`'s.
      const userData = path.join(root, "nested", "userData");
      const store = build(userData, {
        keyringAvailable: false,
        consent: consentAnswering("allow-always").consent,
      });

      await store.secureSet("token", "value");

      expect(statSync(userData).mode & 0o777).toBe(0o700);
      expect(statSync(secretsPath(userData)).mode & 0o777).toBe(0o600);
    },
  );
});
