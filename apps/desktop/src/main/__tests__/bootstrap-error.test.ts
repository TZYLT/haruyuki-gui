import { describe, expect, it } from "vitest";

import { bootstrapErrorHtml, escapeHtml } from "../bootstrap-error.js";

describe("escapeHtml", () => {
  it("escapes the five characters that break out", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  it("escapes the ampersand first, so an escape is not double-escaped", () => {
    // The order matters: escaping `<` first would produce `&lt;`, and a later
    // ampersand pass would turn that into `&amp;lt;`.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("a normal path C:\\logs\\shell.jsonl")).toBe(
      "a normal path C:\\logs\\shell.jsonl",
    );
  });
});

describe("bootstrapErrorHtml", () => {
  it("produces a complete document", () => {
    const html = bootstrapErrorHtml({ event: "shell.boot.failed", detail: "boom" });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
  });

  it("shows the event and the detail", () => {
    const html = bootstrapErrorHtml({
      event: "shell.boot.failed",
      detail: "the renderer is missing",
    });

    expect(html).toContain("shell.boot.failed");
    expect(html).toContain("the renderer is missing");
  });

  it("keeps the export and quit entries on the inline page", () => {
    const html = bootstrapErrorHtml({ event: "e", detail: "d" });

    expect(html).toContain('id="export-diagnostics"');
    expect(html).toContain('id="quit"');
    expect(html).toContain("bridge:control.diagnostics.export");
    expect(html).toContain("bridge:control.diagnostics.quit");
  });

  it("shows the log path when there is one", () => {
    const html = bootstrapErrorHtml({
      event: "e",
      detail: "d",
      logPath: "C:\\Users\\x\\AppData\\Roaming\\haruyuki\\logs",
    });

    expect(html).toContain("C:\\Users\\x\\AppData\\Roaming\\haruyuki\\logs");
  });

  it("omits the log row entirely when there is no path", () => {
    // A "Log: undefined" row would be worse than no row: it looks like a real path.
    const html = bootstrapErrorHtml({ event: "e", detail: "d" });

    expect(html).not.toContain("undefined");
  });

  it("is bilingual without a catalogue", () => {
    // The locale cannot be trusted this early; the settings file may be exactly what
    // failed. Both languages are printed and labelled rather than one being guessed.
    const html = bootstrapErrorHtml({ event: "e", detail: "d" });

    expect(html).toContain("could not start");
    expect(html).toContain("启动失败");
  });

  it("escapes a hostile detail", () => {
    const html = bootstrapErrorHtml({
      event: "e",
      detail: '<img src=x onerror="alert(1)">',
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes a hostile event identifier", () => {
    const html = bootstrapErrorHtml({ event: "</code><script>x</script>", detail: "d" });

    expect(html).not.toContain("<script>x</script>");
  });

  it("escapes a hostile log path", () => {
    const html = bootstrapErrorHtml({ event: "e", detail: "d", logPath: "<b>/tmp</b>" });

    expect(html).not.toContain("<b>/tmp</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("needs no external resource, since the assets are what failed", () => {
    // No stylesheet link, no image and no font; the only script is the inline
    // action handler, and this page is loaded from a file URL with no CSP
    // header. R-11 requires the export/quit entry points to be here.
    const html = bootstrapErrorHtml({ event: "e", detail: "d" });

    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("@import");
  });
});
