/**
 * Reading the two message families a panel sends.
 *
 * A panel sends exactly two kinds of its own: an announcement after every
 * `boot`, and an action from a button on a failure page. Neither names the
 * other, and a reader for one has no business guessing at the other, so each
 * gets its own reader here rather than a single dispatch that has to agree with
 * itself about what an unreadable message meant.
 *
 * Carved out of the controller when that file reached its line budget. Both
 * readers are total: any value at all is either the shape they know or `null`.
 */

/** The announcement a panel makes, in the two versions the core compares. */
export type BridgeAnnouncement = {
  readonly appVersion: string;
  readonly bridgeVersion: string;
};

/**
 * Read the panel's announcement out of one message.
 *
 * Both versions are required and non-empty. An announcement that carries
 * neither has nothing to compare, and reading it as "the versions match" is the
 * one answer that must never be inferred from silence.
 *
 * @param raw one message from the panel
 * @returns the two versions, or `null` when the message is not an announcement
 */
export function bridgeAnnouncementOf(raw: unknown): BridgeAnnouncement | null {
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;

  if (record["kind"] !== "ready") return null;

  const appVersion = record["appVersion"];
  const bridgeVersion = record["bridgeVersion"];

  if (typeof appVersion !== "string" || appVersion === "") return null;
  if (typeof bridgeVersion !== "string" || bridgeVersion === "") return null;

  return { appVersion, bridgeVersion };
}

/**
 * Read the action one message names.
 *
 * @param raw one message from the panel
 * @returns the action it names, or `null` when it names none
 */
export function actionOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;

  if (record["kind"] !== "action") return null;

  const action = record["action"];

  return typeof action === "string" && action.length > 0 ? action : null;
}
