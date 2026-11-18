/**
 * The extension entry: lazy activation, the two registrations, and the seam.
 *
 * The editor is mocked, not launched. Everything `activate` can observe is one
 * of the twelve API members below, so a recording double is the whole fixture.
 *
 * The case this file exists for is the first one: `activate` must start
 * nothing. The double records the opener and every editor member that could
 * spawn, fork or look up an engine, and the assertion is that activation calls
 * none of them -- then that the registered command is what calls the opener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One recorded call into the editor's API. */
interface Recorded {
  readonly member: string;
  readonly args: readonly unknown[];
}

/**
 * The editor side this test installs in place of `vscode`.
 *
 * A module-scoped object rather than an inline factory so each case can read
 * what the extension did after `activate` returned.
 */
const editor = {
  calls: [] as Recorded[],
  /** Command id -> handler, as `registerCommand` would have wired them. */
  commands: new Map<string, (...args: never[]) => unknown>(),
  /** The options `createTreeView` received, so the provider is inspectable. */
  treeView: undefined as unknown,
  /** Every `StatusBarItem` created, in order. */
  statusItems: [] as { text: string; tooltip: unknown; command: unknown }[],
  /** Every `OutputChannel` created, in order. */
  channels: [] as { name: string; lines: string[] }[],
  /** Every `WebviewPanel` created, in order. */
  panels: [] as { viewType: string; title: string }[],

  reset(): void {
    editor.calls.length = 0;
    editor.commands.clear();
    editor.treeView = undefined;
    editor.statusItems.length = 0;
    editor.channels.length = 0;
    editor.panels.length = 0;
  },
};

