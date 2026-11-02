import { createDownloadHandler } from "./controller";
import { LogRepository, SettingsRepository, SETTINGS_KEY } from "./storage";

const settings = new SettingsRepository();
const logs = new LogRepository();

chrome.downloads.onDeterminingFilename.addListener(createDownloadHandler({
  getSettings: () => settings.get(),
  appendLog: (entry) => logs.append(entry),
}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEY in changes) {
    settings.invalidate(changes[SETTINGS_KEY].newValue);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message !== "object" || message === null || !("type" in message)) return false;
  const request = message as { type: unknown; settings?: unknown; revision?: unknown; enabled?: unknown };
  if (!["GET_STATE", "SAVE_SETTINGS", "SET_ENABLED", "CLEAR_LOGS"].includes(request.type as string)) return false;

  void (async () => {
    switch (request.type) {
      case "GET_STATE": {
        const [state, entries] = await Promise.all([settings.get(), logs.list()]);
        return { ok: true, ...state, logs: entries };
      }
      case "SAVE_SETTINGS":
        return { ok: true, ...await settings.save(request.settings, request.revision) };
      case "SET_ENABLED":
        return { ok: true, ...await settings.setEnabled(request.enabled) };
      case "CLEAR_LOGS":
        await logs.clear();
        return { ok: true };
    }
  })().then(sendResponse).catch((error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败，请重试。" });
  });
  return true;
});
