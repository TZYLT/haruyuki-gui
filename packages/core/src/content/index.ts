/**
 * The conversation content model's contract surface.
 *
 * The protocol content modules hold types only, and the core package exports
 * just the facade and its types. Everything else in this
 * directory (the parsers, the tool table, the reasoning aggregator, the fence
 * scanner and the sanitizer) is module-local: a consumer that renders blocks
 * imports `createContentModel` and the protocol's `Block` union, and tests drive
 * the individual modules through direct deep imports.
 *
 * The layer marker is a type, not a runtime value: this module must stay
 * type-only apart from the facade, and a local declaration is what keeps the
 * repository's "no pure forwarding module" gate satisfied.
 */
export type CONTENT_LAYER = "core/content";

export type {
  ContentModel,
  ContentModelOptions,
  ContentStats,
  SourceDelta,
  SourceMessage,
} from "./types.js";
export { createContentModel } from "./model.js";
