/**
 * 生产用的帧读取器：把一条入站帧解码到内核能路由的程度。
 *
 * ## 为什么这个文件必须存在
 *
 * `channel.ts` 的 `DEFAULT_READER.responseOf` **恒返回 `undefined`**——那是个安全
 * 默认，代价是**任何期待答复的 `send` 都会走到 `TIMEOUT`**。内核能发、能看事件，
 * 但收不到任何结果。
 *
 * 接线时发现了这一点：真实栈里**没有任何生产版 `EngineFrameReader`**，
 * 只有测试替身。没有它，整个引擎客户端无法「真的收发」。这个文件补上那一块。
 *
 * ## 为什么 wire 字段名在这里，而 `client/` 别处没有
 *
 * `client/` 里禁止出现 wire **词汇**（命令名、事件名），因为它意味着有人绕过
 * 能力名映射表自拼报文。但**读回复帧必然要知道相关字段叫什么**——那是协议事实，
 * 不是绕过。
 *
 * **本文件没有豁免。** `capability-names.test.ts` 的全目录扫描照常扫它，
 * 而它之所以通得过，是因为**它读的字段名不在 wire 词汇表里**：`request_id`、
 * `success`、`accepted` 是信封/判定字段，不是能力名或事件类型名。
 *
 * **这个区别很重要，所以写清楚**：如果将来有人在这个文件里写下一个 wire **类型名**
 * （比如某个 `*_response` 或某个事件类型），门禁**会红**——它没有被放行。**不要**
 * 把它当成豁免点，也不要为了让它通过而往豁免名单里加它：那会把「读协议字段」
 * 和「自拼报文」混为一谈，而这个约定的理由正是区分这两件事。
 *
 * 本文件的范围是**窄的**：只读两个字段（相关 id、判定标志），不解码任何载荷，
 * 不认识任何具体命令名。「哪个命令的答复长什么样」不是它的事——载荷原样交给
 * 调用方。
 *
 * ## 字段名的依据（不是猜的）
 *
 * 两个字段来自 `fixtures/engine/recordings/*.jsonl` 的**全部**回复帧实测：7 种
 * 键集，每一种都含这两个字段。语料本身没有字段级 schema（`snapshot.json` 的
 * 136 条 message 全是 `fieldLevel:false`），所以用过实测枚举而非文档声明作依据。
 */

import type { DecodedResponse, EngineFrameReader } from "./channel";
import { refusedByEngineError } from "./channel-errors";

/** The correlation field on a reply frame; present on every recorded reply. */
const CORRELATION_FIELD = "request_id";

/**
 * The booleans that say whether the engine accepted the command.
 *
 * Two spellings, both measured in the corpus rather than guessed:
 *
 * - `success` on all seven `<command>_response` shapes;
 * - `accepted` on that acknowledgement, the one acknowledgement whose type does
 *   not follow the reply naming rule.
 *
 * **A correlation id alone is not enough to call a frame a reply.** The engine
 * also *sends* requests that carry a `request_id` - the recorded engine-initiated frame was
 * one recorded - and treating one of those as an answer would settle an
 * unrelated in-flight command with the wrong result. The verdict flag is what
 * separates "your command's answer" from "my request to you".
 *
 * The order matters only for frames that carry both, which none does today; the
 * first present flag wins so a future frame with both is read consistently.
 */
const VERDICT_FIELDS = ["success", "accepted"] as const;

/** Narrow an unknown to a plain record, without trusting its prototype. */
function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  return raw as Record<string, unknown>;
}

/**
 * Read a string field without coercing anything.
 *
 * Coercion is the temptation here and it is wrong: a numeric `request_id` would
 * become `"7"` and then match a caller id of `"7"` that was never sent. Only a
 * string can correlate.
 */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The engine's reply type suffix, as recorded.
 *
 * Not used to decide whether a frame is a reply - the correlation field is the
 * only reliable signal, since one command's acknowledgement does not follow this
 * suffix (`capability-names.ts` names that exception). Kept out of this file
 * entirely: the reader accepts any frame carrying a correlation id.
 */

