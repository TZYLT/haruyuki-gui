/**
 * Layout acceptance: boundaries, performance, copy and logging.
 *
 * Not every acceptance criterion is about behaviour that the store and channel
 * unit tests can see; they are about the shape of the shipped code:
 *
 *   -  the layout layer imports no host: no `electron`, no `vscode`, no
 *         renderer package, no app shell. The full boundary gate is `pnpm
 *         verify` (W-14); this is the C4-local check so a violation fails in
 *         C4's own file first.
 *   layout perf  the performance baseline from docs/35 §1.7: a 256 KiB document loads
 *         and saves inside P50/P95 budgets, and a 1 MiB draft reads and writes
 *         inside its P50 budgets. Numbers are printed so the report carries
 *         measurements, not just green checkmarks.
 *     core emits no user-facing copy: every string literal in the shipped
 *         layout sources is code-facing (codes, file names, keys), never CJK
 *         prose and never an i18n key. Comments are exempt.
 *   IME safety  diagnostics carry codes, file names and counts only -- never document
 *         text, draft text, page props or absolute paths.
 *
 * Determinism and the thresholds
 *   Timings are wall-clock on the machine running the test, which is what
 *   baseline the budgets describe: a local disk on a development machine.
 *   measured ones, so the numbers describe a warm cache; the doc says cold
 *   cache is recorded separately. Thresholds are the published ones and are
 *   not loosened here: a machine that cannot meet them should surface the real
 *   numbers, not a relaxed threshold.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { LayoutDoc, LayoutNode } from "@haruyuki/protocol";
import { LAYOUT_DOC_VERSION, LAYOUT_LIMITS } from "@haruyuki/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDraftStore } from "./draft-store";
import type { DraftStore } from "./draft-store";
import { createNodeLayoutFs } from "./layout-fs";
import { draftPath, layoutDir, layoutPath } from "./layout-paths";
import type { LayoutShell } from "./layout-paths";
import { createLayoutStore } from "./layout-store";
import { validateLayoutDoc } from "./layout-validate";

/** layout perf measures wall-clock time; run it standalone with C4_PERF=1. */
const RUN_PERF = process.env["C4_PERF"] === "1";

/** The shipped sources this item owns, resolved from `import.meta.url`. */
const CORE_LAYOUT_DIR = fileURLToPath(new URL("./", import.meta.url));
const PROTOCOL_LAYOUT_DIR = fileURLToPath(
  new URL("../../../protocol/src/layout/", import.meta.url),
);
const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));

/** Pages the fixtures and the synthetic performance document use. */
const KNOWN: ReadonlySet<string> = new Set(["sample.conversation", "sample.settings"]);

/**
 * Detail keys any layout diagnostic may carry.
 *
 * `file` is always a base name; `step`/`reason` are enum-ish; numbers are
 * counts or sizes. A key outside this set means a message or a document
 * fragment found its way into the log.
 */
const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  "file",
  "step",
  "reason",
  "foundVersion",
  "error",
  "phase",
  "bytes",
  "limit",
  "evicted",
  "entries",
]);

/** A module specifier that must never appear in the layout layer. */
function isForbiddenSpecifier(specifier: string): boolean {
  return (
    specifier === "electron" ||
    specifier === "vscode" ||
    specifier.startsWith("node:electron") ||
    specifier.startsWith("@haruyuki/ui") ||
    specifier.startsWith("@haruyuki/apps") ||
    specifier.startsWith("@haruyuki/desktop") ||
    /(^|\/)apps\//.test(specifier)
  );
}

/** A source file split into comment-free code, its strings and its imports. */
interface SourceScan {
  /** Code with comments removed; string literals are kept verbatim. */
  code: string;
  /** Contents of every single-, double- and template-quoted literal. */
  strings: string[];
  /** Module specifiers from `import`/`export ... from`/`require`/dynamic import. */
  specifiers: string[];
}

/**
 * A small scanner, not a parser.
 *
 * It only has to distinguish the three things a policy check needs: comments
 * (skipped), string literals (kept and recorded), and everything else (kept as
 * code). Handling escapes is what keeps a `//` inside a string from being
 * mistaken for a comment.
 */
