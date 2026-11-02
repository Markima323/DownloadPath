import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "./icons.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const names = [];
async function walk(relative = "") {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) names.push(name);
  }
}
await walk();
const locals = [];
const directory = [];
let offset = 0;
for (const name of names.sort()) {
  const data = await readFile(path.join(source, name));
  const filename = Buffer.from(name, "utf8");
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0x0021, 12); // 1980-01-01，使相同输入生成相同包。
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  locals.push(local, filename, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, filename);
  offset += local.length + filename.length + data.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(names.length, 8);
end.writeUInt16LE(names.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const directoryPath = path.join(root, "artifacts");
await mkdir(directoryPath, { recursive: true });
const destination = path.join(directoryPath, `download-path-router-${pkg.version}.zip`);
await writeFile(destination, Buffer.concat([...locals, central, end]));
console.log(`扩展压缩包：${destination}`);
