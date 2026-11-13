/**
 * fingerprint.mjs - shape and field fingerprints for the contract snapshot.
 *
 * Frozen definition (A2-D02 / 08 section 3.2):
 *   shapeFingerprint = sha256(interface body text with comments stripped and
 *                               whitespace collapsed)[0..12)
 *   fieldFingerprint = sha256(canonical field JSON with field type text comment
 *                               free and whitespace collapsed)[0..12)
 *
 * Both fingerprints strip comments before hashing. The scan-level field `type`
 * is raw source text, so an inline comment inside the type text would otherwise
 * make a comment-only edit look like a field change while `shapeFingerprint`
 * (which always stripped comments) stayed identical.
 *
 * Seam for command extraction, message extraction and snapshot assembly:
 *
 *   import { shapeFingerprint, fieldFingerprint } from "./lib/fingerprint.mjs";
 *   const shape = shapeFingerprint(entry.bodyText);   // "3f2a1c9d0e42"
 *   const fields = fieldFingerprint(entry.fields);    // "9b1c..."
 *
 *   // The diff reports normalized type text, not the raw source slice:
 *   import { normalizeBodyText } from "./lib/fingerprint.mjs";
 *   normalizeBodyText("request_id: string // client id") // "request_id: string"
 *
 * The fingerprints are raw syntax hashes. They answer "did the declaration
 * change?" only, never "does the wire contract still mean the same thing?".
 * Renames are a diff-time inference, so a shape match across two type
 * names is a suspicion, not a conclusion.
 *
 * Determinism: input order never leaks into the output. Body text is comment
 * free and whitespace collapsed; fields are sorted by name and every optional
 * key is coerced to a boolean before hashing, so `undefined` and a missing key
 * hash the same.
 */

import { createHash } from "node:crypto";

/** Fingerprint length in hex characters. Frozen by the route doc (08 3.2). */
export const FINGERPRINT_LENGTH = 12;

/**
 * sha256 hex digest of a UTF-8 string.
 *
 * @param {string} text
 * @returns {string} 64 lowercase hex characters
 */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Shape fingerprint: sha256 over comment-free, whitespace-collapsed body text.
 *
 * @param {string} bodyText interface body or alias type text
 * @returns {string} 12 lowercase hex characters
 */
export function shapeFingerprint(bodyText) {
  return sha256Hex(normalizeBodyText(bodyText)).slice(0, FINGERPRINT_LENGTH);
}

/**
 * Field fingerprint: sha256 over the canonical field JSON, sorted by name.
 *
 * Canonical key order is name, type, optional, readonly, nested. Missing or
 * non-boolean flags are coerced to false; type text is comment free and
 * whitespace-collapsed, matching the `shapeFingerprint` treatment so a
 * comment-only edit is invisible to both. Both scan-level fields and
 * snapshot-level fields ({name, type, optional}) hash consistently, because
 * absent flags become false on both sides.
 *
 * @param {{name?: unknown, type?: unknown, optional?: unknown, readonly?: unknown, nested?: unknown}[]} fields
 * @returns {string} 12 lowercase hex characters
 */
export function fieldFingerprint(fields) {
  const canonical = (Array.isArray(fields) ? fields : [])
    .map((field) => ({
      name: typeof field?.name === "string" ? field.name : String(field?.name ?? ""),
      type: normalizeTypeText(
        typeof field?.type === "string" ? field.type : String(field?.type ?? ""),
      ),
      optional: Boolean(field?.optional),
      readonly: Boolean(field?.readonly),
      nested: Boolean(field?.nested),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  return sha256Hex(JSON.stringify(canonical)).slice(0, FINGERPRINT_LENGTH);
}

/**
 * Normalize one raw type text for hashing: strip comments, collapse whitespace.
 *
 * Fields and shapes must use the same rule, otherwise the two fingerprints
 * disagree about whether a comment-only edit is a change.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTypeText(text) {
  return normalizeBodyText(text);
}

/**
 * Strip comments and collapse whitespace.
 *
 * Comment markers inside string, template and regex-free literal positions are
 * preserved: the scanner tracks single, double and backtick quotes and skips
 * escaped characters, so a `//` inside `"http://..."` cannot start a comment.
 * Template literal interpolation is not parsed; the whole literal stays one
 * quoted run, which is enough because only whitespace and comments are
 * normalized here.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeBodyText(text) {
  if (typeof text !== "string") {
    return "";
  }

  const withoutComments = stripComments(text);

  return collapseWhitespace(withoutComments);
}

/**
 * Collapse every whitespace run to one space and trim.
 *
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Remove `//` and block comments while preserving quoted literals.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let output = "";
  let index = 0;
  let quote = null;

  while (index < text.length) {
    const character = text[index];

    if (quote) {
      output += character;

      if (character === "\\") {
        const escaped = text[index + 1];

        if (escaped !== undefined) {
          output += escaped;
          index += 2;
          continue;
        }
      }

      if (character === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }

      continue;
    }

    if (character === "/" && text[index + 1] === "*") {
      index += 2;

      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }

      index += 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}
