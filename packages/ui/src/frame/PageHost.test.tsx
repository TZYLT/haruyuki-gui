// @vitest-environment jsdom
/**
 * The page host seam.
 *
 * Two behaviours belong to this file rather than to the dock: an unregistered
 * page hides instead of closing (the document has to keep it), and a page that
 * throws is retried by remounting it with the same props.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";

import { LocaleProvider } from "../i18n/index.js";

import { createActivityStore } from "./activity.js";
import { FrameHostProvider, type FrameHost } from "./host-context.js";
import { PageHost, type PagePanelParams } from "./PageHost.js";
import { createPageRegistry } from "./registry.js";
import type { PageInstanceProps } from "./types.js";

/** @param registry the pages to serve @returns a host whose verbs are spies */
function hostOf(registry: ReturnType<typeof createPageRegistry>): FrameHost {
  return {
    registry,
    activity: createActivityStore(),
    layoutRevision: 4,
    openPage: vi.fn(() => "opened"),
    closeTab: vi.fn(),
    hideTab: vi.fn(),
  };
}

/** @param pageId the panel's page @param id the tab id @returns fake panel props */
function panelProps(
  pageId: string,
  id: string,
): { props: IDockviewPanelProps<PagePanelParams>; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();

  return {
    close,
    props: {
      api: {
        id,
        isVisible: true,
        isActive: true,
        setTitle: vi.fn(),
        close,
        setActive: vi.fn(),
      },
      params: { pageId },
    } as unknown as IDockviewPanelProps<PagePanelParams>,
  };
}

/** @param ui the host tree @param host the frame host to provide */
function mount(ui: ReactElement, host: FrameHost): void {
  render(
    <LocaleProvider locale="en">
      <FrameHostProvider value={host}>{ui}</FrameHostProvider>
    </LocaleProvider>,
  );
}

describe("PageHost", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // React reports a caught render error to the window as a recoverable one;
    // swallowing it keeps the test run clean without hiding the catch itself.
    vi.spyOn(window, "reportError").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.restoreAllMocks();
  });

  it("hides an unknown page instead of closing it", () => {
    const registry = createPageRegistry();
    const host = hostOf(registry);
    const { props, close } = panelProps("mystery", "mystery-1");

    mount(<PageHost {...props} />, host);

    screen.getByRole("button", { name: "Close (hide only)" }).click();

    expect(host.hideTab).toHaveBeenCalledWith("mystery-1");
    expect(close).not.toHaveBeenCalled();
  });

  it("retries a crashed page by remounting it with the same props", async () => {
    const registry = createPageRegistry();
    const seen: PageInstanceProps[] = [];
    let broken = true;

    const Boom = (props: PageInstanceProps): ReactElement => {
      seen.push(props);

      if (broken) throw new Error("boom");

      return <p data-testid="recovered">recovered</p>;
    };

    registry.register({
      id: "boom",
      titleKey: "page.frame.picker.main",
      icon: "warning",
      zone: "main",
      minWidth: 480,
      component: Boom,
    });

    const host = hostOf(registry);
    const { props } = panelProps("boom", "boom-1");

    mount(<PageHost {...props} />, host);
    expect(screen.getByRole("alert").textContent).toContain("This page stopped working");

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByTestId("recovered")).toBeTruthy());

    const last = seen.at(-1);

    expect(last?.instanceId).toBe("boom-1");
    expect(last?.pageId).toBe("boom");
    expect(last?.layoutRevision).toBe(4);
    expect(last?.params).toEqual(seen[0]?.params);
  });
});
