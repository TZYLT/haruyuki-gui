/**
 * Capability IO for the `file` family.
 *
 * This is the shape probe for the type layer: every row is `{ input; output }`
 * and the input side is derived from `snapshot.commands[].fields` minus the
 * envelope (`type`, `request_id`, `runtime`). Outputs are transcribed from the
 * engine's response interfaces (`_research/haruyuki/src/types/protocol_v2.ts`)
 * because the contract snapshot carries no field-level information for replies.
 *
 * `file.ops` is the one legacy bidirectional capability: it has no typed helper,
 * no command-face entry and no reply frame, so its IO is an explicit opaque
 * alias instead of a transcribed shape.
 */

/** A file path as the engine expects it (absolute; not normalised here). */
export type FilePath = string;

/** Encoding of the bytes returned by `file.read`; defaults to `utf8`. */
export type FileEncoding = "utf8" | "base64";

/** Opaque body for the legacy `file.ops` duplex wire. */
export type LegacyDuplexBody = unknown;

export interface FileReadInput {
  readonly path: FilePath;
  /** Omitted means `utf8`. */
  readonly encoding?: FileEncoding;
}

export interface FileReadOutput {
  readonly path: FilePath;
  /** `null` when the file cannot be read; `success` then carries the reason. */
  readonly content: string | null;
  /** Mirrors the request; `utf8` when the request omitted it. */
  readonly encoding: FileEncoding;
}

export interface FileWriteInput {
  readonly path: FilePath;
  readonly content: string;
}

export interface FileWriteOutput {
  readonly path: FilePath;
}

export interface FileEditInput {
  readonly file_path: FilePath;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
  readonly expected_replacements?: number;
}

export interface FileEditOutput {
  readonly file_path: FilePath;
  /** Human-readable result message; `null` when the engine sent none. */
  readonly message: string | null;
  readonly replacements: number;
  readonly start_line?: number;
}

export interface FileWatchInput {
  readonly path: FilePath;
}

export interface FileUnwatchInput {
  readonly path: FilePath;
}

export type FileOpsInput = LegacyDuplexBody;

export interface FileIo {
  readonly "file.read": { readonly input: FileReadInput; readonly output: FileReadOutput };
  readonly "file.write": { readonly input: FileWriteInput; readonly output: FileWriteOutput };
  readonly "file.edit": { readonly input: FileEditInput; readonly output: FileEditOutput };
  /** Silent: the wire carries a request id but no reply frame ever arrives. */
  readonly "file.watch": { readonly input: FileWatchInput; readonly output: never };
  /** Silent, same as `file.watch`. */
  readonly "file.unwatch": { readonly input: FileUnwatchInput; readonly output: never };
  /** Duplex legacy: no request/reply pair, no typed helper. */
  readonly "file.ops": { readonly input: FileOpsInput; readonly output: FileOpsInput };
}
