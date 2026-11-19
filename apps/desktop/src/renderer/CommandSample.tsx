/**
 * A sample page for the command path.
 *
 * Two buttons, one per completion shape, because the point of the page is to show
 * the difference between them without a table of capabilities:
 *
 *   `device.info`   a request/response capability; the reply carries data and the
 *                   page renders it, which is what `answered` means.
 *   `terminal.kill` a fire-and-forget capability; there is no correlated answer,
 *                   so the page can only ever report "sent". If it ever showed
 *                   `answered` for that button, the completion derivation in the
 *                   command layer would be broken.
 *
 * The failure rendering is deliberately a mapping over the layer's five codes
 * plus the engine's own refusal, not a translation of `detail`: the page is where
 * a user learns which of the three consequences applies (not implemented, not
 * connected, refused), and `detail` is a log line, not a sentence.
 *
 * No bridge is read at module scope. The preload may have failed to load, and a
 * page that threw while importing would take the whole tab down instead of
 * showing the one sentence that explains it.
 */

import { useCallback, useState, type CSSProperties, type ReactElement } from "react";

import type { CommandErrorCode, CommandReply } from "@haruyuki/core";
import { Button, useT } from "@haruyuki/ui";
import type { Translator } from "@haruyuki/ui";

import { createCommandClient } from "./command.js";
import type { CommandBridgeSurface, CommandClient } from "./command.js";

/** The capability whose completion shape is a real answer. */
const DEVICE_INFO = "device.info";

/** The capability whose completion shape is "written, never answered". */
const TERMINAL_KILL = "terminal.kill";

/** The terminal the sample asks to kill. It is a caller-owned id, passed through. */
const SAMPLE_TERMINAL_ID = "sample";

/** One command and what came back, kept together so the page can label the result. */
interface Outcome {
  readonly capability: string;
  readonly reply: CommandReply;
}

/** What a page may pass to the sample. */
export interface CommandSampleProps {
  /**
   * An already-built client.
   *
   * Optional so a test can drive the page without a preload, and so a host that
   * owns a client can pass it instead of letting the page build a second one over
   * the same bridge. When absent, the preload surface is read on click.
   */
  client?: CommandClient;
}

/** Layout only; colours and spacing come from the token layer, never literals. */
const ACTIONS: CSSProperties = {
  display: "flex",
  gap: "var(--ui-space-2)",
  marginBottom: "var(--ui-space-3)",
};

/**
 * Reads the preload's command surface.
 *
 * Only `invoke` is needed, and a preload that exposes something else (or nothing)
 * is an ordinary state: the click then reports the channel as unavailable rather
 * than throwing inside an event handler.
 *
 * @returns the surface, or `null` when the preload is absent or incomplete
 */
function readBridge(): CommandBridgeSurface | null {
  if (typeof window === "undefined") return null;

  const candidate = (window as unknown as { haruyuki?: unknown }).haruyuki;

  if (typeof candidate !== "object" || candidate === null) return null;

  const members = candidate as Partial<CommandBridgeSurface>;

  if (typeof members.invoke !== "function") return null;

  return candidate as CommandBridgeSurface;
}

/**
 * Picks the client to call: the injected one, or one built over the preload.
 *
 * @param injected a client the host already owns, when it passed one
 * @returns the client, or `null` when the preload has no bridge to send on
 */
function resolveClient(injected: CommandClient | undefined): CommandClient | null {
  if (injected !== undefined) return injected;

  const bridge = readBridge();

  return bridge === null ? null : createCommandClient(bridge);
}

/**
 * The sentence a layer code carries.
 *
 * `null` means "the engine said no, or said something this page has no category
 * for": those render the engine's own words, or the code itself. Keeping the
 * engine's codes out of this switch is what makes `REJECTED` show the engine's
 * sentence instead of a translated paraphrase of it.
 *
 * The catalogue keys are spelled at this call site rather than returned as a key:
 * the i18n gate reads literal `t("...")` references, and a key reached through a
 * variable is a key nobody can prove is used.
 *
 * @param code the failure code from the reply
 * @param t the active translator
 * @returns the sentence, or `null` to fall back to engine text
 */
