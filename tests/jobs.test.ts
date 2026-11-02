import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadHandler } from "../src/background/controller.ts";
import { JOBS_KEY, MoveCoordinator, MoveJobRepository } from "../src/background/jobs.ts";
import { LogRepository } from "../src/background/storage.ts";
import { createDefaultSettings, resolveDownload } from "../src/shared/index.ts";

const absoluteSettings = () => ({
  ...createDefaultSettings(),
  presets: [{ id: "absolute", name: "工作", mode: "absolute" as const, subdirectory: "D:\\Work" }],
  rules: [{ id: "rule", name: "报表", enabled: true, domain: "example.com", includeSubdomains: false, source: "url" as const, presetId: "absolute", priority: 0 }],
});

const item = { id: 8, filename: "C:\\Downloads\\report.csv", url: "https://example.com/report.csv", finalUrl: "https://example.com/report.csv", referrer: "", state: "complete", danger: "safe" } as chrome.downloads.DownloadItem;

function match() {
  const result = resolveDownload(absoluteSettings(), item);
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") throw new Error("Expected absolute match");
  return result;
}

function environment(t: { after: (callback: () => void) => void }) {
  const data: Record<string, unknown> = {};
  const downloads = new Map<number, chrome.downloads.DownloadItem>();
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async (key: string) => structuredClone({ [key]: data[key] }),
    set: async (updates: Record<string, unknown>) => { Object.assign(data, structuredClone(updates)); },
  } }, downloads: { search: async ({ id }: { id: number }) => downloads.has(id) ? [structuredClone(downloads.get(id))] : [] } } as unknown as typeof chrome;
  t.after(() => { globalThis.chrome = previous; });
  return { data, downloads, jobs: new MoveJobRepository(), logs: new LogRepository() };
}

test("absolute jobs persist before filename suggestion and never send absolute paths to Chrome", async (t) => {
  const env = environment(t);
  const coordinator = new MoveCoordinator(env.jobs, env.logs, async () => ({ ok: true }));
  await new Promise<void>((resolve, reject) => {
    createDownloadHandler({ getSettings: async () => ({ settings: absoluteSettings() }), appendLog: (log) => env.logs.append(log), prepareAbsolute: (download, result) => coordinator.prepare(download, result) })(item, (suggestion) => {
      try {
        assert.match(suggestion!.filename, /^_DownloadPathRouter\/[0-9a-f-]{36}\/report\.csv$/);
        assert.equal((env.data[JOBS_KEY] as unknown[]).length, 1);
        assert.equal(suggestion!.filename.includes("D:"), false);
        resolve();
      } catch (error) { reject(error); }
    });
  });
});

test("a late preparation is abandoned when filename decision has timed out", async () => {
  let cleanup!: () => void;
  const cleaned = new Promise<void>((resolve) => { cleanup = resolve; });
  const suggestions: unknown[] = [];
  const handler = createDownloadHandler({
    getSettings: async () => ({ settings: absoluteSettings() }), appendLog: async () => undefined,
    timeoutMs: 5,
    prepareAbsolute: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { jobId: "late", relativePath: "stage/report.csv" }; },
    abandonAbsolute: async (id) => { assert.equal(id, "late"); cleanup(); },
  });
  handler(item, (suggestion) => { suggestions.push(suggestion); });
  await cleaned;
  assert.deepEqual(suggestions, [undefined]);
});

