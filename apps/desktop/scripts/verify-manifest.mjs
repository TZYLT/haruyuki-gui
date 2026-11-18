/**
 * `W8-VERIFY` third script: is the manifest honest about what shipped?
 *
 * This judges `main-crash-record` through Another test and `` together, because they are all
 * claims about the same two files. Reading them in one place is what lets the
 * cross-checks actually compare different sources - separate scripts would
 * each rebuild the expectation from the same input and always agree.
 *
 *   node apps/desktop/scripts/verify-manifest.mjs
 *
 * Exit codes:
 *   0  every claim holds
 *   1  at least one claim is false (printed with the reason)
 *   2  there is no manifest to judge
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanArtifacts } from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const MANIFEST_FILE = path.join(RELEASE_DIR, "release-manifest.json");
const CHECKSUMS_FILE = path.join(RELEASE_DIR, "SHA256SUMS");

/** The icon files the build configuration points at. */
const BUILT_IN_ICONS = ["icon.png", "icon.ico", "icon.icns"].map((name) =>
  path.join(DESKTOP_DIR, "build", name),
);

/** The stock Electron binary: the concrete meaning of "the default icon". */
const STOCK_ELECTRON = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");

/**
 * What to treat as the stock icon, overridable only to prove this check fails.
 *
 * `--default-icon-reference=<exe>` replaces the reference executable. Pointing
 * it at the packaged tree itself makes every embedded icon "stock", which is
 * exactly the state a package built without an icon is in -- so it exercises
 * the byte comparison rather than the file-existence half of the assertion.
 * Nothing else in this script reads it, and no normal run passes it.
 */
function defaultIconReference(argv) {
  const flag = argv.find((arg) => arg.startsWith("--default-icon-reference="));
  if (flag === undefined) return STOCK_ELECTRON;
  const value = flag.slice("--default-icon-reference=".length);
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

/** The only acceptable platform states, and the reasons each may carry. */
const STATES = new Set(["built", "not-built", "skipped"]);
const REASONS = new Set([
  "docker-unavailable",
  "machine-offline",
  "toolchain-missing",
  "not-required",
]);

/** Lines of a GNU checksum file: `<64 hex><two spaces><name>`. */
const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** @type {{ok: boolean, label: string, complaint?: string}[]} */
const results = [];

/**
 * @param {string} label
 * @param {() => string | null | Promise<string | null>} check
 */
async function judge(label, check) {
  const complaint = await check();
  results.push(complaint === null ? { ok: true, label } : { ok: false, label, complaint });
}

/**
 * Pull the hash table out of the free-form release notes.
 *
 * The body table is markdown for a human, so it is parsed rather than trusted:
 * "the draft mentions this digest" is not the same claim as "the draft lists
 * exactly these files".
 *
 * @param {string} notes
 * @returns {{file: string, sha256: string}[]}
 */
export function parseBodyTable(notes) {
  const rows = [];
  for (const line of notes.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/.exec(line.trim());
    if (match !== null) rows.push({ file: match[1], sha256: match[2] });
  }
  return rows;
}

/**
 * @param {string} text
 * @returns {{file: string, sha256: string}[]}
 */
export function parseChecksums(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match !== null) rows.push({ file: match[2], sha256: match[1] });
  }
  return rows;
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/**
 * Read the bytes of every RT_ICON resource in a Windows executable.
 *
 * Hand-rolled because the alternative is a dependency whose only job would be
 * this one read, and because the format is small: a PE header, a resource tree
 * of three directory levels (type -> name -> language), and a data entry that
 * points at the payload. Everything is little-endian.
 *
 * Returns `[]` for anything that is not a PE image or has no resources, so the
 * caller can tell "no icon resource" from "not a binary I can read" by checking
 * whether the file exists at all -- which is the distinction that matters here.
 *
 * @param {string} file
 * @returns {Buffer[]} icon payloads, in resource-name order
 */
