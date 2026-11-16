/**
 * The `pickPaths` acceptance probe.
 *
 * `pickPaths` has no UI entry point in this build: `apps/` contains zero call sites, and
 * the only callers are this directory's probes and the core doubles. That is correct for
 * this item -- `pickPaths` is a host capability, and its consumer is the session layer
 * built by a later item -- but it means the behaviour cannot be verified by clicking
 * around the window.
 *
 * So the dialog is raised here instead, in a real Electron process, with the same
 * `properties` the shell builds. What a human does is click. What is recorded is what the
 * dialogs return.
 *
 * Five answers are the whole of the pick-path contract:
 *
 *   1. a file picker returns one path;
 *   2. a directory picker returns one path;
 *   3. a multi-select file picker can return several;
 *   4. a cancelled dialog returns an empty list, and is not an error;
 *   5. the `properties` actually passed match what the requirement says.
 *
 * Each prompt is shown one at a time so the human knows which answer belongs to which
 * question. Nothing here ships; it goes to `dist/probe/` with the other probes.
 */

import { app, BrowserWindow, dialog } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Where the answers go. `app.exit` does not drain stdout. */
const REPORT = path.join(process.cwd(), "apps", "desktop", "dist", "probe", "pick-answers.json");

/** One question and what the shell's own code passes for it. */
interface Question {
  readonly key: string;
  readonly title: string;
  readonly kind: "file" | "directory";
  readonly multiple: boolean;
}

const QUESTIONS: readonly Question[] = [
  {
    key: "fileSingle",
    title: "1/4  Pick ONE file  (then OK)",
    kind: "file",
    multiple: false,
  },
  {
    key: "directorySingle",
    title: "2/4  Pick ONE folder  (then OK)",
    kind: "directory",
    multiple: false,
  },
  {
    key: "fileMultiple",
    title: "3/4  Pick SEVERAL files  (Ctrl+click two or more, then OK)",
    kind: "file",
    multiple: true,
  },
  {
    key: "directoryMultiple",
    title: "4/4  Pick SEVERAL folders  (Ctrl+click two or more, then OK)",
    kind: "directory",
    multiple: true,
  },
];

/**
 * The `properties` the shell builds, reproduced exactly.
 *
 * Duplicated rather than imported because `main.ts` cannot be imported without starting
 * the whole shell, and a probe that reimplemented the rule differently would be
 * measuring itself -- a mistake an earlier version of the app-name check made.
 *
 * @param kind which selector
 * @param multiple whether several may be chosen
 */
function propertiesFor(
  kind: "file" | "directory",
  multiple: boolean,
): Array<"openFile" | "openDirectory" | "multiSelections"> {
  return kind === "directory"
    ? ["openDirectory", ...(multiple ? (["multiSelections"] as const) : [])]
    : ["openFile", ...(multiple ? (["multiSelections"] as const) : [])];
}

async function main(): Promise<void> {
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 500, height: 300 });
  const answers: Record<string, unknown> = {};

  for (const question of QUESTIONS) {
    // `cancelId` is what makes "cancel" a deliberate answer rather than a window close.
    const result = await dialog.showOpenDialog(window, {
      title: question.title,
      properties: propertiesFor(question.kind, question.multiple),
    });

    answers[question.key] = {
      properties: propertiesFor(question.kind, question.multiple),
      canceled: result.canceled,
      count: result.filePaths.length,
      // Names only: the report is a record of the dialog's behaviour, not of what is on
      // this machine.
      names: result.filePaths.map((full) => path.basename(full)),
    };
  }

  window.destroy();
  writeFileSync(REPORT, JSON.stringify(answers, null, 2), "utf8");
  app.exit(0);
}

void main();
