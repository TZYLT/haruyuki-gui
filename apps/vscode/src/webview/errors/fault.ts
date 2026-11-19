/**
 * The one place the panel turns a bridge status into a fault page.
 *
 * The transport owns the store; this owns the decision. Keeping them apart means
 * the rule "a failed phase with a failure is a page, and nothing else is" is one
 * readable line rather than a condition spread through the React tree, and the
 * page itself stays a pure function of the failure it is handed.
 */

import type { FaultInput } from "./model.js";

export type { FaultInput, ShellFaultAction } from "./model.js";

/** The failure a status message may carry; the bridge declares it as its own. */
export type StatusFailure = FaultInput;

/** What a consumer reads about the shell's last status. */
export interface ShellFaultSource {
  /** The phase the host last reported. */
  readonly phase: string | null;
  /** Why it is `failed`, when the host said. */
  readonly failure: FaultInput | undefined;
}

/**
 * The failure the page should render, or `undefined` while there is none.
 *
 * A phase of `failed` without a failure renders nothing rather than an empty
 * page: the host refuses that combination on the way out, so it means a bug, and
 * a heading with no facts under it would look like a rendering fault instead.
 *
 * @param source the phase and failure the bridge last accepted
 * @returns the failure to render
 */
export function faultOf(source: ShellFaultSource): FaultInput | undefined {
  if (source.phase !== "failed") return undefined;

  return source.failure;
}

/**
 * Rebuild one status failure, field by field.
 *
 * Every member is copied explicitly rather than spread, because a spread would
 * forward any key the host happened to send and, worse, would keep working after
 * a field was added to the message and not to this list. A list is copied element
 * by element for the same reason: the message is untrusted input.
 *
 * It lives with the fault rather than in the bridge because this is the module
 * that reads the fields: putting it next to the message type would mean the
 * reader and the writer of "which facts a page can see" are two files apart.
 *
 * @param raw the untrusted `failure` member of a status message
 * @returns the narrowed failure, or `undefined` when it is not one
 */
export function narrowStatusFailure(raw: unknown): StatusFailure | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const fields = raw as Record<string, unknown>;
  const kind = fields["kind"];
  const detail = fields["detail"];

  if (typeof kind !== "string" || kind.length === 0) return undefined;
  if (typeof detail !== "string") return undefined;

  const logPath = optionalString(fields["logPath"]);
  const candidateDir = optionalString(fields["candidateDir"]);
  const expectedVersion = optionalString(fields["expectedVersion"]);
  const actualVersion = optionalString(fields["actualVersion"]);
  const homeDir = optionalString(fields["homeDir"]);
  const searchedPaths = optionalStrings(fields["searchedPaths"]);
  const missingEntries = optionalStrings(fields["missingEntries"]);

  return {
    kind,
    detail,
    ...(logPath === undefined ? {} : { logPath }),
    ...(searchedPaths === undefined ? {} : { searchedPaths }),
    ...(missingEntries === undefined ? {} : { missingEntries }),
    ...(candidateDir === undefined ? {} : { candidateDir }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(actualVersion === undefined ? {} : { actualVersion }),
    ...(homeDir === undefined ? {} : { homeDir }),
  };
}

/** @returns the string, or `undefined` when it is absent or not one */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @returns a fresh list of strings, or `undefined` when it is not one */
function optionalStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const kept = value.filter((entry: unknown): entry is string => typeof entry === "string");

  // An empty list is dropped rather than carried: "searched nowhere" is the
  // absence of the fact, and a page would render an empty bullet list for it.
  return kept.length === 0 ? undefined : kept;
}
