import { displayDate, errorMessage, getNativeStatus, getState, setEnabled, type ExtensionState, type NativeStatus } from "../ui/client";

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  return result as T;
}

let state: ExtensionState | undefined;
let busy = false;
let writeGeneration = 0;
let refreshing = false;
let refreshAgain = false;
let nativeStatus: NativeStatus | undefined;
const enabled = element<HTMLInputElement>("enabled");

function showError(message: string): void {
  element("error").textContent = message;
  element("error").hidden = false;
  element("retry").hidden = false;
}

function renderNativeNote(): void {
  const note = element("native-note");
  const absolute = state?.settings.presets.some((preset) => preset.mode === "absolute");
  const pendingCount = state?.pendingCount ?? 0;
  note.hidden = !absolute && pendingCount === 0;
  note.classList.toggle("connected", nativeStatus?.available === true);
  note.textContent = nativeStatus?.available
    ? `绝对路径辅助程序已连接。${pendingCount ? `${pendingCount} 项待移动，可在设置中查看或重试。` : "文件将在下载完成后自动移动。"}`
    : nativeStatus ? "绝对路径辅助程序尚未连接。下载文件会保留，请在设置的“使用帮助”中安装并重试。" : "正在检测绝对路径辅助程序；相对子目录功能可正常使用。";
}

function render(): void {
  if (!state) return;
  enabled.checked = state.settings.enabled;
  enabled.disabled = busy;
  document.querySelector(".status-card")?.classList.toggle("paused", !state.settings.enabled);
  element("status-title").textContent = state.settings.enabled ? "自动分流已开启" : "自动分流已暂停";
  element("status-description").textContent = state.settings.enabled ? "新下载将按网站规则保存" : "下载将沿用 Chrome 默认行为";
  element("rule-count").textContent = String(state.settings.rules.filter((rule) => rule.enabled).length);
  element("preset-count").textContent = String(state.settings.presets.length);
  const recent = state.logs.find((log) => log.outcome === "moved" || log.outcome === "matched");
  const container = element("recent");
  container.replaceChildren();
  element("recent-time").textContent = recent ? displayDate(recent.timestamp) : "";
  if (recent) {
    const name = document.createElement("strong");
    name.textContent = recent.filename || "下载文件";
    const rule = document.createElement("span");
    rule.className = "rule";
    rule.textContent = `${recent.outcome === "moved" ? "已移动 · " : recent.jobId ? "等待下载完成后移动 · " : ""}${recent.ruleName ?? "已命中规则"} → ${recent.presetName ?? "路径预设"}`;
    const path = document.createElement("code");
    path.textContent = recent.outcome === "moved" && recent.finalPath ? recent.finalPath : recent.relativePath ? `${recent.jobId ? "暂存位置：默认下载目录" : "默认下载目录"} / ${recent.relativePath}` : "";
    container.append(name, rule, path);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "empty";
    placeholder.textContent = state.settings.rules.length ? "命中规则的下载会显示在这里。" : "还没有网站规则。进入设置，安排第一个下载位置。";
    container.append(placeholder);
  }
  if (state.configError) showError(`配置需要检查：${state.configError}`);
  renderNativeNote();
}

async function refresh(): Promise<void> {
  if (busy || refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const generation = writeGeneration;
  try {
    const latest = await getState();
    if (busy || generation !== writeGeneration) { refreshAgain = true; return; }
    state = latest;
    element("error").hidden = true;
    element("retry").hidden = true;
    render();
  } catch (error) {
    showError(errorMessage(error));
    if (!state) {
      element("status-title").textContent = "暂时无法连接";
      element("status-description").textContent = "请重试，或重新打开扩展";
      enabled.disabled = true;
    }
  } finally {
    refreshing = false;
    if (refreshAgain && !busy) { refreshAgain = false; void refresh(); }
  }
}

enabled.addEventListener("change", () => {
  if (busy || !state) return;
  const next = enabled.checked;
  busy = true;
  writeGeneration++;
  enabled.disabled = true;
  void (async () => {
    try {
      const saved = await setEnabled(next);
      state = { ...saved, logs: state?.logs ?? [], pendingCount: state?.pendingCount };
      element("error").hidden = true;
      element("retry").hidden = true;
      render();
      element("status-message").textContent = next ? "自动分流已开启" : "自动分流已暂停";
    } catch (error) {
      showError(errorMessage(error));
      if (state) enabled.checked = state.settings.enabled;
    } finally {
      busy = false;
      enabled.disabled = !state;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  })();
});

element("open-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().then(() => window.close()).catch((error: unknown) => { showError(errorMessage(error)); });
});
element("retry").addEventListener("click", () => { void refresh(); });
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((_changes, areaName) => { if (areaName === "local") void refresh(); });
void refresh();
void getNativeStatus().then((status) => { nativeStatus = status; renderNativeNote(); }).catch((error: unknown) => {
  nativeStatus = { available: false, extensionId: "", error: errorMessage(error) };
  renderNativeNote();
});
