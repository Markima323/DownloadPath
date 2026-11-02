import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadHandler } from "../src/background/controller.ts";
import type { DownloadLog } from "../src/background/controller.ts";
import { decodeSettings, LogRepository, MAX_LOGS, SettingsRepository } from "../src/background/storage.ts";
import { createDefaultSettings } from "../src/shared/index.ts";

function config() {
  return {
    ...createDefaultSettings(),
    rules: [{ id: "one", name: "报表", enabled: true, domain: "reports.example.com", includeSubdomains: false, source: "url" as const, presetId: "documents", priority: 0 }],
  };
}
const item = { id: 7, url: "https://reports.example.com/file?secret=private", finalUrl: "https://reports.example.com/file", referrer: "", filename: "C:\\Downloads\\中文报表.csv" };

function runHandler(dependencies: Parameters<typeof createDownloadHandler>[0], download = item) {
  const calls: Array<chrome.downloads.FilenameSuggestion | undefined> = [];
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  const returned = createDownloadHandler(dependencies)(download, (suggestion) => {
    calls.push(suggestion);
    completed();
  });
  assert.equal(returned, true);
  return { calls, completion };
}

test("handler suggests relative path, uses uniquify, and logs no URL tokens", async () => {
  const entries: DownloadLog[] = [];
  const result = runHandler({ getSettings: async () => ({ settings: config() }), appendLog: async (entry) => { entries.push(entry); } });
  await result.completion;
  assert.deepEqual(result.calls, [{ filename: "Documents/中文报表.csv", conflictAction: "uniquify" }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.filename, "中文报表.csv");
  assert.equal(entries[0]?.outcome, "matched");
  assert.equal(JSON.stringify(entries).includes("private"), false);
  assert.equal(JSON.stringify(entries).includes("C:\\Downloads"), false);
});

test("disabled and unmatched downloads complete without suggestion or log", async () => {
  for (const settings of [createDefaultSettings(), { ...config(), enabled: false }]) {
    const result = runHandler({ getSettings: async () => ({ settings }), appendLog: async () => { assert.fail("Should not log ordinary unmatched downloads"); } });
    await result.completion;
    assert.deepEqual(result.calls, [undefined]);
  }
});

test("invalid stored configuration does not override the download", async () => {
  const entries: DownloadLog[] = [];
  const result = runHandler({ getSettings: async () => ({ settings: config(), configError: "配置损坏" }), appendLog: async (entry) => { entries.push(entry); } });
  await result.completion;
  assert.deepEqual(result.calls, [undefined]);
  assert.equal(entries[0]?.message, "配置损坏");
});

test("storage failures fall back without blocking", async () => {
  const entries: DownloadLog[] = [];
  const result = runHandler({ getSettings: async () => { throw new Error("存储不可用"); }, appendLog: async (entry) => { entries.push(entry); } });
  await result.completion;
  assert.deepEqual(result.calls, [undefined]);
  assert.equal(entries[0]?.outcome, "error");
});

test("timeout completes once and ignores a late configuration response", async () => {
  let resolveSettings!: (state: { settings: ReturnType<typeof config> }) => void;
  const entries: DownloadLog[] = [];
  const pending = new Promise<{ settings: ReturnType<typeof config> }>((resolve) => { resolveSettings = resolve; });
  const result = runHandler({ getSettings: () => pending, appendLog: async (entry) => { entries.push(entry); }, timeoutMs: 10 });
  await result.completion;
  resolveSettings({ settings: config() });
  await pending;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result.calls, [undefined]);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.message!, /超时/);
});

test("log write rejection cannot stall or duplicate filename suggestion", async () => {
  const result = runHandler({ getSettings: async () => ({ settings: config() }), appendLog: async () => { throw new Error("日志配额不足"); } });
  await result.completion;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.filename, "Documents/中文报表.csv");
});

test("decodeSettings distinguishes missing settings from corrupted values", () => {
  assert.equal(decodeSettings(undefined).settings.enabled, true);
  for (const value of [null, {}, { ...config(), version: 99 }]) {
    const decoded = decodeSettings(value);
    assert.equal(decoded.settings.enabled, false);
    assert.match(decoded.configError!, /配置无效/);
  }
});

test("repositories validate persistence, refresh changed settings, serialize concurrent logs, and enforce retention", async () => {
  const data: Record<string, unknown> = {};
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: {
      get: async (key: string) => structuredClone({ [key]: data[key] }),
      set: async (updates: Record<string, unknown>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        Object.assign(data, structuredClone(updates));
      },
    } },
  } as unknown as typeof chrome;
  try {
    const settings = new SettingsRepository();
    assert.equal((await settings.get()).settings.rules.length, 0);
    const initial = await settings.get();
    const saved = await settings.save(config(), initial.revision);
    assert.equal(saved.settings.rules.length, 1);
    assert.equal((await settings.get()).settings.rules.length, 1);
    await assert.rejects(settings.save({ ...config(), version: 5 }, saved.revision));
    await assert.rejects(settings.save(config(), undefined), /缺少配置版本/);
    assert.deepEqual(data.settings, saved.settings);

    const concurrent = await settings.get();
    const firstEdit = structuredClone(concurrent.settings);
    firstEdit.presets[0]!.name = "窗口 A 的改动";
    const staleEdit = structuredClone(concurrent.settings);
    staleEdit.presets[1]!.name = "窗口 B 的旧快照";
    const writes = await Promise.allSettled([
      settings.save(firstEdit, concurrent.revision),
      settings.save(staleEdit, concurrent.revision),
      settings.setEnabled(false),
    ]);
    assert.equal(writes[0]?.status, "fulfilled");
    assert.equal(writes[1]?.status, "rejected");
    assert.equal(writes[2]?.status, "fulfilled");
    const afterConcurrentSave = await settings.get();
    assert.equal(afterConcurrentSave.settings.presets[0]?.name, "窗口 A 的改动");
    assert.equal(afterConcurrentSave.settings.presets[1]?.name, "文档");
    assert.equal(afterConcurrentSave.settings.enabled, false);
    await assert.rejects(settings.setEnabled("true"), /布尔/);
    settings.invalidate({ ...config(), enabled: false });
    assert.equal((await settings.get()).settings.enabled, false);
    settings.invalidate(undefined);
    assert.equal((await settings.get()).settings.rules.length, 0);

    const logs = new LogRepository();
    const makeLog = (index: number): DownloadLog => ({ id: `log-${index}`, downloadId: index, timestamp: new Date().toISOString(), outcome: "matched", filename: `${index}.csv` });
    await Promise.all(Array.from({ length: MAX_LOGS + 5 }, (_, index) => logs.append(makeLog(index))));
    const entries = await logs.list();
    assert.equal(entries.length, MAX_LOGS);
    assert.equal(entries[0]?.id, `log-${MAX_LOGS + 4}`);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, MAX_LOGS);
    await Promise.all([logs.clear(), logs.append(makeLog(999))]);
    assert.deepEqual((await logs.list()).map((entry) => entry.id), ["log-999"]);
    data.logs = [null, { id: "broken" }, makeLog(11)];
    assert.deepEqual((await logs.list()).map((entry) => entry.id), ["log-11"]);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