function scanSource(source: string): SourceScan {
  const code: string[] = [];
  const strings: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      code.push(" ");
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      const quote = char;
      let value = "";
      index += 1;

      while (index < source.length) {
        const current = source[index];

        if (current === "\\") {
          value += current;
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }

        if (current === quote) {
          index += 1;
          break;
        }

        value += current;
        index += 1;
      }

      strings.push(value);
      code.push(source.slice(start, index));
      continue;
    }

    code.push(char ?? "");
    index += 1;
  }

  const stripped = code.join("");
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }

  return { code: stripped, strings, specifiers: [...specifiers] };
}

/** One shipped `.ts` file, tagged with the package it belongs to. */
interface LayoutSourceFile {
  path: string;
  name: string;
  origin: "core" | "protocol";
  source: string;
}

/** The shipped `.ts` files of the two layout directories. */
async function layoutSourceFiles(): Promise<LayoutSourceFile[]> {
  const files: LayoutSourceFile[] = [];
  const groups = [
    { directory: CORE_LAYOUT_DIR, origin: "core" as const },
    { directory: PROTOCOL_LAYOUT_DIR, origin: "protocol" as const },
  ];

  for (const { directory, origin } of groups) {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".ts")).sort();

    for (const name of names) {
      const path = join(directory, name);
      files.push({ path, name, origin, source: await readFile(path, "utf8") });
    }
  }

  return files;
}

/** A module specifier set by shell only for readability in failures. */
function specifiersOf(files: Array<{ name: string; scan: SourceScan }>): string[] {
  return files.flatMap(({ scan }) => scan.specifiers);
}

/** `[U+3400–U+4DBF, U+4E00–U+9FFF, U+F900–U+FAFF]`: CJK unified ideographs. */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** A log sink that records what a store or draft store emitted. */
interface LogEntry {
  code: string;
  detail: Record<string, unknown> | undefined;
}

function collectingLog(
  entries: LogEntry[],
): (code: string, detail?: Record<string, unknown>) => void {
  return (code, detail) => {
    entries.push({ code, detail });
  };
}

/** The nearest-rank percentile used by the acceptance table (P50, P95). */
function percentileOf(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) throw new Error("no timing samples");

  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  const value = sorted[index];

  if (value === undefined) throw new Error("percentile index out of range");
  return value;
}

function formatMs(value: number): string {
  return `${(Math.round(value * 100) / 100).toFixed(2)} ms`;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-layout-acceptance-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function targetOf(shell: LayoutShell): string {
  return layoutPath(root, shell);
}

async function seed(shell: LayoutShell, text: string): Promise<void> {
  await mkdir(layoutDir(root), { recursive: true });
  await writeFile(targetOf(shell), text, "utf8");
}

/**
 * A document just under the frozen 256 KiB ceiling.
 *
 * Shape: horizontal root -> four vertical splits -> four horizontal splits ->
 * four panels each (64 panels), four tabs per panel (256 tabs), depth 4. Every
 * limit (256 panels / 1024 tabs / depth 32) stays satisfied;
 * the filler goes into a tab `props` bag so the bytes are JSON the validator
 * accepts, not padding outside the document.
 */
function buildNearLimitDoc(): { doc: LayoutDoc; bytes: number } {
  const build = (fillerLength: number): LayoutDoc => {
    const rootChildren: LayoutNode[] = [];

    for (let group = 0; group < 4; group += 1) {
      const subSplits: LayoutNode[] = [];

      for (let sub = 0; sub < 4; sub += 1) {
        const panels: LayoutNode[] = [];

        for (let panel = 0; panel < 4; panel += 1) {
          const id = `p-${String(group)}-${String(sub)}-${String(panel)}`;
          const tabs = Array.from({ length: 4 }, (_, tabIndex) => ({
            tabId: `${id}-t${String(tabIndex)}`,
            pageId: "sample.conversation",
            props: { filler: "x".repeat(fillerLength) },
          }));

          panels.push({ type: "panel", id, tabs });
        }

        subSplits.push({ type: "split", orientation: "horizontal", children: panels });
      }

      rootChildren.push({ type: "split", orientation: "vertical", children: subSplits });
    }

    return {
      version: LAYOUT_DOC_VERSION,
      root: { type: "split", orientation: "horizontal", children: rootChildren },
    };
  };

  // Measure the empty-filler shape once, then spend the remaining budget on the
  // 256 tabs. 248 KiB leaves room for escaping and the JSON braces themselves.
  const baseBytes = Buffer.byteLength(JSON.stringify(build(0)), "utf8");
  const tabCount = 256;
  const targetBytes = 248 * 1024;
  let perTab = Math.max(0, Math.floor((targetBytes - baseBytes) / tabCount));
  let doc = build(perTab);
  let bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");

  // Guard both edges: never exceed the validator's cap, never drift far below
  // "near limit" (a 40 KiB document would not measure the stated baseline).
  while (bytes > LAYOUT_LIMITS.maxBytes && perTab > 0) {
    perTab = Math.max(0, perTab - 8);
    doc = build(perTab);
    bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  }

  return { doc, bytes };
}

/** A store over the temp layout directory with the synthetic document as default. */
function makePerfStore(doc: LayoutDoc) {
  return createLayoutStore({
    fs: createNodeLayoutFs(),
    layoutPath: targetOf("desktop"),
    defaultDoc: doc,
    knownPageIds: KNOWN,
  });
}

/** Measure `iterations` awaits of `run`, returning milliseconds per call. */
async function measure(iterations: number, run: () => Promise<void>): Promise<number[]> {
  const samples: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }

  return samples;
}

