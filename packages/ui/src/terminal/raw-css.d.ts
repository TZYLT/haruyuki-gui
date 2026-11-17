/**
 * Ambient types for the one bundler-specific import in this package.
 *
 * Why this exists rather than `/// <reference types="vite/client" />`
 *   `packages/ui/tsconfig.json` sets `"types": []` on purpose: this package is
 *   shipped as source, so it must not require a bundler's types to compile. A
 *   reference to `vite/client` would make every consumer of `@haruyuki/ui` need
 *   Vite's types available, and would silently turn a build tool into a dependency
 *   of the type layer.
 *
 *   That leaves exactly one import whose module does not exist as far as the
 *   compiler is concerned: `@xterm/xterm/css/xterm.css?raw`, which Vite resolves
 *   by inlining the file and vitest resolves to the empty string. Declaring it
 *   here is narrower than either alternative -- importing the whole client type
 *   set, or suppressing the error with a cast at the use site, where the reason
 *   would be invisible to the next reader.
 *
 * What is declared, and what is deliberately not
 *   Only `?raw` on a `.css` file, because that is the only suffix this package
 *   uses. Declaring `?inline`, `?url` and the rest would invite a second use of a
 *   loader in a package that is not supposed to have one, and each would need its
 *   own note about which environments honour it.
 */

declare module "*.css?raw" {
  /**
   * The file's text.
   *
   * The file's whole contents under a bundler that implements `?raw`; the empty
   * string under one that does not, which includes vitest. Both are the same type,
   * which is exactly why `stylesheet.ts` documents the difference and its test
   * asserts the empty case rather than a non-empty one.
   */
  const text: string;

  export default text;
}
