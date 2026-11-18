/**
 * The about window's page: what this copy of the application is, and whether a
 * newer one exists.
 *
 * A second document rather than a route in the shell, so the two can be open at
 * once and so closing one cannot affect the other. It is served over the same
 * `app://` origin, under the same CSP, which is why nothing here needs a policy
 * of its own.
 *
 * The page shows facts and offers actions; it decides nothing. Every value
 * comes from one of two channels -- the read-only installation facts, and the
 * update check -- and both answer with a shape this file validates instead of
 * trusting. A window that rendered whatever the main process sent would show a
 * hole instead of a sentence the day a field was renamed.
 *
 * It works offline by construction: the facts are read from the package and from
 * `runtime-state.json`, and the only outbound request in the whole window is the
 * one the update button makes, on a click.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Alert, Button, useT } from "@haruyuki/ui";
import { ABOUT_INFO_CHANNEL, ABOUT_OPEN_CHANNEL, UPDATE_CHECK_CHANNEL } from "../shared/bridge.js";

/**
 * The parts of the preload this page uses.
 *
 * Declared rather than imported from the bridge: the renderer needs one member,
 * and the preload is plain JavaScript with no module graph this side can see.
 */
interface AboutBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/** One engine source, spelled the same three ways the runtime spells it. */
type EngineSource = "bundled" | "external" | "path";

/** One verification outcome, plus the absence of one. */
type EngineLastResult = "ok" | "entry-mismatch" | "tree-mismatch" | "missing" | "unknown";

/** What the installation channel answers, after validation. */
interface AboutFacts {
  readonly appVersion: string;
  readonly engine: {
    readonly version: string;
    readonly source: EngineSource;
    readonly lastResult: EngineLastResult;
  };
  readonly runtime: {
    readonly electron: string;
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly repoUrl: string;
  readonly issueUrl: string;
}

/**
 * The update check, as this page models it.
 *
 * `idle` exists only here: it is "the user has not asked yet", which the main
 * process never answers, and rendering it as `checking` would show a spinner
 * nobody started.
 */
type UpdateOutcome =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | {
      readonly state: "available";
      readonly current: string;
      readonly latest: string;
      readonly pageUrl: string;
    }
  | { readonly state: "up-to-date"; readonly current: string }
  | {
      readonly state: "failed";
      readonly reason: "rate-limit" | "network" | "no-release";
      readonly detail?: string;
    };

/** The three documents, as the open channel names them. */
type LegalDoc = "license" | "notice" | "third-party";

/**
 * Read the bridge this page calls.
 *
 * Read per use rather than at module scope: a preload that failed to load is one
 * readable sentence on the page, not a module that throws before the first paint.
 */
function readBridge(): AboutBridge | null {
  const candidate = (window as unknown as { haruyuki?: unknown }).haruyuki;

  if (typeof candidate !== "object" || candidate === null) return null;

  return typeof (candidate as { invoke?: unknown }).invoke === "function"
    ? (candidate as AboutBridge)
    : null;
}

/** Whether a value is a non-empty string, used by every parser below. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Validate the installation payload.
 *
 * @param value whatever the channel answered
 * @returns the facts, or `null` when this is not that shape
 */
function parseAboutFacts(value: unknown): AboutFacts | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const engine = record["engine"];
  const runtime = record["runtime"];

  if (typeof engine !== "object" || engine === null) return null;
  if (typeof runtime !== "object" || runtime === null) return null;

  const engineRecord = engine as Record<string, unknown>;
  const runtimeRecord = runtime as Record<string, unknown>;

  if (!isText(record["appVersion"])) return null;
  if (!isText(record["repoUrl"]) || !isText(record["issueUrl"])) return null;
  if (!isText(runtimeRecord["electron"]) || !isText(runtimeRecord["node"])) return null;
  if (!isText(runtimeRecord["platform"]) || !isText(runtimeRecord["arch"])) return null;

  // A missing version is a real answer (the lock did not ship, the pick was
  // never started), so it is allowed to be the empty string. The other two
  // fields are words this page switches on, and an unknown word would render a
  // missing sentence rather than an honest one.
  if (typeof engineRecord["version"] !== "string") return null;

  const source = engineRecord["source"];
  const lastResult = engineRecord["lastResult"];

  if (source !== "bundled" && source !== "external" && source !== "path") return null;

