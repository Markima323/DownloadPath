import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./zip.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const entries = new Map();
async function walk(relative = "") {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) entries.set(name, await readFile(path.join(source, name)));
  }
}
await walk();
const directoryPath = path.join(root, "artifacts");
await mkdir(directoryPath, { recursive: true });
const destination = path.join(directoryPath, `download-path-router-${pkg.version}.zip`);
await writeZip(destination, entries);
console.log(`扩展压缩包：${destination}`);

const helperFiles = [
  "native/bin/download-path-host.exe", "install-native.cmd", "uninstall-native.cmd",
  "scripts/install-native.ps1", "scripts/uninstall-native.ps1", "README.md",
];
const helperEntries = new Map();
for (const name of helperFiles) helperEntries.set(name, await readFile(path.join(root, name)));
const helperDestination = path.join(directoryPath, `download-path-router-windows-helper-${pkg.version}.zip`);
await writeZip(helperDestination, helperEntries);
console.log(`Windows 辅助程序包：${helperDestination}`);
