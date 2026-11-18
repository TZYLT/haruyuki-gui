/**
 * The panel host: one panel, one document, one frame path.
 *
 * The editor is doubled, not launched. Four API members are all this module can
 * observe -- `Uri.joinPath`, `ViewColumn`, `window.createWebviewPanel` and the
 * panel it returns -- so a recording double is the whole fixture, and each case
 * can assert what the editor would have seen.
 *
 * Two claims this file exists for. One panel: `open` twice must create once and
 * reveal once, or the second call either shows two docks or replaces a live
 * document nobody released. And the retained context: the option has to be `true`
 * at the creation site, because the editor reads it once and cannot be told
 * later -- a panel that is rebuilt on every tab switch is a reload the user sees.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/** One recorded call into the editor's API. */
interface Recorded {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** One created panel, with the counters a case asserts on. */
interface FakePanel {
  readonly options: Record<string, unknown>;
  readonly webview: {
    readonly cspSource: string;
    html: string;
    postMessage(message: unknown): void;
    asWebviewUri(uri: UriLike): UriLike;
    onDidReceiveMessage(listener: (raw: unknown) => void): { dispose(): void };
  };
  readonly revealed: number;
  readonly disposeCalls: number;
  /** How many view-state listeners are attached right now. */
  readonly viewStateListeners: number;
  /** How many document-message listeners are attached right now. */
  readonly messageListeners: number;
  /** Post a message as the document would, through the installed subscription. */
  fireMessage(raw: unknown): void;
  /** Fire a visibility change, as switching tabs would. */
  fireViewState(visible: boolean): void;
  /** Fire the disposal listener, as the user closing the tab would. */
  fireDispose(): void;
}

/** As much of a `Uri` as this module and its double read. */
interface UriLike {
  fsPath: string;
  toString(): string;
}

/** The editor side this test installs in place of `vscode`. */
const editor = {
  calls: [] as Recorded[],
  panels: [] as FakePanel[],

  reset(): void {
    editor.calls.length = 0;
    editor.panels.length = 0;
  },
};

/** The extension root a host is created against. */
const EXTENSION_ROOT = "/extension";

vi.mock("vscode", () => {
  /**
   * @param value a posix path this double uses as the URI's whole identity
   * @returns a URI with the two members the host reads
   */
  function makeUri(value: string): UriLike {
    return { fsPath: value, toString: () => `file://${value}` };
  }

  return {
    Uri: {
      joinPath(base: UriLike, ...segments: string[]): UriLike {
        editor.calls.push({ member: "Uri.joinPath", args: [base, ...segments] });

        return makeUri(`${base.fsPath}/${segments.join("/")}`);
      },
    },
    ViewColumn: { Active: -1, One: 1 },
    window: {
      createWebviewPanel(
        viewType: string,
        title: string,
        showOptions: unknown,
        options: Record<string, unknown>,
      ): FakePanel {
        editor.calls.push({
          member: "createWebviewPanel",
          args: [viewType, title, showOptions, options],
        });

        const listeners = new Set<() => void>();
        const viewStateListeners = new Set<
          (event: { webviewPanel: { visible: boolean } }) => void
        >();
        // The document's own messages: `ready`, `command.invoke`, `terminal.ack`
        // and `action`. A panel with no listener here is a panel that opens and
        // then answers nothing, which looks exactly like a blank document.
        const messageListeners = new Set<(raw: unknown) => void>();
        const index = editor.panels.length + 1;

        let html = "";
        let revealed = 0;
        let disposeCalls = 0;
        let visible = true;

        const panel: FakePanel = {
          options,
          webview: {
            // A per-instance origin, which is the reason this cannot be a
            // constant: another panel's origin would be refused by this policy.
            cspSource: `https://panel${String(index)}.vscode-cdn.net`,
            get html(): string {
              return html;
            },
            set html(next: string) {
              html = next;
            },
            postMessage(): void {
              editor.calls.push({ member: "postMessage", args: [index] });
            },
            asWebviewUri(uri: UriLike): UriLike {
              editor.calls.push({ member: "asWebviewUri", args: [uri] });

              const origin = `https://panel${String(index)}.vscode-cdn.net`;
              const served = `${origin}${uri.fsPath.replace(EXTENSION_ROOT, "")}`;

              return { fsPath: served, toString: () => served };
            },
            onDidReceiveMessage(listener: (raw: unknown) => void): { dispose(): void } {
              editor.calls.push({ member: "onDidReceiveMessage", args: [index] });
              messageListeners.add(listener);

              return {
                dispose(): void {
                  messageListeners.delete(listener);
                },
              };
            },
          },
          get revealed(): number {
            return revealed;
          },
          get disposeCalls(): number {
            return disposeCalls;
          },
          get viewStateListeners(): number {
            return viewStateListeners.size;
          },
          get messageListeners(): number {
            return messageListeners.size;
          },
          fireMessage(raw: unknown): void {
            for (const listener of [...messageListeners]) listener(raw);
          },
          fireViewState(next: boolean): void {
            visible = next;

            for (const listener of [...viewStateListeners]) {
              listener({ webviewPanel: { visible: next } });
            }
          },
          fireDispose(): void {
            for (const listener of [...listeners]) listener();
          },
        };

        // The members the host drives, kept off the assertion surface so a case
        // reads counters rather than the calls it would have to reconstruct.
        const drivable = {
          ...panel,
          reveal(): void {
            editor.calls.push({ member: "reveal", args: [index] });

            revealed += 1;
          },
          dispose(): void {
            editor.calls.push({ member: "dispose", args: [index] });

            disposeCalls += 1;
            panel.fireDispose();
          },
          onDidDispose(listener: () => void): { dispose(): void } {
            listeners.add(listener);

            return {
              dispose(): void {
                listeners.delete(listener);
              },
            };
          },
          onDidChangeViewState(listener: (event: { webviewPanel: { visible: boolean } }) => void): {
            dispose(): void;
          } {
            viewStateListeners.add(listener);

            return {
              dispose(): void {
                viewStateListeners.delete(listener);
              },
            };
          },
          get visible(): boolean {
            return visible;
          },
        };

        editor.panels.push(panel);

        return drivable as unknown as FakePanel;
      },
    },
  };
});

import { createPanelHost, PANEL_TITLE, PANEL_VIEW_TYPE, type PanelLink } from "../panel.js";

/**
 * Build a host with a template that needs no build tree.
 *
 * @param language the editor's language tag
 * @param link the two directions the assembly would hand over, when a case is
 *   about them
 * @returns the host and the sink it logs into
 */
function createHost(
  language = "zh-cn",
  link?: (panel: { readonly webview: unknown }) => PanelLink,
): { readonly host: ReturnType<typeof createPanelHost>; readonly lines: string[] } {
  const lines: string[] = [];

  const host = createPanelHost({
    extensionUri: { fsPath: EXTENSION_ROOT } as never,
    language,
    log: (code) => lines.push(code),
    // The real template is read from the installed extension; a test supplies
    // the shape the bundler writes so it needs no build of its own.
    readTemplate: () =>
      '<html><head></head><body><div id="root"></div>' +
      '<script type="module" src="./assets/index-x.js"></script></body></html>',
    ...(link === undefined ? {} : { createLink: link }),
  });

  return { host, lines };
}

/** The options each `createWebviewPanel` call received. */
function createdOptions(): Record<string, unknown>[] {
  return editor.calls
    .filter((call) => call.member === "createWebviewPanel")
    .map((call) => call.args[3] as Record<string, unknown>);
}

describe("panel host", () => {
  beforeEach(() => {
    editor.reset();
  });

  it("creates exactly one panel however often it is opened", () => {
    const { host } = createHost();

    host.open();
    host.open();
    host.open();

    // One creation and two reveals: the second and third opens reach the dock
    // that is already showing rather than a second one.
    expect(editor.panels).toHaveLength(1);
    expect(editor.panels[0]?.revealed).toBe(2);
  });

  it("registers the panel under the id the package declares", () => {
    createHost().host.open();

    const created = editor.calls.find((call) => call.member === "createWebviewPanel");

    expect(created?.args[0]).toBe(PANEL_VIEW_TYPE);
    expect(created?.args[1]).toBe(PANEL_TITLE);
  });

  it("retains the webview context at the creation site", () => {
    createHost().host.open();

    // The editor reads this once, when it creates the panel; there is no later
    // call that could turn it on, so the assertion has to be about that object.
    expect(createdOptions()[0]?.["retainContextWhenHidden"]).toBe(true);
    expect(createdOptions()[0]?.["enableScripts"]).toBe(true);
  });

  it("declares the retained context where the panel is created", () => {
    // The same claim read from the source rather than from the call: a reviewer
    // checking the creation site greps for the option, and there must be exactly
    // one place it is written -- the one that creates the panel.
    const source = readFileSync(path.join(import.meta.dirname, "..", "panel.ts"), "utf8");

    expect(source.match(/retainContextWhenHidden:\s*true/g)).toHaveLength(1);

    const created = source.indexOf("createWebviewPanel(");
    const option = source.indexOf("retainContextWhenHidden");

    expect(created).toBeGreaterThan(-1);
    expect(option).toBeGreaterThan(created);
    // Within the options object of that call, not somewhere later in the file.
    expect(source.slice(created, option)).not.toContain("});");
  });

  it("lets the panel read only its own two directories", () => {
    createHost().host.open();

    const roots = createdOptions()[0]?.["localResourceRoots"] as UriLike[];

    expect(roots.map((root) => root.fsPath)).toEqual([
      `${EXTENSION_ROOT}/dist/webview`,
      `${EXTENSION_ROOT}/media`,
    ]);
  });

  it("fills the document through the panel's own origin", () => {
    createHost().host.open();

    const html = editor.panels[0]?.webview.html ?? "";

    expect(html).toContain('id="root"');
    expect(html).toContain("script-src https://panel1.vscode-cdn.net");
    expect(html).toContain('src="https://panel1.vscode-cdn.net/dist/webview/assets/index-x.js"');
    expect(html).not.toContain("file://");
  });

  it("carries the editor's language into the document", () => {
    createHost("ja").host.open();

    expect(editor.panels[0]?.webview.html).toContain('data-locale="ja"');
  });

  it("replaces the panel after it has been closed", () => {
    const { host } = createHost();

    host.open();
    editor.panels[0]?.fireDispose();

    host.open();

    // A disposed panel cannot be revealed; the handle is cleared by the same
    // event the editor fires, so the next open builds a new document.
    expect(editor.panels).toHaveLength(2);
    expect(editor.panels[1]?.revealed).toBe(0);
  });

  it("disposes the panel once, however often it is closed", async () => {
    const { host } = createHost();

    host.open();

    const panel = editor.panels[0];

    await host.close();
    await host.close();

    // A second close must not throw on a panel that is already gone: a window
    // that never opened one still reaches this path.
    expect(panel?.disposeCalls).toBe(1);
  });

  it("is a no-op to close before anything was opened", async () => {
    const { host, lines } = createHost();

    await expect(host.close()).resolves.toBeUndefined();

    expect(editor.panels).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it("reports the lifecycle so a support request can name the step", () => {
    const { host, lines } = createHost();

    host.open();
    host.open();

    // Only this module's own codes; a frame-path code would mean the replay
    // point was constructed against something it could not subscribe to.
    expect(lines).toEqual(["PANEL_OPENED", "PANEL_REVEALED"]);
  });

  it("announces the protocol versions once, when the panel appears", () => {
    createHost().host.open();

    // One announcement on creation: the document needs the versions to build its
    // receiver, and the visibility edge that replays them is a separate event.
    expect(editor.calls.filter((call) => call.member === "postMessage")).toHaveLength(1);
  });

  it("subscribes the frame path to the panel's visibility, and drops it on close", async () => {
    const { host } = createHost();

    host.open();

    const panel = editor.panels[0];

    // The edge is what puts the panel back in sync after a return to the tab, so
    // it must be subscribed while the panel lives and not afterwards.
    expect(panel?.viewStateListeners).toBe(1);

    await host.close();

    expect(panel?.viewStateListeners).toBe(0);
  });

  it("replays the announcement once per return to visibility", () => {
    const { host } = createHost();

    host.open();

    const panel = editor.panels[0];
    const posts = (): number => editor.calls.filter((call) => call.member === "postMessage").length;

    panel?.fireViewState(false);

    // Going away is not an announcement: nothing is buffered and nothing is sent.
    expect(posts()).toBe(1);

    panel?.fireViewState(true);

    expect(posts()).toBe(2);

    // An active-tab change inside the same group reports the event without
    // crossing the boundary, so it must not produce a third announcement.
    panel?.fireViewState(true);

    expect(posts()).toBe(2);
  });
});

describe("panel host: the document's messages", () => {
  beforeEach(() => {
    editor.reset();
  });

  /**
   * Record what the host handed to the link, so a case can assert the direction
   * really exists rather than that a call was made.
   *
   * @returns the recorder and the factory to hand over
   */
  function recorder(): {
    readonly received: unknown[];
    readonly disposed: number;
    readonly factory: (panel: { readonly webview: unknown }) => PanelLink;
  } {
    const received: unknown[] = [];
    const counter = { disposed: 0 };

    return {
      received,
      get disposed(): number {
        return counter.disposed;
      },
      factory: () => ({
        receive(raw: unknown): void {
          received.push(raw);
        },
        dispose(): void {
          counter.disposed += 1;
        },
      }),
    };
  }

  it("installs the one subscription the document's messages arrive through", () => {
    const sink = recorder();

    createHost("zh-cn", sink.factory).host.open();

    // Without this subscription the editor has nowhere to deliver `ready`,
    // `command.invoke`, `terminal.ack` or `action`, and the panel opens and then
    // answers nothing -- which is exactly a blank document with no error.
    expect(editor.panels[0]?.messageListeners).toBe(1);
    expect(editor.calls.some((call) => call.member === "onDidReceiveMessage")).toBe(true);
  });

  it("hands every document message to the link, unchanged", () => {
    const sink = recorder();

    createHost("zh-cn", sink.factory).host.open();

    const panel = editor.panels[0];
    const message = { kind: "ready", appVersion: "0.1.0", bridgeVersion: "1" };

    panel?.fireMessage(message);

    // Passed through as it arrived: the host is not a parser of this protocol,
    // and a re-encoded message would be a second authority on its shape.
    expect(sink.received).toEqual([message]);
  });

  it("subscribes before the announcement, so an early ready is not lost", () => {
    const sink = recorder();

    createHost("zh-cn", sink.factory).host.open();

    const subscribed = editor.calls.findIndex((call) => call.member === "onDidReceiveMessage");
    const announced = editor.calls.findIndex((call) => call.member === "postMessage");

    // The document posts `ready` the moment it sees `boot`; a subscription
    // installed afterwards would miss it and the panel would never connect.
    expect(subscribed).toBeGreaterThan(-1);
    expect(announced).toBeGreaterThan(-1);
    expect(subscribed).toBeLessThan(announced);
  });

  it("releases the subscription when the document is closed", async () => {
    const sink = recorder();

    const { host } = createHost("zh-cn", sink.factory);

    host.open();

    const panel = editor.panels[0];

    await host.close();

    expect(panel?.messageListeners).toBe(0);
    expect(sink.disposed).toBe(1);
  });

  it("opens the panel even when the two directions cannot be built", () => {
    const { host, lines } = createHost("zh-cn", () => {
      throw new Error("no core to talk to");
    });

    host.open();

    // A build with no core still shows its document and says what is missing;
    // throwing here would leave a created panel with no handle at all.
    expect(editor.panels).toHaveLength(1);
    expect(editor.panels[0]?.webview.html).toContain('id="root"');
    expect(lines).toContain("PANEL_LINK_FAILED");
  });
});
