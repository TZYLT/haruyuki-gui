/**
 * Bundle selection is the order the requirement fixes: external pick, bundled,
 * PATH, missing. The tests care most about two failure modes that would be
 * invisible in a happy path:
 *
 *   an external pick that no longer works must fall back to the bundled engine
 *   and carry the reason for the status note, not silently change source;
 *
 *   a PATH candidate without `node_modules` is not an engine; accepting it would
 *   start a bundle whose dependencies cannot resolve.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEngineVersion, selectBundle } from "../runtime/selection.js";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-select-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

/** Create an engine-shaped directory (entry + node_modules + package.json). */
async function engine(name: string, version = "0.6.0", packageName = "haruyuki"): Promise<string> {
  const dir = path.join(work!, name);

  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await writeFile(path.join(dir, "haruyuki.js"), "entry", "utf8");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: packageName, version }),
    "utf8",
  );

  return dir;
}

describe("selectBundle", () => {
  it("prefers a valid external pick over everything else", async () => {
    const bundled = await engine("bundled");
    const external = await engine("external", "0.7.0");
    const result = await selectBundle({ bundledDir: bundled, externalDir: external });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.source).toBe("external");
    expect(result.location.engineDir).toBe(external);
    expect(result.location.version).toBe("0.7.0");
  });

  it("falls back to bundled and reports the invalid external pick", async () => {
    const bundled = await engine("bundled");
    const result = await selectBundle({
      bundledDir: bundled,
      externalDir: path.join(work!, "gone"),
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.source).toBe("bundled");
    expect(result.externalInvalid?.dir).toContain("gone");
    expect(result.externalInvalid?.reason).toContain("gone");
  });

  it("rejects a relative external path instead of resolving it", async () => {
    const bundled = await engine("bundled");
    const result = await selectBundle({ bundledDir: bundled, externalDir: "relative-engine" });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.source).toBe("bundled");
    expect(result.externalInvalid?.reason).toContain("absolute");
  });

  it("rejects an external package whose name is not haruyuki", async () => {
    const bundled = await engine("bundled");
    const external = await engine("external", "0.7.0", "not-haruyuki");
    const result = await selectBundle({ bundledDir: bundled, externalDir: external });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.source).toBe("bundled");
    expect(result.externalInvalid?.reason).toContain('not "haruyuki"');
  });

  it("uses PATH when neither external nor bundled is usable", async () => {
    const pathEngine = await engine("path-engine", "0.6.1");
    const result = await selectBundle({
      bundledDir: path.join(work!, "missing-bundled"),
      pathEnv: `${path.join(work!, "empty")};${pathEngine}`,
      pathDelimiter: ";",
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.source).toBe("path");
    expect(result.location.engineDir).toBe(pathEngine);
    expect(result.location.version).toBe("0.6.1");
  });

  it("skips a PATH directory without node_modules", async () => {
    const empty = path.join(work!, "empty-engine");
    await mkdir(empty, { recursive: true });
    await writeFile(path.join(empty, "haruyuki.js"), "entry", "utf8");

    const good = await engine("good");
    const result = await selectBundle({
      bundledDir: path.join(work!, "missing"),
      pathEnv: `${empty}${path.delimiter}${good}`,
    });

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.location.engineDir).toBe(good);
  });

  it("reports missing with the external reason when nothing is usable", async () => {
    const result = await selectBundle({
      bundledDir: path.join(work!, "missing-bundled"),
      externalDir: path.join(work!, "missing-external"),
      pathEnv: path.join(work!, "empty-path"),
    });

    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.externalInvalid?.dir).toContain("missing-external");
    expect(result.reason).toContain("selected engine is invalid");
  });

  it("does not treat a file named haruyuki.js without node_modules as an engine", async () => {
    const broken = path.join(work!, "broken");

    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "haruyuki.js"), "entry", "utf8");

    const result = await selectBundle({
      bundledDir: broken,
      pathEnv: "",
    });

    expect(result.kind).toBe("missing");
  });
});

describe("readEngineVersion", () => {
  it("returns the version when package.json is readable", async () => {
    await expect(readEngineVersion(await engine("versioned", "1.2.3"))).resolves.toBe("1.2.3");
  });

  it("returns undefined instead of failing selection on a missing package.json", async () => {
    const dir = path.join(work!, "no-package");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "haruyuki.js"), "entry", "utf8");

    await expect(readEngineVersion(dir)).resolves.toBeUndefined();
  });
});
