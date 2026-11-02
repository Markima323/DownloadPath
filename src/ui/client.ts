import { validateSettings, type MatchSource, type Settings } from "../shared/index";

export interface DownloadLog {
  id: string;
  downloadId: number;
  timestamp: string;
  outcome: "matched" | "invalid" | "error" | "moved" | "move_error";
  filename: string;
  ruleName?: string;
  presetName?: string;
  relativePath?: string;
  source?: MatchSource;
  domain?: string;
  message?: string;
  finalPath?: string;
  jobId?: string;
}

export interface ExtensionState {
  settings: Settings;
  logs: DownloadLog[];
  revision: string;
  configError?: string;
  pendingCount?: number;
}

export interface SettingsSnapshot {
  settings: Settings;
  revision: string;
}

export interface NativeStatus {
  available: boolean;
  extensionId: string;
  version?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request(message: unknown): Promise<Record<string, unknown>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    throw new Error("请在 Chrome 中安装并打开此扩展后使用。");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("连接超时，请稍后重试或重新打开此页面。")), 10_000);
      }),
    ]);
    if (!isRecord(response) || response.ok !== true) {
      throw new Error(isRecord(response) && typeof response.error === "string" ? response.error : "未能读取扩展数据，请重试。");
    }
    return response;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function readLogs(value: unknown): DownloadLog[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is DownloadLog => {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== "string" || typeof entry.downloadId !== "number" || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) return false;
    if (!["matched", "invalid", "error", "moved", "move_error"].includes(String(entry.outcome)) || typeof entry.filename !== "string") return false;
    for (const key of ["ruleName", "presetName", "relativePath", "domain", "message", "finalPath", "jobId"]) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") return false;
    }
    return entry.source === undefined || ["referrer", "url", "finalUrl"].includes(String(entry.source));
  }).slice(0, 500);
}

function readRevision(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("配置版本无法读取，请刷新后重试。");
  }
  return value;
}

function readSnapshot(response: Record<string, unknown>): SettingsSnapshot {
  const saved = validateSettings(response.settings);
  if (!saved.ok) throw new Error("保存结果无法读取，请刷新后检查。");
  return { settings: saved.settings, revision: readRevision(response.revision) };
}

export async function getState(): Promise<ExtensionState> {
  const response = await request({ type: "GET_STATE" });
  const result = validateSettings(response.settings);
  if (!result.ok) throw new Error(`配置无法读取：${result.errors.join("；")}`);
  return {
    settings: result.settings,
    logs: readLogs(response.logs),
    revision: readRevision(response.revision),
    pendingCount: typeof response.pendingCount === "number" && Number.isSafeInteger(response.pendingCount) && response.pendingCount >= 0 ? response.pendingCount : 0,
    ...(typeof response.configError === "string" ? { configError: response.configError } : {}),
  };
}

export async function saveSettings(settings: Settings, revision: string): Promise<SettingsSnapshot> {
  const result = validateSettings(settings);
  if (!result.ok) throw new Error(result.errors.join("；"));
  const response = await request({ type: "SAVE_SETTINGS", settings: result.settings, revision: readRevision(revision) });
  return readSnapshot(response);
}

export async function setEnabled(enabled: boolean): Promise<SettingsSnapshot> {
  const response = await request({ type: "SET_ENABLED", enabled });
  return readSnapshot(response);
}

export async function getNativeStatus(): Promise<NativeStatus> {
  const response = await request({ type: "GET_NATIVE_STATUS" });
  if (typeof response.available !== "boolean" || typeof response.extensionId !== "string" || !/^[a-p]{32}$/.test(response.extensionId)) {
    throw new Error("辅助程序状态无法读取，请重新检测。");
  }
  return {
    available: response.available,
    extensionId: response.extensionId,
    ...(typeof response.version === "string" ? { version: response.version } : {}),
    ...(typeof response.error === "string" ? { error: response.error } : {}),
  };
}

export async function retryMove(jobId: string): Promise<void> {
  await request({ type: "RETRY_MOVE", jobId });
}

export async function retryPendingMoves(): Promise<number> {
  const response = await request({ type: "RETRY_PENDING_MOVES" });
  return typeof response.count === "number" && Number.isSafeInteger(response.count) && response.count >= 0 ? response.count : 0;
}

export async function revealFile(path: string): Promise<void> {
  await request({ type: "REVEAL_FILE", path });
}

export async function clearLogs(): Promise<void> {
  await request({ type: "CLEAR_LOGS" });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

export function sourceLabel(source: MatchSource): string {
  return { referrer: "来源页面", url: "初始下载地址", finalUrl: "最终下载地址" }[source];
}

export function displayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}
