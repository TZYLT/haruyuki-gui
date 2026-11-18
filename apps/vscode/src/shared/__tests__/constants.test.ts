/**
 * The shell's single-source constants, checked against the files they copy.
 *
 * Three copies exist that no compiler can compare:
 *
 * - `APP_VERSION` against `package.json`'s `version`, which VS Code packages.
 *   The bundle is CommonJS and cannot import a manifest, so the literal is a copy
 *   and this test is what keeps it honest.
 * - `TESTED_ENGINE_VERSION` against the contract snapshot's engine pin, which is
 *   the number every fixture and the diagnostics bundle already agree on.
 * - `BRIDGE_VERSION` against `WEBVIEW_BRIDGE_VERSION` in `webview/bridge.ts`.
 *   The two live in different bundles on purpose (the extension host entry must
 *   not drag React in), so an import cannot unify them; the handshake compares
 *   them for exact equality, so a mismatch breaks every panel at runtime with no
 *   build error at all.
 *
 * Nothing here launches an editor: `package.json` and the snapshot are read from
 * disk, and the webview constant is a value import of a module that only holds
 * module-scope helpers.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { COMMAND_OPEN_PANEL, OUTPUT_CHANNEL_NAME, VIEW_LAUNCHER } from "../channels.js";
import { APP_VERSION, BRIDGE_VERSION, TESTED_ENGINE_VERSION } from "../version.js";
import { WEBVIEW_BRIDGE_VERSION } from "../../webview/bridge.js";

/** `apps/vscode/src/shared/__tests__` -> `apps/vscode`. */
const PACKAGE_DIR = path.resolve(import.meta.dirname, "..", "..", "..");

/** `apps/vscode` -> repository root. */
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

/** The extension manifest: the declarations these constants have to match. */
const MANIFEST = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as Record<
  string,
  unknown
>;

/** The contract snapshot: the pinned engine pair. */
const SNAPSHOT = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "packages", "protocol", "src", "contract", "snapshot.json"),
    "utf8",
  ),
) as { engine: { version: string } };

/** The declared `contributes` block, narrowed to what is asserted. */
const contributes = MANIFEST["contributes"] as {
  commands: { command: string }[];
  viewsContainers: { activitybar: { id: string }[] };
  views: Record<string, { id: string }[]>;
};

/** The declared `activationEvents`. */
const activationEvents = MANIFEST["activationEvents"] as string[];

describe("shared constants: versions", () => {
  it("matches the version the packaged manifest declares", () => {
    expect(APP_VERSION).toBe(MANIFEST["version"]);
  });

  it("matches the engine pair the contract snapshot pins", () => {
    expect(TESTED_ENGINE_VERSION).toBe(SNAPSHOT.engine.version);
  });

  it("matches the bridge version the panel bundle announces", () => {
    // An exact-equality handshake, so a difference here is a panel that never
    // connects rather than a build failure.
    expect(BRIDGE_VERSION).toBe(WEBVIEW_BRIDGE_VERSION);
  });
});

describe("shared constants: the manifest contract", () => {
  it("registers the panel command it declares", () => {
    const declared = contributes.commands.map((entry) => entry.command);

    expect(declared).toContain(COMMAND_OPEN_PANEL);
  });

  it("declares an activation event for the command and the view", () => {
    // Both entry points have to be activators: a command with no event is a
    // palette entry that only works once something else started the shell.
    expect(activationEvents).toContain(`onCommand:${COMMAND_OPEN_PANEL}`);
    expect(activationEvents).toContain(`onView:${VIEW_LAUNCHER}`);
  });

  it("declares the launcher view under the activity-bar container", () => {
    const containers = contributes.viewsContainers.activitybar.map((entry) => entry.id);
    const [container, views] = Object.entries(contributes.views)[0] ?? ["", []];

    expect(containers).toHaveLength(1);
    expect(container).toBe(containers[0]);
    expect(views.map((entry) => entry.id)).toContain(VIEW_LAUNCHER);
  });

  it("names the output channel", () => {
    // A display name, so it is prose rather than an id; asserting it is set is
    // what keeps a rename from producing an empty Output dropdown entry.
    expect(OUTPUT_CHANNEL_NAME.length).toBeGreaterThan(0);
  });
});
