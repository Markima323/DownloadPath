import { normalizeAbsoluteDirectory, validateAbsoluteDirectory } from "../shared/index";
import type { MatchSource, ResolveResult } from "../shared/index";
import type { DownloadLog } from "./controller";
import type { LogRepository } from "./storage";

export const JOBS_KEY = "moveJobs";
export const STAGING_DIRECTORY = "_DownloadPathRouter";
export const MAX_PENDING_JOBS = 200;

export interface MoveJob {
  id: string;
  downloadId: number;
  destinationDirectory: string;
  relativePath: string;
  filename: string;
  ruleName: string;
  presetName: string;
  source: MatchSource;
  domain: string;
  createdAt: string;
  state: "pending" | "moving" | "failed";
  sourcePath?: string;
  error?: string;
}

function isJob(value: unknown): value is MoveJob {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
    && typeof item.downloadId === "number" && Number.isSafeInteger(item.downloadId)
    && typeof item.destinationDirectory === "string" && validateAbsoluteDirectory(item.destinationDirectory).length === 0
    && ["filename", "relativePath", "ruleName", "presetName", "domain", "createdAt"].every((key) => typeof item[key] === "string")
    && ["url", "finalUrl", "referrer"].includes(item.source as string)
    && ["pending", "moving", "failed"].includes(item.state as string)
    && (item.sourcePath === undefined || typeof item.sourcePath === "string")
    && (item.error === undefined || typeof item.error === "string");
}

export class MoveJobRepository {
  private writes: Promise<void> = Promise.resolve();

  private async read(): Promise<MoveJob[]> {
    const data = await chrome.storage.local.get(JOBS_KEY);
    if (data[JOBS_KEY] === undefined) return [];
    if (!Array.isArray(data[JOBS_KEY]) || !data[JOBS_KEY].every(isJob)) {
      throw new Error("待移动任务记录无效，请保留临时目录中的文件并检查扩展配置。");
    }
    return data[JOBS_KEY];
  }

  async list(): Promise<MoveJob[]> { await this.writes; return this.read(); }

  async get(id: string): Promise<MoveJob | undefined> { return (await this.list()).find((job) => job.id === id); }

  add(job: MoveJob): Promise<void> {
    return this.enqueue(async () => {
      const jobs = await this.read();
      if (jobs.length >= MAX_PENDING_JOBS) throw new Error("待移动文件过多，请先安装辅助程序并重试已有任务。此次下载沿用默认位置。");
      await chrome.storage.local.set({ [JOBS_KEY]: [...jobs, job] });
    });
  }