function consequenceText(code: CommandErrorCode, t: Translator): string | null {
  switch (code) {
    case "COMMAND_UNKNOWN_CAPABILITY":
    case "COMMAND_CAPABILITY_UNAVAILABLE":
      return t("page.commandSample.notAvailable");
    case "COMMAND_SCOPE_REQUIRED":
      return t("page.commandSample.scopeRequired");
    case "COMMAND_CHANNEL_UNAVAILABLE":
    case "NOT_CONNECTED":
      return t("page.commandSample.notConnected");
    case "COMMAND_BAD_PAYLOAD":
      return t("page.commandSample.badPayload");
    default:
      return null;
  }
}

/**
 * Renders an answered payload as JSON.
 *
 * A summary rather than a typed view: this page's job is to show that the data
 * arrived, and inventing a schema for whichever capability was pressed would be
 * this layer claiming knowledge of the body it explicitly does not interpret.
 *
 * @param data the decoded answer, already untrusted
 * @returns pretty-printed JSON
 */
function summarize(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    // A value with a cycle or a throwing `toJSON` cannot be a command reply in
    // practice, but a sample page must not be the thing that crashes the tab.
    return String(data);
  }
}

/**
 * Renders one reply's successful arms.
 *
 * @param reply a reply already known to be `ok: true`
 * @param t the active translator
 * @returns the answer, or the "sent" acknowledgement
 */
function Success({
  reply,
  t,
}: {
  reply: Extract<CommandReply, { ok: true }>;
  t: Translator;
}): ReactElement {
  if (reply.completion === "answered") {
    return (
      <>
        <p>{t("page.commandSample.answered")}</p>
        <pre>{summarize(reply.data)}</pre>
      </>
    );
  }

  return <p>{t("page.commandSample.accepted")}</p>;
}

/**
 * Renders one reply's failure arm.
 *
 * The code is always shown as a token: the user-facing sentence says what
 * happened, and the token is what a field report or a log grep needs.
 *
 * @param reply a reply already known to be `ok: false`
 * @param t the active translator
 * @returns the consequence sentence plus the code
 */
function Failure({
  reply,
  t,
}: {
  reply: Extract<CommandReply, { ok: false }>;
  t: Translator;
}): ReactElement {
  const sentence = consequenceText(reply.code, t);

  return (
    <>
      <p>{sentence ?? reply.engineText ?? t("error.withCode", { code: reply.code })}</p>
      <code>{reply.code}</code>
    </>
  );
}

/**
 * The sample page.
 *
 * @param props an optional pre-built client
 * @returns the page
 */
export function CommandSample({ client }: CommandSampleProps): ReactElement {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = useCallback(
    async (capability: string, body: Record<string, unknown>): Promise<void> => {
      setBusy(capability);

      try {
        const resolved = resolveClient(client);

        const reply: CommandReply =
          resolved === null
            ? {
                ok: false,
                code: "COMMAND_CHANNEL_UNAVAILABLE",
                detail: "the renderer has no preload bridge to send a command on",
              }
            : await resolved.invoke(capability, body);

        setOutcome({ capability, reply });
      } catch {
        // The client promises not to reject; this is the belt-and-braces path so
        // a bug there cannot leave the buttons disabled forever.
        setOutcome({
          capability,
          reply: {
            ok: false,
            code: "COMMAND_CHANNEL_UNAVAILABLE",
            detail: "the command client failed unexpectedly",
          },
        });
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const disabled = busy !== null;

  return (
    <section>
      <h3>{t("page.commandSample.title")}</h3>

      <div style={ACTIONS}>
        <Button
          onClick={() => {
            void run(DEVICE_INFO, {});
          }}
          loading={busy === DEVICE_INFO}
          disabled={disabled}
        >
          {t("page.commandSample.deviceInfo")}
        </Button>

        <Button
          variant="secondary"
          onClick={() => {
            void run(TERMINAL_KILL, { terminal_id: SAMPLE_TERMINAL_ID });
          }}
          loading={busy === TERMINAL_KILL}
          disabled={disabled}
        >
          {t("page.commandSample.terminalKill")}
        </Button>
      </div>

      {outcome === null ? null : (
        <div>
          <code>{outcome.capability}</code>
          {outcome.reply.ok ? (
            <Success reply={outcome.reply} t={t} />
          ) : (
            <Failure reply={outcome.reply} t={t} />
          )}
        </div>
      )}
    </section>
  );
}
