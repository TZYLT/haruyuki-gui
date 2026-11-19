/**
 * What the shell says when it cannot run: which situation, and which answers.
 *
 * This module decides *which* of the four situations the panel is in and *which*
 * actions it offers. It renders nothing and resolves no copy: the sentences are
 * the catalogue's and belong to the component (the i18n gate only counts a key
 * when its literal appears in a `t()` call, and a table lookup here would leave
 * ten live keys looking unused). What is left is the part that has to be exactly
 * right and is therefore worth testing on its own -- the mapping from a failure
 * on the wire to the set of actions a user may take.
 *
 * Four situations reach the page, and they are four because the *answers* differ:
 *
 * | situation | what the user can do |
 * |---|---|
 * | the engine was not found | choose a directory, open the setting, read the log |
 * | the directory is not an engine | choose another directory, read the log |
 * | the build was never tested | connect anyway, choose another directory |
 * | no folder is open | open a folder, or accept the home directory |
 *
 * A page that offered the same buttons in all four cases would be a page the user
 * has to diagnose before they can use it, which is the state this replaces.
 */

/**
 * One answer the page offers.
 *
 * The name is the whole contract: it is what the panel sends as an `action`, and
 * the host answers every one of them. A view that invented a name would render a
 * button that reaches a logger and does nothing.
 */
export type ShellFaultAction =
  | "chooseEngineDir"
  | "openSettings"
  | "openLogs"
  | "openFolder"
  | "connectAnyway"
  | "useHomeDir"
  | "retry";

/**
 * Which of the four situations the page is in.
 *
 * Named for what is wrong rather than for the failure kind on the wire, because
 * one situation can arrive as more than one kind: a directory that failed its
 * structural check and a search that found nothing are both "there is no engine
 * here", and they differ only in what the page can say about the folder.
 */
export type ShellFaultSituation =
  | "engineMissing"
  | "invalidEngineDir"
  | "untestedEngine"
  | "noWorkspace"
  | "engineStopped"
  | "engineLost"
  | "coreStopped";

/** The failure, as the wire carries it. Structural so this module imports no core type. */
export interface FaultInput {
  readonly kind: string;
  readonly detail: string;
  readonly logPath?: string;
  readonly searchedPaths?: readonly string[];
  readonly missingEntries?: readonly string[];
  readonly candidateDir?: string;
  readonly expectedVersion?: string;
  readonly actualVersion?: string;
  readonly homeDir?: string;
}

/** What the page renders, decided once, here. */
export interface ShellFaultView {
  readonly situation: ShellFaultSituation;
  /** The answers, in the order they are offered. */
  readonly actions: readonly ShellFaultAction[];
  /** The failure itself, for the facts the component renders. */
  readonly failure: FaultInput;
  /**
   * Whether one of the answers needs a confirmation before it takes effect.
   *
   * Only the home-directory degradation does: running an engine in a directory
   * nobody chose is a decision the user has to make twice, and the page asks for
   * the second answer itself rather than leaving it to the host.
   */
  readonly confirmsHomeDir: boolean;
}

/**
 * Which situation each failure kind means.
 *
 * Five, not four: "found and not running" is its own question because its own
 * answer is "try again". Folding it into "not found" left a crash offering only
 * the two buttons that assume the user picked the wrong directory, which is the
 * one thing a crash does not mean.
 */
const SITUATIONS: Readonly<Record<string, ShellFaultSituation>> = {
  "missing-engine": "engineMissing",
  // A directory that was inspected and refused. Distinct from "nothing was
  // found": the user has somewhere concrete to go and repair.
  "invalid-dir": "invalidEngineDir",
  "untested-engine": "untestedEngine",
  "no-workspace": "noWorkspace",
  // The engine was found and did not come up. "It is not running now", and the
  // answer is to try again -- a page that only offered "choose another
  // directory" would leave the one action the user wants unavailable.
  "start-failed": "engineStopped",
  // The engine was started and then went away. The shell is intact and the
  // panel still holds its content, so this is the disconnected sentence, not
  // the failed-to-start one.
  "engine-lost": "engineLost",
  // A folder that is there and cannot say what version it is. The page names it
  // as a bad directory rather than as a missing one: the repair is a different
  // folder, not a search.
  "version-unknown": "invalidEngineDir",
  // The shell's own child is gone. The requirement keeps this row separate from
  // the engine's: a stopped core takes the shell with it, and telling the user
  // the engine did not start would name the wrong process.
  crash: "coreStopped",
  internal: "coreStopped",
};

/** The answers per situation, in the order the page offers them. */
const ACTIONS: Readonly<Record<ShellFaultSituation, readonly ShellFaultAction[]>> = {
  // A directory to search, the setting that decides the search, and the log that
  // explains it. The three together are "where do I look next".
  engineMissing: ["chooseEngineDir", "openSettings", "openLogs"],
  // Naming the missing entries is only useful if the user can then go and pick
  // the right folder, so the picker leads here too.
  invalidEngineDir: ["chooseEngineDir", "openLogs"],
  // The override leads: the versions are shown beside it, and choosing another
  // engine is the careful answer rather than the correct one.
  untestedEngine: ["connectAnyway", "chooseEngineDir"],
  // A folder to work in, or the degradation. Neither is a default.
  noWorkspace: ["openFolder", "useHomeDir"],
  // Retry leads because it is the only answer that needs no decision: the
  // engine was the right one a moment ago. The other two are for when it is not.
  engineStopped: ["retry", "chooseEngineDir", "openLogs"],
  // The engine was the right one and the folder has not changed: retry leads and
  // the picker stays available for the case where it will not come back.
  engineLost: ["retry", "chooseEngineDir", "openLogs"],
  // Retry is the whole answer here: the core is the shell's own child, and the
  // folder has not changed.
  coreStopped: ["retry", "openLogs"],
};

/**
 * Decide the page for one failure.
 *
 * @param failure the failure the host reported
 * @returns the situation, its answers, and the failure they answer
 */
export function toShellFault(failure: FaultInput): ShellFaultView {
  const situation = SITUATIONS[failure.kind] ?? "engineMissing";

  return {
    situation,
    actions: ACTIONS[situation],
    failure,
    confirmsHomeDir: situation === "noWorkspace",
  };
}
