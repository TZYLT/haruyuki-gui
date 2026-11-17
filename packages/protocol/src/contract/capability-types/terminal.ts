/**
 * Capability IO for the `terminal` family.
 *
 * All four capabilities are `untracked`: no request id, no reply frame, and the
 * effect arrives as terminal frames on the broadcast. Their output is therefore
 * `never` — there is nothing to await and nothing to type.
 */

export interface TerminalInputInput {
  readonly terminal_id: string;
  readonly data: string;
}

export interface TerminalKillInput {
  readonly terminal_id: string;
}

export interface TerminalResizeInput {
  readonly terminal_id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalSpawnInput {
  readonly terminal_id: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
}

export interface TerminalIo {
  readonly "terminal.input": { readonly input: TerminalInputInput; readonly output: never };
  readonly "terminal.kill": { readonly input: TerminalKillInput; readonly output: never };
  readonly "terminal.resize": { readonly input: TerminalResizeInput; readonly output: never };
  readonly "terminal.spawn": { readonly input: TerminalSpawnInput; readonly output: never };
}
