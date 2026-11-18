/**
 * Ambient types for the one bundler-specific import this package reaches.
 *
 * Why this exists rather than `/// <reference types="vite/client" />`
 *   `apps/vscode/tsconfig.json` names its type roots explicitly
 *   (`"types": ["node", "vscode"]`), so pulling in a bundler's client types
 *   would add a build tool to a list that is otherwise about the runtime this
 *   shell talks to.
 *
 *   The declaration is needed here as well as in `packages/ui`, because
 *   TypeScript resolves ambient modules per program: compiling this package
 *   follows the `@haruyuki/ui` import into `packages/ui/src/terminal/stylesheet.ts`,
 *   where the `?raw` import has to resolve again, in *this* program. A
 *   declaration in the source package is not visible to a consumer that
 *   compiles the same source.
 *
 * What is declared, and what is deliberately not
 *   Only `?raw` on a `.css` file, which is the only suffix `@haruyuki/ui` uses.
 *   Declaring `?url` or `?inline` as well would promise behaviour nobody has
 *   checked.
 */

declare module "*.css?raw" {
  /**
   * The file's text, or the empty string in an environment without `?raw`.
   *
   * Under a bundler that implements `?raw` this is the real stylesheet; under
   * vitest it is empty, which is why `stylesheet.ts` documents the split and
   * its test asserts the empty case.
   */
  const text: string;

  export default text;
}
