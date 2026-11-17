/**
 * Capability IO for the `workspace` family.
 *
 * The engine answers these with paths relative to the search root, so the
 * outputs carry no absolute paths except where the wire explicitly echoes one.
 */

/** One row of `workspace.list` (`protocol_v2.ts:927-936`). */
export interface WorkspaceListItem {
  readonly path: string;
  readonly type: "file" | "dir";
}

/** One entry of `workspace.tree` (`protocol_v2.ts:949-951`). */
export interface WorkspaceTreeEntry {
  readonly path: string;
  readonly type: "file" | "dir";
}

/** One row of `workspace.search` (`protocol_v2.ts:888-891`). */
export interface WorkspaceSearchEntry {
  readonly path: string;
  readonly type: "file";
}

/** One match of `workspace.grep` (`protocol_v2.ts:870-886`). */
export interface WorkspaceGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly column_end: number;
  readonly text: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export type WorkspaceCwdMapInput = Record<never, never>;

export interface WorkspaceGrepInput {
  readonly query: string;
  readonly case_sensitive?: boolean;
  readonly context_lines?: number;
  readonly cwd?: string;
  readonly glob?: string;
  readonly is_regex?: boolean;
  readonly max_results?: number;
  readonly whole_word?: boolean;
}

export interface WorkspaceListInput {
  readonly path: string;
  readonly include_files?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkspaceSearchInput {
  readonly query: string;
  readonly cwd?: string;
  readonly max_results?: number;
}

export interface WorkspaceSetBootCwdInput {
  readonly cwd: string;
}

export interface WorkspaceTreeInput {
  readonly path: string;
  readonly depth: number;
}

export interface WorkspaceCwdMapOutput {
  /** Persisted per-conversation overrides, keyed by listener scope key. */
  readonly cwd_map: Readonly<Record<string, string>>;
  /** Listener boot CWD used when a conversation has no entry in `cwd_map`. */
  readonly boot_working_directory: string | null;
}

export interface WorkspaceGrepOutput {
  readonly matches: readonly WorkspaceGrepMatch[];
  readonly total_matches: number;
  readonly total_files: number;
  readonly truncated: boolean;
}

export interface WorkspaceListOutput {
  readonly path: string;
  readonly folders: readonly string[];
  readonly files?: readonly string[];
  readonly hasMore: boolean;
  readonly total?: number;
}

export interface WorkspaceSearchOutput {
  readonly files: readonly WorkspaceSearchEntry[];
}

export interface WorkspaceSetBootCwdOutput {
  readonly boot_working_directory: string;
  readonly cwd_revision: number;
}

export interface WorkspaceTreeOutput {
  readonly path: string;
  readonly entries: readonly WorkspaceTreeEntry[];
  readonly has_more_depth: boolean;
}

export interface WorkspaceIo {
  readonly "workspace.cwdMap": {
    readonly input: WorkspaceCwdMapInput;
    readonly output: WorkspaceCwdMapOutput;
  };
  readonly "workspace.grep": {
    readonly input: WorkspaceGrepInput;
    readonly output: WorkspaceGrepOutput;
  };
  readonly "workspace.list": {
    readonly input: WorkspaceListInput;
    readonly output: WorkspaceListOutput;
  };
  readonly "workspace.search": {
    readonly input: WorkspaceSearchInput;
    readonly output: WorkspaceSearchOutput;
  };
  readonly "workspace.setBootCwd": {
    readonly input: WorkspaceSetBootCwdInput;
    readonly output: WorkspaceSetBootCwdOutput;
  };
  readonly "workspace.tree": {
    readonly input: WorkspaceTreeInput;
    readonly output: WorkspaceTreeOutput;
  };
}
