/**
 * The one pick-path case the four-dialog run could not answer: a cancellation.
 *
 * The first pass asked for one file, one folder, several files and several folders, and
 * every dialog was answered affirmatively -- so "cancel returns an empty list" stayed
 * unverified even though the other three claims locked down.
 *
 * This asks a single question and is meant to be cancelled. Nothing else changes: same
 * `properties` construction, same launcher, same report shape.
 */

import { app, BrowserWindow, dialog } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Where the answer goes. `app.exit` does not drain stdout. */
const REPORT = path.join(process.cwd(), "apps", "desktop", "dist", "probe", "cancel-answers.json");

async function main(): Promise<void> {
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 500, height: 300 });

  const result = await dialog.showOpenDialog(window, {
    title: "Cancel this dialog  (press Cancel or Esc — that IS the answer being tested)",
    properties: ["openFile"],
  });

  // What the shell's `pickPaths` does with this answer: a cancellation becomes `[]`, and
  // is not an error. Reproduced here so the recorded value is the one the member returns.
  const returned = result.canceled ? [] : result.filePaths;

  window.destroy();
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        canceled: result.canceled,
        dialogPathCount: result.filePaths.length,
        memberReturns: returned,
        memberReturnsIsArray: Array.isArray(returned),
        memberReturnsLength: returned.length,
      },
      null,
      2,
    ),
    "utf8",
  );

  app.exit(0);
}

void main();
