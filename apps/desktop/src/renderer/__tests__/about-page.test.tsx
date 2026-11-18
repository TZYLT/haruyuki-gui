/**
 * The about page: what it shows for each of the five update results.
 *
 * The assertions quote the catalogue, because the value of this page is the
 * wording: three of the five results mean "I do not know", and a page that
 * showed any of them as "up to date" would be the one failure the feature
 * cannot afford. So the tests check that the five are five distinct sentences,
 * and that the three uncertain ones never borrow the up-to-date one.
 *
 * The bridge is a fake with the one member the page uses. There is no Electron
 * and no network here, which is also the property the page claims: everything it
 * shows arrives on a channel that reads the installation.
 */

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider, en } from "@haruyuki/ui";

import { AboutPage } from "../about-page.js";

/** The three channels under test, spelled out so a rename is a visible change. */
const INFO_CHANNEL = "bridge:control.about.info";
const OPEN_CHANNEL = "bridge:control.about.open";
const UPDATE_CHANNEL = "bridge:control.update.check";

/** The installation facts the fake answers with. */
const FACTS = {
  appVersion: "0.1.0",
  engine: { version: "0.6.0", source: "bundled", lastResult: "ok" },
  runtime: { electron: "45.3.2", node: "24.22.3", platform: "win32", arch: "x64" },
  repoUrl: "https://github.com/TZYLT/haruyuki-gui",
  issueUrl: "https://github.com/TZYLT/haruyuki-gui/issues",
};

/** A bridge that answers a scripted value per channel. */
interface FakeBridge {
  invoke: ReturnType<typeof vi.fn>;
}

/**
 * Install a bridge on the window.
 *
 * @param answers what each channel resolves to, keyed by channel name
 */
function installBridge(answers: Record<string, unknown>): FakeBridge {
  const invoke = vi.fn((channel: string) => {
    const answer = answers[channel];

    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });

  (window as unknown as { haruyuki?: FakeBridge }).haruyuki = { invoke };

  return { invoke };
}

/** Render the page in English, the catalogue the assertions quote. */
function renderPage(): void {
  render(
    <LocaleProvider locale="en">
      <AboutPage />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { haruyuki?: FakeBridge }).haruyuki;
});

describe("the installation facts", () => {
  it("shows the five sections the window promises", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: { state: "up-to-date", current: "0.1.0" },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("0.1.0")).toBeDefined();
    });

    expect(screen.getByText("0.6.0")).toBeDefined();
    expect(screen.getByText(en["common.about.sourceBundled"])).toBeDefined();
    expect(screen.getByText(en["common.about.lastResultOk"])).toBeDefined();
    expect(screen.getByText(en["common.about.licenseLine"])).toBeDefined();
    expect(screen.getByText("win32")).toBeDefined();
    expect(screen.getByText("x64")).toBeDefined();
    expect(screen.getByText("45.3.2")).toBeDefined();
  });

  it("shows the repository and the issue entry as links", async () => {
    installBridge({ [INFO_CHANNEL]: FACTS });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(FACTS.repoUrl)).toBeDefined();
    });

    expect(screen.getByText(FACTS.repoUrl).getAttribute("href")).toBe(FACTS.repoUrl);
    expect(screen.getByText(FACTS.issueUrl).getAttribute("href")).toBe(FACTS.issueUrl);
  });

  it("says so, rather than going blank, when the bridge did not load", async () => {
    delete (window as unknown as { haruyuki?: FakeBridge }).haruyuki;

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(en["common.about.bridgeUnavailable"])).toBeDefined();
    });
  });
});

describe("the three legal entries", () => {
  it("sends the document name each button names", async () => {
    const bridge = installBridge({ [INFO_CHANNEL]: FACTS, [OPEN_CHANNEL]: { ok: true } });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(en["common.about.openLicense"])).toBeDefined();
    });

    await userEvent.click(screen.getByText(en["common.about.openLicense"]));
    await userEvent.click(screen.getByText(en["common.about.openNotice"]));
    await userEvent.click(screen.getByText(en["common.about.openThirdParty"]));

    const opened = bridge.invoke.mock.calls
      .filter((call) => call[0] === OPEN_CHANNEL)
      .map((call) => (call[1] as { doc: string }).doc);

    expect(opened).toEqual(["license", "notice", "third-party"]);
  });

  it("shows the reason when a document could not be opened", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [OPEN_CHANNEL]: { ok: false, detail: "NOTICE is not in the package" },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(en["common.about.openNotice"])).toBeDefined();
    });

    await userEvent.click(screen.getByText(en["common.about.openNotice"]));

    await waitFor(() => {
      // The detail is interpolated into a sentence this catalogue owns, so the
      // path is visible without being a paragraph of raw English.
      expect(screen.getByText(/NOTICE is not in the package/)).toBeDefined();
    });
  });
});

