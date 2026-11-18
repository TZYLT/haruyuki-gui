/**
 * The directory this shell runs the engine in, and whether it had to ask.
 *
 * The working directory is the first workspace folder. That is a decision, not a
 * convenience: the engine writes its own tree under its cwd, and the file tree
 * the panel shows is that tree, so the two must be the same directory or the
 * panel would be browsing one place while the engine writes another.
 *
 * With no workspace folder open there is no such directory, and this module
 * refuses to start rather than picking one:
 *
 * - `resolveWorkspaceCwd` answers `no-workspace` with `needsConfirmation` and
 *   the directory the degradation would use. Nothing is started and nothing is
 *   chosen for them.
 * - `useHomeDir` is the capability that choice resolves to. It is only chosen
 *   when the caller passes `confirmedHomeDir`, which the panel sets after the
 *   user agreed; the home directory is never a silent fallback.
 *
 * A degradation is therefore visible in the answer itself (`origin: "home"`),
 * so a caller can say which directory it is using instead of implying that a
 * workspace existed.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * One workspace folder, narrowed to the one member this module reads.
 *
 * Structural because the editor's `WorkspaceFolder` is not available in this
 * process without an editor, and `uri.fsPath` is the only part that matters to a
 * spawn spec.
 */
export type WorkspaceFolderLike = {
  readonly uri: { readonly fsPath: string };
};

/** Where the shell decided to work. */
export type WorkspaceCwd = {
  /** Absolute directory the engine child is spawned in. */
  readonly cwd: string;
  /**
   * Root of the file tree, always the same directory as `cwd`.
   *
   * A separate field rather than a computed one: a consumer that derives the
   * root some other way is a second answer to one question, and the panel would
   * show a tree the engine is not writing.
   */
  readonly fileTreeRoot: string;
  /** `workspace` when a folder was open; `home` only after the user confirmed. */
  readonly origin: "workspace" | "home";
};

/** The answer to "where do we work", including the case there is nowhere. */
export type WorkspaceResolution =
  | (WorkspaceCwd & { readonly ok: true })
  | {
      readonly ok: false;
      readonly reason: "no-workspace";
      /**
       * The decision the user has to make, stated as a field rather than left
       * for the caller to read out of a sentence. A caller that starts anyway
       * has to ignore this, which is a visible mistake instead of a quiet one.
       */
      readonly needsConfirmation: true;
      /** Directory the confirmed degradation would use; see {@link useHomeDir}. */
      readonly homeDir: string;
      /** One English sentence for the status page; never parsed for control flow. */
      readonly detail: string;
    };

/** Everything {@link resolveWorkspaceCwd} needs. */
export type ResolveWorkspaceCwdOptions = {
  /** `vscode.workspace.workspaceFolders`, injected so a test owns the list. */
  readonly folders?: readonly WorkspaceFolderLike[] | undefined;
  /** `os.homedir()`, injected so a test never depends on the real home. */
  readonly homeDir?: string;
  /**
   * The user's answer to the no-workspace prompt.
   *
   * `false`/absent means the prompt has not been answered, so the resolution is
   * a refusal. It is never inferred: a missing workspace folder is not consent
   * to run in the home directory.
   */
  readonly confirmedHomeDir?: boolean;
};

/**
 * The home directory, as the capability the no-workspace prompt offers.
 *
 * Exported separately from {@link resolveWorkspaceCwd} so the panel can show the
 * directory it is about to use before the user agrees to it.
 *
 * @param homeDir an override for a test; defaults to `os.homedir()`
 * @returns the absolute directory the degraded run would use
 */
export function useHomeDir(homeDir?: string): string {
  return resolve(homeDir ?? homedir());
}

/**
 * Pick the working directory.
 *
 * @param options the workspace folders, the home override and whether the user
 *   confirmed degrading to it
 * @returns the directory plus its file-tree root, or why there is no directory
 */
export function resolveWorkspaceCwd(options: ResolveWorkspaceCwdOptions): WorkspaceResolution {
  const folder = options.folders?.[0];
  const folderPath = folder?.uri.fsPath.trim() ?? "";

  if (folderPath !== "") {
    return settled(resolve(folderPath), "workspace");
  }

  if (options.confirmedHomeDir === true) {
    return settled(useHomeDir(options.homeDir), "home");
  }

  const homeDir = useHomeDir(options.homeDir);

  return {
    ok: false,
    reason: "no-workspace",
    needsConfirmation: true,
    homeDir,
    detail:
      options.folders === undefined || options.folders.length === 0
        ? `no workspace folder is open; choose one, or confirm starting in ${homeDir}`
        : `the first workspace folder has no directory; choose one, or confirm starting in ${homeDir}`,
  };
}

/**
 * Build the one success shape, so `cwd` and `fileTreeRoot` cannot drift.
 *
 * @param cwd absolute working directory
 * @param origin where the directory came from
 * @returns the resolved working directory
 */
function settled(cwd: string, origin: WorkspaceCwd["origin"]): WorkspaceResolution {
  return { ok: true, cwd, fileTreeRoot: cwd, origin };
}
