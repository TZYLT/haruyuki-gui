/**
 * JSON safety at the content layer's exit.
 *
 * Every block leaves the content model through a wire frame and is read back on
 * the other side, so a block must already be a value that
 * `JSON.parse(JSON.stringify())` can carry unchanged. Upstream payloads are wire
 * JSON most of the time, but the tool result and the unknown block's raw payload
 * are arbitrary `unknown`, and a malformed one must not poison the block around
 * it.
 *
 * This module is deliberately narrow. It is:
 *
 * - **not escaping**: strings are copied character for character, so a payload
 *   holding `<script>alert(1)</script>` still holds exactly that. Making text
 *   safe to inject into a document is the renderer's job, and doing it here
 *   would corrupt the author's text twice;
 * - **not rendering**: no value becomes markup, no block becomes HTML, and an
 *   image source is never decoded, resolved or turned into a Blob or object URL;
 * - **not parsing**: a tool's `argumentsText` is an opaque string that is never
 *   parsed here, and a string that looks like JSON stays a string.
 *
 * The value rules are the JSON subset: string, finite number, boolean, null,
 * array, plain object. Anything else is dropped -- omitted from an object, and
 * replaced by `null` in an array so positions do not shift. A cycle is cut on
 * the current path; a repeated, non-cyclic reference is copied twice. Objects
 * keep their own enumerable *data* properties only: accessors are not invoked
 * (this function must not run foreign code), and `Date`, `Map`, `Set` and class
 * instances therefore keep just their own fields, usually none.
 */

import type { Block, BlockBase, BlockId, ContentUpdate, ImageSource } from "@haruyuki/protocol";

/** Internal marker for "JSON cannot represent this"; never escapes this module. */
const OMIT = Symbol("json-omit");

/**
 * Copy an arbitrary value into the JSON subset.
 *
 * Never throws: a value JSON cannot represent at the top level becomes `null`,
 * and a nested one disappears according to its container's rule. Strings are
 * returned untouched, including any markup they contain.
 */
export function toJsonSafe(value: unknown): unknown {
  const cleaned = cleanValue(value, new WeakSet<object>());
  return cleaned === OMIT ? null : cleaned;
}

/**
 * Clean one block field by field.
 *
 * The shape is rebuilt from the known fields of the block's type rather than
 * spread from the input, so a stray function or class instance on the incoming
 * object cannot ride along. Strings that carry content (`text`, `info`, a
 * result, an image's bytes) are kept verbatim; only values that are declared
 * `unknown` (`result`, `raw`) are cleaned recursively. `type` and `status` are
 * copied, never derived, so a state machine decision is not made here.
 *
 * A future block type that this version does not know still leaves as JSON: it
 * falls through to the generic cleaner instead of throwing or being dropped.
 */
export function sanitizeBlock(block: Block): Block {
  const candidate: unknown = block;
  if (candidate === null || typeof candidate !== "object") {
    // There is no block shape to repair, so the predictable JSON answer is
    // used rather than propagating a TypeError.
    return toJsonSafe(candidate) as Block;
  }

  switch (block.type) {
    case "text": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "text",
        text: asText(block.text),
        flavor: block.flavor,
        status: block.status,
      };
    }
    case "code": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "code",
        text: asText(block.text),
        info: asText(block.info),
        closed: asFlag(block.closed),
        status: block.status,
      };
    }
    case "image": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "image",
        source: sanitizeImageSource(block.source),
        alt: asTextOrNull(block.alt),
      };
    }
    case "tool_call": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "tool_call",
        toolCallId: asText(block.toolCallId),
        name: asTextOrNull(block.name),
        argumentsText: asText(block.argumentsText),
        result: toJsonSafe(block.result),
        status: block.status,
        orphan: asFlag(block.orphan),
      };
    }
    case "reasoning": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "reasoning",
        text: asText(block.text),
      };
    }
    case "notice": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "notice",
        category: block.category,
        title: asTextOrNull(block.title),
        text: asText(block.text),
      };
    }
    case "error": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "error",
        message: asText(block.message),
        errorType: asTextOrNull(block.errorType),
        detail: asTextOrNull(block.detail),
      };
    }
    case "unknown": {
      const base = copyBase(block);
      return {
        id: base.id,
        messageId: base.messageId,
        runId: base.runId,
        role: base.role,
        type: "unknown",
        rawType: asText(block.rawType),
        raw: toJsonSafe(block.raw),
      };
    }
    default:
      return toJsonSafe(block) as Block;
  }
}

