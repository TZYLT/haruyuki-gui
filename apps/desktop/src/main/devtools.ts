/**
 * The inspector escape hatch.
 *
 * One `HARUYUKI_DEVTOOLS` variable, read here rather than in `main.ts` so the rule
 * ("the inspector opens in a packaged build only when the operator asked") has a
 * single place to be tested and a single place to be changed. `main.ts` was over the
 * file-size gate; this is the smallest piece of it that is a rule rather than wiring.
 */

/** The variable that lets a packaged build open the inspector. */
export const DEVTOOLS_ENV = "HARUYUKI_DEVTOOLS";

/**
 * Whether the inspector may be opened in this run.
 *
 * Read at call time, not cached: the value is a launch-time decision, and a test that
 * sets the variable after import must still see it.
 */
export function devtoolsAllowed(): boolean {
  return process.env[DEVTOOLS_ENV] === "1";
}