function readIconResources(file) {
  if (!existsSync(file)) return [];

  // One open handle for the whole parse, and positional reads, so a
  // 250 MB executable costs a few dozen small reads rather than a full load.
  const fd = openSync(file, "r");
  /** @param {number} offset @param {number} bytes @returns {Buffer} */
  const read = (offset, bytes) => {
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, offset);
    return buffer;
  };

  try {
    const peOffset = read(0x3c, 4).readUInt32LE(0);
    const coff = read(peOffset, 24);
    if (coff.toString("latin1", 0, 4) !== "PE\u0000\u0000") return [];

    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const optional = read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    // PE32+ puts the data directories at 112, PE32 at 96. Electron is always
    // 64-bit here, but the 32-bit offset is what an arm build would hit.
    const directoryOffset = magic === 0x20b ? 112 : 96;
    const resourceRva = optional.readUInt32LE(directoryOffset + 2 * 8);
    if (resourceRva === 0) return [];

    const sectionTable = read(peOffset + 24 + optionalSize, sectionCount * 40);
    const sections = [];
    for (let index = 0; index < sectionCount; index++) {
      const at = index * 40;
      sections.push({
        virtualSize: sectionTable.readUInt32LE(at + 8),
        virtualAddress: sectionTable.readUInt32LE(at + 12),
        rawSize: sectionTable.readUInt32LE(at + 16),
        rawPointer: sectionTable.readUInt32LE(at + 20),
      });
    }

    const toFileOffset = (rva) => {
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
          return rva - section.virtualAddress + section.rawPointer;
        }
      }
      return -1;
    };

    const base = toFileOffset(resourceRva);
    if (base < 0) return [];

    /** Entries of one resource directory: a header, then name/offset pairs. */
    const entries = (offset) => {
      const header = read(base + offset, 16);
      const count = header.readUInt16LE(12) + header.readUInt16LE(14);
      const body = read(base + offset + 16, count * 8);
      const out = [];
      for (let index = 0; index < count; index++) {
        out.push({
          name: body.readUInt32LE(index * 8),
          // The high bit marks a string key, which an RT_ICON entry never has.
          offset: body.readUInt32LE(index * 8 + 4) & 0x7fffffff,
        });
      }
      return out;
    };

    const icons = [];
    for (const type of entries(0)) {
      if ((type.name & 0x7fffffff) !== 3) continue; // 3 is RT_ICON
      for (const name of entries(type.offset)) {
        for (const language of entries(name.offset)) {
          const entry = read(base + language.offset, 16);
          const payloadRva = entry.readUInt32LE(0);
          const size = entry.readUInt32LE(4);
          const at = toFileOffset(payloadRva);
          if (at < 0 || size === 0) continue;
          icons.push(read(at, size));
        }
      }
    }
    return icons;
  } finally {
    closeSync(fd);
  }
}

