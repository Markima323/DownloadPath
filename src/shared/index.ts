export type MatchSource = "referrer" | "url" | "finalUrl";

export interface Preset {
  id: string;
  name: string;
  subdirectory: string;
}

export interface DownloadRule {
  id: string;
  name: string;
  enabled: boolean;
  domain: string;
  includeSubdomains: boolean;
  source: MatchSource;
  presetId: string;
  priority: number;
}

export interface Settings {
  version: 1;
  enabled: boolean;
  presets: Preset[];
  rules: DownloadRule[];
}

export interface DownloadContext {
  url: string;
  finalUrl?: string;
  referrer?: string;
  filename: string;
}

export type ResolveResult =
  | {
      kind: "matched";
      rule: DownloadRule;
      preset: Preset;
      relativePath: string;
    }
  | { kind: "disabled" | "unmatched" | "invalid"; reason?: string };

export type SettingsValidation =
  | { ok: true; settings: Settings }
  | { ok: false; errors: string[] };

export const SETTINGS_VERSION = 1;
export const MAX_PRESETS = 100;
export const MAX_RULES = 500;
export const MAX_SUBDIRECTORY_LENGTH = 240;

const SOURCES: readonly MatchSource[] = ["referrer", "url", "finalUrl"];
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const ILLEGAL_WINDOWS_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i;

/** Fresh objects on every call: editing defaults must not leak into other callers. */
export function createDefaultSettings(): Settings {
  return {
    version: 1,
    enabled: true,
    presets: [
      { id: "software", name: "软件", subdirectory: "Software" },
      { id: "documents", name: "文档", subdirectory: "Documents" },
      { id: "images", name: "图片", subdirectory: "Images" },
    ],
    rules: [],
  };
}

/** Accept a hostname or a pasted HTTP(S) URL; store hostnames only. */
export function normalizeDomain(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("请输入网站域名。");
  }
  const value = input.trim();
  if (/[\s\u0000-\u001f\u007f*\\]/u.test(value)) {
    throw new Error("域名不能包含空白、通配符或反斜杠；子域名请使用单独的选项。");
  }
  const isUrl = /^https?:\/\//i.test(value);
  if (!isUrl && /[/?#@]/.test(value)) {
    throw new Error("请输入完整的 HTTP(S) 链接或纯域名。");
  }
  if (!isUrl && value.includes(":") && !/^\[[0-9a-f:]+\]$/i.test(value)) {
    throw new Error("纯域名不应包含协议或端口；也可以粘贴完整的 HTTP(S) 链接。");
  }
  let url: URL;
  try {
    url = new URL(isUrl ? value : `https://${value}`);
  } catch {
    throw new Error("网站域名无效。");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("请使用不包含用户名和密码的 HTTP(S) 网站链接。");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253) {
    throw new Error("网站域名为空或过长。");
  }
  // URL already validates the syntax and canonicalizes IPv6 addresses.
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname;
  if (
    !hostname
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("网站域名包含无效的域名片段。");
  }
  return hostname;
}

/** Only separator conversion; validation must not silently repair dangerous paths. */
export function normalizeSubdirectory(input: string): string {
  return input.replace(/\\/g, "/");
}

export function validateSubdirectory(input: string): string[] {
  if (typeof input !== "string" || input.length === 0) {
    return ["目标子目录不能为空。"];
  }
  const path = normalizeSubdirectory(input);
  const errors: string[] = [];
  if (path.length > MAX_SUBDIRECTORY_LENGTH) {
    errors.push(`目标子目录不能超过 ${MAX_SUBDIRECTORY_LENGTH} 个字符。`);
  }
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) {
    errors.push("请填写默认下载目录内的相对子目录，不能使用绝对路径。");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "")) {
    errors.push("子目录不能以分隔符开头或结尾，也不能包含连续的分隔符。");
  }
  if (parts.some((part) => part === "." || part === "..")) {
    errors.push("子目录不能包含 . 或 .. 路径片段。");
  }
  if (parts.some((part) => ILLEGAL_WINDOWS_CHARS.test(part))) {
    errors.push('子目录不能包含 < > : " | ? * 或控制字符。');
  }
  if (parts.some((part) => /[. ]$/.test(part))) {
    errors.push("每一级目录名不能以空格或句点结尾。");
  }
  if (parts.some((part) => RESERVED_WINDOWS_NAME.test(part))) {
    errors.push("子目录不能使用 CON、NUL、COM1 等 Windows 保留名称。");
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  errors: string[],
): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    errors.push(`${label}包含不支持的字段。`);
  }
}

function validateId(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    errors.push(`${label}标识无效（使用 1–80 个字母、数字、连字符或下划线）。`);
    return false;
  }
  return true;
}

function validateName(value: unknown, label: string, errors: string[]): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    errors.push(`${label}名称应为 1–80 个字符，且不能包含控制字符。`);
    return false;
  }
  return true;
}