test("host failure preserves durable source and can be retried by a fresh coordinator", async (t) => {
  const env = environment(t);
  const broken = new MoveCoordinator(env.jobs, env.logs, async () => { throw new Error("未安装辅助程序"); });
  const prepared = await broken.prepare(item, match());
  const sourcePath = `C:\\Downloads\\${prepared.relativePath.replaceAll("/", "\\")}`;
  env.downloads.set(item.id, { ...item, filename: sourcePath });
  await broken.process(prepared.jobId);
  assert.equal((await env.jobs.get(prepared.jobId))?.state, "failed");
  assert.equal((await env.jobs.get(prepared.jobId))?.sourcePath, sourcePath);
  assert.equal((await env.logs.list())[0]?.outcome, "move_error");
  env.downloads.clear(); // 已保存 sourcePath，Chrome 下载历史被清除仍可恢复。
  const requests: Record<string, unknown>[] = [];
  const restored = new MoveCoordinator(env.jobs, env.logs, async (request) => { requests.push(request); return { ok: true, finalPath: "D:\\Work\\report.csv" }; });
  await restored.process(prepared.jobId);
  assert.equal(requests[0]?.sourcePath, sourcePath);
  assert.equal((await env.jobs.list()).length, 0);
  assert.equal((await env.logs.list())[0]?.finalPath, "D:\\Work\\report.csv");
});

test("retries deduplicate the same active job and serialize distinct file moves", async (t) => {
  const env = environment(t);
  let calls = 0;
  let running = 0;
  let peak = 0;
  const coordinator = new MoveCoordinator(env.jobs, env.logs, async () => {
    calls++; running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return { ok: true, finalPath: "D:\\Work\\report.csv" };
  });
  const first = await coordinator.prepare(item, match());
  const second = await coordinator.prepare({ id: 9 }, match());
  env.downloads.set(8, { ...item, filename: `C:\\Downloads\\${first.relativePath.replaceAll("/", "\\")}` });
  env.downloads.set(9, { ...item, id: 9, filename: `C:\\Downloads\\${second.relativePath.replaceAll("/", "\\")}` });
  await Promise.all([coordinator.process(first.jobId), coordinator.process(first.jobId), coordinator.process(second.jobId)]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.equal((await env.jobs.list()).length, 0);
});

test("incomplete and browser-blocked downloads do not reach the host", async (t) => {
  const env = environment(t);
  let calls = 0;
  const coordinator = new MoveCoordinator(env.jobs, env.logs, async () => { calls++; return { ok: true }; });
  const prepared = await coordinator.prepare(item, match());
  const filename = `C:\\Downloads\\${prepared.relativePath.replaceAll("/", "\\")}`;
  env.downloads.set(item.id, { ...item, filename, state: "in_progress" });
  await coordinator.process(prepared.jobId);
  assert.equal((await env.jobs.get(prepared.jobId))?.state, "pending");
  env.downloads.set(item.id, { ...item, filename, danger: "uncommon" });
  await coordinator.process(prepared.jobId);
  assert.equal(calls, 0);
  assert.equal((await env.jobs.get(prepared.jobId))?.state, "failed");
});

test("explicit Save As outside staging is preserved and canceled tasks are removed", async (t) => {
  const env = environment(t);
  const coordinator = new MoveCoordinator(env.jobs, env.logs, async () => { assert.fail("Should never move user's chosen file"); });
  const prepared = await coordinator.prepare(item, match());
  env.downloads.set(item.id, { ...item, filename: "E:\\Chosen\\report.csv" });
  await coordinator.process(prepared.jobId);
  assert.equal((await env.jobs.list()).length, 0);
  assert.match((await env.logs.list())[0]!.message!, /另存为/);
  await coordinator.prepare(item, match());
  await coordinator.onDownloadChanged({ id: item.id, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
  assert.equal((await env.jobs.list()).length, 0);
});

test("unexpected native destination is rejected and the task remains recoverable", async (t) => {
  const env = environment(t);
  const coordinator = new MoveCoordinator(env.jobs, env.logs, async () => ({ ok: true, finalPath: "E:\\Unexpected\\report.csv" }));
  const prepared = await coordinator.prepare(item, match());
  env.downloads.set(item.id, { ...item, filename: `C:\\Downloads\\${prepared.relativePath.replaceAll("/", "\\")}` });
  await coordinator.process(prepared.jobId);
  assert.equal((await env.jobs.get(prepared.jobId))?.state, "failed");
  assert.match((await env.logs.list())[0]!.message!, /不一致/);
});
