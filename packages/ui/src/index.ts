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

export {
  CAPABILITY_DESCRIPTORS,
  CAPABILITY_FAMILIES,
  COMMAND_DESCRIPTOR_LIST,
  filterDescriptors,
} from "./command/descriptors.js";
export type {
  CapabilityDescriptor,
  CapabilityFamily,
  CapabilityParamSpec,
  CapabilityScope,
} from "./command/descriptors.js";
export * from "./bridge/index.js";
export * from "./components/index.js";
export * from "./i18n/index.js";
export * from "./icons/index.js";
export * from "./tokens/index.js";