/** Validate untrusted storage/import data, then return a canonical, whitelisted copy. */
export function validateSettings(input: unknown): SettingsValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["配置必须是一个 JSON 对象。"] };
  unexpectedFields(input, ["version", "enabled", "presets", "rules"], "配置", errors);
  if (input.version !== 1) errors.push("不支持此配置版本，当前仅支持 version: 1。");
  if (typeof input.enabled !== "boolean") errors.push("总开关 enabled 必须为布尔值。");
  if (!Array.isArray(input.presets) || input.presets.length > MAX_PRESETS) {
    errors.push(`路径预设必须为数组，最多 ${MAX_PRESETS} 条。`);
  }
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES) {
    errors.push(`网站规则必须为数组，最多 ${MAX_RULES} 条。`);
  }
  if (errors.length) return { ok: false, errors };

  const presets: Preset[] = [];
  const presetIds = new Set<string>();
  for (const [index, value] of (input.presets as unknown[]).entries()) {
    const label = `预设 ${index + 1}：`;
    if (!isRecord(value)) {
      errors.push(`${label}必须是对象。`);
      continue;
    }
    const before = errors.length;
    unexpectedFields(value, ["id", "name", "subdirectory"], label, errors);
    if (validateId(value.id, label, errors)) {
      if (presetIds.has(value.id)) errors.push(`${label}标识重复。`);
      presetIds.add(value.id);
    }
    validateName(value.name, label, errors);
    if (typeof value.subdirectory !== "string") {
      errors.push(`${label}目标子目录必须为文本。`);
    } else {
      errors.push(...validateSubdirectory(value.subdirectory).map((error) => label + error));
    }
    if (errors.length === before) {
      presets.push({
        id: value.id as string,
        name: (value.name as string).trim(),
        subdirectory: normalizeSubdirectory(value.subdirectory as string),
      });
    }
  }

  const rules: DownloadRule[] = [];
  const ruleIds = new Set<string>();
  for (const [index, value] of (input.rules as unknown[]).entries()) {
    const label = `规则 ${index + 1}：`;
    if (!isRecord(value)) {
      errors.push(`${label}必须是对象。`);
      continue;
    }
    const before = errors.length;
    unexpectedFields(
      value,
      ["id", "name", "enabled", "domain", "includeSubdomains", "source", "presetId", "priority"],
      label,
      errors,
    );
    if (validateId(value.id, label, errors)) {
      if (ruleIds.has(value.id)) errors.push(`${label}标识重复。`);
      ruleIds.add(value.id);
    }
    validateName(value.name, label, errors);
    if (typeof value.enabled !== "boolean") errors.push(`${label}启用状态必须为布尔值。`);
    if (typeof value.includeSubdomains !== "boolean") errors.push(`${label}子域名选项必须为布尔值。`);
    let domain = "";
    if (typeof value.domain !== "string") {
      errors.push(`${label}域名必须为文本。`);
    } else {
      try {
        domain = normalizeDomain(value.domain);
      } catch (error) {
        errors.push(label + (error instanceof Error ? error.message : "网站域名无效。"));
      }
    }
    if (!SOURCES.includes(value.source as MatchSource)) errors.push(`${label}匹配依据无效。`);
    if (typeof value.presetId !== "string" || !presetIds.has(value.presetId)) {
      errors.push(`${label}关联的路径预设不存在。`);
    }
    if (
      typeof value.priority !== "number" ||
      !Number.isSafeInteger(value.priority) ||
      value.priority < -10000 ||
      value.priority > 10000
    ) {
      errors.push(`${label}优先级必须为 -10000 到 10000 之间的整数。`);
    }
    if (errors.length === before) {
      rules.push({
        id: value.id as string,
        name: (value.name as string).trim(),
        enabled: value.enabled as boolean,
        domain,
        includeSubdomains: value.includeSubdomains as boolean,
        source: value.source as MatchSource,
        presetId: value.presetId as string,
        priority: value.priority as number,
      });
    }
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, settings: { version: 1, enabled: input.enabled as boolean, presets, rules } };
}

function downloadHostname(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    let url = new URL(address);
    if (url.protocol === "blob:") url = new URL(url.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return normalizeDomain(url.origin);
  } catch {
    return undefined;
  }
}

function safeBasename(filename: string): string | undefined {
  if (typeof filename !== "string") return undefined;
  const basename = filename.split(/[\\/]/).at(-1);
  if (!basename || basename === "." || basename === "..") return undefined;
  let safe = basename.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "");
  if (!safe || safe === "." || safe === "..") return undefined;
  if (RESERVED_WINDOWS_NAME.test(safe)) safe = `_${safe}`;
  // An overlong filename should be left to Chrome's default handling, rather than
  // truncating the user's filename or losing its extension.
  if (safe.length > 255) return undefined;
  return safe;
}

/** Settings are validated once when loaded; this function handles each download. */
export function resolveDownload(settings: Settings, context: DownloadContext): ResolveResult {
  if (!settings.enabled) return { kind: "disabled" };
  const hosts: Partial<Record<MatchSource, string | undefined>> = {};
  let selected: DownloadRule | undefined;
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    if (!(rule.source in hosts)) hosts[rule.source] = downloadHostname(context[rule.source]);
    const host = hosts[rule.source];
    if (
      host &&
      (host === rule.domain || (rule.includeSubdomains && host.endsWith(`.${rule.domain}`))) &&
      (!selected || rule.priority > selected.priority)
    ) {
      selected = rule;
    }
  }
  if (!selected) return { kind: "unmatched" };
  const preset = settings.presets.find((entry) => entry.id === selected.presetId);
  if (!preset) return { kind: "invalid", reason: "规则关联的路径预设不存在。" };
  const pathErrors = validateSubdirectory(preset.subdirectory);
  if (pathErrors.length) return { kind: "invalid", reason: pathErrors[0] };
  const filename = safeBasename(context.filename);
  if (!filename) return { kind: "invalid", reason: "无法生成有效的目标文件名。" };
  return {
    kind: "matched",
    rule: selected,
    preset,
    relativePath: `${normalizeSubdirectory(preset.subdirectory)}/${filename}`,
  };
}
