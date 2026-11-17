/**
 * Capability IO for the `memory` family.
 *
 * Memory is a git-backed tree per agent: writes carry an optional commit
 * message and come back with `committed`/`commit_sha`, which is why the read and
 * write outputs are not symmetric.
 */

/** One row of `memory.list` (`protocol_v2.ts:1180-1191`). */
export interface MemoryFileEntry {
  readonly relative_path: string;
  readonly is_system: boolean;
  readonly description: string | null;
  readonly content: string;
  readonly size: number;
  readonly references?: readonly string[];
  readonly kind?: "markdown" | "image";
  readonly mime_type?: string | null;
}

/** One row of `memory.history` (`protocol_v2.ts:1204-1210`). */
export interface MemoryHistoryCommit {
  readonly sha: string;
  readonly message: string;
  readonly timestamp: string;
  readonly author_name: string | null;
}

export interface MemoryCommitDiffInput {
  readonly agent_id: string;
  readonly sha: string;
}

export interface MemoryDeleteFileInput {
  readonly agent_id: string;
  readonly path: string;
  readonly commit_message?: string;
}

export interface MemoryEnableInput {
  readonly agent_id: string;
}

export interface MemoryFileAtRefInput {
  readonly agent_id: string;
  readonly file_path: string;
  readonly ref: string;
}

export interface MemoryHistoryInput {
  readonly agent_id: string;
  readonly file_path?: string;
  readonly limit?: number;
}

export interface MemoryListInput {
  readonly agent_id: string;
  readonly include_references?: boolean;
}

export interface MemoryReadFileInput {
  readonly agent_id: string;
  readonly path: string;
  readonly encoding?: "utf8" | "base64";
}

export interface MemoryWriteFileInput {
  readonly agent_id: string;
  readonly path: string;
  readonly content: string;
  readonly encoding?: "utf8" | "base64";
  readonly commit_message?: string;
}

export interface MemoryCommitDiffOutput {
  readonly sha: string;
  readonly diff: string | null;
}

export interface MemoryDeleteFileOutput {
  readonly agent_id: string;
  readonly path: string;
  readonly committed?: boolean;
  readonly commit_sha?: string;
}

export interface MemoryEnableOutput {
  readonly memory_directory?: string;
}

export interface MemoryFileAtRefOutput {
  readonly file_path: string;
  readonly ref: string;
  readonly content: string | null;
}

export interface MemoryHistoryOutput {
  readonly file_path: string;
  readonly commits: readonly MemoryHistoryCommit[];
}

export interface MemoryListOutput {
  readonly entries: readonly MemoryFileEntry[];
  readonly done: boolean;
  readonly total: number;
  readonly memfs_enabled?: boolean;
  readonly memfs_initialized?: boolean;
}

export interface MemoryReadFileOutput {
  readonly agent_id: string;
  readonly path: string;
  readonly content: string | null;
  readonly encoding: "utf8" | "base64";
}

export interface MemoryWriteFileOutput {
  readonly agent_id: string;
  readonly path: string;
  readonly committed?: boolean;
  readonly commit_sha?: string;
}

export interface MemoryIo {
  readonly "memory.commitDiff": {
    readonly input: MemoryCommitDiffInput;
    readonly output: MemoryCommitDiffOutput;
  };
  readonly "memory.deleteFile": {
    readonly input: MemoryDeleteFileInput;
    readonly output: MemoryDeleteFileOutput;
  };
  readonly "memory.enable": {
    readonly input: MemoryEnableInput;
    readonly output: MemoryEnableOutput;
  };
  readonly "memory.fileAtRef": {
    readonly input: MemoryFileAtRefInput;
    readonly output: MemoryFileAtRefOutput;
  };
  readonly "memory.history": {
    readonly input: MemoryHistoryInput;
    readonly output: MemoryHistoryOutput;
  };
  readonly "memory.list": { readonly input: MemoryListInput; readonly output: MemoryListOutput };
  readonly "memory.readFile": {
    readonly input: MemoryReadFileInput;
    readonly output: MemoryReadFileOutput;
  };
  readonly "memory.writeFile": {
    readonly input: MemoryWriteFileInput;
    readonly output: MemoryWriteFileOutput;
  };
}
