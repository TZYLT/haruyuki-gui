/**
 * Typed assertions shared by the gate self-tests (`scripts/*.test.ts`).
 *
 * The gates are untyped `.mjs`; their parser/extractor exports are typed by
 * JSDoc, which leaves three shapes that a test cannot use directly once the
 * tests are type-checked (`scripts/tsconfig.json`, strict + `noUncheckedIndexedAccess`):
 *
 *   1. a discriminated `{ ok: true, ... } | { ok: false, ... }` result - the
 *      idiomatic `expect(result.ok, ...).toBe(true)` tells the compiler
 *      nothing, so the success-only fields stay "does not exist on type";
 *   2. the first entry of a report section - `noUncheckedIndexedAccess` types
 *      `lines[0]` as `string | undefined`, and asserting `toContain` on
 *      `undefined` would silently pass a broken report;
 *   3. a value looked up by key that the test has just proven exists.
 *
 * Each helper below performs the run-time check *and* narrows the type, so the
 * tests get compile-time checking without an `as` cast or a `@ts-expect-error`
 * that would hide a genuine mismatch. They are deliberately test-only: the
 * gates must not depend on vitest.
 */
import { expect } from "vitest";

/**
 * Assert a parser/extractor result is the success arm and narrow to it.
 *
 * Use instead of `expect(result.ok, ...).toBe(true)` whenever the following
 * lines read success-only fields: the assertion signature keeps the narrowing
 * for the rest of the test without a cast.
 *
 * @param result discriminated result carrying an `ok` flag
 * @param context what is being asserted, echoed in the failure message
 */
export function assertSuccess<T extends { ok: boolean }>(
  result: T,
  context: string,
): asserts result is Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`${context}: expected ok=true, got ${JSON.stringify(result)}`);
  }
}

/**
 * Assert a parser/extractor result is the failure arm and narrow to it, so the
 * failure-only fields (`code`, `symbol`, `message`, `health`) are readable.
 *
 * @param result discriminated result carrying an `ok` flag
 * @param context what is being asserted, echoed in the failure message
 */
export function assertFailure<T extends { ok: boolean }>(
  result: T,
  context: string,
): asserts result is Extract<T, { ok: false }> {
  if (result.ok) {
    throw new Error(`${context}: expected ok=false, got ${JSON.stringify(result)}`);
  }
}

/**
 * Return the first element of a non-empty list.
 *
 * Fails the test with the list name when the list is empty, which is what a
 * missed report section or a vanished extraction looks like; `lines[0]` would
 * otherwise be `undefined` and comparisons against it would not fail.
 *
 * @param items list that the caller asserts is non-empty
 * @param context what is being read, echoed in the failure message
 */
export function first<T>(items: readonly T[], context: string): T {
  const [head] = items;

  if (head === undefined) {
    throw new Error(`${context}: expected at least one element, got none`);
  }

  return head;
}

/**
 * Return a value that the test has just proven to be present.
 *
 * Covers the `noUncheckedIndexedAccess` / optional-field lookups (`find(...)`,
 * `[key]`, `?.` results) where the preceding assertion already pins presence:
 * failing here is a clearer message than a downstream `undefined` access.
 *
 * @param value value the caller asserts is present
 * @param context what is being read, echoed in the failure message
 */
export function defined<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${context}: expected a value, got ${String(value)}`);
  }

  return value;
}

/**
 * Narrow an `unknown` value to a typed array.
 *
 * `canonicalizeSnapshot` / `buildSnapshot` return `Record<string, unknown>`, so
 * their array fields are `unknown`; a test that maps over one needs a real
 * array. `Array.isArray` is what gives the compiler the narrowing, so no `as`
 * cast is involved.
 *
 * @param value value the caller expects to be an array
 * @param context what is being read, echoed in the failure message
 * @returns the same array, typed with the caller's element type
 */
export function arrayOf<T>(value: unknown, context: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected an array, got ${typeof value}`);
  }

  return value;
}

/**
 * Narrow an `unknown` value to a string-keyed record.
 *
 * Same `Record<string, unknown>` problem as {@link arrayOf}, for object fields
 * (a snapshot's `health` block, the canonical `engine` block).
 *
 * @param value value the caller expects to be a plain object
 * @param context what is being read, echoed in the failure message
 * @returns the value as a string-keyed record
 */
export function recordOf(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${context}: expected an object, got ${Array.isArray(value) ? "an array" : typeof value}`,
    );
  }

  return Object.fromEntries(Object.entries(value));
}

/**
 * `expect` a value to be present, narrowing it for the following lines.
 *
 * The assertion form is needed when the value is a `const` binding (for
 * example the result of `JSON.parse`) rather than an expression.
 *
 * @param value value the caller asserts is present
 * @param context what is being asserted, echoed in the failure message
 */
export function assertDefined<T>(value: T | null | undefined, context: string): asserts value is T {
  expect(value, context).not.toBeUndefined();

  if (value === null || value === undefined) {
    throw new Error(`${context}: expected a value, got ${String(value)}`);
  }
}