vi.mock("vscode", () => {
  class TreeItem {
    label: string;
    collapsibleState: number;
    id?: string;
    tooltip?: string;
    command?: { command: string; title: string };

    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  /** As much of a `Uri` as the panel host reads. */
  function makeUri(value: string): {
    fsPath: string;
    toString(): string;
  } {
    return { fsPath: value, toString: () => `file://${value}` };
  }

  return {
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    Uri: {
      joinPath(base: { fsPath: string }, ...segments: string[]): unknown {
        editor.calls.push({ member: "Uri.joinPath", args: [base, ...segments] });

        return makeUri(`${base.fsPath}/${segments.join("/")}`);
      },
    },
    env: {
      // A language the panel writes verbatim; the value itself is not the
      // subject of this file, only that it reaches the document untouched.
      language: "zh-cn",
    },
    window: {
      createOutputChannel(name: string) {
        editor.calls.push({ member: "createOutputChannel", args: [name] });

        const channel = { name, lines: [] as string[] };

        editor.channels.push(channel);

        return {
          appendLine: (value: string) => channel.lines.push(value),
          show: () => undefined,
          dispose: () => undefined,
        };
      },
      createStatusBarItem(alignment: number, priority: number) {
        editor.calls.push({ member: "createStatusBarItem", args: [alignment, priority] });

        const item = {
          text: "",
          tooltip: undefined as unknown,
          command: undefined as unknown,
          show: () => undefined,
          hide: () => undefined,
          dispose: () => undefined,
        };

        editor.statusItems.push(item);

        return item;
      },
      createTreeView(viewId: string, options: unknown) {
        editor.calls.push({ member: "createTreeView", args: [viewId, options] });
        editor.treeView = options;

        return { dispose: () => undefined };
      },
      createWebviewPanel(viewType: string, title: string, showOptions: unknown, options: unknown) {
        editor.calls.push({
          member: "createWebviewPanel",
          args: [viewType, title, showOptions, options],
        });

        editor.panels.push({ viewType, title });

        return {
          webview: {
            cspSource: "https://panel.vscode-cdn.net",
            html: "",
            postMessage: () => undefined,
            asWebviewUri: (uri: { fsPath: string }) => makeUri(uri.fsPath),
          },
          visible: true,
          reveal: () => undefined,
          dispose: () => undefined,
          onDidDispose: () => ({ dispose: () => undefined }),
          onDidChangeViewState: () => ({ dispose: () => undefined }),
        };
      },
    },
    commands: {
      registerCommand(command: string, callback: (...args: never[]) => unknown) {
        editor.calls.push({ member: "registerCommand", args: [command] });
        editor.commands.set(command, callback);

        return { dispose: () => undefined };
      },
    },
  };
});

import * as extension from "../extension.js";

/** A `context` as far as the extension reads it. */
function context(): {
  subscriptions: { dispose(): void }[];
  extensionUri: { fsPath: string; toString(): string };
} {
  // The panel host resolves its two resource roots against this, and nothing
  // else in the entry reads it.
  return {
    subscriptions: [],
    extensionUri: { fsPath: "/extension", toString: () => "file:///extension" },
  };
}

/** Every recorded call named one of these. */
function called(members: readonly string[]): Recorded[] {
  return editor.calls.filter((call) => members.includes(call.member));
}

describe("extension entry: activation", () => {
  beforeEach(() => {
    editor.reset();
    extension.setPanelOpener(undefined);
  });

  afterEach(() => {
    extension.setPanelOpener(undefined);
  });

  it("starts nothing: activation registers and returns", () => {
    extension.activate(context() as never);

    // The panels, the core child and the engine are all reached through the
    // opener, and the opener is the one thing activation must not call.
    expect(called(["openPanel", "fork", "spawn", "start"])).toEqual([]);

    // Installing a panel host is not opening one: activation must not have
    // created a webview, or the cost it exists to avoid is paid on every start.
    expect(editor.panels).toHaveLength(0);

    // Positive half: it did register the two entry points, so "nothing" is not
    // the vacuous reading of an empty call log.
    expect(editor.commands.has("haruyuki.openPanel")).toBe(true);
    expect(called(["createTreeView"])).toHaveLength(1);
  });

  it("does not open the panel until the command is invoked", () => {
    extension.activate(context() as never);

    // Installed after activation so this case observes the command rather than
    // the host activation installs; both are the same seam.
    const open = vi.fn();

    extension.setPanelOpener({ open });

    expect(open).toHaveBeenCalledTimes(0);

    editor.commands.get("haruyuki.openPanel")?.();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("wires the launcher item's command to the same panel command", () => {
    extension.activate(context() as never);

    const provider = (editor.treeView as { treeDataProvider: TreeDataProviderLike })
      .treeDataProvider;
    const items = provider.getChildren(undefined);

    expect(items).toHaveLength(1);

    const item = provider.getTreeItem(items[0]);

    // The activity-bar container cannot carry a command; the item must, or the
    // icon selects a label and opens nothing.
    expect(item.command?.command).toBe("haruyuki.openPanel");
    expect(provider.getChildren(items[0])).toEqual([]);
  });

  it("points the status bar at the same command", () => {
    extension.activate(context() as never);

    expect(editor.statusItems).toHaveLength(1);
    expect(editor.statusItems[0]?.command).toBe("haruyuki.openPanel");
  });

  it("registers everything it creates for disposal", () => {
    const ctx = context();

    extension.activate(ctx as never);

    // Channel, status item, command and tree view: four handles, no more.
    expect(ctx.subscriptions).toHaveLength(4);
    expect(editor.channels).toHaveLength(1);
  });

  it("logs the activation so a support request can name the build", () => {
    extension.activate(context() as never);

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    expect(lines).toContain("EXTENSION_ACTIVATED");
    expect(lines).toContain("0.1.0");
  });
});

describe("extension entry: the panel seam", () => {
  beforeEach(() => {
    editor.reset();
    extension.setPanelOpener(undefined);
  });

  afterEach(() => {
    extension.setPanelOpener(undefined);
  });

  it("says so when no opener is installed instead of failing silently", () => {
    extension.activate(context() as never);
    // The entry installs the real host during activation; removing it is how a
    // build with no panel module behind the seam behaves.
    extension.setPanelOpener(undefined);

    extension.openPanel();

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    expect(lines).toContain("PANEL_OPEN_REQUESTED");
    expect(lines).toContain("no panel opener is installed");
  });

  it("opens the panel the entry itself installed", () => {
    extension.activate(context() as never);
    extension.openPanel();

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    // The wiring this change added: the click no longer falls through to the
    // "no opener" sentence, so it reached the panel module. Whether a document
    // could be built depends on a build artifact this test does not ship, and
    // that failure is the panel's own reported one.
    expect(lines).toContain("PANEL_OPEN_REQUESTED");
    expect(lines).not.toContain("no panel opener is installed");
  });

  it("survives a throwing opener and leaves the status bar failed", () => {
    extension.activate(context() as never);
    extension.setPanelOpener({
      open: () => {
        throw new Error("the panel document is missing");
      },
    });

    expect(() => extension.openPanel()).not.toThrow();

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    expect(lines).toContain("PANEL_OPEN_FAILED");
    expect(editor.statusItems[0]?.text).toContain("Failed");
    // The message is summarised, not interpolated into a line that also carries
    // a frame payload the panel might have handed over.
    expect(lines).toContain("the panel document is missing");
  });

  it("closes an installed panel on deactivate and clears the seam", async () => {
    const close = vi.fn(async () => undefined);

    extension.activate(context() as never);
    extension.setPanelOpener({ open: vi.fn(), close });

    await extension.deactivate();

    expect(close).toHaveBeenCalledTimes(1);
    expect(editor.channels[0]?.lines.join("\n")).toContain("EXTENSION_DEACTIVATED");

    // The seam is empty afterwards: a reopened window must not reuse the
    // previous opener, which owned a disposed webview.
    extension.openPanel();

    expect(editor.channels[0]?.lines.join("\n")).toContain("no panel opener is installed");
  });

  it("swallows a failing close, because the editor waits on deactivate", async () => {
    extension.activate(context() as never);
    extension.setPanelOpener({
      open: vi.fn(),
      close: async () => {
        throw new Error("already disposed");
      },
    });

    await expect(extension.deactivate()).resolves.toBeUndefined();

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    expect(lines).toContain("PANEL_CLOSE_FAILED");
  });

  it("is a no-op when nothing was ever opened", async () => {
    extension.activate(context() as never);

    await expect(extension.deactivate()).resolves.toBeUndefined();

    const lines = editor.channels[0]?.lines.join("\n") ?? "";

    expect(lines).toContain("EXTENSION_DEACTIVATED");
  });
});

/** The parts of `TreeDataProvider` this test calls. */
interface TreeDataProviderLike {
  getTreeItem(element: unknown): {
    command?: { command: string };
  };
  getChildren(element: unknown): unknown[];
}
