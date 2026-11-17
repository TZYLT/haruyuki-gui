/**
 * Capability IO for the `git` family.
 *
 * Both capabilities are read-only queries about branches; the only mutation in
 * this family (checkout) reports the branch it landed on, not git's stdout.
 */

/** One branch row (`protocol_v2.ts:2346-2351`). */
export interface GitBranchInfo {
  readonly name: string;
  readonly is_current: boolean;
  readonly is_remote: boolean;
}

export interface GitCheckoutBranchInput {
  readonly branch: string;
  readonly create?: boolean;
  readonly cwd?: string;
}

export interface GitSearchBranchesInput {
  readonly query: string;
  readonly cwd?: string;
  readonly max_results?: number;
}

export interface GitCheckoutBranchOutput {
  /** The branch now checked out. */
  readonly branch: string;
}

export interface GitSearchBranchesOutput {
  readonly branches: readonly GitBranchInfo[];
}

export interface GitIo {
  readonly "git.checkoutBranch": {
    readonly input: GitCheckoutBranchInput;
    readonly output: GitCheckoutBranchOutput;
  };
  readonly "git.searchBranches": {
    readonly input: GitSearchBranchesInput;
    readonly output: GitSearchBranchesOutput;
  };
}
