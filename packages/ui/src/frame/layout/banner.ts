/**
 * The notice a layout outcome earns.
 *
 * Kept in the UI package rather than the renderer so the copy lives beside the
 * other frame messages: the i18n gate only walks UI sources, and a renderer that
 * spelled the keys itself would be a second, unchecked copy of the same words.
 */

import type { Translator } from "../../i18n/index.js";
import type { BannerProps } from "../Banner.js";

/** The outcomes a layout load can report. */
export type LayoutOutcome = "ok" | "default" | "migrated" | "corrupt" | "fell-back-to-default";

/**
 * Build the banner for one layout load.
 *
 * @param outcome how the store's read ended
 * @param writable whether the document may be overwritten
 * @param t the active translator
 * @returns a banner, or null when the load was clean and writable
 */
export function layoutBanner(
  outcome: LayoutOutcome,
  writable: boolean,
  t: Translator,
): BannerProps | null {
  if (writable === false) {
    return { tone: "warning", message: t("page.frame.banner.readOnly") };
  }

  if (outcome === "corrupt" || outcome === "fell-back-to-default") {
    return { tone: "danger", message: t("page.frame.banner.corrupt") };
  }

  if (outcome === "default") {
    return { tone: "warning", message: t("page.frame.banner.readFailed") };
  }

  return null;
}