describe("layout acceptance", () => {
  it("the layout layer imports no host and touches no host API", async () => {
    const files = await Promise.all(
      (await layoutSourceFiles()).map(async (file) => ({ ...file, scan: scanSource(file.source) })),
    );
    expect(files.length).toBeGreaterThan(0);

    const forbidden: Array<{ file: string; specifier: string }> = [];

    for (const { name, origin, scan } of files) {
      for (const specifier of scan.specifiers) {
        if (isForbiddenSpecifier(specifier))
          forbidden.push({ file: `${origin}/${name}`, specifier });
      }
    }

    expect(forbidden).toEqual([]);
    expect(specifiersOf(files).length).toBeGreaterThan(0);

    // Protocol is transport-neutral: its layout directory may only import
    // relative siblings, never a Node builtin or a runtime package.
    for (const { name, origin, scan } of files) {
      if (origin !== "protocol") continue;
      for (const specifier of scan.specifiers) {
        expect(specifier.startsWith("."), `protocol/${name} imports ${specifier}`).toBe(true);
      }
    }

    // No host globals used as identifiers or member expressions. Word
    // boundaries keep `windowMs`-style names out of this check. Test files are
    // exempt from this particular scan: a negative assertion naturally names
    // the API it forbids, and the import scan above still covers them.
    const hostPattern =
      /\b(ipcRenderer|BrowserWindow|webContents|acquireVsCodeApi)\b|\b(window|document)\./;

    for (const { name, scan } of files) {
      if (name.endsWith(".test.ts")) continue;
      const match = hostPattern.exec(scan.code);
      expect(match, `${name} references host API ${match?.[0] ?? ""}`).toBeNull();
    }
  });

  it.skipIf(!RUN_PERF)(
    "a 256 KiB layout and a 1 MiB draft stay inside the performance budgets",
    async () => {
      const { doc, bytes } = buildNearLimitDoc();

      expect(bytes).toBeLessThanOrEqual(LAYOUT_LIMITS.maxBytes);
      expect(bytes).toBeGreaterThanOrEqual(240 * 1024);

      const validation = validateLayoutDoc(doc, KNOWN);
      expect(validation.ok).toBe(true);

      await seed("desktop", `${JSON.stringify(doc)}\n`);
      const store = makePerfStore(doc);
      const firstLoad = await store.load();
      expect(firstLoad.ok).toBe(true);

      // Warm-up: the budget describes a warm cache; cold cache is recorded
      // separately.
      for (let index = 0; index < 5; index += 1) {
        const warmed = await store.load();
        expect(warmed.ok).toBe(true);
      }

      const loadSamples = await measure(100, async () => {
        const result = await store.load();
        if (!result.ok) throw new Error(`load failed with ${result.code}`);
      });

      const current = await store.load();
      if (!current.ok) throw new Error(`load failed with ${current.code}`);

      for (let index = 0; index < 5; index += 1) {
        const warmed = await store.save(current.doc);
        expect(warmed.ok).toBe(true);
      }

      const saveSamples = await measure(100, async () => {
        const result = await store.save(current.doc);
        if (!result.ok) throw new Error(`save failed with ${result.code}`);
      });

      const loadP50 = percentileOf(loadSamples, 50);
      const loadP95 = percentileOf(loadSamples, 95);
      const saveP50 = percentileOf(saveSamples, 50);
      const saveP95 = percentileOf(saveSamples, 95);

      console.log(
        `[layout perf] layout load ${(bytes / 1024).toFixed(1)} KiB: P50 ${formatMs(loadP50)}, ` +
          `P95 ${formatMs(loadP95)} (n=100, warm)`,
      );
      console.log(
        `[layout perf] layout save ${(bytes / 1024).toFixed(1)} KiB (atomic write): ` +
          `P50 ${formatMs(saveP50)}, P95 ${formatMs(saveP95)} (n=100, warm)`,
      );

      expect(loadP50).toBeLessThanOrEqual(10);
      expect(loadP95).toBeLessThanOrEqual(25);
      expect(saveP50).toBeLessThanOrEqual(20);
      expect(saveP95).toBeLessThanOrEqual(50);

      // One MiB draft: the entry cap in UTF-8 bytes, not in characters.
      const draft = createDraftStore({
        fs: createNodeLayoutFs(),
        draftsPath: draftPath(root, "desktop"),
      });
      const draftText = "d".repeat(1024 * 1024);
      expect(Buffer.byteLength(draftText, "utf8")).toBe(1024 * 1024);

      const firstSave = await draft.saveDraft("conv-perf", draftText);
      expect(firstSave).toEqual({ ok: true });
      for (let index = 0; index < 3; index += 1) {
        await draft.saveDraft("conv-perf", draftText);
        await draft.loadDraft("conv-perf");
      }

      // The store keeps an in-memory mirror after the first read, so a warm
      // `loadDraft` never touches the disk (it measures ~0 ms and would make the
      // baseline meaningless). Measure what a restart actually pays: a fresh
      // store reading and parsing the 1 MiB draft file.
      const draftRead = async (): Promise<string> => {
        const fresh = createDraftStore({
          fs: createNodeLayoutFs(),
          draftsPath: draftPath(root, "desktop"),
        });
        const text = await fresh.loadDraft("conv-perf");
        if (text === null) throw new Error("expected the draft to exist");
        return text;
      };

      for (let index = 0; index < 3; index += 1) {
        await draftRead();
      }

      const draftReadSamples = await measure(100, async () => {
        await draftRead();
      });

      const draftSaveSamples = await measure(30, async () => {
        const result = await draft.saveDraft("conv-perf", draftText);
        if (!result.ok) throw new Error(`draft save refused with ${result.code}`);
      });

      const draftReadP50 = percentileOf(draftReadSamples, 50);
      const draftReadP95 = percentileOf(draftReadSamples, 95);
      const draftSaveP50 = percentileOf(draftSaveSamples, 50);
      const draftSaveP95 = percentileOf(draftSaveSamples, 95);

      console.log(
        `[layout perf] draft read 1 MiB (fresh store, file+parse): P50 ${formatMs(draftReadP50)}, ` +
          `P95 ${formatMs(draftReadP95)} (n=100)`,
      );
      console.log(
        `[layout perf] draft save 1 MiB: P50 ${formatMs(draftSaveP50)}, P95 ${formatMs(draftSaveP95)} (n=30)`,
      );

      expect(draftReadP50).toBeLessThanOrEqual(5);
      expect(draftSaveP50).toBeLessThanOrEqual(10);
    },
    60_000,
  );

  it("shipped layout sources contain no user-facing copy or i18n imports", async () => {
    const files = await Promise.all(
      (await layoutSourceFiles()).map(async (file) => ({ ...file, scan: scanSource(file.source) })),
    );

    // Product copy lives in the shell, not in core (I-7). Tests are excluded
    // from the literal scan because synthetic draft text there is user data,
    // not copy; the i18n import check still covers every file.
    const shipped = files.filter(({ name }) => !name.endsWith(".test.ts"));
    expect(shipped.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; literal: string }> = [];

    for (const { name, scan } of shipped) {
      for (const literal of scan.strings) {
        if (CJK_PATTERN.test(literal)) offenders.push({ file: name, literal });
      }
    }

    expect(offenders).toEqual([]);

    const i18nImports = files.flatMap(({ name, scan }) =>
      scan.specifiers
        .filter((specifier) => /(^|\/)(i18n|intl|locales?)(\/|$)/.test(specifier))
        .map((specifier) => ({ file: name, specifier })),
    );
    expect(i18nImports).toEqual([]);
  });

  it("load failures log codes, file names and reasons only -- never document content", async () => {
    const sentinel = "V18-SENTINEL-DO-NOT-LOG";
    const entries: LogEntry[] = [];

    // A parseable but invalid document. The sentinel lives in a tab's props
    // (which the recovery scan reads) and in the document extras.
    const corrupt = JSON.parse(await readFile(join(FIXTURE_DIR, "corrupt.json"), "utf8")) as {
      root: { children: Array<{ tabs: Array<Record<string, unknown>> }> };
      extras?: Record<string, unknown>;
    };
    const firstPanel = corrupt.root.children[0];
    const firstTab = firstPanel?.tabs[0];
    if (firstTab === undefined) throw new Error("expected the corrupt fixture to contain a tab");
    firstTab["props"] = { secret: sentinel };
    corrupt.extras = { note: sentinel };
    await seed("desktop", `${JSON.stringify(corrupt)}\n`);

    const store = createLayoutStore({
      fs: createNodeLayoutFs(),
      layoutPath: targetOf("desktop"),
      defaultDoc: JSON.parse(
        await readFile(join(FIXTURE_DIR, "default.json"), "utf8"),
      ) as LayoutDoc,
      knownPageIds: KNOWN,
      log: collectingLog(entries),
    });

    const invalidLoad = await store.load();
    expect(invalidLoad.ok).toBe(true);
    if (!invalidLoad.ok) throw new Error("expected a fallback document");
    expect(invalidLoad.outcome).toBe("fell-back-to-default");

    // Unparseable bytes with the same sentinel inside.
    await seed("desktop", `{"version":1,"note":"${sentinel}"`);

    const corruptStore = createLayoutStore({
      fs: createNodeLayoutFs(),
      layoutPath: targetOf("desktop"),
      defaultDoc: JSON.parse(
        await readFile(join(FIXTURE_DIR, "default.json"), "utf8"),
      ) as LayoutDoc,
      knownPageIds: KNOWN,
      log: collectingLog(entries),
    });

    const unparseableLoad = await corruptStore.load();
    expect(unparseableLoad.ok).toBe(true);
    if (!unparseableLoad.ok) throw new Error("expected a fallback document");
    expect(unparseableLoad.outcome).toBe("corrupt");

    // Log entries exist, are codes, and only carry allow-listed details.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.code)).toContain("LAYOUT_INVALID");
    expect(entries.map((entry) => entry.code)).toContain("LAYOUT_CORRUPT");

    for (const entry of entries) {
      expect(entry.code).toMatch(/^[A-Z][A-Z0-9_]+$/);

      for (const [key, value] of Object.entries(entry.detail ?? {})) {
        expect(ALLOWED_LOG_KEYS.has(key), `unexpected log key "${key}"`).toBe(true);
        expect(["string", "number", "boolean"].includes(typeof value)).toBe(true);

        if (key === "file") {
          expect(value).toBe("desktop.json");
          expect(String(value)).not.toMatch(/[\\/]/);
        }
      }
    }

    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(sentinel);
    expect(serialised).not.toContain('"root"');
    expect(serialised).not.toContain("vendor.future");
    expect(serialised.length).toBeLessThan(1000);

    // Drafts are text by contract (I-10); a refusal or eviction must not log it.
    const draftEntries: LogEntry[] = [];
    const draft: DraftStore = createDraftStore({
      fs: createNodeLayoutFs(),
      draftsPath: draftPath(root, "desktop"),
      log: collectingLog(draftEntries),
    });

    const oversizedDraft = `${sentinel}${"d".repeat(1024 * 1024)}`;
    const draftResult = await draft.saveDraft("conv-oversized", oversizedDraft);
    expect(draftResult).toEqual({ ok: false, code: "DRAFT_TOO_LARGE" });
    expect(draftEntries).toHaveLength(1);
    expect(draftEntries[0]?.code).toBe("DRAFT_TOO_LARGE");

    for (const entry of draftEntries) {
      for (const key of Object.keys(entry.detail ?? {})) {
        expect(ALLOWED_LOG_KEYS.has(key), `unexpected draft log key "${key}"`).toBe(true);
      }
    }

    const draftLog = JSON.stringify(draftEntries);
    expect(draftLog).not.toContain(sentinel);
    expect(draftLog).not.toContain("dddd");
  });
});
