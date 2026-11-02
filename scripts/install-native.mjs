import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("本机辅助程序目前仅支持 Windows。");
const extensionId = process.argv[2];
if (extensionId !== undefined && !/^[a-p]{32}$/.test(extensionId)) throw new Error("扩展 ID 应为 32 个 a 到 p 的小写字母。");
const script = fileURLToPath(new URL("./install-native.ps1", import.meta.url));
const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
if (extensionId) args.push("-ExtensionId", extensionId);
const result = spawnSync("powershell.exe", args, { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
