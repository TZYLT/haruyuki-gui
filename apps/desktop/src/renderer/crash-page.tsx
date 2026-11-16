/**
 * The crash page: one surface for the two process deaths the shell can explain.
 *
 * It is a page rather than a dialog because there is nothing left to go back to --
 * the engine or the interface process is gone, and a dismissed modal would leave the
 * user on a shell that cannot work. Reusing `ErrorState` keeps the product's one
 * error language; the three actions are the requirement's, not the component's, so
 * they sit beside it instead of enlarging its props (`RD-09`).
 *
 * The route arrives as a query string (`?crash=engine|renderer&reason=&code=&signal=`),
 * because main rebuilds this page by reloading the window and the renderer must not
 * depend on a preload member for facts that are not secret. Every field is parsed
 * here: a malformed URL renders the generic message, never an exception before the
 * first paint.
 *
 * `window.haruyuki` is read when a button is pressed, never at module scope, so a
 * preload that failed to load becomes one readable sentence instead of a blank page.
 */

import { useState, type CSSProperties, type ReactElement } from "react";

import { Alert, Button, ErrorState, useT } from "@haruyuki/ui";

import { DIAGNOSTICS_CHANNELS } from "../shared/bridge.js";

/** The crash routes this page understands. */
const CRASH_KINDS = ["engine", "renderer"] as const;

/** One validated crash route. */
export interface CrashParams {
  /** Which process died. */
  readonly kind: (typeof CRASH_KINDS)[number];
  /** Electron's renderer reason; absent for an engine crash. */
  readonly reason: string | null;
  /** The engine's terminating signal; absent for a renderer crash. */
  readonly signal: string | null;
  /** The exit code, from `exitCode` or from the `code` spelling `crash/page.ts` uses. */
  readonly exitCode: number | null;
}

/**
 * Read one string parameter, treating empty as absent.
 *
 * `URLSearchParams` returns `""` for `?reason=`, and the page renders "not reported"
 * for `null`. The two must not diverge, so both spellings of absence collapse here.
 *
 * @param value the raw parameter
 * @returns the value, or `null` when it was absent or empty
 */
function textParam(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

/**
 * Read one integer parameter.
 *
 * A non-numeric code is not shown as the word it was: an exit code that did not
 * parse is an absent exit code, which the page already knows how to describe.
 *
 * @param value the raw parameter
 * @returns the integer, or `null` when absent or not an integer
 */
function integerParam(value: string | null): number | null {
  if (value === null || value === "") return null;

  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Parse the crash facts out of a URL query string.
 *
 * Exported so the route's input shape is testable without a DOM, and so `main.tsx`
 * uses this one validation instead of a second copy that could accept more.
 *
 * @param search `window.location.search`, or any query string
 * @returns the crash facts, or `null` when this is not a crash route
 */
export function parseCrashParams(search: string): CrashParams | null {
  const params = new URLSearchParams(search);
  const crash = params.get("crash");

  if (crash !== "engine" && crash !== "renderer") return null;

  const code = integerParam(params.get("code"));

  return {
    kind: crash,
    reason: textParam(params.get("reason")),
    signal: textParam(params.get("signal")),
    // `crash/page.ts` writes the exit code as `code` for both kinds. `exitCode`
    // is accepted as well because the requirement names it and a hand-written URL
    // may use either; the explicit one wins when both are present.
    exitCode: integerParam(params.get("exitCode")) ?? code,
  };
}

/**
 * The parts of the preload this page uses. Structural rather than imported from
 * `shared/bridge.ts`: the renderer needs one member, not the bridge's whole surface.
 */
interface CrashBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/**
 * The bridge, if the preload put one on the window.
 *
 * @returns the bridge, or `null` when it is absent or lacks `invoke`
 */
function readBridge(): CrashBridge | null {
  const candidate = (window as unknown as { haruyuki?: unknown }).haruyuki;

  if (typeof candidate !== "object" || candidate === null) return null;

  return typeof (candidate as { invoke?: unknown }).invoke === "function"
    ? (candidate as CrashBridge)
    : null;
}

/** The action row under the message. */
const ACTIONS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--ui-space-2)",
  marginTop: "var(--ui-space-4)",
};

/**
 * The crash surface.
 *
 * No props: everything it shows is the loaded URL's, and the route that mounts it
 * has already validated the kind. The remaining fields are read here so a direct
 * load of the crash URL behaves exactly like a main-process switch.
 *
 * @returns the crash page
 */
export function CrashPage(): ReactElement {
  const t = useT();
  const [crash] = useState(() => parseCrashParams(window.location.search));
  const [actionFailed, setActionFailed] = useState(false);

  /**
   * Send one command, turning a missing bridge or a rejected invoke into a sentence.
   *
   * A rejection is shown as "the bridge is unavailable" rather than an arbitrary
   * message: main refuses a command at the bridge boundary, the renderer cannot tell
   * the two apart, and an English exception's text would be the only untranslated
   * string on the page.
   *
   * @param channel the allowlisted channel
   * @param payload omitted for the two command channels, which take no argument
   */
  const send = (channel: string, payload?: unknown): void => {
    const bridge = readBridge();

    if (bridge === null) {
      setActionFailed(true);

      return;
    }

    try {
      const reply = payload === undefined ? bridge.invoke(channel) : bridge.invoke(channel, payload);

      void reply.catch(() => {
        setActionFailed(true);
      });
    } catch {
      // A bridge that throws synchronously is no more usable than a missing one.
      setActionFailed(true);
    }
  };

  const title =
    crash?.kind === "engine"
      ? t("common.crash.engineTitle")
      : crash?.kind === "renderer"
        ? t("common.crash.rendererTitle")
        : t("common.state.error");

  const notAvailable = t("common.crash.notAvailable");
  const detail =
    crash === null
      ? t("common.crash.description")
      : crash.kind === "engine"
        ? t("common.crash.engineDetails", {
            code: crash.exitCode ?? notAvailable,
            signal: crash.signal ?? notAvailable,
          })
        : t("common.crash.rendererDetails", {
            reason: crash.reason ?? notAvailable,
            exitCode: crash.exitCode ?? notAvailable,
          });

  return (
    <div style={{ padding: "var(--ui-space-8)" }} data-testid="crash-page">
      <ErrorState title={title} detail={detail} />

      <div style={ACTIONS}>
        <Button
          variant="secondary"
          onClick={() => {
            // `sessionAvailable` is main's fact, not this page's; main logs the
            // requested value and sends its own. The page has no session to claim.
            send(DIAGNOSTICS_CHANNELS.export, { kind: "open", sessionAvailable: false });
          }}
        >
          {t("common.crash.export")}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            send(DIAGNOSTICS_CHANNELS.relaunch);
          }}
        >
          {t("common.crash.restart")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            send(DIAGNOSTICS_CHANNELS.quit);
          }}
        >
          {t("common.crash.quit")}
        </Button>
      </div>

      {actionFailed ? (
        <div style={{ marginTop: "var(--ui-space-3)" }}>
          <Alert tone="danger">{t("common.crash.bridgeUnavailable")}</Alert>
        </div>
      ) : null}
    </div>
  );
}
