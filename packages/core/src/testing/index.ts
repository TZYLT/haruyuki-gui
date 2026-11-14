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
