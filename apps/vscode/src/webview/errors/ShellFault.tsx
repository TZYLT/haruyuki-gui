/**
 * The shell's fault page: the panel is alive, the engine is not.
 *
 * Why this is a module of its own rather than a banner
 *
 *   The frame's banner is a layout notification: it says a document could not be
 *   read, or that tabs are hidden, and the page behind it stays usable. This is
 *   the other thing -- the shell cannot run at all -- and it owns the status area
 *   for as long as it lasts. The two are composed side by side by `main.tsx`, and
 *   the frame is *kept* underneath: a fault covers the state area and never
 *   replaces the frame or resets the layout, so a reconnect finds the user's
 *   arrangement exactly as it was.
 *
 * Why the action row is here rather than in a banner
 *
 *   The four situations offer different answers, and the banner's slot holds one.
 *   Collapsing them to one would mean the page asked the user to pick the right
 *   button before reading what went wrong.
 *
 * Where the copy lives
 *
 *   Here, as `t()` calls with literal keys. The i18n gate counts a key as used
 *   only when its literal appears in a `t(...)` call or a `key:`/`labelKey=`
 *   position, and it deliberately rejects a second message table -- a catalogue
 *   key that nothing spells out is exactly the dead weight it exists to catch. So
 *   the sentences are resolved at the point of rendering, and `model.ts` decides
 *   only which situation and which answers.
 */

import { useState, type ReactElement } from "react";

import { Button, ErrorState, useT } from "@haruyuki/ui";

import { toShellFault, type FaultInput, type ShellFaultAction } from "./model.js";

/** Props of {@link ShellFault}. */
export interface ShellFaultProps {
  /** The failure the host reported. */
  readonly failure: FaultInput;
  /** Send one answer to the host. The panel owns the wire, not this page. */
  readonly onAction: (action: ShellFaultAction) => void;
}

/**
 * Render the fault page.
 *
 * @param props the failure and the way back to the host
 * @returns the page
 */
