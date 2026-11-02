import { access, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("本机辅助程序目前仅支持 Windows，请在 Windows 上构建。");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "native", "bin");
const executable = path.join(directory, "download-path-host.exe");
const systemRoot = process.env.SystemRoot || "C:\\Windows";
let compiler;
for (const architecture of ["Framework64", "Framework"]) {
  const candidate = path.join(systemRoot, "Microsoft.NET", architecture, "v4.0.30319", "csc.exe");
  try { await access(candidate); compiler = candidate; break; } catch { /* try the other framework */ }
}
if (!compiler) throw new Error("没有找到 Windows .NET Framework C# 编译器，请启用 .NET Framework 4.8 后重试。");
await mkdir(directory, { recursive: true });
execFileSync(compiler, [
  "/nologo", "/optimize+", "/target:exe", "/platform:anycpu", "/langversion:5", "/codepage:65001", "/utf8output",
  "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll",
  `/out:${executable}`, path.join(root, "native", "Host.cs"),
], { cwd: root, stdio: "inherit", windowsHide: true });
console.log(`Windows 辅助程序：${executable}`);
