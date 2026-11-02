import { createDownloadHandler } from "./controller";
import { LogRepository, SettingsRepository, SETTINGS_KEY } from "./storage";
import { MoveCoordinator, MoveJobRepository } from "./jobs";
import { nativeRequest, nativeStatus } from "./native";

const settings = new SettingsRepository();
const logs = new LogRepository();
const jobs = new MoveJobRepository();
const moves = new MoveCoordinator(jobs, logs, nativeRequest);

chrome.downloads.onDeterminingFilename.addListener(createDownloadHandler({
  getSettings: () => settings.get(),
  appendLog: (entry) => logs.append(entry),
  prepareAbsolute: (download, result) => moves.prepare(download, result),
  abandonAbsolute: (id) => jobs.remove(id),
}));

chrome.downloads.onChanged.addListener((delta) => { void moves.onDownloadChanged(delta).catch(() => undefined); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEY in changes) {
    settings.invalidate(changes[SETTINGS_KEY].newValue);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message !== "object" || message === null || !("type" in message)) return false;
  const request = message as { type: unknown; settings?: unknown; revision?: unknown; enabled?: unknown; jobId?: unknown; path?: unknown };
  if (!["GET_STATE", "SAVE_SETTINGS", "SET_ENABLED", "CLEAR_LOGS", "GET_NATIVE_STATUS", "RETRY_MOVE", "RETRY_PENDING_MOVES", "REVEAL_FILE"].includes(request.type as string)) return false;

  void (async () => {
    switch (request.type) {
      case "GET_STATE": {
        const [state, entries, pending] = await Promise.all([settings.get(), logs.list(), jobs.list()]);
        return { ok: true, ...state, logs: entries, pendingCount: pending.length };
      }
      case "SAVE_SETTINGS":
        return { ok: true, ...await settings.save(request.settings, request.revision) };
      case "SET_ENABLED":
        return { ok: true, ...await settings.setEnabled(request.enabled) };
      case "GET_NATIVE_STATUS":
        return { ok: true, ...await nativeStatus() };
      case "RETRY_MOVE":
        if (typeof request.jobId !== "string" || !await jobs.get(request.jobId)) throw new Error("此任务已完成或不存在，请刷新记录。");
        void moves.process(request.jobId).catch(() => undefined);
        return { ok: true };
      case "RETRY_PENDING_MOVES":
        return { ok: true, count: await moves.recover() };
      case "REVEAL_FILE": {
        if (typeof request.path !== "string" || !(await logs.list()).some((entry) => entry.outcome === "moved" && entry.finalPath === request.path)) throw new Error("只能打开当前记录中已移动文件的位置。");
        const result = await nativeRequest({ operation: "reveal", path: request.path }, 10_000);
        if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "无法打开文件位置。");
        return { ok: true };
      }
      case "CLEAR_LOGS":
        await logs.clear();
        return { ok: true };
    }
  })().then(sendResponse).catch((error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败，请重试。" });
  });
  return true;
});

// 每次 worker 启动恢复持久化任务，覆盖下载完成或移动中途浏览器退出的情况。
void moves.recover().catch(() => undefined);
