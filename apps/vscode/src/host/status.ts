/**
 * The status bar item: the one place a user can see what the engine is doing
 * while the panel is closed.
 *
 * Five states, because the user's next action differs in each of them:
 *
 *   `inactive`      nothing has been started yet.
 *   `starting`      the core was asked to start; nothing is listening yet.
 *   `connected`     the core answered `ready` and the panel is live.
 *   `disconnected`  the core was connected and is not any more (stop, crash).
 *   `failed`        the core could not start, or died without reporting a phase
 *                   of its own. Clicking opens the panel that explains it.
 *
 * These are deliberately not collapsed into "ready / not ready". The two middle
 * states are the ones a user waits in and the ones a shell must be able to tell
 * apart: a start that takes ten seconds is not a crash, and a crash is not a
 * start. A two-value indicator would have to pick one of them for both.
 *
 * Every state, `failed` included, is wired to the same command, so the status
 * bar is always a way back into the panel and never a dead label.
 *
 * The mapping from the core's own phases lives here and nowhere else. The core
 * speaks `starting`/`ready`/`failed`/`stopped`; this module is the only reader
 * that turns them into a status-bar word, so a new phase cannot be rendered two
 * different ways by two callers.
 *
 * All the API is injected. `vscode.StatusBarItem` is a plain object with five
 * members, so a test drives this module with a recording double and no editor.
 */

import { createTranslator, type Translator } from "@haruyuki/ui";

import type { CoreStatusSnapshot, RuntimePhase } from "../core/ipc.js";
import { COMMAND_OPEN_PANEL } from "../shared/channels.js";
import { APP_VERSION, TESTED_ENGINE_VERSION } from "../shared/version.js";

/** The five states the status bar can show. */
export const STATUS_STATES = [
  "inactive",
  "starting",
  "connected",
  "disconnected",
  "failed",
] as const;

/** One state of the status bar. */
export type StatusState = (typeof STATUS_STATES)[number];

/**
 * The members of `vscode.StatusBarItem` this module writes.
 *
 * Declared here rather than imported so a test can pass a plain object; the
 * real item satisfies this structurally.
 */
export interface StatusBarLike {
  text: string;
  /**
   * `unknown` because this module only ever WRITES these two: the real members
   * are `string | MarkdownString | undefined` and `string | Command | undefined`,
   * and declaring the union here would name editor types this module never
   * reads. `unknown` accepts the real item and accepts the strings written.
   */
  tooltip: unknown;
  command: unknown;
  show(): void;
  hide(): void;
}

/** Where the version, origin and working directory of the engine came from. */
export interface StatusDetails {
  /** Engine build the core reported, when it reported one. */
  readonly engineVersion?: string;
  /** `bundled`, `external`, ... -- where the engine bundle was found. */
  readonly source?: string;
  /** The working directory the core runs the engine in. */
  readonly cwd?: string;
}

/** Diagnostic sink: codes and words, never a payload. */
export type StatusLog = (code: string, detail?: Record<string, unknown>) => void;

/** Options of {@link createStatusBar}. */
export interface StatusBarOptions {
  /** The item to drive. Created and disposed by the composition root. */
  readonly item: StatusBarLike;
  /** The app version a tooltip reports. Defaults to the shell's constant. */
  readonly appVersion?: string;
  /**
   * The editor's language tag.
   *
   * The five states are words, not icons: a window whose editor speaks Chinese
   * must not show "Connected" in the status bar while the panel it opens is in
   * Chinese. Defaults to English so a caller that has no locale still renders.
   */
  readonly locale?: string;
  /** Diagnostic sink for transitions a user cannot see. */
  readonly log?: StatusLog;
}

/** The handle the composition root keeps. */
export interface StatusBar {
  /** The state last rendered. */
  readonly state: StatusState;
  /** The details last rendered; empty until the core reports them. */
  readonly details: StatusDetails;
  /** Render one state. Memoised: the same state and facts twice write nothing. */
  set(state: StatusState, details?: StatusDetails): void;
  /** Apply one status snapshot from the core verbatim. */
  apply(snapshot: CoreStatusSnapshot): void;
  /** The text this module renders for a state, without rendering it. */
  textFor(state: StatusState): string;
}

/**
 * The catalogue key for each state.
 *
 * The extension host reads the same catalogue the panel does: a hardcoded
 * English word here is an untranslated word in a Chinese editor, and the
 * requirement names the status bar as a surface that must follow the language.
 *
 * A `switch` returning `t()` calls with literal keys rather than a
 * `Record<StatusState, MessageKey>` looked up at the call site, because the i18n
 * gate counts a key as used only where its literal appears inside `t(`. A table
 * of keys would make every one of the five read as declared-but-unused, which is
 * the gate working as designed rather than a false alarm.
 *
 * @param t the catalogue translator
 * @param state the state whose word is wanted
 * @returns the word for that state, in the translator's language
 */