  update(id: string, update: Partial<Pick<MoveJob, "state" | "sourcePath" | "error">>): Promise<void> {
    return this.enqueue(async () => {
      const jobs = await this.read();
      const existing = jobs.find((job) => job.id === id);
      if (!existing) return;
      Object.assign(existing, update);
      if (existing.error === undefined) delete existing.error;
      await chrome.storage.local.set({ [JOBS_KEY]: jobs });
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const jobs = await this.read();
      await chrome.storage.local.set({ [JOBS_KEY]: jobs.filter((job) => job.id !== id) });
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function isStagedFile(path: string, jobId: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.at(-2)?.toLowerCase() === jobId.toLowerCase()
    && parts.at(-3) === STAGING_DIRECTORY && !!parts.at(-1);
}

type Matched = Extract<ResolveResult, { kind: "matched" }>;
type NativeRequest = (message: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class MoveCoordinator {
  private active = new Map<string, Promise<void>>();
  private workQueue: Promise<void> = Promise.resolve();

  constructor(private jobs: MoveJobRepository, private logs: LogRepository, private request: NativeRequest) {}

  async prepare(download: { id: number }, result: Matched): Promise<{ jobId: string; relativePath: string }> {
    if (!result.absoluteDirectory) throw new Error("任务没有绝对目标目录。");
    const jobId = crypto.randomUUID();
    const relativePath = `${STAGING_DIRECTORY}/${jobId}/${result.relativePath}`;
    await this.jobs.add({
      id: jobId, downloadId: download.id, destinationDirectory: result.absoluteDirectory,
      relativePath, filename: result.relativePath, ruleName: result.rule.name,
      presetName: result.preset.name, source: result.rule.source, domain: result.rule.domain,
      createdAt: new Date().toISOString(), state: "pending",
    });
    return { jobId, relativePath };
  }

  async onDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted" && !delta.danger) return;
    const job = (await this.jobs.list()).find((entry) => entry.downloadId === delta.id);
    if (!job) return;
    if (delta.state?.current === "interrupted" && delta.error?.current === "USER_CANCELED") {
      await this.jobs.remove(job.id);
      await this.logs.append(this.log(job, "error", { message: "下载已取消，未移动任何文件。" }));
      return;
    }
    await this.process(job.id);
  }

  process(id: string): Promise<void> {
    const running = this.active.get(id);
    if (running) return running;
    const task = this.workQueue.then(() => this.perform(id)).catch(async (error: unknown) => {
      const job = await this.jobs.get(id);
      if (!job) return;
      const message = error instanceof Error ? error.message : "移动失败，文件保留在临时位置。";
      await this.jobs.update(id, { state: "failed", error: message });
      await this.logs.append(this.log(job, "move_error", { jobId: id, message }));
    }).finally(() => { this.active.delete(id); });
    this.workQueue = task.catch(() => undefined);
    this.active.set(id, task);
    return task;
  }

  async recover(): Promise<number> {
    const jobs = await this.jobs.list();
    // 每个任务独立重试，单个不可用目的地不影响其它任务。
    for (const job of jobs) void this.process(job.id).catch(() => undefined);
    return jobs.length;
  }

  private async perform(id: string): Promise<void> {
    const job = await this.jobs.get(id);
    if (!job) return;
    const [download] = await chrome.downloads.search({ id: job.downloadId });
    if (download && download.state !== "complete") return;
    if (download && !["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe"].includes(download.danger)) {
      throw new Error("Chrome 尚未放行此下载，请先在浏览器下载列表中处理，再重试移动。");
    }
    const sourcePath = job.sourcePath || download?.filename;
    if (!sourcePath) throw new Error("找不到原下载记录，请在默认下载目录的 _DownloadPathRouter 文件夹中保留并检查文件。");
    if (!isStagedFile(sourcePath, job.id)) {
      await this.jobs.remove(id);
      await this.logs.append(this.log(job, "error", { message: "实际保存位置已被另存为或其他扩展更改，保留该位置，不自动移动。" }));
      return;
    }
    await this.jobs.update(id, { state: "moving", sourcePath, error: undefined });
    const response = await this.request({ operation: "move", jobId: id, sourcePath, destinationDirectory: job.destinationDirectory });
    if (response.ok !== true || typeof response.finalPath !== "string") {
      throw new Error(typeof response.error === "string" ? response.error : "本机程序未能确认最终位置，原文件将保留或可重试恢复。");
    }
    const finalPath = response.finalPath;
    const lastSeparator = finalPath.lastIndexOf("\\");
    const parent = finalPath.slice(0, lastSeparator + 1);
    if (validateAbsoluteDirectory(finalPath).length || !parent || normalizeAbsoluteDirectory(parent).toLowerCase() !== job.destinationDirectory.toLowerCase()) {
      throw new Error("本机程序返回的目标位置与预设不一致，请检查下载文件后重试。");
    }
    await this.logs.append(this.log(job, "moved", { jobId: id, finalPath, message: "已移动到绝对路径。" }));
    await this.jobs.remove(id);
  }

  private log(job: MoveJob, outcome: DownloadLog["outcome"], details: Partial<DownloadLog>): DownloadLog {
    return {
      id: `${job.id}-${outcome}`, downloadId: job.downloadId, timestamp: new Date().toISOString(),
      outcome, filename: job.filename, ruleName: job.ruleName, presetName: job.presetName,
      relativePath: job.relativePath, source: job.source, domain: job.domain, ...details,
    };
  }
}
