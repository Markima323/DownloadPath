import { resolveDownload } from "../shared/index";
import type { MatchSource, Settings } from "../shared/index";

export interface DownloadLog {
  id: string;
  downloadId: number;
  timestamp: string;
  outcome: "matched" | "invalid" | "error";
  filename: string;
  ruleName?: string;
  presetName?: string;
  relativePath?: string;
  source?: MatchSource;
  domain?: string;
  message?: string;
}

export interface SettingsState {
  settings: Settings;
  configError?: string;
}

type Download = Pick<chrome.downloads.DownloadItem, "id" | "url" | "finalUrl" | "referrer" | "filename">;
type Suggest = (suggestion?: chrome.downloads.FilenameSuggestion) => void;

export interface HandlerDependencies {
  getSettings: () => Promise<SettingsState>;
  appendLog: (log: DownloadLog) => Promise<void>;
  timeoutMs?: number;
}

export function createDownloadHandler(dependencies: HandlerDependencies) {
  return (download: Download, suggest: Suggest): true => {
    let finished = false;
    const record = (details: Partial<DownloadLog> & Pick<DownloadLog, "outcome">) => {
      const log: DownloadLog = {
        id: crypto.randomUUID(),
        downloadId: download.id,
        timestamp: new Date().toISOString(),
        filename: download.filename.split(/[\\/]/).pop() || "下载文件",
        ...details,
      };
      // 日志写入不参与文件名决策，磁盘或配额错误不能阻塞下载。
      try {
        void dependencies.appendLog(log).catch(() => undefined);
      } catch {
        // 同样隔离注入实现可能产生的同步异常。
      }
    };
    const finish = (suggestion?: chrome.downloads.FilenameSuggestion): boolean => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      suggest(suggestion);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish()) record({ outcome: "error", message: "读取规则超时，已沿用 Chrome 默认下载位置。" });
    }, dependencies.timeoutMs ?? 1500);

    void Promise.resolve().then(() => dependencies.getSettings()).then((state) => {
      if (finished) return;
      if (state.configError) {
        finish();
        record({ outcome: "error", message: state.configError });
        return;
      }
      const result = resolveDownload(state.settings, download);
      if (result.kind === "matched") {
        finish({ filename: result.relativePath, conflictAction: "uniquify" });
        record({
          outcome: "matched",
          ruleName: result.rule.name,
          presetName: result.preset.name,
          relativePath: result.relativePath,
          source: result.rule.source,
          domain: result.rule.domain,
        });
      } else {
        finish();
        if (result.kind === "invalid") {
          record({ outcome: "invalid", message: result.reason || "目标路径无效，已沿用 Chrome 默认下载位置。" });
        }
      }
    }).catch((error: unknown) => {
      if (finish()) record({ outcome: "error", message: error instanceof Error ? error.message : "处理规则失败，已沿用 Chrome 默认下载位置。" });
    });
    // Chrome 要求异步 suggest 显式返回 true，每次事件只完成一次。
    return true;
  };
}
