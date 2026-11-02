import {
  MAX_ABSOLUTE_DIRECTORY_LENGTH,
  MAX_SUBDIRECTORY_LENGTH,
  normalizeDomain,
  normalizeAbsoluteDirectory,
  normalizeSubdirectory,
  resolveDownload,
  validateSettings,
  validateAbsoluteDirectory,
  validateSubdirectory,
  type DownloadRule,
  type MatchSource,
  type Preset,
  type Settings,
} from "../shared/index";
import { clearLogs, displayDate, errorMessage, getNativeStatus, getState, retryMove, retryPendingMoves, revealFile, saveSettings, setEnabled, sourceLabel, type ExtensionState, type NativeStatus } from "../ui/client";

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  return result as T;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function action(text: string, label: string, callback: () => void, danger = false): HTMLButtonElement {
  const button = node("button", `button button-icon${danger ? " danger" : ""}`, text);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", callback);
  return button;
}

let state: ExtensionState | undefined;
let writing = false;
let writeGeneration = 0;
let refreshing = false;
let refreshAgain = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let nativeStatus: NativeStatus | undefined;
let nativeChecking = false;
const enabled = element<HTMLInputElement>("global-enabled");
const ruleForm = element<HTMLFormElement>("rule-form");
const presetForm = element<HTMLFormElement>("preset-form");
const rulePreset = element<HTMLSelectElement>("rule-preset");
const dialog = element<HTMLDialogElement>("confirm-dialog");

function notify(message: string, error = false): void {
  const toast = element("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 8000 : 3500);
}

function updateBusy(): void {
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = writing; });
  enabled.disabled = writing || !state;
  element<HTMLButtonElement>("save-rule").disabled = writing || !state || state.settings.presets.length === 0;
  element<HTMLButtonElement>("save-preset").disabled = writing || !state;
  element<HTMLButtonElement>("export-config").disabled = writing || !state;
  element<HTMLButtonElement>("import-config").disabled = writing || !state;
  element<HTMLButtonElement>("check-native-status").disabled = writing || nativeChecking;
  element<HTMLButtonElement>("retry-pending-moves").disabled = writing || !state?.pendingCount;
  element<HTMLButtonElement>("copy-extension-id").disabled = writing || !/^[a-p]{32}$/.test(element<HTMLInputElement>("extension-id").value);
}

function presetModeLabel(preset: Preset): string {
  return preset.mode === "absolute" ? "绝对路径" : "相对子目录";
}