describe("the five update results", () => {
  it("shows the checking state before the answer arrives", async () => {
    installBridge({ [INFO_CHANNEL]: FACTS });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    // Never resolves, so the page stays in the in-progress state.
    (window as unknown as { haruyuki: FakeBridge }).haruyuki.invoke = vi.fn((channel: string) =>
      channel === UPDATE_CHANNEL ? new Promise(() => undefined) : Promise.resolve(FACTS),
    );

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByTestId("about-update-checking")).toBeDefined();
    });
  });

  it("offers the download page when a newer version exists", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: {
        state: "available",
        current: "0.1.0",
        latest: "0.2.0",
        pageUrl: "https://github.com/TZYLT/haruyuki-gui/releases/latest",
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText("Version v0.2.0 is available (current v0.1.0)")).toBeDefined();
    });

    // The button is an anchor, so the window's own open handler turns it into a
    // browser tab: no second channel, and no scheme the page can choose.
    expect(screen.getByText(en["common.about.update.openPage"]).getAttribute("href")).toBe(
      "https://github.com/TZYLT/haruyuki-gui/releases/latest",
    );
  });

  it("says up to date only when the check concluded that", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: { state: "up-to-date", current: "0.1.0" },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText("You are up to date (v0.1.0)")).toBeDefined();
    });
  });

  it("shows the exhausted quota as its own result, with the hint line", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: { state: "failed", reason: "rate-limit" },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText(en["common.about.update.failedRateLimit"])).toBeDefined();
    });

    expect(screen.getByText(en["common.about.update.rateLimitHint"])).toBeDefined();
    // The one failure this feature cannot afford: an unknown answer rendered
    // as a conclusion.
    expect(screen.queryByTestId("about-update-up-to-date")).toBeNull();
  });

  it("shows an unreachable GitHub as its own result, with the ASCII detail", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: {
        state: "failed",
        reason: "network",
        detail: "getaddrinfo ENOTFOUND api.github.com",
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText(en["common.about.update.failedNetwork"])).toBeDefined();
    });

    expect(screen.getByText("getaddrinfo ENOTFOUND api.github.com")).toBeDefined();
    expect(screen.queryByTestId("about-update-up-to-date")).toBeNull();
  });

  it("tells a never-released repository apart from a failed check", async () => {
    installBridge({
      [INFO_CHANNEL]: FACTS,
      [UPDATE_CHANNEL]: { state: "failed", reason: "no-release" },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText(en["common.about.update.noRelease"])).toBeDefined();
    });

    // Not an error: the requirement is explicit that this is a normal state.
    expect(screen.queryByText(en["common.about.update.failedNetwork"])).toBeNull();
    expect(screen.queryByText(en["common.about.update.failedRateLimit"])).toBeNull();
  });

  it("never turns an unreadable answer into up to date", async () => {
    installBridge({ [INFO_CHANNEL]: FACTS, [UPDATE_CHANNEL]: { state: "something-else" } });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("about-check-update")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("about-check-update"));

    await waitFor(() => {
      expect(screen.getByText(en["common.about.update.failedNetwork"])).toBeDefined();
    });

    expect(screen.queryByTestId("about-update-up-to-date")).toBeNull();
  });

  it("keeps the five results five distinct sentences", () => {
    // The catalogue half of the same claim: a copy edit that made two of them
    // equal would satisfy every per-state test above and still fail the
    // requirement.
    const sentences = [
      en["common.about.update.available"],
      en["common.about.update.upToDate"],
      en["common.about.update.failedRateLimit"],
      en["common.about.update.failedNetwork"],
      en["common.about.update.noRelease"],
    ];

    expect(new Set(sentences).size).toBe(sentences.length);
    expect(en["common.about.update.rateLimitHint"]).not.toBe(en["common.about.update.upToDate"]);
  });
});
