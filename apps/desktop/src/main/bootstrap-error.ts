/**
 * The error surface for a shell that failed before it could render.
 *
 * The renderer's `ErrorState` component is the normal path: a page that loaded and
 * caught a failure shows a real component with the app's own styling and i18n. This
 * module is for the case where that cannot happen -- the `app://` handler is not
 * registered, the bundle did not build, the window loaded a URL that 404s. At that
 * point there is no React, no catalogue and no token layer, so the page has to be a
 * self-contained string.
 *
 * Two constraints shape it:
 *
 *   No external resources. The page is loaded from `app://` under a CSP that allows
 *   `'self'` scripts, but a boot failure may mean the assets are exactly what is
 *   missing. Everything here is inline text and inline style, which the CSP permits
 *   (`style-src 'self' 'unsafe-inline'`). No image, no font, no script.
 *
 *   Bilingual without a catalogue. The locale cannot be trusted this early -- the
 *   settings file may be unreadable, which is one of the reasons we are here. Both
 *   languages are printed, labelled, rather than guessing one.
 */

/** What went wrong, at the granularity a human reading it needs. */
export interface BootstrapFailure {
  /** Short stable identifier, matching the log's `event` field. */
  event: string;
  /** Human-readable detail. Must already be safe to interpolate into HTML. */
  detail: string;
  /** Absolute log path, when one is known. Shown so the user can attach it. */
  logPath?: string;
  /**
   * The shell error code, when the failure has one.
   *
   * Shown verbatim: it is ASCII, stable, and it is the token a bug report needs.
   * The page does *not* translate it. Translating here would mean shipping a
   * catalogue into the one page that exists because the catalogue may be
   * unavailable, and a wrong-language heading is a smaller problem than a page
   * that cannot render.
   */
  code?: string;
}

/**
 * Escape the five characters that break out of text or an attribute.
 *
 * The detail strings here come from errors (`err.message`), which can contain
 * anything including a file path with an angle bracket in it. This page is the last
 * thing standing between a broken launch and a blank window, so it does not get to
 * assume its input is tame.
 *
 * @param value untrusted text
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the failure page.
 *
 * The document is intentionally plain: a heading, the failure, and where the log is.
 * A styled error page would need the token layer, and the token layer is part of
 * what just failed to load.
 *
 * @param failure what to report
 * @returns a complete HTML document
 */
export function bootstrapErrorHtml(failure: BootstrapFailure): string {
  const event = escapeHtml(failure.event);
  const detail = escapeHtml(failure.detail);
  const logRow =
    failure.logPath === undefined
      ? ""
      : `<dt>Log / 日志</dt><dd><code>${escapeHtml(failure.logPath)}</code></dd>`;
  const codeRow =
    failure.code === undefined
      ? ""
      : `<dt>Code / 错误码</dt><dd><code>${escapeHtml(failure.code)}</code></dd>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>haruyuki - failed to start</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 2.5rem;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.6;
      }
      h1 { font-size: 1.1rem; margin: 0 0 1.25rem; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1.25rem; margin: 0; }
      dt { font-weight: 600; }
      dd { margin: 0; }
      code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.92em; }
      .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
      button { font: inherit; padding: 0.45rem 0.9rem; cursor: pointer; }
      .hint { margin-top: 1.75rem; font-size: 0.92em; opacity: 0.75; }
    </style>
  </head>
  <body>
    <h1>haruyuki could not start / haruyuki 启动失败</h1>
    <dl>
      <dt>Event / 事件</dt><dd><code>${event}</code></dd>
      ${codeRow}
      <dt>Detail / 详情</dt><dd>${detail}</dd>
      ${logRow}
    </dl>
    <div class="actions">
      <button id="export-diagnostics" type="button">Export diagnostics / 导出诊断</button>
      <button id="quit" type="button">Quit / 退出</button>
    </div>
    <p id="action-note" class="hint" hidden>
      The diagnostics bridge is unavailable on this page. / 此页无法使用诊断桥接。
    </p>
    <p class="hint">
      The failure is recorded in the log above. Relaunching may help; if it does not,
      please attach that file to a bug report.<br />
      失败已记录在上面的日志文件里。可以尝试重新启动；若仍然失败，请把该文件附在问题报告里。
    </p>
    <script>
      (function () {
        var bridge = window.haruyuki;
        var note = document.getElementById("action-note");
        var exportButton = document.getElementById("export-diagnostics");
        var quitButton = document.getElementById("quit");

        if (exportButton) {
          exportButton.addEventListener("click", function () {
            if (!bridge || typeof bridge.invoke !== "function") {
              if (note) note.hidden = false;
              return;
            }
            try {
              bridge.invoke("bridge:control.diagnostics.export", {
                kind: "open",
                sessionAvailable: false,
              });
            } catch (error) {
              if (note) note.hidden = false;
            }
          });
        }

        if (quitButton) {
          quitButton.addEventListener("click", function () {
            if (bridge && typeof bridge.invoke === "function") {
              try {
                bridge.invoke("bridge:control.diagnostics.quit");
                return;
              } catch (error) {
                // Fall through to closing this window below.
              }
            }
            window.close();
          });
        }
      })();
    </script>
  </body>
</html>
`;
}