/**
 * Build the reader the channel needs to settle commands.
 *
 * `typeOf` is the same rule `channel.ts` uses by default: a non-empty string in
 * `type`. It is repeated rather than imported because the default is private to
 * that module, and because a reader that disagrees with it about what an event
 * is would be worse than a duplicated two-line function.
 *
 * @returns a total reader: every input answers, none throws
 */
export function createFrameReader(): EngineFrameReader {
  return {
    typeOf(raw: unknown): string | undefined {
      const record = asRecord(raw);
      if (record === undefined) {
        return undefined;
      }

      return stringField(record, "type");
    },

    responseOf(raw: unknown): DecodedResponse | undefined {
      const record = asRecord(raw);
      if (record === undefined) {
        return undefined;
      }

      const requestId = stringField(record, CORRELATION_FIELD);
      if (requestId === undefined) {
        // No correlation id: this is an event, not an answer. A command whose
        // wire has no id can never be correlated, and that is by design - the
        // channel never puts those in its in-flight table.
        return undefined;
      }

      const verdict = verdictOf(record);
      if (verdict === undefined) {
        // Correlated but no verdict: the engine is *asking*, not answering -
        // the engine-initiated frame is the recorded shape. Returning a decode here would
        // let it settle whichever command happens to share the id - exactly the
        // "a foreign id must not be mis-matched" case arriving through the back
        // door.
        return undefined;
      }

      if (verdict) {
        // The payload is whatever else the frame carried. The reader does not
        // know the shape and must not invent one: which fields are meaningful is
        // the command's business, not the transport's.
        return { requestId, ok: true, data: payloadOf(record) };
      }

      return {
        requestId,
        ok: false,
        error: refusedByEngineError(requestId, detailOf(record)),
      };
    },
  };
}

/**
 * The engine's yes/no about a command, or `undefined` when the frame carries no
 * verdict at all.
 *
 * Only a real boolean counts. `"true"` and `1` are not verdicts: the first is a
 * string the engine never sends, and accepting it would turn a malformed frame
 * into a confident answer.
 *
 * @param record the decoded frame
 * @returns the verdict, or `undefined` when the frame is not an answer
 */
function verdictOf(record: Record<string, unknown>): boolean | undefined {
  for (const key of VERDICT_FIELDS) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return undefined;
}

/**
 * The part of a successful reply that belongs to the caller.
 *
 * Everything except the fields this module reads. Dropping them is not tidiness:
 * the correlation id and the type are transport facts the caller already has, and
 * handing them back invites a caller to branch on them again.
 *
 * @param record the decoded frame
 * @returns the payload fields, or `undefined` when the reply carried none
 */
function payloadOf(record: Record<string, unknown>): unknown {
  const payload: Record<string, unknown> = {};
  let count = 0;

  for (const [key, value] of Object.entries(record)) {
    if (key === CORRELATION_FIELD || key === "type" || VERDICT_FIELDS.includes(key as never)) {
      continue;
    }
    payload[key] = value;
    count += 1;
  }

  return count === 0 ? undefined : payload;
}

/**
 * The engine's own words about a rejection, when it offered any.
 *
 * Several spellings are recorded, so this looks in the places a message has been
 * seen rather than pinning one. It stays a *display* string: the branch key is
 * `success`, and `engineText` is quoted for humans.
 *
 * @param record the decoded frame
 * @returns the message, or `undefined` when the frame said nothing
 */
function detailOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["error", "detail", "message", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    const nested = asRecord(value);
    if (nested !== undefined) {
      const inner = stringField(nested, "message") ?? stringField(nested, "detail");
      if (inner !== undefined) {
        return inner;
      }
    }
  }

  return undefined;
}
