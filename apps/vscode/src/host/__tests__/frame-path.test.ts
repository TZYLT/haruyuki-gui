/**
 * The host-side replay point: exactly one announcement per return to visibility.
 *
 * A fake panel stands in for the editor's, because the rules under test are about
 * which notifications count, not about the editor. The fake reports `visible` and
 * lets a case fire the listener the way the editor does, including the case that
 * is easy to get wrong: an event that does not cross the boundary.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createFramePath,
  type FramePathOptions,
  type ViewStateEvent,
  type WebviewPanelLike,
} from "../frame-path.js";

/** The version facts a composition root would supply. */
const OPTIONS: FramePathOptions = {
  appVersion: "1.0.0",
  bridgeVersion: "1",
  frameProtocolVersion: 1,
};

/** A panel that records what was posted and lets a case fire its event. */
interface FakePanel extends WebviewPanelLike {
  readonly posted: unknown[];
  /** Fire one view-state notification, as the editor would. */
  fire(visible: boolean): void;
  /** How many listeners are attached right now. */
  readonly attached: number;
}

/**
 * @param visible whether the panel starts visible
 * @returns a panel whose listener a case can fire
 */
function createPanel(visible = true): FakePanel {
  const posted: unknown[] = [];
  const listeners = new Set<(event: ViewStateEvent) => void>();
  const panel = {
    visible,
    posted,
    webview: {
      postMessage(message: unknown): void {
        posted.push(message);
      },
    },
    onDidChangeViewState(listener: (event: ViewStateEvent) => void): { dispose(): void } {
      listeners.add(listener);

      return {
        dispose(): void {
          listeners.delete(listener);
        },
      };
    },
    fire(next: boolean): void {
      panel.visible = next;

      for (const listener of [...listeners]) listener({ webviewPanel: { visible: next } });
    },
    get attached(): number {
      return listeners.size;
    },
  };

  return panel;
}

describe("host frame path", () => {
  it("replays exactly once per hidden-to-visible transition", () => {
    const panel = createPanel(true);
    const path = createFramePath(panel, OPTIONS);

    expect(path.announce()).toBe(true);
    expect(panel.posted).toEqual([{ kind: "boot", ...OPTIONS }]);

    // Hide, show, hide, show: two returns, so two replays and nothing else.
    panel.fire(false);
    expect(path.replayed).toBe(0);

    panel.fire(true);
    expect(path.replayed).toBe(1);

    panel.fire(false);
    panel.fire(true);
    expect(path.replayed).toBe(2);

    // Three announcements in total: the initial one plus the two replays. One
    // per transition, not one per event and never a burst.
    expect(panel.posted).toHaveLength(3);

    path.dispose();
  });

  it("sends nothing for an event that does not cross the boundary", () => {
    const panel = createPanel(true);
    const log = vi.fn();
    const path = createFramePath(panel, { ...OPTIONS, log });

    path.announce();
    panel.posted.length = 1;

    // An active-tab change inside the same group reports `visible: true` while
    // the panel never went away. Treating that as a return would replay once per
    // focus change, which is the failure this rule exists to prevent.
    panel.fire(true);
    panel.fire(true);

    expect(path.replayed).toBe(0);
    expect(panel.posted).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();

    path.dispose();
  });

  it("keeps the last observed visibility when the panel is already hidden", () => {
    const panel = createPanel(false);
    const path = createFramePath(panel, OPTIONS);

    // A panel created hidden never sent a boot: nothing could read one yet.
    expect(path.visible).toBe(false);

    panel.fire(true);
    expect(path.replayed).toBe(1);
    expect(panel.posted).toEqual([{ kind: "boot", ...OPTIONS }]);

    path.dispose();
  });

  it("stops replaying after dispose", () => {
    const panel = createPanel(true);
    const path = createFramePath(panel, OPTIONS);

    expect(panel.attached).toBe(1);

    path.dispose();
    expect(panel.attached).toBe(0);

    // Disposing twice is safe, and a panel that outlives this module must not be
    // able to reach a handle that is gone.
    path.dispose();

    panel.fire(false);

    expect(path.replayed).toBe(0);
    expect(panel.posted).toEqual([]);
  });

  it("counts a refused post instead of retrying it", () => {
    const panel = createPanel(true);
    const log = vi.fn();
    const path = createFramePath(
      {
        ...panel,
        webview: {
          postMessage(): unknown {
            throw new Error("disposed");
          },
        },
      },
      { ...OPTIONS, log },
    );

    expect(path.announce()).toBe(false);

    panel.fire(false);
    panel.fire(true);

    // One attempt for the transition, no retry loop: a second boot for one
    // transition is worse than a missing one.
    expect(path.replayed).toBe(1);
    expect(log.mock.calls.map(([code]) => code)).toEqual([
      "HOST_BOOT_POST_FAILED",
      "HOST_BOOT_POST_FAILED",
      "HOST_BOOT_REPLAY_FAILED",
    ]);

    path.dispose();
  });
});
