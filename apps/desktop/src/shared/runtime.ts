/**
 * The runtime's public status and failure shapes.
 *
 * Shared by the main process (which produces them), the preload (which carries
 * them unchanged) and the renderer (which shows them). Keeping the shape here
 * means the error page cannot invent a field the main process never sends, and
 * the main process cannot rename one without breaking the page's type check.
 *
 * The failure kinds are the route's vocabulary (`42` §3.7): a missing bundle, an
 * entry mismatch, a tree mismatch, an invalid external pick and a failed start.
 * This is not a `ShellErrorCode`: a runtime failure is a state with a recovery
 * action, not a thrown shell error.
 */

/** Where the running engine came from. */
export type RuntimeSource = "bundled" | "external" | "path";

/** What failed, in the route's vocabulary. */
export type RuntimeFailureKind =
  "missing-bundle" | "entry-mismatch" | "tree-mismatch" | "external-invalid" | "start-failed";

/** A failure the runtime error page can explain and offer actions for. */
export interface RuntimeFailure {
  readonly kind: RuntimeFailureKind;
  /** One sentence, already suitable as secondary text. */
  readonly detail: string;
  readonly engineDir?: string;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly logPath?: string;
  /** Present when an external pick was invalid and the app fell back. */
  readonly externalInvalid?: { readonly dir: string; readonly reason: string };
}

/** The state the status channel returns. */
export type RuntimeStatus =
  | {
      readonly phase: "starting" | "ready";
      readonly source?: RuntimeSource;
      readonly engineVersion?: string;
      readonly appVersion: string;
      /** Set when an external pick was invalid but the app recovered. */
      readonly externalNotice?: string;
    }
  | {
      readonly phase: "failed";
      readonly failure: RuntimeFailure;
      readonly appVersion: string;
      readonly externalNotice?: string;
    };

/** A directory choice, kept as a named shape for the picker payload. */
export interface RuntimeChoice {
  readonly engineDir: string;
}

/**
 * Result of asking the main process to open the log directory.
 *
 * `shell.openPath` can fail (directory missing, no default handler), and a
 * hard-coded `{ok:true}` would make the page claim success while nothing opened.
 */
export type RuntimeLogResult =
  { readonly ok: true } | { readonly ok: false; readonly detail?: string };