  if (
    lastResult !== "ok" &&
    lastResult !== "entry-mismatch" &&
    lastResult !== "tree-mismatch" &&
    lastResult !== "missing" &&
    lastResult !== "unknown"
  ) {
    return null;
  }

  return {
    appVersion: record["appVersion"] as string,
    engine: {
      version: engineRecord["version"] as string,
      source,
      lastResult,
    },
    runtime: {
      electron: runtimeRecord["electron"] as string,
      node: runtimeRecord["node"] as string,
      platform: runtimeRecord["platform"] as string,
      arch: runtimeRecord["arch"] as string,
    },
    repoUrl: record["repoUrl"] as string,
    issueUrl: record["issueUrl"] as string,
  };
}

/**
 * Validate the update answer.
 *
 * The five states are kept apart here exactly as they are on the wire: an
 * unparsed payload is `null`, and this page then shows the network failure
 * sentence rather than "up to date", because "we could not read the answer" is
 * one of the "I do not know" cases, not a conclusion.
 *
 * @param value whatever the channel answered
 * @returns the outcome, or `null` when this is not that shape
 */
function parseUpdateOutcome(value: unknown): UpdateOutcome | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;

  if (record["state"] === "checking") return { state: "checking" };

  if (record["state"] === "up-to-date") {
    return isText(record["current"]) ? { state: "up-to-date", current: record["current"] } : null;
  }

  if (record["state"] === "available") {
    const current = record["current"];
    const latest = record["latest"];
    const pageUrl = record["pageUrl"];

    if (!isText(current) || !isText(latest) || !isText(pageUrl)) return null;

    return { state: "available", current, latest, pageUrl };
  }

  if (record["state"] === "failed") {
    const reason = record["reason"];
    const detail = record["detail"];

    if (reason !== "rate-limit" && reason !== "network" && reason !== "no-release") return null;

    return {
      state: "failed",
      reason,
      ...(typeof detail === "string" && detail !== "" ? { detail } : {}),
    };
  }

  return null;
}

/** One row of the label/value grid. */
function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", gap: "var(--ui-space-3)", padding: "var(--ui-space-2) 0" }}>
      <span style={{ flex: "0 0 168px", color: "var(--ui-color-muted-2)" }}>{label}</span>
      <span
        style={{ flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" }}
        {...(testId === undefined ? {} : { "data-testid": testId })}
      >
        {value}
      </span>
    </div>
  );
}

