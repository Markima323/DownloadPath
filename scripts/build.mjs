import { build } from "esbuild";
import { mkdir, readdir, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIcons } from "./icons.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "dist");
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== "dist") {
  throw new Error("拒绝清理项目目录以外的路径。");
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/background/index.ts", "src/options/options.ts", "src/popup/popup.ts"],
  outbase: "src",
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

async function copyStatic(relative) {
  const input = path.join(root, "src", relative);
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyStatic(entryRelative);
    else if (/\.(html|css|svg|png)$/.test(entry.name)) {
      const target = path.join(output, entryRelative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, "src", entryRelative), target);
    }
  }
}
await copyStatic("");
const manifest = JSON.parse(await readFile(path.join(root, "src/manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
manifest.version = pkg.version;
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await createIcons(path.join(output, "assets"));
console.log(`\n可加载的扩展：${output}`);
