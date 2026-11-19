/**
 * The frame's notice bar.
 *
 * Four situations need to reach the user without replacing page content, and
 * they differ only in severity and in whether there is something to do about
 * them:
 *
 * | scene | when | tone |
 * |---|---|---|
 * | `layout` | the document could not be read, or came from a newer version and is read-only | warning |
 * | `hiddenTabs` | tabs are hidden because their pages are not registered | info |
 * | `unknownPages` | the document names pages this build cannot render | warning |
 * | `engineOffline` | the engine is not connected, so page data cannot load | danger |
 *
 * This module is deliberately a policy shim over the component layer's `Alert`:
 * the tones, the ARIA role, the icon and the dismiss button (with a translated
 * accessible name) already exist there, and a second banner rendering them again
 * would be a second place for the tone rules to drift. What the frame adds is
 * the scene-to-tone decision and the action slot.
 *
 * The message text is passed in already translated. That is not laziness: the
 * scene alone does not know the counts, the version, or whether the failure was
 * a read error, and composing a sentence from fragments in here would make the
 * translations wrong the moment a language reorders them.
 */

import type { ReactElement } from "react";

import { Alert } from "../components/Alert.js";
import type { AlertTone } from "../components/Alert.js";
import { Button } from "../components/Button.js";

/** The four situations `59` section 4.4 and 4.6 name. */
export type BannerScene = "layout" | "hiddenTabs" | "unknownPages" | "engineOffline";

/**
 * Severity per scene.
 *
 * `layout` and `unknownPages` are warnings rather than errors: the frame opened
 * and the user can keep working. `engineOffline` is an error because pages are
 * unusable until it clears, and `hiddenTabs` is information because the user
 * chose to close those tabs.
 */
export const BANNER_SCENE_TONE: Record<BannerScene, AlertTone> = {
  layout: "warning",
  hiddenTabs: "info",
  unknownPages: "warning",
  engineOffline: "danger",
};

/** Props of {@link Banner}. */
export interface BannerProps {
  /** Severity; decides the colour and the ARIA role. Required. */
  readonly tone: AlertTone;
  /** Already translated message. */
  readonly message: string;
  /** Label of the optional action; rendered only together with `onAction`. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** When present, renders a dismiss button. */
  readonly onDismiss?: () => void;
  /** Test hook, forwarded to the underlying alert. */
  readonly "data-testid"?: string;
}

/**
 * Render one notice bar.
 *
 * @param props banner props
 * @returns the alert element
 */
export function Banner({
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
  "data-testid": testId,
}: BannerProps): ReactElement {
  const actionable = actionLabel !== undefined && onAction !== undefined;

  return (
    <Alert
      tone={tone}
      className="hz-banner"
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <p className="hz-banner__message">{message}</p>
      {actionable ? (
        <div className="hz-banner__actions">
          <Button variant="secondary" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