/** One titled block; every section of the page is one. */
function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section style={{ marginTop: "var(--ui-space-6)" }}>
      <h2 style={{ fontSize: "var(--ui-font-size-4)", margin: "0 0 var(--ui-space-2)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The five update results.
 *
 * Five branches rather than one with a flag, because the requirement is that a
 * reader can tell them apart. In particular the three "I do not know" answers
 * must never borrow the wording of "there is no newer version".
 *
 * @param props the outcome and the page URL the download button opens
 * @returns the sentence, its hint, and the button when there is one
 */
function UpdateResult({ outcome }: { outcome: UpdateOutcome }): ReactElement | null {
  const t = useT();

  if (outcome.state === "idle") return null;

  if (outcome.state === "checking") {
    return (
      <p
        role="status"
        data-testid="about-update-checking"
        style={{ margin: "var(--ui-space-3) 0 0" }}
      >
        {t("common.about.update.checking")}
      </p>
    );
  }

  if (outcome.state === "available") {
    return (
      <div style={{ marginTop: "var(--ui-space-3)" }} data-testid="about-update-available">
        <Alert tone="success">
          {t("common.about.update.available", {
            latest: outcome.latest,
            current: outcome.current,
          })}
        </Alert>
        {/* An anchor, not a button that calls something: the window's own
            open handler is what hands `https:` URLs to the browser, so this
            reaches the download page without a second channel and without the
            page being able to choose a scheme. */}
        <p style={{ margin: "var(--ui-space-3) 0 0" }}>
          <a href={outcome.pageUrl} target="_blank" rel="noreferrer">
            {t("common.about.update.openPage")}
          </a>
        </p>
      </div>
    );
  }

  if (outcome.state === "up-to-date") {
    return (
      <p data-testid="about-update-up-to-date" style={{ margin: "var(--ui-space-3) 0 0" }}>
        {t("common.about.update.upToDate", { current: outcome.current })}
      </p>
    );
  }

  if (outcome.reason === "no-release") {
    return (
      <p data-testid="about-update-no-release" style={{ margin: "var(--ui-space-3) 0 0" }}>
        {t("common.about.update.noRelease")}
      </p>
    );
  }

  if (outcome.reason === "rate-limit") {
    return (
      <div style={{ marginTop: "var(--ui-space-3)" }} data-testid="about-update-rate-limit">
        <Alert tone="warning">{t("common.about.update.failedRateLimit")}</Alert>
        {/* A line of its own: this is not a network problem and not something
            the reader can fix by pressing the button again now. */}
        <p style={{ margin: "var(--ui-space-2) 0 0", color: "var(--ui-color-muted-2)" }}>
          {t("common.about.update.rateLimitHint")}
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: "var(--ui-space-3)" }} data-testid="about-update-network">
      <Alert tone="warning">{t("common.about.update.failedNetwork")}</Alert>
      {/* The detail is the transport's own message: untrusted text, shown as
          text, and never translated -- it is what a report needs to quote. */}
      {outcome.detail === undefined ? null : (
        <p
          style={{
            margin: "var(--ui-space-2) 0 0",
            color: "var(--ui-color-muted-2)",
            wordBreak: "break-word",
          }}
        >
          {outcome.detail}
        </p>
      )}
    </div>
  );
}

/**
 * The page.
 *
 * Exported rather than mounted here: a test renders it inside its own provider,
 * and the mount (theme, locale, `createRoot`) belongs to the entry module.
 *
 * @returns the about surface
 */
export function AboutPage(): ReactElement {
  const t = useT();
  const [facts, setFacts] = useState<AboutFacts | null>(null);
  const [factsMissing, setFactsMissing] = useState(false);
  const [update, setUpdate] = useState<UpdateOutcome>({ state: "idle" });
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  useEffect(() => {
    const bridge = readBridge();

    if (bridge === null) {
      setFactsMissing(true);
      return;
    }

    void bridge
      .invoke(ABOUT_INFO_CHANNEL)
      .then((value) => {
        const parsed = parseAboutFacts(value);

        if (parsed === null) setFactsMissing(true);
        else setFacts(parsed);
      })
      .catch(() => {
        setFactsMissing(true);
      });
  }, []);

  /** Ask GitHub, with the checking state shown first so the button is never silent. */
  const checkForUpdate = (): void => {
    const bridge = readBridge();

    if (bridge === null) {
      setUpdate({ state: "failed", reason: "network", detail: "bridge unavailable" });
      return;
    }

    setUpdate({ state: "checking" });

    void bridge
      .invoke(UPDATE_CHECK_CHANNEL)
      .then((value) => {
        const parsed = parseUpdateOutcome(value);

        // An unreadable answer is not a conclusion. It is reported as the
        // transport failure, because that is the only "do not know" sentence
        // that does not claim to know why.
        setUpdate(parsed ?? { state: "failed", reason: "network", detail: "unreadable response" });
      })
      .catch(() => {
        setUpdate({ state: "failed", reason: "network", detail: "the update channel failed" });
      });
  };

  /** Open one of the three documents that ship with the application. */
  const openDoc = (doc: LegalDoc): void => {
    const bridge = readBridge();

    if (bridge === null) {
      setOpenFailure(t("common.about.unavailable"));
      return;
    }

    setOpenFailure(null);

    void bridge
      .invoke(ABOUT_OPEN_CHANNEL, { doc })
      .then((value) => {
        const record = typeof value === "object" && value !== null ? value : {};

        if ((record as Record<string, unknown>)["ok"] === true) return;

        const detail = (record as Record<string, unknown>)["detail"];

        setOpenFailure(typeof detail === "string" ? detail : t("common.about.unavailable"));
      })
      .catch(() => {
        setOpenFailure(t("common.about.unavailable"));
      });
  };

  return (
    <div style={{ padding: "var(--ui-space-8)", maxWidth: 640 }} data-testid="about-page">
      <h1 style={{ fontSize: "var(--ui-font-size-6)", margin: 0 }}>{t("common.about.title")}</h1>

      {factsMissing ? (
        <div style={{ marginTop: "var(--ui-space-4)" }}>
          <Alert tone="warning">{t("common.about.bridgeUnavailable")}</Alert>
        </div>
      ) : null}

      {facts === null ? null : (
        <>
          <Section title={t("common.about.version")}>
            <p
              data-testid="about-app-version"
              style={{ margin: 0, fontSize: "var(--ui-font-size-5)" }}
            >
              {facts.appVersion}
            </p>
          </Section>

          <Section title={t("common.about.engine")}>
            <Row
              label={t("common.about.engineVersion")}
              testId="about-engine-version"
              value={
                facts.engine.version === "" ? t("common.about.unavailable") : facts.engine.version
              }
            />
            <Row
              label={t("common.about.engineSource")}
              testId="about-engine-source"
              value={sourceLabel(facts.engine.source, t)}
            />
            <Row
              label={t("common.about.lastResult")}
              testId="about-last-result"
              value={lastResultLabel(facts.engine.lastResult, t)}
            />
          </Section>

          <Section title={t("common.about.license")}>
            <p style={{ margin: 0 }}>{t("common.about.licenseLine")}</p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--ui-space-2)",
                marginTop: "var(--ui-space-3)",
              }}
            >
              <Button
                variant="secondary"
                data-testid="about-open-license"
                onClick={() => openDoc("license")}
              >
                {t("common.about.openLicense")}
              </Button>
              <Button
                variant="secondary"
                data-testid="about-open-notice"
                onClick={() => openDoc("notice")}
              >
                {t("common.about.openNotice")}
              </Button>
              <Button
                variant="secondary"
                data-testid="about-open-third-party"
                onClick={() => openDoc("third-party")}
              >
                {t("common.about.openThirdParty")}
              </Button>
            </div>
            {openFailure === null ? null : (
              <div style={{ marginTop: "var(--ui-space-3)" }}>
                <Alert tone="danger">{t("common.about.openFailed", { detail: openFailure })}</Alert>
              </div>
            )}
          </Section>

          <Section title={t("common.about.repo")}>
            <Row
              label={t("common.about.repoUrl")}
              value={
                <a href={facts.repoUrl} target="_blank" rel="noreferrer">
                  {facts.repoUrl}
                </a>
              }
            />
            <Row
              label={t("common.about.issue")}
              value={
                <a href={facts.issueUrl} target="_blank" rel="noreferrer">
                  {facts.issueUrl}
                </a>
              }
            />
          </Section>

          <Section title={t("common.about.environment")}>
            <Row
              label={t("common.about.platform")}
              testId="about-env-platform"
              value={facts.runtime.platform}
            />
            <Row
              label={t("common.about.arch")}
              testId="about-env-arch"
              value={facts.runtime.arch}
            />
            <Row
              label={t("common.about.electron")}
              testId="about-env-electron"
              value={facts.runtime.electron}
            />
            <Row
              label={t("common.about.node")}
              testId="about-env-node"
              value={facts.runtime.node}
            />
          </Section>
        </>
      )}

      <Section title={t("common.about.checkUpdate")}>
        <Button
          variant="primary"
          loading={update.state === "checking"}
          onClick={checkForUpdate}
          data-testid="about-check-update"
        >
          {t("common.about.checkUpdate")}
        </Button>
        <UpdateResult outcome={update} />
      </Section>
    </div>
  );
}

/** The engine source as a sentence, with the three words mapped one to one. */
function sourceLabel(source: EngineSource, t: ReturnType<typeof useT>): string {
  if (source === "external") return t("common.about.sourceExternal");
  if (source === "path") return t("common.about.sourcePath");

  return t("common.about.sourceBundled");
}

/**
 * The last verification as a sentence.
 *
 * `entry-mismatch` and `tree-mismatch` differ in the log and in what to do about
 * them, but not in what a reader needs here: the engine that was started did not
 * match the record. They stay two keys anyway so the catalogue does not hide the
 * distinction from a future surface that shows it.
 */
function lastResultLabel(result: EngineLastResult, t: ReturnType<typeof useT>): string {
  if (result === "ok") return t("common.about.lastResultOk");
  if (result === "entry-mismatch") return t("common.about.lastResultEntryMismatch");
  if (result === "tree-mismatch") return t("common.about.lastResultTreeMismatch");
  if (result === "missing") return t("common.about.lastResultMissing");

  return t("common.about.lastResultUnknown");
}
