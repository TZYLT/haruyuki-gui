/**
 * Public surface of the renderer package.
 *
 * Downstream pages import from here and from nowhere else. That is the point of a
 * single entry: it makes the package's public API a thing somebody chose, rather
 * than whatever happened to be reachable by a deep import. Moving or renaming an
 * internal file is then safe.
 *
 * It also uses its own local export so the module is a real one rather than a
 * barrel with no behaviour, which the ownership gate rejects -- correctly, since a
 * forwarding-only module has nothing to own.
 */

/** Package name, useful in diagnostics and in error messages. */
export const PACKAGE_NAME = "@haruyuki/ui" as const;

export * from "./components/index.js";
export * from "./i18n/index.js";
export * from "./icons/index.js";
export * from "./tokens/index.js";