/**
 * Clean one update: every upsert keeps its position, and `removes` is deduped
 * in first-seen order. A missing or malformed list becomes empty rather than
 * throwing, so a bad frame cannot break the update envelope.
 */
export function sanitizeUpdate(update: ContentUpdate): ContentUpdate {
  const candidate: unknown = update;
  if (candidate === null || typeof candidate !== "object") {
    return { messageId: "", upserts: [], removes: [] };
  }

  const record = candidate as Partial<Record<keyof ContentUpdate, unknown>>;
  const upserts = Array.isArray(record.upserts)
    ? (record.upserts as unknown[]).map((block) => sanitizeBlock(block as Block))
    : [];
  const removes = Array.isArray(record.removes) ? uniqueBlockIds(record.removes as unknown[]) : [];

  return { messageId: asText(record.messageId), upserts, removes };
}

function cleanValue(value: unknown, path: WeakSet<object>): unknown | typeof OMIT {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // JSON has one zero: `-0` survives in memory but not on the wire, so it is
      // normalised here to keep the round trip a deep equal.
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : OMIT;
    case "object":
      return cleanObject(value, path);
    default:
      // undefined, function, symbol, bigint: outside the JSON subset.
      return OMIT;
  }
}

function cleanObject(value: object, path: WeakSet<object>): unknown | typeof OMIT {
  if (path.has(value)) {
    // A cycle is cut where it closes; the entries above this point survive.
    return OMIT;
  }

  path.add(value);
  try {
    return Array.isArray(value) ? cleanArray(value, path) : cleanRecord(value, path);
  } catch {
    // A revoked proxy or a throwing trap must not take the whole block down.
    return OMIT;
  } finally {
    path.delete(value);
  }
}

function cleanArray(value: readonly unknown[], path: WeakSet<object>): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const raw = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    const cleaned = cleanValue(raw, path);
    // An omitted entry becomes null so that later positions keep their index.
    out.push(cleaned === OMIT ? null : cleaned);
  }
  return out;
}

function cleanRecord(value: object, path: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      // An accessor is skipped instead of invoked: cleaning must not execute
      // foreign code, and one throwing getter must not fail the block.
      continue;
    }

    const cleaned = cleanValue(descriptor.value, path);
    if (cleaned === OMIT) {
      continue;
    }
    defineJsonProperty(out, key, cleaned);
  }
  return out;
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  // Plain assignment would treat a literal "__proto__" key as a prototype
  // change; defining a data property matches how JSON.parse keeps such a key.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Read the four identity fields through one set of rules, per block type.
 *
 * Callers name the fields individually in the literal they return instead of
 * spreading this object. A literal that writes `type` alongside a spread looks
 * like a frame whose channel the frame gate cannot read, so block literals are
 * written out in full; naming the fields also keeps the returned shape to the
 * declared ones instead of whatever else the input happens to carry.
 */
function copyBase(block: Block): BlockBase {
  return {
    id: asText(block.id),
    messageId: asText(block.messageId),
    runId: asTextOrNull(block.runId),
    role: block.role,
  };
}

function sanitizeImageSource(source: unknown): ImageSource {
  const cleaned = toJsonSafe(source);
  if (isRecord(cleaned)) {
    if (cleaned.kind === "url") {
      return { kind: "url", url: asText(cleaned.url) };
    }
    if (cleaned.kind === "base64") {
      return {
        kind: "base64",
        mediaType: asText(cleaned.mediaType),
        data: asText(cleaned.data),
      };
    }
  }
  // Neither URL resolution nor decoding happens here, even for a malformed
  // payload; an unclassifiable source collapses to an empty url source.
  return { kind: "url", url: "" };
}

function uniqueBlockIds(ids: readonly unknown[]): BlockId[] {
  const seen = new Set<string>();
  const out: BlockId[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFlag(value: unknown): boolean {
  return value === true;
}
