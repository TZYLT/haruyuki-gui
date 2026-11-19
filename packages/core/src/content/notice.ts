/**
 * User-content cleaning: strip the agent-only reminders, lift task
 * notifications out of the text, and hand the rest back as ordered spans.
 *
 * Two different XML fragments arrive inside user content:
 *
 * - `<system-reminder>...</system-reminder>` is context the engine builds for
 *   the agent (environment, device, memory). It is never user prose and never
 *   gets displayed. The engine strips it on the echo path with a global,
 *   non-greedy match; this module uses the same shape so both paths agree.
 * - `<task-notification>...</task-notification>` is a background task's result.
 *   It becomes a `notice` span, not user text: the summary is the title, the
 *   result is the body. A notification whose result contains a system reminder
 *   is agent-only context and is dropped whole.
 *
 * Order matters. Reminders are located on the raw text because a notification
 * may carry one in its result: that is exactly the agent-only case, and it must
 * be classified before the reminder is removed. The display text is then built
 * from a copy with the reminder ranges cut out, so prose around a reminder stays
 * one span (`"hello <reminder>...</reminder>world"` reads as `"hello world"`)
 * while a notification quoted inside a reminder disappears with it.
 *
 * Outside those removals the source text is preserved verbatim, as required by
 * §4.13: spaces, blank lines and line endings are never rewritten. Only the
 * engine's own transcript pointer lines are dropped.
 *
 * Notifications can arrive unclosed at the end of the content, and the engine
 * appends a `Full transcript available at:` line after one. Both are consumed
 * here so no XML reaches a surface.
 *
 * The XML is not parsed with a library. Only the five predefined entities are
 * decoded, once, which keeps `&amp;lt;` as the text `&lt;` instead of letting a
 * second pass turn it into a tag.
 */

/** Prose without the agent-only reminders. */
export type TextSpan = {
  readonly kind: "text";
  readonly text: string;
};

/** One background task notification, separated from user prose. */
export type TaskNotificationSpan = {
  readonly kind: "notice";
  readonly category: "task-notification";
  /** The decoded `summary`; `null` when the notification had none. */
  readonly title: string | null;
  /** The decoded `result`, with transcript lines removed. */
  readonly text: string;
};

/** One displayable piece of user content, in source order. */
export type NoticeSpan = TextSpan | TaskNotificationSpan;

/**
 * The engine's reminder shape. Global and non-greedy for the same reason as the
 * echo path: one message may carry several reminders, and a greedy match would
 * eat the user's text between the first opener and the last closer.
 */
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * One task notification, closed or unclosed to the end of the content.
 *
 * The body is non-greedy so the first closer wins. `$` in the alternation is the
 * unclosed variant. The trailing transcript line is consumed with the
 * notification so it cannot become a text span of its own.
 */
const TASK_NOTIFICATION_PATTERN =
  /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)(?:[ \t]*\r?\n[ \t]*Full transcript available at:[^\r\n]*)?/g;

/** A notification's summary; non-greedy for the same reason as the body. */
const SUMMARY_PATTERN = /<summary>([\s\S]*?)<\/summary>/;

/** A notification's result; non-greedy for the same reason as the body. */
const RESULT_PATTERN = /<result>([\s\S]*?)<\/result>/;

/** The engine's trailing pointer to a task transcript; not user content. */
const TRANSCRIPT_LINE_PATTERN = /^[ \t]*Full transcript available at:[^\r\n]*(?:\r?\n|$)/gm;

/** Only the five XML predefined entities are decoded; no DTD, no library. */
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const XML_ENTITY_PATTERN = /&(amp|lt|gt|quot|apos);/g;

/** A half-open range of the original text. */
type Range = {
  readonly start: number;
  readonly end: number;
};

/**
 * Remove every complete `<system-reminder>...</system-reminder>` block.
 *
 * An unterminated reminder is left alone: guessing where it ends would hide
 * real user text, and the engine's own regex behaves the same way.
 */
export function stripReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_PATTERN, "");
}

/** Decode the five predefined entities exactly once. */
function unescapeXml(text: string): string {
  return text.replace(
    XML_ENTITY_PATTERN,
    (entity: string, name: string) => XML_ENTITIES[name] ?? entity,
  );
}

/** Delete transcript pointer lines, wherever they appear. */
function dropTranscriptLines(text: string): string {
  return text.replace(TRANSCRIPT_LINE_PATTERN, "");
}

/**
 * Display text for a notification body. This is engine output, not user prose,
 * so its outer whitespace is trimmed; transcript pointer lines never display.
 */
function noticeBody(text: string): string {
  return dropTranscriptLines(unescapeXml(text)).trim();
}

/**
 * Append a text span only when it has visible characters.
 *
 * The text is sliced from the source verbatim: §4.13 forbids rewriting the
 * user's prose, so there is no trim, no line-ending conversion and no
 * blank-line collapsing. Only transcript pointer lines are removed, and an
 * empty or whitespace-only run still produces no span.
 */
function appendTextSpan(spans: NoticeSpan[], raw: string): void {
  const text = dropTranscriptLines(raw);
  if (text.trim().length > 0) {
    spans.push({ kind: "text", text });
  }
}

