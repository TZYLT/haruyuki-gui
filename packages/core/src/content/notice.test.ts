/**
 * Tests for reminder stripping and task-notification extraction.
 *
 * These pin the user-content contract: agent-only reminders never surface, a
 * task notification becomes a notice instead of user prose, body text keeps its
 * position around a notification, an agent-only result hides the whole notice,
 * and the history array shape is walked in part order. Every case also asserts
 * that no XML markup survives as display text.
 */

import { describe, expect, it } from "vitest";

import {
  extractNotifications,
  parseUserContent,
  stripReminders,
  type NoticeSpan,
} from "./notice.js";

const REMINDER = "<system-reminder>\nagent-only context\n</system-reminder>";

const NOTIFICATION = [
  "<task-notification>",
  "<task-id>task_1</task-id>",
  "<summary>Agent &amp; &quot;sub&quot; completed</summary>",
  "<result>sub-ok</result>",
  "</task-notification>",
].join("\n");

const TITLE = 'Agent & "sub" completed';

const AGENT_ONLY = [
  "<task-notification>",
  "<summary>internal</summary>",
  "<result><system-reminder>secret context</system-reminder></result>",
  "</task-notification>",
].join("\n");

function textSpan(text: string): NoticeSpan {
  return { kind: "text", text };
}

function notice(title: string | null, text: string): NoticeSpan {
  return { kind: "notice", category: "task-notification", title, text };
}

describe("stripReminders", () => {
  it("removes every reminder and leaves the prose around it intact", () => {
    const raw = `before\n${REMINDER}\nmid${REMINDER}after`;

    expect(stripReminders(raw)).toBe("before\n\nmidafter");
    expect(stripReminders(raw)).not.toContain("<system-reminder>");
  });

  it("leaves an unterminated reminder alone instead of guessing its end", () => {
    expect(stripReminders("<system-reminder>open")).toBe("<system-reminder>open");
  });
});

describe("pure content", () => {
  it("produces no span for a message that is only reminders", () => {
    expect(parseUserContent(REMINDER)).toEqual([]);
    expect(parseUserContent(`${REMINDER}\n${REMINDER}`)).toEqual([]);
  });

  it("turns a notification into a notice and hides its markup", () => {
    const content = `${NOTIFICATION}\nFull transcript available at: C:/work/task_1.log`;

    expect(parseUserContent(content)).toEqual([notice(TITLE, "sub-ok")]);
    expect(JSON.stringify(parseUserContent(content))).not.toContain("<task-notification");
    expect(JSON.stringify(parseUserContent(content))).not.toContain("Full transcript");
  });

  it("accepts a notification that is not closed before the end", () => {
    const content =
      "<task-notification>\n<summary>still running</summary>\n<result>partial result</result>";

    expect(parseUserContent(content)).toEqual([notice("still running", "partial result")]);
  });

  it("decodes the five XML entities exactly once", () => {
    const content = [
      "<task-notification>",
      "<summary>A &amp; B &lt;tag&gt;</summary>",
      "<result>&amp;lt; &amp;amp; &quot;q&quot; &apos;a&apos;</result>",
      "</task-notification>",
    ].join("\n");

    expect(parseUserContent(content)).toEqual([notice("A & B <tag>", "&lt; &amp; \"q\" 'a'")]);
  });

  it("removes a transcript pointer line inside the result too", () => {
    const content = [
      "<task-notification>",
      "<summary>done</summary>",
      "<result>line one",
      "Full transcript available at: C:/work/task_1.log",
      "line two</result>",
      "</task-notification>",
    ].join("\n");

    expect(parseUserContent(content)).toEqual([notice("done", "line one\nline two")]);
  });
});

describe("mixed content", () => {
  it("keeps the prose before and after a notification in source order", () => {
    const content = `first line\n${NOTIFICATION}\nlast line`;

    expect(parseUserContent(content)).toEqual([
      textSpan("first line"),
      notice(TITLE, "sub-ok"),
      textSpan("last line"),
    ]);
  });

  it("drops a notification that carries agent-only context", () => {
    expect(parseUserContent(AGENT_ONLY)).toEqual([]);

    const spans = parseUserContent(`before\n${AGENT_ONLY}\nafter`);

    expect(spans).toEqual([textSpan("before"), textSpan("after")]);
    expect(JSON.stringify(spans)).not.toContain("secret context");
  });

  it("does not mistake a notification quoted inside a reminder for a notice", () => {
    const content = `<system-reminder>copied ${NOTIFICATION}</system-reminder>`;

    expect(parseUserContent(content)).toEqual([]);
    expect(JSON.stringify(parseUserContent(content))).not.toContain("sub-ok");
  });

  it("walks an array of parts in order and drops reminder-only parts", () => {
    const content = [
      { type: "text", text: REMINDER },
      { type: "text", text: `hello ${REMINDER}world` },
      { type: "text", text: NOTIFICATION },
      { type: "text", text: "tail" },
      { type: "image", source: { type: "url", url: "https://example.test/cat.png" } },
    ];

    expect(parseUserContent(content)).toEqual([
      textSpan("hello world"),
      notice(TITLE, "sub-ok"),
      textSpan("tail"),
    ]);
  });

  it("keeps a mixed reminder part's prose without joining it to a neighbour", () => {
    const spans = parseUserContent([
      { type: "text", text: `hello ${REMINDER}world` },
      { type: "text", text: "next part" },
    ]);

    expect(spans).toEqual([textSpan("hello world"), textSpan("next part")]);
  });

  it("collapses a run of blank lines to one blank line", () => {
    expect(parseUserContent("first\n\n\n\nsecond")).toEqual([textSpan("first\n\nsecond")]);
  });
});

describe("robustness", () => {
  it("returns nothing for content that is neither a string nor a part array", () => {
    expect(parseUserContent(null)).toEqual([]);
    expect(parseUserContent(42)).toEqual([]);
    expect(parseUserContent({ content: "not a part array" })).toEqual([]);
    expect(parseUserContent([{ type: "text", text: 42 }, null, { type: "image" }])).toEqual([]);
  });

  it("exposes the same spans through extractNotifications for a string", () => {
    expect(extractNotifications(NOTIFICATION)).toEqual(parseUserContent(NOTIFICATION));
    expect(extractNotifications("")).toEqual([]);
  });

  it("never returns reminder or notification markup as display text", () => {
    const injections: unknown[] = [
      REMINDER,
      NOTIFICATION,
      `before ${NOTIFICATION} after`,
      AGENT_ONLY,
      [REMINDER, `mix ${REMINDER} tail`, NOTIFICATION],
    ];

    for (const injection of injections) {
      const json = JSON.stringify(parseUserContent(injection));
      expect(json).not.toContain("<system-reminder");
      expect(json).not.toContain("<task-notification");
    }
  });
});
