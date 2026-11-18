/*
 * The webview bundles CSS through its build; tsc only needs to know the import
 * is a side effect. `@haruyuki/ui` is shipped as source, so a CSS import inside
 * it has to resolve again in this package's program.
 */
declare module "*.css";
