import { createDefaultSettings, validateSettings } from "../shared/index";
import type { Settings } from "../shared/index";
import type { DownloadLog, SettingsState } from "./controller";

export const SETTINGS_KEY = "settings";
export const LOGS_KEY = "logs";
export const MAX_LOGS = 100;

export interface SettingsSnapshot extends SettingsState {
  // A worker-scoped opaque token: restarting the worker safely invalidates stale editors.
  revision: string;
}

export function decodeSettings(value: unknown): SettingsState {
  if (value === undefined) return { settings: createDefaultSettings() };
  const result = validateSettings(value);
  if (result.ok) return { settings: result.settings };
  return {
    settings: { ...createDefaultSettings(), enabled: false },
    configError: `已暂停分流：保存的配置无效。${result.errors.slice(0, 3).join("；")} 请在设置中修复后保存。`,
  };
}

export class SettingsRepository {
  private snapshot: Promise<SettingsSnapshot> | undefined;
  private writes: Promise<void> = Promise.resolve();

  get(): Promise<SettingsSnapshot> {
    if (!this.snapshot) {
      this.snapshot = chrome.storage.local.get(SETTINGS_KEY)
        .then((data) => ({ ...decodeSettings(data[SETTINGS_KEY]), revision: crypto.randomUUID() }))
        .catch((error: unknown) => {
          this.snapshot = undefined;
          throw error;
        });
    }
    return this.snapshot;
  }

  invalidate(value: unknown): void {
    this.snapshot = Promise.resolve({ ...decodeSettings(value), revision: crypto.randomUUID() });
  }

  async save(input: unknown, expectedRevision: unknown): Promise<SettingsSnapshot> {
    const result = validateSettings(input);
    if (!result.ok) throw new Error(result.errors.join("；"));
    if (typeof expectedRevision !== "string" || !expectedRevision) throw new Error("缺少配置版本，请刷新页面后重试。");
    return this.enqueue(async () => {
      const current = await this.get();
      if (current.revision !== expectedRevision) {
        throw new Error("配置已在其他窗口中更新，请重试保存。当前表单中的编辑仍然保留。");
      }
      return this.write(result.settings);
    });
  }

  async setEnabled(enabled: unknown): Promise<SettingsSnapshot> {
    if (typeof enabled !== "boolean") throw new Error("启用状态必须为布尔值。");
    return this.enqueue(async () => {
      const current = await this.get();
      if (current.configError) throw new Error("请先在设置中修复无效配置，再开启或暂停分流。");
      return this.write({ ...current.settings, enabled });
    });
  }

  private async write(settings: Settings): Promise<SettingsSnapshot> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    const snapshot = { settings, revision: crypto.randomUUID() };
    this.snapshot = Promise.resolve(snapshot);
    return snapshot;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }
}

function isLog(value: unknown): value is DownloadLog {
  if (typeof value !== "object" || value === null) return false;
  const log = value as Record<string, unknown>;
  const optionalStrings = ["ruleName", "presetName", "relativePath", "domain", "message"];
  return typeof log.id === "string" && typeof log.downloadId === "number"
    && Number.isFinite(log.downloadId) && typeof log.timestamp === "string"
    && Number.isFinite(Date.parse(log.timestamp)) && typeof log.filename === "string"
    && ["matched", "invalid", "error"].includes(log.outcome as string)
    && (log.source === undefined || ["referrer", "url", "finalUrl"].includes(log.source as string))
    && optionalStrings.every((key) => log[key] === undefined || typeof log[key] === "string");
}

export class LogRepository {
  private queue: Promise<void> = Promise.resolve();

  private async read(): Promise<DownloadLog[]> {
    const data = await chrome.storage.local.get(LOGS_KEY);
    return Array.isArray(data[LOGS_KEY]) ? data[LOGS_KEY].filter(isLog).slice(0, MAX_LOGS) : [];
  }

  async list(): Promise<DownloadLog[]> {
    await this.queue;
    return this.read();
  }

  append(log: DownloadLog): Promise<void> {
    return this.enqueue(async () => {
      const logs = await this.read();
      await chrome.storage.local.set({ [LOGS_KEY]: [log, ...logs].slice(0, MAX_LOGS) });
    });
  }

  clear(): Promise<void> {
    return this.enqueue(() => chrome.storage.local.set({ [LOGS_KEY]: [] }));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
