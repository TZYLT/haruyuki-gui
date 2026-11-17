/**
 * Tests for the command sample page.
 *
 * The page exists to make the three reply arms visible, so the cases walk the
 * arms one by one and assert what a user would read: the JSON of an answer, the
 * plain acknowledgement of a fire-and-forget command, and one sentence per
 * failure consequence. What is deliberately not asserted is styling - the page
 * owns behaviour, `Button` owns appearance.
 *
 * The client is injected, which is what keeps these tests free of Electron: the
 * page's only contract with the host is `invoke(capability, body)`.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import type { CommandReply } from "@haruyuki/core";
import { LocaleProvider } from "@haruyuki/ui";

import { CommandSample } from "../CommandSample.js";
import type { CommandClient } from "../command.js";

/** One call the page made. */
interface Recorded {
  capability: string;
  body: Record<string, unknown>;
}

/** A client that answers with one fixed reply and records what it was asked. */
function clientReturning(reply: CommandReply): {
  client: CommandClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];

  return {
    calls,
    client: {
      invoke: async (capability, body) => {
        calls.push({ capability, body });
        return reply;
      },
    },
  };
}

/**
 * Wrap the page in the locale provider it reads its sentences from.
 *
 * @param client an injected client, when the case is not about a missing preload
 * @returns the tree to render
 */
function tree(client?: CommandClient): ReactElement {
  const page = client === undefined ? <CommandSample /> : <CommandSample client={client} />;

  return <LocaleProvider locale="en">{page}</LocaleProvider>;
}

describe("CommandSample", () => {
  it("renders an answered device.info reply as JSON", async () => {
    const { client, calls } = clientReturning({
      ok: true,
      completion: "answered",
      data: { backend: "fake", version: "0.9.0" },
    });
    const { container } = render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("Answered")).toBeTruthy();
    expect(calls).toEqual([{ capability: "device.info", body: {} }]);
    expect(container.querySelector("pre")?.textContent).toContain('"backend": "fake"');
  });

  it("renders an accepted reply as sent, with no answer body", async () => {
    const { client } = clientReturning({ ok: true, completion: "accepted" });
    const { container } = render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("Sent to the engine")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("sends terminal.kill with its terminal id and reports it as sent", async () => {
    const { client, calls } = clientReturning({ ok: true, completion: "accepted" });
    render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Kill sample terminal" }));

    expect(await screen.findByText("Sent to the engine")).toBeTruthy();
    expect(calls).toEqual([{ capability: "terminal.kill", body: { terminal_id: "sample" } }]);
  });

  it("shows the engine's own words for a refusal", async () => {
    const { client } = clientReturning({
      ok: false,
      code: "REJECTED",
      detail: "the engine refused the command",
      engineText: "model not available",
    });
    render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("model not available")).toBeTruthy();
    expect(screen.getByText("REJECTED")).toBeTruthy();
  });

  it("maps an unknown or unavailable capability to one sentence", async () => {
    const unknown = clientReturning({
      ok: false,
      code: "COMMAND_UNKNOWN_CAPABILITY",
      detail: "not in the table",
    });
    const first = render(tree(unknown.client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));
    expect(await screen.findByText("This feature is not available")).toBeTruthy();
    expect(screen.getByText("COMMAND_UNKNOWN_CAPABILITY")).toBeTruthy();
    first.unmount();

    const unavailable = clientReturning({
      ok: false,
      code: "COMMAND_CAPABILITY_UNAVAILABLE",
      detail: "not on this runtime",
    });
    render(tree(unavailable.client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));
    expect(await screen.findByText("This feature is not available")).toBeTruthy();
  });

  it("maps a dead channel to the not-connected sentence", async () => {
    for (const code of ["NOT_CONNECTED", "COMMAND_CHANNEL_UNAVAILABLE"] as const) {
      const { client } = clientReturning({ ok: false, code, detail: "no channel" });
      const view = render(tree(client));

      await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

      expect(await screen.findByText("The engine is not connected")).toBeTruthy();
      view.unmount();
    }
  });

  it("maps a missing scope to the scope sentence", async () => {
    const { client } = clientReturning({
      ok: false,
      code: "COMMAND_SCOPE_REQUIRED",
      detail: "no runtime",
    });
    render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("Select a conversation first")).toBeTruthy();
  });

  it("maps an invalid payload to the invalid-request sentence", async () => {
    const { client } = clientReturning({
      ok: false,
      code: "COMMAND_BAD_PAYLOAD",
      detail: "the body carries an envelope key",
    });
    render(tree(client));

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("The request is invalid")).toBeTruthy();
  });

  it("reports an unavailable channel when the preload has no bridge", async () => {
    // No client prop and no `window.haruyuki` in jsdom: the page must say so
    // rather than throw inside the click handler.
    render(tree());

    await userEvent.click(screen.getByRole("button", { name: "Get device info" }));

    expect(await screen.findByText("The engine is not connected")).toBeTruthy();
    expect(screen.getByText("COMMAND_CHANNEL_UNAVAILABLE")).toBeTruthy();
  });

  it("disables both buttons while a command is in flight", async () => {
    let release: ((reply: CommandReply) => void) | undefined;
    const client: CommandClient = {
      invoke: () =>
        new Promise<CommandReply>((resolve) => {
          release = resolve;
        }),
    };
    render(tree(client));

    const deviceButton = screen.getByRole("button", { name: "Get device info" });
    const killButton = screen.getByRole("button", { name: "Kill sample terminal" });

    await userEvent.click(deviceButton);

    expect((deviceButton as HTMLButtonElement).disabled).toBe(true);
    expect((killButton as HTMLButtonElement).disabled).toBe(true);

    release?.({ ok: true, completion: "accepted" });

    expect(await screen.findByText("Sent to the engine")).toBeTruthy();
    expect((deviceButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not call the client more than once per click", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, completion: "accepted" as const }));
    render(tree({ invoke }));

    await userEvent.click(screen.getByRole("button", { name: "Kill sample terminal" }));

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