/** Every complete reminder range, in source order. */
function reminderRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const match of text.matchAll(SYSTEM_REMINDER_PATTERN)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

/** Whether a zero-width position falls inside one of the ranges. */
function isInside(position: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

/**
 * Keep the parts of the text that are not covered by a range.
 *
 * The ranges come from a global regex, so they are already ordered and do not
 * overlap. `Math.max` guards against a caller handing in nested ranges.
 */
function cutRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) {
    return text;
  }

  let out = "";
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      out += text.slice(cursor, range.start);
    }
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < text.length) {
    out += text.slice(cursor);
  }

  return out;
}

/**
 * Whether a raw notification body puts agent context in its result.
 *
 * The result is decoded before the marker check so the escaped
 * `&lt;system-reminder&gt;` form is caught too: both forms would otherwise
 * reach a surface as the literal XML the caller must never display.
 */
function hasAgentOnlyResult(body: string): boolean {
  const result = RESULT_PATTERN.exec(body);
  return unescapeXml(result?.[1] ?? "").includes("<system-reminder");
}

/**
 * Build one notice from the inside of a notification.
 *
 * A missing summary yields `title: null`; the result may legitimately be empty.
 * The decoded `<system-reminder` check is the fallback path for a notice whose
 * raw classification is unavailable; normally the caller decides agent-only
 * from the raw body before reminders are removed.
 */
function notificationFrom(body: string): TaskNotificationSpan | null {
  if (hasAgentOnlyResult(body)) {
    return null;
  }

  const summary = SUMMARY_PATTERN.exec(body);
  const result = RESULT_PATTERN.exec(body);

  const rawTitle = summary?.[1] ?? "";
  const rawResult = result?.[1] ?? "";
  const title = unescapeXml(rawTitle.trim());

  return {
    kind: "notice",
    category: "task-notification",
    title: title.length === 0 ? null : title,
    text: noticeBody(rawResult),
  };
}

/** How a raw notification is classified before reminders are stripped. */
type NotificationClass = {
  /** True when the notification starts inside a reminder and must vanish with it. */
  readonly insideReminder: boolean;
  /** True when its result carries agent-only context and it must not be shown. */
  readonly agentOnly: boolean;
};

/** Classify the raw notifications in source order. */
function classifyNotifications(text: string, reminders: readonly Range[]): NotificationClass[] {
  const classes: NotificationClass[] = [];

  for (const match of text.matchAll(TASK_NOTIFICATION_PATTERN)) {
    const start = match.index ?? 0;
    classes.push({
      insideReminder: isInside(start, reminders),
      agentOnly: hasAgentOnlyResult(match[1] ?? ""),
    });
  }

  return classes;
}

/**
 * Split user content into text and notice spans, in source order.
 *
 * Reminders are cut from the display text. Notifications are located twice: on
 * the raw text to classify agent-only results and notifications quoted inside
 * reminders, and on the cleaned text to produce spans. Notifications that were
 * inside a reminder are already gone from the cleaned text; the surviving ones
 * line up with the non-inside classifications in order.
 *
 * A dropped notification does not split the prose around it: the text on both
 * sides is accumulated and emitted as one span. That is still the source text
 * verbatim, minus the notification the user never wrote.
 */
export function extractNotifications(text: string): readonly NoticeSpan[] {
  const reminders = reminderRanges(text);
  const cleaned = cutRanges(text, reminders);
  const classes = classifyNotifications(text, reminders).filter((entry) => !entry.insideReminder);
  const spans: NoticeSpan[] = [];
  let classIndex = 0;
  let cursor = 0;
  let pending = "";

  for (const match of cleaned.matchAll(TASK_NOTIFICATION_PATTERN)) {
    const start = match.index ?? cursor;
    pending += cleaned.slice(cursor, start);
    cursor = start + match[0].length;

    const classification = classes[classIndex];
    classIndex += 1;

    const agentOnly = classification?.agentOnly ?? false;
    if (agentOnly) {
      continue;
    }

    const notice = notificationFrom(match[1] ?? "");
    if (notice === null) {
      continue;
    }

    appendTextSpan(spans, pending);
    pending = "";
    spans.push(notice);
  }

  pending += cleaned.slice(cursor);
  appendTextSpan(spans, pending);

  return spans;
}

/**
 * Parse one user message's `content`, from a live body or a history entry.
 *
 * A string is cleaned as a whole. An array is walked in part order: a text part
 * that is nothing but reminders is agent-only and contributes nothing; a mixed
 * part keeps its prose; every other part type is left to the part handlers.
 *
 * Callers only pass user messages here. A notification in another role is not
 * user content and is not extracted by that role's path.
 */
export function parseUserContent(content: unknown): readonly NoticeSpan[] {
  if (typeof content === "string") {
    return extractNotifications(content);
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const spans: NoticeSpan[] = [];

  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }

    const record = part as { readonly type?: unknown; readonly text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }

    // A part that is entirely reminder text carries agent context, not prose.
    // Whitespace-only parts are equally empty and produce no span.
    if (stripReminders(record.text).trim().length === 0) {
      continue;
    }

    spans.push(...extractNotifications(record.text));
  }

  return spans;
}