export function ShellFault({ failure, onAction }: ShellFaultProps): ReactElement {
  const t = useT();
  const view = toShellFault(failure);

  // The home-directory answer is asked twice: once by the button, and once by the
  // sentence that states where the engine would write. A single click that starts
  // writing into somebody's home directory is the failure this state exists for.
  const [confirming, setConfirming] = useState(false);

  const facts = factsOf(view.situation, failure, t);

  return (
    <div className="shell-fault" role="region" aria-live="polite" data-testid="shell-fault">
      {/*
        No `detail`. The host's sentence is a diagnostic -- it names resolver
        rungs and internal reasons -- so it belongs in the log, where the "open
        logs" answer points. It is also English: rendering it under a translated
        heading puts one untranslatable paragraph in the middle of a localized
        page. What a user can act on is the heading, the structured facts below
        and the answers under them.
      */}
      <ErrorState title={titleOf(view.situation, t)} />

      {facts.length === 0 ? null : (
        <ul className="shell-fault__facts" data-testid="shell-fault-facts">
          {facts.map((fact) => (
            <li key={fact.label} className="shell-fault__fact" data-testid="shell-fault-fact">
              {fact.text}
            </li>
          ))}
        </ul>
      )}

      {confirming ? (
        <div className="shell-fault__confirm" data-testid="shell-fault-confirm">
          <p className="shell-fault__risk">
            {t("error.workspaceMissingRisk", { homeDir: failure.homeDir ?? "" })}
          </p>
          <div className="shell-fault__actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirming(false);
                onAction("useHomeDir");
              }}
            >
              {t("common.action.confirm")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("common.action.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="shell-fault__actions" data-testid="shell-fault-actions">
          {view.actions.map((action) => (
            <Button
              key={action}
              variant={action === view.actions[0] ? "primary" : "secondary"}
              size="sm"
              onClick={() => {
                // The degradation asks first. Every other answer is already the
                // user's decision, so it is sent as it is.
                if (action === "useHomeDir") {
                  setConfirming(true);

                  return;
                }

                onAction(action);
              }}
            >
              {labelOf(action, t)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One rendered fact: the sentence it shows, and the label it is keyed by. */
interface RenderedFact {
  readonly label: string;
  readonly text: string;
}

/**
 * The supporting facts for one situation.
 *
 * A fact is emitted only when the host supplied it. An empty row would be a label
 * with nothing after it, which reads as a rendering bug rather than as a missing
 * fact -- so the absence of the field is what removes the row.
 *
 * @param situation the situation, which decides which facts apply
 * @param failure the failure that carried them
 * @param t the translator
 * @returns the rows to render, in reading order
 */
function factsOf(
  situation: ReturnType<typeof toShellFault>["situation"],
  failure: FaultInput,
  t: ReturnType<typeof useT>,
): readonly RenderedFact[] {
  const facts: RenderedFact[] = [];

  switch (situation) {
    case "engineMissing": {
      // Where the search looked, as one sentence: the separator belongs to the
      // catalogue's phrasing, so the paths arrive joined and are never re-split.
      if (failure.searchedPaths !== undefined && failure.searchedPaths.length > 0) {
        facts.push({
          label: "error.runtimeSearchedPaths",
          text: t("error.runtimeSearchedPaths", { paths: failure.searchedPaths.join(", ") }),
        });
      }

      break;
    }

    case "invalidEngineDir": {
      if (failure.missingEntries !== undefined && failure.missingEntries.length > 0) {
        facts.push({
          label: "error.runtimeInvalidMissing",
          text: t("error.runtimeInvalidMissing", { entries: failure.missingEntries.join(", ") }),
        });
      }

      if (failure.candidateDir !== undefined) {
        facts.push({
          label: "error.runtimePath",
          text: `${t("error.runtimePath")}: ${failure.candidateDir}`,
        });
      }

      break;
    }

    case "untestedEngine": {
      // One row, not two: the pair is the fact, and splitting it would let a
      // translation move the two halves apart or lose one of them.
      if (failure.expectedVersion !== undefined && failure.actualVersion !== undefined) {
        facts.push({
          label: "error.runtimeUntestedVersions",
          text: t("error.runtimeUntestedVersions", {
            expected: failure.expectedVersion,
            actual: failure.actualVersion,
          }),
        });
      }

      if (failure.candidateDir !== undefined) {
        facts.push({
          label: "error.runtimePath",
          text: `${t("error.runtimePath")}: ${failure.candidateDir}`,
        });
      }

      break;
    }

    case "noWorkspace": {
      // The risk sentence is rendered by the confirmation step instead, so that
      // it sits beside the button the user is about to press rather than above
      // two answers, one of which does not carry the risk at all.
      break;
    }
  }

  // The log location applies to all four: it is what every answer above is
  // ultimately diagnosed from, and it is a path rather than prose.
  if (failure.logPath !== undefined) {
    facts.push({
      label: "error.runtimeLogPath",
      text: `${t("error.runtimeLogPath")}: ${failure.logPath}`,
    });
  }

  return facts;
}

/**
 * The label of one answer.
 *
 * A `switch` on the action that calls `t()` with a literal, so the i18n gate sees
 * each key used. `./model.ts` decides *which* answers exist; the words are here.
 *
 * @param action the answer the button sends
 * @param t the translator
 * @returns its label
 */
function labelOf(action: ShellFaultAction, t: ReturnType<typeof useT>): string {
  switch (action) {
    case "chooseEngineDir":
      return t("error.runtimeChoose");
    case "openSettings":
      return t("page.topbar.settings");
    case "openLogs":
      return t("error.runtimeOpenLog");
    case "openFolder":
      return t("common.diagnostics.openFolder");
    case "connectAnyway":
      return t("error.runtimeConnectAnyway");
    case "useHomeDir":
      return t("error.workspaceUseHomeDir");
  }
}

/**
 * The heading for one situation.
 *
 * A `switch` rather than a table, because the i18n gate only counts a key as used
 * when its literal appears in a `t()` call. The same reason the desktop shell's
 * error page uses one.
 *
 * @param situation which of the four this is
 * @param t the translator
 * @returns the heading
 */
function titleOf(
  situation: ReturnType<typeof toShellFault>["situation"],
  t: ReturnType<typeof useT>,
): string {
  switch (situation) {
    case "engineMissing":
      return t("error.runtimeMissingTitle");
    case "invalidEngineDir":
      return t("error.runtimeInvalidTitle");
    case "untestedEngine":
      return t("error.runtimeUntestedTitle");
    case "noWorkspace":
      return t("error.workspaceMissingTitle");
  }
}
