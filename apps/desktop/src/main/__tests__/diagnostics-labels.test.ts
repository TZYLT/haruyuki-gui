import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnosticsLabels, diagnosticsSecrets } from "../diagnostics/wiring.js";
import type { EngineHost } from "../supervision/engine-host.js";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("diagnosticsLabels", () => {
  it("resolves the native-dialog copy in both catalogues", () => {
    const zh = diagnosticsLabels("zh-CN");
    const en = diagnosticsLabels("en");

    expect(zh.saveTitle).toBe("保存诊断包");
    expect(zh.capFull).toBe("保存全部内容");
    expect(zh.openFolder).toBe("打开文件夹");
    expect(en.saveTitle).toBe("Save diagnostic bundle");
    expect(en.openFolder).toBe("Open folder");
  });
});

describe("diagnosticsSecrets", () => {
  it("reads the engine token value in production", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "d4-diagnostics-secrets-"));

    created.push(dir);

    const tokenFile = path.join(dir, "engine-token");

    await writeFile(tokenFile, "engine-capability-123\n", "utf8");

    const host = { tokenFile } as unknown as EngineHost;

    expect(diagnosticsSecrets(host)).toEqual(["engine-capability-123"]);
  });

  it("returns no value when the token file is gone", () => {
    const host = { tokenFile: path.join(tmpdir(), "missing-token") } as unknown as EngineHost;

    expect(diagnosticsSecrets(host)).toEqual([]);
  });
});
