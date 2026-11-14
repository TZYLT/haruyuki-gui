/**
 * @haruyuki/core/testing
 *
 * Responsibility: the test-support surface - transport doubles that mirror the
 * platform APIs, the observation/comparison harness used to prove two shells
 * behave alike, and the snapshot normaliser.
 *
 * Why a subpath instead of the package root: production code must not be able
 * to reach any of this. The root entry stays the product's two surfaces
 * (`./engine`, `./port`); only a test or a comparison script imports this.
 *
 * Why this file is not a barrel: `scripts/check-module-ownership.mjs` rejects a
 * module whose every statement is a forwarding export. The version constant
 * below is this file's own declaration, which keeps it a module rather than an
 * alias for the modules it forwards.
 */

/**
 * Shape version of the test-support surface.
 *
 * Bumped only when an exported shape here changes in a way a consumer notices.
 * Frames and fixtures carry their own versions; this one covers the helpers.
 */
export const TESTING_SUPPORT_VERSION = 1;

// Fixtures: the loaders and the replay client. A consumer that drives a recorded
// session imports these and nothing else from the engine side.
export { loadFixture, loadFixtureText, loadFramesFixture, createInstantClock } from "./fixture";
export { replayThrough } from "./replay-client";

// Transport doubles: the two platform shapes, plus the shared delivery rules.
export { createIpcDouble } from "./transport/ipc";
export { createPostMessageDouble } from "./transport/postmessage";
export { createDelivery } from "./transport/delivery";

// Observation: what a shell actually received, and how two of them are compared.
export { observeThrough, createObservedDouble } from "./observation";
export { compareObservations, createComparisonHarness } from "./compare";
export { reduce } from "./reducer";

// Snapshots: one normaliser, so a snapshot cannot differ merely because it was
// taken in another directory.
export { normalizeForSnapshot, DEFAULT_VOLATILE_KEYS, DEFAULT_PATH_PATTERNS } from "./snapshot";

// The port doubles for the two shells, so cross-shell parity can be graded
// without importing the port package directly.
export { createDesktopHostPort } from "./adapters/desktop";
export { createVscodeHostPort } from "./adapters/vscode";

export type { Clock, WireFixture, FramesFixture, ReplayPlan, ReplayInjection } from "./fixture";
export type { ReplayThroughOptions, ReplayThroughResult } from "./replay-client";
export type {
  TransportDouble,
  TransportRejection,
  TransportDoubleOptions,
  DeliveryConfig,
} from "./transport/delivery";
export type { Observation, ObserveOptions, RecordingTransportDouble } from "./observation";
export type { ComparisonReport, ComparisonHarness } from "./compare";
export type { ReducedState } from "./reducer";
export type { SnapshotRules } from "./snapshot";
export type { DesktopHostPort } from "./adapters/desktop";
export type { VscodeHostPort } from "./adapters/vscode";
