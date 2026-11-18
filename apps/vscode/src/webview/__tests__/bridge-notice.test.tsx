/** @vitest-environment jsdom */
/**
 * What the panel shows when the host speaks another bridge version.
 *
 * The version guard has two halves and they are proven separately: the bridge
 * test shows that a mismatch stops sending, and this one shows that the stop is
 * visible. A guard the user cannot see is indistinguishable from a panel that
 * silently does nothing, which is the failure this pair exists to rule out.
 *
 * The message itself comes from the catalogue rather than from a literal here,
 * so this test asserts that the notice names the code and that the frame renders
 * it -- not how the sentence is worded.
 */

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleProvider } from "@haruyuki/ui";

import { BRIDGE_VERSION_MISMATCH, resetWebviewApi } from "../bridge.js";
import { useBridgeNotice, webviewTransport } from "../transport.js";

/** The bridge version a host this panel cannot read would announce. */
const OTHER_VERSION = "999";

/** A component that renders exactly what the shell renders for a guard. */
function BridgeNotice(): ReactElement | null {
  const notice = useBridgeNotice();

  if (notice === undefined) return null;

  return <p data-testid="shown">{notice.message}</p>;
}

afterEach(() => {
  resetWebviewApi();
});

describe("bridge version guard notice", () => {
  it("stops the panel and shows the mismatch once the host disagrees", () => {
    const transport = webviewTransport();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "boot",
          appVersion: "1.0.0",
          bridgeVersion: OTHER_VERSION,
          frameProtocolVersion: 1,
        },
      }),
    );

    const snapshot = transport.bridge.snapshot();

    expect(snapshot.state).toBe("rejected");
    expect(snapshot.code).toBe(BRIDGE_VERSION_MISMATCH);
    expect(snapshot.versions?.actual).toBe(OTHER_VERSION);

    render(
      <LocaleProvider locale="en">
        <BridgeNotice />
      </LocaleProvider>,
    );

    // The one visible consequence of the stop: a notice naming the code, and
    // nothing else in the panel pretending to work.
    expect(screen.getByTestId("shown").textContent).toContain(BRIDGE_VERSION_MISMATCH);

    transport.dispose();
  });
});
