/**
 * Public surface of the terminal layer.
 *
 * Why every name is listed instead of re-exported wholesale
 *   `export *` makes the public surface "whatever happens to be in the directory",
 *   so an internal helper added for one module's own convenience becomes API the
 *   moment it is written. That is not a hypothetical: this package exports
 *   several shapes that exist only to be stubbed by a test -- the frame
 *   translation's refusal vocabulary, the narrow addon interface, the sink's
 *   statistics -- and every one of them would be part of the contract if the
 *   directory were forwarded as a whole. The host imports from here, so this is
 *   the list somebody has to read to know what they may rely on.
 *
 * What is exported and why
 *   - the phase machine's types, because a host has to name a phase to pass one
 *     in, and `reducePhase` because a host that keeps its own state needs it;
 *   - the two exit functions, because input translation is the host's business
 *     when it owns the keyboard;
 *   - the host factory and the stylesheet installer, because the host owns the
 *     document and reads the CSS file;
 *   - the four commands, because they are the only way to ask for a terminal;
 *   - the sink factory, because the host registers it with the router;
 *   - the two frame translators, because the host is what receives frames;
 *   - the search model and its bar, because the search UI is this layer's;
 *   - the snapshot pair, because restoring on refresh is the host's timing.
 *
 * What is deliberately not exported
 *   The panel's internal hooks, the decision table behind input handling, the
 *   snapshot's byte helper, and every `*Options`-style shape a caller only fills
 *   in to call one of the functions above -- those stay reachable through the
 *   function's own signature, where they cannot drift into a second contract.
 */

/** Identifies the terminal layer in diagnostics. */
export const TERMINAL_LAYER = "terminal" as const;

export { TerminalPanel, initialPanelState } from "./panel.js";
export type { TerminalPanelProps } from "./panel.js";

export { SearchBar } from "./search-bar.js";
export type { SearchBarProps } from "./search-bar.js";

export { reducePhase } from "./state.js";
export type { TerminalPanelState, TerminalPhase, TerminalSignal } from "./state.js";

export { translateKey, translatePaste } from "./exit.js";

export { createTerminalHost, installTerminalStyles } from "./host.js";

// The inlined stylesheet: empty under vitest, the file's text under Vite. A host
// that mounts a panel needs it, and `hasTerminalStylesheet` says which of the two
// it received without the caller inspecting the string.
export { hasTerminalStylesheet, TERMINAL_STYLESHEET } from "./stylesheet.js";

export { killTerminal, resizeTerminal, sendInput, spawnTerminal } from "./commands.js";
export type { CommandOutcome, CommandSender } from "./commands.js";

export { createTerminalSink } from "./sink.js";

export { signalFromFrame, signalFromLifecycle } from "./frames.js";

// The feed is what makes the two translators reachable: it is the only production
// path from a delivered frame to `reducePhase`, and `connectTerminalFeed` is the
// one place the three-way hookup happens.
export { connectTerminalFeed, createTerminalFeed } from "./feed.js";
export type { FeedResult, TerminalFeed, TerminalFeedOptions, TerminalFrameSource } from "./feed.js";
export type { TerminalFrame, TerminalLifecycleEvent } from "./frames.js";

export { createTerminalSearch, positionMessage } from "./search.js";
export type { SearchPosition, TerminalSearch } from "./search.js";

export { captureSnapshot, restoreSnapshot } from "./persist.js";
export type { TerminalSnapshot } from "./persist.js";
