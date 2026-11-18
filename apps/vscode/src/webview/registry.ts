/**
 * The webview's page registry.
 *
 * `registerSamplePages` throws when it meets an id that is already registered,
 * and that is the right behaviour for the layer: two bootstraps in one registry
 * means the panel mounted twice, and swallowing it would leave a broken mount
 * looking correct. This module therefore owns the *call site* instead of the
 * rule: the registry is built once per module instance and handed out again on
 * every later request, so no second registration can happen even if a hot
 * reload re-runs a module that asks for it.
 *
 * Module scope is the right lifetime because a webview document is one panel
 * session. A reload gets a fresh module instance and a fresh registry, which is
 * the same rule the layout document follows: nothing here outlives the panel.
 */

import { createPageRegistry, registerSamplePages, type PageRegistry } from "@haruyuki/ui";

/** Built on the first request; `null` until then so a failure is not cached. */
let registry: PageRegistry | null = null;

/**
 * The registry every consumer in this webview shares.
 *
 * @returns the process-wide registry, with the sample pages registered
 */
export function createRegistry(): PageRegistry {
  if (registry !== null) return registry;

  const next = createPageRegistry();

  registerSamplePages(next);
  registry = next;

  return registry;
}
