/**
 * Ambient types for the one bundler-specific import in this package.
 *
 * Why this exists rather than `/// <reference types="vite/client" />`
 *   `apps/desktop/tsconfig.json` names its type roots explicitly
 *   (`"types": ["node", "electron"]`), so pulling in Vite's client types would add
 *   a build tool to a list that is otherwise about the runtime the shell talks to.
 *
 *   The declaration is needed here as well as in `packages/ui`, because TypeScript
 *   resolves ambient modules per program: the renderer imports
 *   `TERMINAL_STYLESHEET` from `@haruyuki/ui`, and compiling this package follows
 *   that import into `packages/ui/src/terminal/stylesheet.ts` -- where the `?raw`
 *   import has to resolve again, in *this* program. A declaration in the source
 *   package is not visible to a consumer that compiles the same source.
 *
 * What is declared, and what is deliberately not
 *   Only `?raw` on a `.css` file. `apps/desktop/vite.renderer.mts` is a plain Vite
 *   config with no plugin adding suffixes, so `?raw` is the only one this package
 *   can rely on; declaring `?url` or `?inline` as well would promise behaviour
 *   nobody has checked.
 */

declare module "*.css?raw" {
  /**
   * The file's text, or the empty string in an environment without `?raw`.
   *
   * Under this package's build that is the real stylesheet, because Vite inlines
   * it. Under vitest it is empty, which is why `stylesheet.ts` documents the split
   * and its test asserts the empty case.
   */
  const text: string;

  export default text;
}