/** @param {Buffer} bytes @returns {string} */
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const REFERENCE_ICON = defaultIconReference(process.argv.slice(2));
  if (!existsSync(MANIFEST_FILE)) {
    process.stderr.write(`no ${MANIFEST_FILE}: nothing was packaged\n`);
    return 2;
  }

  /** @type {any} */
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
  const checksumText = existsSync(CHECKSUMS_FILE) ? await readFile(CHECKSUMS_FILE, "utf8") : "";

  // Every platform is in exactly one of three states, and "built"
  // carries the evidence of where it was built.
  const platforms = manifest.platforms ?? {};
  await judge("every platform state is one of built/not-built/skipped", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (!STATES.has(value?.state)) return `${name} has state ${JSON.stringify(value?.state)}`;
    }
    return null;
  });
  await judge("a built platform carries builtIn", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (value?.state === "built" && typeof value.builtIn !== "string") {
        return `${name} is built but has no builtIn`;
      }
    }
    return null;
  });
  await judge("a not-built platform carries a known reason", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (value?.state === "not-built" && !REASONS.has(value.reason)) {
        return `${name} has reason ${JSON.stringify(value.reason)}`;
      }
    }
    return null;
  });

  // builtIn says where, not just that something happened. The Linux value
  // is a digest because a tag can be repointed.
  await judge("linux builtIn is a docker image with a digest", () => {
    const linux = platforms.linux;
    if (linux?.state !== "built") return null;
    if (!String(linux.builtIn).startsWith("docker:")) return `not a docker image: ${linux.builtIn}`;
    if (!/@sha256:[0-9a-f]{64}$/.test(String(linux.builtIn)))
      return `no image digest: ${linux.builtIn}`;
    return null;
  });
  await judge("windows builtIn names the host", () => {
    const win32 = platforms.win32;
    if (win32?.state !== "built") return null;
    return /^win32-x64@\S+$/.test(String(win32.builtIn)) ? null : `uninformative: ${win32.builtIn}`;
  });

  // The two documents are compared against each other and against the
  // files, and those are three different sources on purpose.
  const fromChecksums = parseChecksums(checksumText);
  const fromBody = parseBodyTable(String(manifest.releaseNotes ?? ""));
  await judge("the checksum file and the release notes list the same files", () => {
    const left = fromChecksums
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    const right = fromBody
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    return left === right ? null : `they differ:\n${left}\n---\n${right}`;
  });
  await judge("the manifest artifact list matches the checksum file", () => {
    const listed = (manifest.artifacts ?? [])
      .map((a) => `${a.sha256}  ${a.file}`)
      .sort()
      .join("\n");
    const hashed = fromChecksums
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    return listed === hashed
      ? null
      : `manifest lists ${String((manifest.artifacts ?? []).length)} artifacts, checksums ${String(fromChecksums.length)}`;
  });

  // A third party recomputes. This is the only check whose input is the
  // bytes on disk rather than a document's opinion of them.
  await judge("recomputing each artifact reproduces its recorded digest", async () => {
    for (const artifact of manifest.artifacts ?? []) {
      const file = path.join(RELEASE_DIR, artifact.file);
      if (!existsSync(file)) return `${artifact.file} is listed but missing`;
      const actual = await sha256Of(file);
      if (actual !== artifact.sha256)
        return `${artifact.file}: recorded ${artifact.sha256}, actual ${actual}`;
    }
    return null;
  });
  await judge("the artifact list covers every downloadable file on disk", async () => {
    const onDisk = (await scanArtifacts(RELEASE_DIR))
      .filter((entry) => !["SHA256SUMS", "release-manifest.json"].includes(entry.file))
      .filter((entry) => !entry.file.startsWith("builder-"))
      .map((entry) => entry.file)
      .sort();
    const listed = (manifest.artifacts ?? []).map((a) => a.file).sort();
    return onDisk.join() === listed.join()
      ? null
      : `disk [{${onDisk.join()}}] vs manifest [{${listed.join()}}]`;
  });

  // The icon the package actually carries is not the Electron default.
  //
  // Judged by the bytes inside the packaged executable, not by whether an icon
  // file sits somewhere in the tree. On Windows the icon is not shipped as a
  // separate file at all -- `electron-builder` overwrites the icon resource
  // group embedded in the .exe -- so "is there an .ico in the tree" has the
  // same answer for a correct and an incorrect build, and a check phrased that
  // way stays red after the icon is wired up correctly. That is what this
  // assertion used to do.
  //
  // The reference is the stock Electron binary's own icon group, which is what
  // "the default icon" means concretely. Comparing the packaged bytes against
  // `build/icon.ico` instead would only prove the configuration and the build
  // agree with each other, and they can agree while both being wrong.
  //
  // Only trees of platforms the manifest calls "built" are judged: an unpacked
  // directory can survive from an earlier run on a platform this run declares
  // it did not build, and judging that would be judging someone else's input.
  //
  // Linux is out of scope for the byte comparison on purpose: its icon is not
  // embedded in the executable but written into the AppImage's icon theme, so
  // the equivalent check needs the AppImage and cannot run on this host. That
  // is a gap in coverage, not a pass -- see the manifest's platform state,
  // which reports Linux as not built here.
  await judge("the packaged icon is not the Electron default", async () => {
    // Half one: the configuration must hand the builder a real icon. If these
    // are missing the builder has nothing to embed and silently falls back.
    for (const file of BUILT_IN_ICONS) {
      if (!existsSync(file)) return `${path.relative(REPO_ROOT, file)} is missing`;
    }

    const stock = readIconResources(REFERENCE_ICON);
    if (stock.length === 0) {
      // An unreadable reference is an unjudged claim, not a pass.
      return `cannot read an icon resource from ${path.relative(REPO_ROOT, REFERENCE_ICON)}`;
    }
    const stockDigests = new Set(stock.map((icon) => digest(icon)));

    /** @type {string[]} */
    const judged = [];
    for (const tree of manifest.trees ?? []) {
      const platform = tree.startsWith("win-")
        ? "win32"
        : tree.startsWith("linux-")
          ? "linux"
          : null;
      if (platform === null || manifest.platforms?.[platform]?.state !== "built") continue;
      if (platform !== "win32") continue;

      const root = path.join(RELEASE_DIR, tree);
      if (!existsSync(root)) continue;
      const executables = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /[.]exe$/i.test(entry.name))
        .map((entry) => path.join(root, entry.name));

      for (const file of executables) {
        const shipped = readIconResources(file);
        if (shipped.length === 0) continue;
        judged.push(path.relative(RELEASE_DIR, file));
        // Every embedded icon must be one we supplied. One stock icon left over
        // is enough to say the default is (partly) what shipped, so the test is
        // "nothing matches the stock group", not "something differs".
        if (shipped.some((icon) => stockDigests.has(digest(icon)))) {
          return `${path.relative(RELEASE_DIR, file)} still contains a stock Electron icon resource`;
        }
      }
    }

    // A platform reported as built but leaving nothing to read means the
    // evidence is absent, which is not the same as the claim holding.
    if (judged.length === 0 && manifest.platforms?.win32?.state === "built") {
      return "win32 is built but no unpacked executable carries an icon resource";
    }

    return null;
  });

  for (const result of results) {
    process.stdout.write(
      result.ok
        ? `  ok    ${result.label}\n`
        : `  FAIL  ${result.label}: ${result.complaint ?? ""}\n`,
    );
  }

  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `\n${String(results.length - failed)} of ${String(results.length)} assertions hold\n`,
  );
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
