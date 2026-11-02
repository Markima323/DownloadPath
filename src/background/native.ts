export const NATIVE_HOST = "com.download_path_router.host";

export function nativeRequest(message: Record<string, unknown>, timeoutMs = 30 * 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, response?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* disconnected already */ }
      if (error) reject(error);
      else resolve(response!);
    };
    try {
      // 原生端口在大文件跨盘复制期间保持 worker 存活，完成即关闭。
      port = chrome.runtime.connectNative(NATIVE_HOST);
      timer = setTimeout(() => finish(new Error("本机程序响应超时，请稍后重试以恢复移动结果。")), timeoutMs);
      port.onMessage.addListener((response: unknown) => {
        if (typeof response !== "object" || response === null || Array.isArray(response)) {
          finish(new Error("本机程序返回了无效响应。"));
        } else finish(undefined, response as Record<string, unknown>);
      });
      port.onDisconnect.addListener(() => {
        const details = chrome.runtime.lastError?.message;
        finish(new Error(`本机辅助程序未安装、未授权或连接已断开${details ? `：${details}` : "。"}`));
      });
      port.postMessage(message);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("无法连接本机辅助程序。"));
    }
  });
}

export async function nativeStatus(): Promise<{ available: boolean; version?: string; error?: string; extensionId: string }> {
  try {
    const result = await nativeRequest({ operation: "ping" }, 5000);
    if (result.ok !== true || typeof result.version !== "string") throw new Error(typeof result.error === "string" ? result.error : "本机程序响应无效。");
    return { available: true, version: result.version, extensionId: chrome.runtime.id };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : "本机程序不可用。", extensionId: chrome.runtime.id };
  }
}