function labelOf(t: Translator, state: StatusState): string {
  switch (state) {
    case "inactive":
      return t("common.engine.status.inactive");
    case "starting":
      return t("common.engine.status.starting");
    case "connected":
      return t("common.engine.status.connected");
    case "disconnected":
      return t("common.engine.status.disconnected");
    case "failed":
      return t("common.engine.status.failed");
  }
}

/**
 * The theme icon each state shows.
 *
 * Icons rather than a colour: a background colour is the only way a status item
 * can be tinted, and tinting one word green reads as a build result. The icon
 * carries the state and the word confirms it.
 */
const ICONS: Readonly<Record<StatusState, string>> = {
  inactive: "$(circle-outline)",
  starting: "$(loading~spin)",
  connected: "$(check)",
  disconnected: "$(debug-disconnect)",
  failed: "$(error)",
};

/**
 * The core phase each state came from.
 *
 * `starting` and `ready` are the core's own; `stopped` and `failed` are the two
 * terminal arms, and both have to land in a state the user can act on.
 *
 * @param phase one phase reported by the core
 * @returns the state to render
 */
export function stateForPhase(phase: RuntimePhase): StatusState {
  switch (phase) {
    case "starting":
      return "starting";
    case "ready":
      return "connected";
    case "stopped":
      return "disconnected";
    case "failed":
      return "failed";
  }
}

/**
 * Whether two detail sets render the same tooltip.
 *
 * @param a one set
 * @param b another
 * @returns whether every reported fact matches
 */
function sameDetails(a: StatusDetails, b: StatusDetails): boolean {
  return a.engineVersion === b.engineVersion && a.source === b.source && a.cwd === b.cwd;
}

/**
 * Build the status bar.
 *
 * The item is hidden until the first non-idle state: an entry that says "Idle"
 * in every window, before the user has asked for anything, is a permanent icon
 * for a feature that is not running. Its `command` is set either way, so the
 * panel can also be reached from a state the item is not showing.
 *
 * @param options the item, the app version and the diagnostic sink
 * @returns the handle
 */
export function createStatusBar(options: StatusBarOptions): StatusBar {
  const { item } = options;
  const log = options.log ?? ((): void => undefined);
  const appVersion = options.appVersion ?? APP_VERSION;
  // One translator for the whole item. The catalogue is the panel's own, so a
  // renamed key breaks the host's compile in the same step it breaks the panel's.
  const t = createTranslator(options.locale ?? "en");

  let state: StatusState = "inactive";
  let details: StatusDetails = {};
  let shown = false;

  /**
   * The tooltip: what the state means plus the facts a bug report needs.
   *
   * The version block always names both numbers. Reporting only the engine's own
   * version would leave "which build was this supposed to be" unanswered
   * exactly when the engine does not start and cannot answer.
   *
   * @returns the tooltip text
   */
  function tooltip(): string {
    return [
      `Haruyuki: ${labelOf(t, state)}`,
      "",
      `App version: ${appVersion}`,
      `Tested engine: ${TESTED_ENGINE_VERSION}`,
      t("common.engine.tooltip.version", { version: details.engineVersion ?? "not reported" }),
      t("common.engine.tooltip.source", { source: details.source ?? "unknown" }),
      t("common.engine.tooltip.cwd", { cwd: details.cwd ?? "unknown" }),
      "",
      t("common.engine.tooltip.open"),
    ].join("\n");
  }

  /**
   * Write one state into the item.
   *
   * @param next the state to render
   * @param nextDetails the facts that accompany it
   */
  function render(next: StatusState, nextDetails: StatusDetails): void {
    state = next;
    details = nextDetails;

    item.text = `${ICONS[next]} ${labelOf(t, next)}`;
    item.tooltip = tooltip();
    item.command = COMMAND_OPEN_PANEL;

    const wanted = next !== "inactive";

    if (wanted === shown) return;

    if (wanted) {
      item.show();
    } else {
      item.hide();
    }

    shown = wanted;
  }

  // The idle item is an entry point even while it is hidden.
  render("inactive", {});

  return {
    get state(): StatusState {
      return state;
    },
    get details(): StatusDetails {
      return details;
    },

    set(next: StatusState, nextDetails: StatusDetails = {}): void {
      // A repeat of the same state with no new facts is a no-op: the core may
      // repeat a status line, and a rewrite makes the tooltip flicker.
      if (next === state && sameDetails(nextDetails, details)) return;

      render(next, nextDetails);
    },

    apply(snapshot: CoreStatusSnapshot): void {
      const next = stateForPhase(snapshot.phase);
      const nextDetails: StatusDetails = {
        ...(snapshot.engineVersion === undefined ? {} : { engineVersion: snapshot.engineVersion }),
        ...(snapshot.source === undefined ? {} : { source: snapshot.source }),
        ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
      };

      if (next === "failed" && snapshot.failure !== undefined) {
        log("HOST_STATUS_FAILED", { kind: snapshot.failure.kind });
      }

      render(next, nextDetails);
    },

    textFor(candidate: StatusState): string {
      return `${ICONS[candidate]} ${labelOf(t, candidate)}`;
    },
  };
}