function renderNativeStatus(): void {
  const extensionId = nativeStatus?.extensionId ?? (typeof chrome !== "undefined" ? chrome.runtime?.id : undefined);
  if (extensionId) {
    element<HTMLInputElement>("extension-id").value = extensionId;
    element("native-install-command").textContent = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-native.ps1 -ExtensionId ${extensionId}`;
  }
  const pendingCount = state?.pendingCount ?? 0;
  element("pending-count").textContent = String(pendingCount);
  const status = element("native-status");
  status.classList.toggle("connected", nativeStatus?.available === true);
  if (nativeChecking || !nativeStatus) {
    element("native-status-title").textContent = "正在检测辅助程序…";
    element("native-status-description").textContent = "相对子目录功能可以正常使用，无需等待检测。";
  } else if (nativeStatus.available) {
    element("native-status-title").textContent = `已连接 Windows 辅助程序${nativeStatus.version ? ` · ${nativeStatus.version}` : ""}`;
    element("native-status-description").textContent = "绝对路径将在 Chrome 下载完成后自动移动；移动成功后可在最近记录中打开最终文件夹。";
  } else {
    element("native-status-title").textContent = "辅助程序尚未连接";
    element("native-status-description").textContent = `${nativeStatus.error ?? "请按下方步骤安装后重新检测。"} 未移动的下载文件会保留，可在连接成功后重试。`;
  }
  const warning = element("native-warning");
  warning.hidden = !state?.settings.presets.some((preset) => preset.mode === "absolute") && pendingCount === 0;
  warning.classList.toggle("notice-warning", !nativeStatus?.available);
  warning.classList.toggle("notice-neutral", nativeStatus?.available === true);
  element("native-warning-title").textContent = nativeStatus?.available ? "绝对路径支持已就绪" : nativeChecking || !nativeStatus ? "正在检查绝对路径支持…" : "绝对路径需要 Windows 辅助程序";
  element("native-warning-description").textContent = nativeStatus?.available
    ? `文件将在下载完成后自动移动。${pendingCount ? `当前有 ${pendingCount} 项待移动，可前往帮助中重试。` : "移动后的实际位置会显示在最近记录中。"}`
    : `你可以先保存绝对路径预设。辅助程序未连接时，文件保留在下载暂存位置；安装并检测成功后可重试。${pendingCount ? `当前有 ${pendingCount} 项待移动。` : ""}`;
  updateBusy();
}

async function checkNativeStatus(): Promise<void> {
  if (nativeChecking) return;
  nativeChecking = true;
  renderNativeStatus();
  try { nativeStatus = await getNativeStatus(); }
  catch (error) {
    nativeStatus = { available: false, extensionId: typeof chrome !== "undefined" ? chrome.runtime?.id ?? "" : "", error: errorMessage(error) };
  } finally {
    nativeChecking = false;
    renderNativeStatus();
  }
}

function showRoute(): void {
  const routes = { rules: "网站规则", presets: "路径预设", logs: "最近记录", help: "使用帮助" };
  const hash = location.hash.slice(1);
  const route = Object.hasOwn(routes, hash) ? hash as keyof typeof routes : "rules";
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== route; });
  document.querySelectorAll<HTMLAnchorElement>("[data-route]").forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  element("breadcrumb-current").textContent = routes[route];
  document.title = `${routes[route]} · 下载路径助手`;
}

function renderSummary(): void {
  if (!state) return;
  const { settings, logs } = state;
  enabled.checked = settings.enabled;
  element("global-status").textContent = settings.enabled ? "自动分流已开启" : "自动分流已暂停";
  element("disabled-notice").hidden = settings.enabled;
  element("stat-active-rules").textContent = String(settings.rules.filter((rule) => rule.enabled).length);
  element("stat-presets").textContent = String(settings.presets.length);
  element("nav-rule-count").textContent = String(settings.rules.length);
  element("nav-preset-count").textContent = String(settings.presets.length);
  const latest = logs.find((log) => log.outcome === "matched" || log.outcome === "moved");
  element("stat-last-match").textContent = latest ? displayDate(latest.timestamp).slice(0, -3) : "暂无";
  const warning = element("config-warning");
  warning.hidden = !state.configError;
  warning.textContent = state.configError ? `配置需要检查：${state.configError}。请修正或重新导入有效配置。` : "";
}

function renderRules(): void {
  if (!state) return;
  const list = element("rules-list");
  list.replaceChildren();
  const rules = state.settings.rules.map((rule, index) => ({ rule, index })).sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);
  element("rules-empty").hidden = rules.length > 0;
  element("rules-table-wrap").hidden = rules.length === 0;
  for (const { rule } of rules) {
    const row = node("tr");
    const website = node("td");
    website.append(node("span", "rule-name", rule.name), node("span", "rule-detail", `${rule.includeSubdomains ? "*." : ""}${rule.domain}`), node("span", "rule-detail", sourceLabel(rule.source)));
    const presetCell = node("td");
    const preset = state.settings.presets.find((entry) => entry.id === rule.presetId);
    const tag = node("span", "preset-tag", preset?.name ?? "预设不存在");
    if (preset) tag.title = `${presetModeLabel(preset)} · ${preset.subdirectory}`;
    presetCell.append(tag);
    if (preset) presetCell.append(node("span", "rule-detail target-detail", `${presetModeLabel(preset)} · ${preset.subdirectory}`));
    const priority = node("td", "priority", String(rule.priority));
    const statusCell = node("td");
    const status = node("button", `status-pill${rule.enabled ? "" : " paused"}`, rule.enabled ? "已启用" : "已暂停");
    status.type = "button";
    status.setAttribute("aria-label", `${rule.enabled ? "暂停" : "启用"}规则“${rule.name}”`);
    status.setAttribute("aria-pressed", String(rule.enabled));
    status.addEventListener("click", () => { void mutate((settings) => {
      const entry = settings.rules.find((item) => item.id === rule.id);
      if (!entry) throw new Error("此规则已被删除，请刷新后重试。");
      entry.enabled = !entry.enabled;
    }, "规则状态已更新"); });
    statusCell.append(status);
    const actions = node("td", "align-right");
    actions.append(action("编辑", `编辑规则“${rule.name}”`, () => editRule(rule)), action("删除", `删除规则“${rule.name}”`, () => { void removeRule(rule); }, true));
    row.append(website, presetCell, priority, statusCell, actions);
    list.append(row);
  }
}

function renderPresets(): void {
  if (!state) return;
  const list = element("presets-list");
  list.replaceChildren();
  element("presets-empty").hidden = state.settings.presets.length > 0;
  for (const preset of state.settings.presets) {
    const card = node("article", "card preset-card");
    const mark = node("span", "folder-mark", "▱");
    mark.setAttribute("aria-hidden", "true");
    const footer = node("div", "preset-card-footer");
    const count = state.settings.rules.filter((rule) => rule.presetId === preset.id).length;
    const actions = node("div");
    actions.append(action("编辑", `编辑预设“${preset.name}”`, () => editPreset(preset)), action("删除", `删除预设“${preset.name}”`, () => { void removePreset(preset); }, true));
    footer.append(node("span", "preset-usage", `${count} 条关联规则`), actions);
    card.append(mark, node("span", `mode-label${preset.mode === "absolute" ? " absolute" : ""}`, presetModeLabel(preset)), node("h3", undefined, preset.name), node("p", "preset-path", preset.subdirectory), footer);
    list.append(card);
  }
  const selected = rulePreset.value;
  rulePreset.replaceChildren();
  if (!state.settings.presets.length) {
    const option = node("option", undefined, "请先添加路径预设");
    option.value = "";
    rulePreset.append(option);
  } else {
    for (const preset of state.settings.presets) {
      const option = node("option", undefined, `${preset.name} · ${presetModeLabel(preset)} · ${preset.subdirectory}`);
      option.value = preset.id;
      rulePreset.append(option);
    }
    if (state.settings.presets.some((preset) => preset.id === selected)) rulePreset.value = selected;
  }
}

function renderLogs(): void {
  if (!state) return;
  const list = element("logs-list");
  list.replaceChildren();
  element("logs-empty").hidden = state.logs.length > 0;
  for (const log of state.logs) {
    const card = node("article", "card log-card");
    const success = log.outcome === "matched" || log.outcome === "moved";
    const mark = node("span", `log-icon${success ? "" : " error"}`, log.outcome === "moved" ? "↗" : success ? "✓" : "!");
    mark.setAttribute("aria-hidden", "true");
    const content = node("div", "log-content");
    const title = node("div", "log-title");
    const time = node("time", undefined, displayDate(log.timestamp));
    time.dateTime = log.timestamp;
    title.append(node("span", undefined, log.filename || "下载文件"), time);
    const description = log.outcome === "matched" || log.outcome === "moved"
      ? `${log.outcome === "moved" ? "已移动 · " : log.jobId ? "等待下载完成后移动 · " : "命中规则 · "}${log.ruleName ?? "网站规则"} → ${log.presetName ?? "路径预设"}${log.source ? ` · ${sourceLabel(log.source)}` : ""}${log.domain ? ` · ${log.domain}` : ""}`
      : `${log.outcome === "move_error" ? "移动失败 · " : ""}${log.message ?? "未能应用路径，请检查规则设置。"}`;
    content.append(title, node("p", "log-description", description));
    if (log.outcome === "moved" && log.finalPath) content.append(node("span", "log-path", log.finalPath));
    else if (log.relativePath) content.append(node("span", "log-path", `${log.jobId ? "暂存位置：默认下载目录" : "默认下载目录"} / ${log.relativePath}`));
    if (log.outcome === "moved" && log.finalPath) {
      const finalPath = log.finalPath;
      content.append(action("打开文件夹 ↗", `打开“${log.filename}”所在文件夹`, () => { void runLogAction(() => revealFile(finalPath), "已请求打开文件夹"); }));
    }
    if (log.outcome === "move_error" && log.jobId) {
      const jobId = log.jobId;
      content.append(action("重试移动 →", `重试移动“${log.filename}”`, () => { void runLogAction(() => retryMove(jobId), "已提交重试，请查看后续移动结果"); }));
    }
    card.append(mark, content);
    list.append(card);
  }
}

function render(): void {
  renderSummary();
  renderRules();
  renderPresets();
  renderLogs();
  renderNativeStatus();
  updateBusy();
}

async function refresh(): Promise<void> {
  if (writing || refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const generation = writeGeneration;
  try {
    const latest = await getState();
    if (writing || generation !== writeGeneration) { refreshAgain = true; return; }
    state = latest;
    element("load-error").hidden = true;
    render();
  } catch (error) {
    element("load-error-text").textContent = errorMessage(error);
    element("load-error").hidden = false;
    updateBusy();
  } finally {
    refreshing = false;
    if (refreshAgain && !writing) { refreshAgain = false; void refresh(); }
  }
}

async function mutate(change: (settings: Settings) => void, success: string): Promise<boolean> {
  if (writing) return false;
  if (!state) { notify("扩展尚未连接，请点击重试。", true); return false; }
  writing = true;
  writeGeneration++;
  updateBusy();
  try {
    const latest = await getState();
    const next = structuredClone(latest.settings);
    change(next);
    const saved = await saveSettings(next, latest.revision);
    state = { ...saved, logs: latest.logs, pendingCount: latest.pendingCount };
    render();
    notify(success);
    return true;
  } catch (error) {
    notify(errorMessage(error), true);
    return false;
  } finally {
    writing = false;
    updateBusy();
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

async function runLogAction(operation: () => Promise<void | string>, success: string): Promise<void> {
  if (writing) return;
  writing = true;
  writeGeneration++;
  updateBusy();
  try {
    const result = await operation();
    notify(typeof result === "string" ? result : success);
  } catch (error) { notify(errorMessage(error), true); }
  finally {
    writing = false;
    updateBusy();
    refreshAgain = false;
    void refresh();
  }
}

function resetRule(): void {
  ruleForm.reset();
  element<HTMLInputElement>("rule-id").value = "";
  element("rule-form-title").textContent = "新建网站规则";
  element<HTMLButtonElement>("save-rule").textContent = "保存规则";
}

function resetPreset(): void {
  presetForm.reset();
  element<HTMLInputElement>("preset-id").value = "";
  element("preset-form-title").textContent = "新建路径预设";
  updateDirectoryPreview();
}

function focusEditor(id: string): void {
  const field = element<HTMLInputElement>(id);
  field.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  field.focus({ preventScroll: true });
}

function editRule(rule: DownloadRule): void {
  element<HTMLInputElement>("rule-id").value = rule.id;
  element<HTMLInputElement>("rule-name").value = rule.name;
  element<HTMLInputElement>("rule-domain").value = rule.domain;
  element<HTMLInputElement>("rule-subdomains").checked = rule.includeSubdomains;
  element<HTMLSelectElement>("rule-source").value = rule.source;
  rulePreset.value = rule.presetId;
  element<HTMLInputElement>("rule-priority").value = String(rule.priority);
  element<HTMLInputElement>("rule-enabled").checked = rule.enabled;
  element("rule-form-title").textContent = "编辑网站规则";
  focusEditor("rule-name");
}

function editPreset(preset: Preset): void {
  element<HTMLInputElement>("preset-id").value = preset.id;
  element<HTMLInputElement>("preset-name").value = preset.name;
  element<HTMLInputElement>("preset-directory").value = preset.subdirectory;
  element<HTMLSelectElement>("preset-mode").value = preset.mode ?? "relative";
  element("preset-form-title").textContent = "编辑路径预设";
  updateDirectoryPreview();
  focusEditor("preset-name");
}

async function confirmAction(title: string, description: string, acceptText: string): Promise<boolean> {
  if (dialog.open) return false;
  element("confirm-title").textContent = title;
  element("confirm-description").textContent = description;
  element("confirm-accept").textContent = acceptText;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => { resolve(dialog.returnValue === "accept"); }, { once: true });
    dialog.showModal();
  });
}

async function removeRule(rule: DownloadRule): Promise<void> {
  if (!await confirmAction("删除这条规则？", `“${rule.name}”将不再参与自动分流，已下载的文件不受影响。`, "删除规则")) return;
  const saved = await mutate((settings) => { settings.rules = settings.rules.filter((entry) => entry.id !== rule.id); }, "规则已删除");
  if (saved && element<HTMLInputElement>("rule-id").value === rule.id) resetRule();
}

async function removePreset(preset: Preset): Promise<void> {
  if (state?.settings.rules.some((rule) => rule.presetId === preset.id)) {
    notify("此预设仍有关联的网站规则，请先修改或删除这些规则。", true);
    return;
  }
  if (!await confirmAction("删除这个路径预设？", `将删除“${preset.name}”。文件夹及其文件不会被删除。`, "删除预设")) return;
  const saved = await mutate((settings) => {
    if (settings.rules.some((rule) => rule.presetId === preset.id)) throw new Error("此预设仍有关联的网站规则，请先修改或删除这些规则。");
    settings.presets = settings.presets.filter((entry) => entry.id !== preset.id);
  }, "预设已删除");
  if (saved && element<HTMLInputElement>("preset-id").value === preset.id) resetPreset();
}

function updateDirectoryPreview(): void {
  const directory = element<HTMLInputElement>("preset-directory").value;
  const absolute = element<HTMLSelectElement>("preset-mode").value === "absolute";
  element<HTMLInputElement>("preset-directory").maxLength = absolute ? MAX_ABSOLUTE_DIRECTORY_LENGTH : MAX_SUBDIRECTORY_LENGTH;
  element("preset-directory-label").textContent = absolute ? "Windows 目标目录" : "目标子目录";
  element<HTMLInputElement>("preset-directory").placeholder = absolute ? "例如：D:\\Work\\Reports" : "例如：Work/Reports";
  element("preset-directory-hint").textContent = absolute ? "填写包含盘符的完整目录，支持不同磁盘，例如 D:\\Work 或 E:\\Software。" : "支持多层子目录；不支持盘符、绝对路径或 ..";
  element("absolute-mode-notice").hidden = !absolute;
  element("directory-preview").textContent = absolute ? `下载完成后移动到：${directory || "…"}` : `默认下载目录 / ${directory ? directory.replaceAll("\\", "/") : "…"}`;
}

ruleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const id = element<HTMLInputElement>("rule-id").value;
      const rule: DownloadRule = {
        id: id || crypto.randomUUID(),
        name: element<HTMLInputElement>("rule-name").value.trim(),
        domain: normalizeDomain(element<HTMLInputElement>("rule-domain").value),
        includeSubdomains: element<HTMLInputElement>("rule-subdomains").checked,
        source: element<HTMLSelectElement>("rule-source").value as MatchSource,
        presetId: rulePreset.value,
        priority: Number(element<HTMLInputElement>("rule-priority").value),
        enabled: element<HTMLInputElement>("rule-enabled").checked,
      };
      const saved = await mutate((settings) => {
        if (id) {
          const index = settings.rules.findIndex((entry) => entry.id === id);
          if (index < 0) throw new Error("此规则已被删除，请取消编辑后重新添加。");
          settings.rules[index] = rule;
        } else settings.rules.push(rule);
      }, id ? "规则已更新" : "新规则已保存");
      if (saved) resetRule();
    } catch (error) { notify(errorMessage(error), true); }
  })();
});

presetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const id = element<HTMLInputElement>("preset-id").value;
      const rawDirectory = element<HTMLInputElement>("preset-directory").value;
      const mode = element<HTMLSelectElement>("preset-mode").value === "absolute" ? "absolute" : "relative";
      const errors = mode === "absolute" ? validateAbsoluteDirectory(rawDirectory) : validateSubdirectory(rawDirectory);
      if (errors.length) throw new Error(errors.join("；"));
      const preset: Preset = {
        id: id || crypto.randomUUID(),
        name: element<HTMLInputElement>("preset-name").value.trim(),
        subdirectory: mode === "absolute" ? normalizeAbsoluteDirectory(rawDirectory) : normalizeSubdirectory(rawDirectory),
        mode,
      };
      const saved = await mutate((settings) => {
        if (id) {
          const index = settings.presets.findIndex((entry) => entry.id === id);
          if (index < 0) throw new Error("此预设已被删除，请取消编辑后重新添加。");
          settings.presets[index] = preset;
        } else settings.presets.push(preset);
      }, id ? "路径预设已更新" : "新预设已保存");
      if (saved) resetPreset();
    } catch (error) { notify(errorMessage(error), true); }
  })();
});

async function toggleEnabled(next: boolean): Promise<void> {
  if (writing || !state) return;
  writing = true;
  writeGeneration++;
  updateBusy();
  try {
    const saved = await setEnabled(next);
    state = { ...saved, logs: state.logs, pendingCount: state.pendingCount };
    render();
    notify(next ? "自动分流已开启" : "自动分流已暂停");
  } catch (error) {
    notify(errorMessage(error), true);
    enabled.checked = state.settings.enabled;
  } finally {
    writing = false;
    updateBusy();
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

enabled.addEventListener("change", () => { void toggleEnabled(enabled.checked); });

element("test-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const output = element("test-result");
  output.replaceChildren();
  if (!state) { output.className = "test-result error"; output.textContent = "扩展尚未连接，请重试。"; return; }
  const url = element<HTMLInputElement>("test-url").value.trim();
  const finalUrl = element<HTMLInputElement>("test-final-url").value.trim() || undefined;
  const referrer = element<HTMLInputElement>("test-referrer").value.trim();
  try {
    const result = resolveDownload(state.settings, { url, finalUrl, referrer, filename: element<HTMLInputElement>("test-filename").value });
    if (result.kind === "matched") {
      output.className = "test-result success";
      const targetPath = result.absoluteDirectory ? `${result.absoluteDirectory.replace(/\\$/, "")}\\${result.relativePath}` : `默认下载目录 / ${result.relativePath}`;
      output.append(node("strong", undefined, `✓ 命中“${result.rule.name}”`), node("span", undefined, `${sourceLabel(result.rule.source)} · ${result.preset.name}${result.absoluteDirectory ? " · 下载完成后移动" : ""}`), node("code", undefined, targetPath));
      if (result.absoluteDirectory && !nativeStatus?.available) output.append(node("p", "test-native-note", "此预设需要 Windows 辅助程序。请在“使用帮助”中完成安装与检测；未连接时文件会保留在下载暂存位置。"));
    } else {
      output.className = result.kind === "invalid" ? "test-result error" : "test-result neutral";
      output.append(node("strong", undefined, result.kind === "disabled" ? "自动分流已暂停" : result.kind === "invalid" ? "当前配置无法应用" : "没有命中规则"), node("span", undefined, result.reason || (result.kind === "unmatched" ? "此次下载将沿用 Chrome 默认行为。请检查匹配依据和域名。" : "开启自动分流后，再次运行测试。")));
    }
  } catch (error) { output.className = "test-result error"; output.textContent = errorMessage(error); }
});

element("export-config").addEventListener("click", () => {
  if (!state) return;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(state.settings, null, 2)}\n`], { type: "application/json" }));
  const link = node("a");
  link.href = url;
  link.download = `download-path-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("配置已导出，不包含下载记录。");
});

const importFile = element<HTMLInputElement>("import-file");
element("import-config").addEventListener("click", () => { importFile.value = ""; importFile.click(); });
importFile.addEventListener("change", () => {
  void (async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("配置文件不能超过 1 MB。");
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()) as unknown; } catch { throw new Error("文件不是有效的 JSON 配置。"); }
      const result = validateSettings(parsed);
      if (!result.ok) throw new Error(`配置未导入：${result.errors.join("；")}`);
      if (!await confirmAction("替换当前配置？", `将导入 ${result.settings.presets.length} 个路径预设和 ${result.settings.rules.length} 条网站规则。\n当前预设、规则及未保存的编辑会被替换，最近记录不受影响。建议先导出备份。`, "替换并导入")) return;
      const saved = await mutate((settings) => { Object.assign(settings, result.settings); }, "配置已导入");
      if (saved) { resetPreset(); resetRule(); }
    } catch (error) { notify(errorMessage(error), true); }
    finally { importFile.value = ""; }
  })();
});

element("clear-logs").addEventListener("click", () => {
  void (async () => {
    if (!await confirmAction("清空最近记录？", "仅删除此扩展保留的记录，不会删除已下载的文件。", "清空记录")) return;
    if (writing) return;
    writing = true;
    writeGeneration++;
    updateBusy();
    try { await clearLogs(); if (state) state.logs = []; renderLogs(); notify("记录已清空"); }
    catch (error) { notify(errorMessage(error), true); }
    finally { writing = false; updateBusy(); if (refreshAgain) { refreshAgain = false; void refresh(); } }
  })();
});

element("open-download-settings").addEventListener("click", () => {
  void chrome.tabs.create({ url: "chrome://settings/downloads" }).catch((error: unknown) => { notify(errorMessage(error), true); });
});
element("new-rule").addEventListener("click", () => { resetRule(); focusEditor("rule-name"); });
element("empty-new-rule").addEventListener("click", () => { resetRule(); focusEditor("rule-name"); });
element("new-preset").addEventListener("click", () => { resetPreset(); focusEditor("preset-name"); });
element("cancel-rule").addEventListener("click", resetRule);
element("cancel-preset").addEventListener("click", resetPreset);
element("preset-directory").addEventListener("input", updateDirectoryPreview);
element("preset-mode").addEventListener("change", updateDirectoryPreview);
element("check-native-status").addEventListener("click", () => { void checkNativeStatus(); });
element("retry-pending-moves").addEventListener("click", () => {
  void runLogAction(async () => {
    const count = await retryPendingMoves();
    return count ? `已提交 ${count} 项移动重试，请查看最近记录。` : "当前没有可以重试的文件，尚未下载完成的文件会在完成后处理。";
  }, "已提交移动重试");
});
element("copy-extension-id").addEventListener("click", () => {
  const input = element<HTMLInputElement>("extension-id");
  void navigator.clipboard.writeText(input.value).then(() => notify("扩展 ID 已复制")).catch(() => {
    input.focus(); input.select(); notify("无法自动复制，请复制已选中的扩展 ID。", true);
  });
});
element("retry-load").addEventListener("click", () => { void refresh(); });
window.addEventListener("hashchange", showRoute);
window.addEventListener("focus", () => { void refresh(); });
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((_changes, areaName) => { if (areaName === "local") void refresh(); });
showRoute();
updateBusy();
void refresh();
void checkNativeStatus();
