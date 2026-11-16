/**
 * The runtime error page: the shell is alive, the engine is not.
 *
 * It is a separate component from `RendererErrorPage` on purpose. That page is
 * the `ErrorBoundary` fallback for a render-time throw and has one action,
 * "try again"; this page has up to four actions and a failure shape the main
 * process produced. Folding them together would give a render throw buttons that
 * do not apply to it, and would make the runtime's recovery path depend on the
 * render tree's error handling.
 *
 * `ErrorState` supplies the visual language and the `role="alert"`; this page
 * adds the action row because `ErrorState` supports one button and this failure
 * needs a choice between picking a directory, falling back to the bundled engine
 * and reading the log.
 */

import { useState, type ReactNode } from "react";

import { Button, ErrorState, useT, type MessageKey } from "@haruyuki/ui";

import type { RuntimeFailure, RuntimeLogResult } from "../shared/runtime.js";

/** Props of {@link RuntimeErrorPage}. */
export interface RuntimeErrorPageProps {
  readonly failure: RuntimeFailure;
  /** Re-run the startup check without changing the selection. */
  readonly onRetry?: () => void;
  /** Open the directory picker. */
  readonly onPick?: () => void;
  /** Clear the external pick and use the bundled engine. */
  readonly onUseBundled?: () => void;
  /** Ask the main process to open the log directory. */
  readonly onOpenLog?: () => Promise<RuntimeLogResult>;
}

/**
 * Render the runtime failure.
 *
 * @param props failure and available recovery actions
 * @returns the page
 */
export function RuntimeErrorPage({
  failure,
  onRetry,
  onPick,
  onUseBundled,
  onOpenLog,
}: RuntimeErrorPageProps): ReactNode {
  const t = useT();
  const detail = detailOf(failure, t);
  const [logError, setLogError] = useState<string | null>(null);

  const openLog = async (): Promise<void> => {
    if (onOpenLog === undefined) return;

    setLogError(null);

    try {
      const result = await onOpenLog();

      if (!result.ok) {
        setLogError(result.detail ?? t("error.runtimeLogPath"));
      }
    } catch (error) {
      setLogError(error instanceof Error ? error.message : t("error.runtimeLogPath"));
    }
  };

  return (
    <div
      className="runtime-error"
      data-testid="runtime-error"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <ErrorState title={titleOf(failure, t)} detail={detail} />

      {failure.externalInvalid === undefined ? null : (
        <p className="ui-state__description" style={{ margin: 0 }}>
          {t("error.runtimeExternalFallback")}
          {`: ${failure.externalInvalid.reason}`}
        </p>
      )}

      <div className="ui-state__actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {onPick === undefined ? null : <Button onClick={onPick}>{t("error.runtimeChoose")}</Button>}
        {onRetry === undefined ? null : (
          <Button variant="secondary" onClick={onRetry} iconLeft="refresh">
            {t("page.error.retry")}
          </Button>
        )}
        {onUseBundled === undefined ? null : (
          <Button variant="secondary" onClick={onUseBundled}>
            {t("error.runtimeUseBundled")}
          </Button>
        )}
        {onOpenLog === undefined ? null : (
          <Button variant="ghost" onClick={() => void openLog()} iconLeft="file">
            {t("error.runtimeOpenLog")}
          </Button>
        )}
      </div>

      {logError === null ? null : (
        <p className="ui-state__description" role="status" style={{ margin: 0 }}>
          {logError}
        </p>
      )}
    </div>
  );
}

/**
 * Heading for the failure kind.
 *
 * A `switch` rather than a `Record`: the i18n gate only counts a key as used
 * when its literal appears in a `t()` call, and a table lookup would leave the
 * three headings looking unreferenced.
 *
 * @param failure the failure
 * @param t translator
 * @returns translated heading
 */
function titleOf(failure: RuntimeFailure, t: (key: MessageKey) => string): string {
  switch (failure.kind) {
    case "mismatch":
      return t("error.runtimeMismatch");
    case "spawn":
      return t("error.runtimeSpawn");
    case "missing":
      return t("error.runtimeMissing");
  }
}

/**
 * Compose the secondary lines without pretending a stack trace is a sentence.
 *
 * Expected/actual hashes are shown only when the failure carries them; a missing
 * engine has no hash to compare, and an empty field would look like a bug.
 *
 * @param failure the failure
 * @param t translator
 * @returns detail text
 */
function detailOf(failure: RuntimeFailure, t: (key: MessageKey) => string): string {
  const parts = [failure.detail];

  if (failure.enginePath !== undefined) {
    parts.push(`${t("error.runtimePath")}: ${failure.enginePath}`);
  }

  if (failure.expected !== undefined) {
    parts.push(`${t("error.runtimeExpected")}: ${failure.expected}`);
  }

  if (failure.actual !== undefined) {
    parts.push(`${t("error.runtimeActual")}: ${failure.actual}`);
  }

  if (failure.logPath !== undefined) {
    parts.push(`${t("error.runtimeLogPath")}: ${failure.logPath}`);
  }

  return parts.join(" · ");
}
