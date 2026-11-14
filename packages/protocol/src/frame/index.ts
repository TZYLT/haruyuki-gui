/**
 * Frame layer public surface.
 *
 * A barrel, and nothing else: the envelope types live in `frame.ts` and the
 * type table in `frame-types.ts`, so a consumer that only needs the table does
 * not have to carry the envelope documentation with it. Splitting the two also
 * keeps `check-frame.mjs` pointed at one small file whose AST it can parse.
 *
 * Imports carry the `.js` extension because `moduleResolution: Bundler` still
 * resolves the emitted-specifier style this repository writes, and because the
 * same specifier shape is what a compiled consumer would see.
 */
export * from "./frame.js";
export * from "./frame-types.js";
