import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright";

// Every resource is private to this run. Only a fresh, random HKCU test-host key
// is added/removed. The official helper registration and user profiles are untouched.
const root = fileURLToPath(new URL("../", import.meta.url));
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const resultPath = path.join(root, "test-results", `native-browser-${runId}`);
const extensionPath = path.join(resultPath, "extension");
const profilePath = path.join(resultPath, "profile");
const downloadPath = path.join(resultPath, "downloads");
const absoluteTarget = path.join(resultPath, "absolute-output", "工作文件");
const uiTarget = path.join(resultPath, "ui-output", "中文目录");
const nativeStatePath = path.join(resultPath, "native-state");
const helperPath = path.join(root, "native", "bin", "download-path-host.exe");
const testHost = `com.download_path_router.test_${randomBytes(8).toString("hex")}`;
const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${testHost}`;
const hostManifestPath = path.join(resultPath, "test-host.json");
const checks = [];
const pageErrors = [];
let context;
let worker;
let optionsPage;
let extensionId;
let server;
let origin;
let hostRegistered = false;
let globalTimer;

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function poll(operation, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function reg(args, allowMissing = false) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0 && !allowMissing) {
    throw new Error(`reg.exe ${args[0]} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function registerHost() {
  const existing = await reg(["QUERY", registryKey, "/ve"], true);
  assert.notEqual(existing.code, 0, "random test registry key must not already exist");
  await writeFile(hostManifestPath, JSON.stringify({
    name: testHost,
    description: "Download Path Router isolated browser smoke fixture",
    path: helperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2));
  await reg(["ADD", registryKey, "/ve", "/t", "REG_SZ", "/d", hostManifestPath, "/f"]);
  hostRegistered = true;
}

async function unregisterHost() {
  if (!hostRegistered) return;
  assert.match(registryKey, /^HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.download_path_router\.test_[a-f0-9]{16}$/);
  await reg(["DELETE", registryKey, "/f"]);
  hostRegistered = false;
}

function fixtureContent(name, tag) {
  return `download-path-native-smoke:${tag}:${name}`;
}

async function startServer() {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.searchParams.get("name") ?? "native.txt";
    const tag = url.searchParams.get("tag") ?? "fixture";
    if (url.pathname === "/download") {
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="native.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      });
      response.end(fixtureContent(name, tag));
      return;
    }
    if (url.pathname === "/page") {
      const target = `/download?name=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Native download fixture</title><a id="download" href="${target.replaceAll("&", "&amp;")}">Download fixture</a>`);
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
}

async function launch() {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium", headless: true, acceptDownloads: false,
    viewport: { width: 1440, height: 1080 },
    env: { ...process.env, LOCALAPPDATA: nativeStatePath },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    ],
    timeout: 30_000,
  });
  const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
  await cdp.detach();
  worker = context.serviceWorkers().find((entry) => entry.url().startsWith("chrome-extension://"))
    ?? await context.waitForEvent("serviceworker", { predicate: (entry) => entry.url().startsWith("chrome-extension://"), timeout: 20_000 });
  extensionId = new URL(worker.url()).hostname;
  optionsPage = await context.newPage();
  optionsPage.on("pageerror", (error) => pageErrors.push(String(error)));
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await poll(() => optionsPage.locator("#global-enabled").isEnabled(), "extension UI connects to worker");
}

async function message(request) {
  return optionsPage.evaluate((value) => chrome.runtime.sendMessage(value), request);
}

async function state() {
  const current = await message({ type: "GET_STATE" });
  assert.equal(current.ok, true, "GET_STATE succeeds");
  return current;
}

function settings(mode = "absolute", directory = absoluteTarget) {
  return {
    version: 1, enabled: true,
    presets: [{ id: "native-preset", name: mode === "absolute" ? "绝对路径验证" : "相对目录验证", mode, subdirectory: directory }],
    rules: [{ id: "native-rule", name: "本机移动验证", enabled: true, domain: "127.0.0.1", includeSubdomains: false, source: "url", presetId: "native-preset", priority: 10 }],
  };
}

async function setSettings(value) {
  await worker.evaluate((next) => chrome.storage.local.set({ settings: next }), value);
  await poll(async () => isDeepStrictEqual((await state()).settings, value), "download settings loaded");
}

async function downloads() {
  return worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 }));
}

async function trigger(name, tag) {
  const before = new Set((await downloads()).map((item) => item.id));
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/page?name=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`);
    await page.locator("#download").click();
    return await poll(async () => {
      const item = (await downloads()).find((entry) => !before.has(entry.id));
      if (item?.state === "interrupted") throw new Error(`Download interrupted: ${item.error}`);
      return item?.state === "complete" ? item : undefined;
    }, `${tag}: Chrome download completes`);
  } finally {
    await page.close();
  }
}

function assertStagingPath(item) {
  const relative = path.relative(downloadPath, item.filename);
  assert.match(relative, /^_DownloadPathRouter[\\/][a-f0-9-]{36}[\\/][^\\/]+$/i, "absolute-mode source is inside the dedicated staging directory");
}

async function waitMoved(item, name, tag, targetDirectory = absoluteTarget) {
  assertStagingPath(item);
  const log = await poll(async () => (await state()).logs.find((entry) => entry.downloadId === item.id && entry.outcome === "moved"), `${tag}: move is recorded`);
  assert.equal(typeof log.finalPath, "string", "moved record exposes final destination");
  assert.equal(path.resolve(path.dirname(log.finalPath)), path.resolve(targetDirectory), "native final path is outside Chrome's download root");
  assert.equal(await readFile(log.finalPath, "utf8"), fixtureContent(name, tag), "native destination contains the original complete bytes");
  await poll(async () => !await exists(item.filename), `${tag}: staging source is removed after successful move`);
  checks.push({ label: tag, stagingPath: item.filename, finalPath: log.finalPath, jobId: log.jobId });
  console.log(`PASS ${tag} -> ${log.finalPath}`);
  return log;
}

async function waitFailed(item, name, tag) {
  assertStagingPath(item);
  const log = await poll(async () => (await state()).logs.find((entry) => entry.downloadId === item.id && entry.outcome === "move_error"), `${tag}: unavailable helper is reported`);
  assert.equal(typeof log.jobId, "string", "failed move provides a retryable job ID");
  assert.equal(await readFile(item.filename, "utf8"), fixtureContent(name, tag), "failed move preserves complete staging source");
  assert.equal(await exists(path.join(absoluteTarget, name)), false, "failed move does not claim a destination file");
  assert.ok((await state()).pendingCount >= 1, "failed move remains pending");
  checks.push({ label: tag, jobId: log.jobId, preservedStagingPath: item.filename });
  console.log(`PASS ${tag}: original is preserved and retryable`);
  return log;
}

async function nativeUiSuite() {
  const presetName = "绝对目录 · 界面验证";
  const ruleName = "本机目录 · 界面验证";
  await optionsPage.reload();
  await poll(() => optionsPage.locator("#global-enabled").isEnabled(), "native UI reloads latest settings");
  await optionsPage.locator('[data-route="presets"]').click();
  await optionsPage.locator("#preset-name").fill(presetName);
  await optionsPage.locator("#preset-mode").selectOption("absolute");
  await optionsPage.locator("#preset-directory").fill(uiTarget);
  assert.ok((await optionsPage.locator("#directory-preview").innerText()).includes(uiTarget), "absolute preset preview uses an absolute destination");
  await optionsPage.locator("#save-preset").click();
  const preset = await poll(async () => (await state()).settings.presets.find((entry) => entry.name === presetName), "absolute preset saved from UI");
  assert.equal(preset.mode, "absolute");
  assert.equal(preset.subdirectory, uiTarget);

  await optionsPage.locator('[data-route="rules"]').click();
  await optionsPage.locator("#rule-name").fill(ruleName);
  await optionsPage.locator("#rule-domain").fill("127.0.0.1");
  await optionsPage.locator("#rule-source").selectOption("url");
  await optionsPage.locator("#rule-preset").selectOption(preset.id);
  await optionsPage.locator("#rule-priority").fill("30");
  await optionsPage.locator("#save-rule").click();
  await poll(async () => (await state()).settings.rules.some((entry) => entry.name === ruleName), "absolute rule saved from UI");
  await optionsPage.locator("#test-url").fill(`${origin}/download?name=preview.txt`);
  await optionsPage.locator("#test-referrer").fill("");
  await optionsPage.locator("#test-filename").fill("preview.txt");
  await optionsPage.locator('#test-form button[type="submit"]').click();
  await poll(() => optionsPage.locator("#test-result").innerText().then((text) => text.includes(path.join(uiTarget, "preview.txt"))), "absolute matching preview displays final directory");
  const uiDownload = await trigger("界面绝对路径.txt", "UI-created absolute destination");
  await waitMoved(uiDownload, "界面绝对路径.txt", "UI-created absolute destination", uiTarget);

  await optionsPage.locator('[data-route="help"]').click();
  await optionsPage.locator("#check-native-status").click();
  await poll(() => optionsPage.locator("#native-status-title").innerText().then((text) => text.includes("已连接 Windows 辅助程序")), "native status check is available from UI");
  assert.equal(await optionsPage.locator("#extension-id").inputValue(), extensionId, "UI shows this isolated extension's ID");
  assert.equal(await optionsPage.locator("#pending-count").innerText(), "0", "UI pending count is clear after successful moves");
  await optionsPage.screenshot({ path: path.join(resultPath, "native-help.png"), fullPage: true, animations: "disabled" });
  await optionsPage.locator('[data-route="logs"]').click();
  await poll(() => optionsPage.locator("#logs-list").innerText().then((text) => text.includes(uiTarget)), "move log displays the real final destination");
  await optionsPage.screenshot({ path: path.join(resultPath, "native-logs.png"), fullPage: true, animations: "disabled" });
  await optionsPage.locator('[data-route="rules"]').click();
  await optionsPage.locator("#toast").waitFor({ state: "hidden" });
  await optionsPage.evaluate(() => scrollTo(0, 0));
  await optionsPage.mouse.move(1400, 20);
  await optionsPage.screenshot({ path: path.join(resultPath, "native-options.png"), fullPage: true, animations: "disabled" });
  checks.push({ label: "UI absolute preset/rule save, matching preview, helper status, and final-path logs" });
  console.log("PASS absolute-mode settings and native-status user interface");
}

async function suite() {
  assert.equal(process.platform, "win32", "Native Messaging smoke suite currently targets Windows");
  assert.equal(await exists(chromium.executablePath()), true, "Install the test browser with npx playwright install chromium");
  assert.equal(await exists(helperPath), true, "Build native/bin/download-path-host.exe before running this suite");
  assert.equal(await exists(path.join(root, "dist", "manifest.json")), true, "Run npm run build before this suite");
  await mkdir(resultPath, { recursive: true });
  await cp(path.join(root, "dist"), extensionPath, { recursive: true });
  const backgroundPath = path.join(extensionPath, "background", "index.js");
  const background = await readFile(backgroundPath, "utf8");
  assert.ok(background.includes("com.download_path_router.host"), "built extension contains the native-host identifier");
  await writeFile(backgroundPath, background.replaceAll("com.download_path_router.host", testHost));
  await mkdir(path.join(profilePath, "Default"), { recursive: true });
  await mkdir(downloadPath, { recursive: true });
  await mkdir(nativeStatePath, { recursive: true });
  await writeFile(path.join(profilePath, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadPath, prompt_for_download: false, directory_upgrade: true } }));
  await startServer();
  await launch();
  await registerHost();
  const nativeStatus = await message({ type: "GET_NATIVE_STATUS" });
  assert.equal(nativeStatus.ok, true);
  assert.equal(nativeStatus.available, true, `registered helper is available: ${JSON.stringify(nativeStatus)}`);
  assert.equal(typeof nativeStatus.version, "string");
  checks.push({ label: "registered isolated helper answers native status", version: nativeStatus.version });

  await setSettings(settings());
  const first = await trigger("绝对路径.txt", "absolute move");
  const firstLog = await waitMoved(first, "绝对路径.txt", "absolute move");
  assert.equal(path.basename(firstLog.finalPath), "绝对路径.txt");
  const duplicate = await trigger("绝对路径.txt", "duplicate target is preserved");
  const duplicateLog = await waitMoved(duplicate, "绝对路径.txt", "duplicate target is preserved");
  assert.notEqual(duplicateLog.finalPath, firstLog.finalPath, "duplicate chooses a new destination instead of overwriting");
  assert.equal(path.extname(duplicateLog.finalPath), ".txt", "duplicate retains extension");
  assert.equal(await readFile(firstLog.finalPath, "utf8"), fixtureContent("绝对路径.txt", "absolute move"), "original destination is unchanged");

  await unregisterHost();
  const missingStatus = await message({ type: "GET_NATIVE_STATUS" });
  assert.equal(missingStatus.available, false, "an unregistered helper is shown as unavailable");
  const failed = await trigger("稍后重试.txt", "missing helper failure");
  const failedLog = await waitFailed(failed, "稍后重试.txt", "missing helper failure");
  await registerHost();
  const retry = await message({ type: "RETRY_MOVE", jobId: failedLog.jobId });
  assert.equal(retry.ok, true, `single retry is accepted: ${JSON.stringify(retry)}`);
  await waitMoved(failed, "稍后重试.txt", "missing helper failure");

  await unregisterHost();
  const restartFailure = await trigger("重启后重试.txt", "restart-persistent failure");
  const restartLog = await waitFailed(restartFailure, "重启后重试.txt", "restart-persistent failure");
  await context.close();
  context = undefined;
  await launch();
  assert.ok((await state()).pendingCount >= 1, "pending move survives a real browser restart");
  assert.equal(await readFile(restartFailure.filename, "utf8"), fixtureContent("重启后重试.txt", "restart-persistent failure"));
  await registerHost();
  const batch = await message({ type: "RETRY_PENDING_MOVES" });
  assert.equal(batch.ok, true, `batch retry succeeds: ${JSON.stringify(batch)}`);
  const restoredLog = await waitMoved(restartFailure, "重启后重试.txt", "restart-persistent failure");
  assert.equal(restoredLog.jobId, restartLog.jobId, "restart resumes the same persisted job");
  await poll(async () => (await state()).pendingCount === 0, "successful retries clear all pending tasks");

  await unregisterHost();
  await setSettings(settings("relative", "Relative/兼容"));
  const relative = await trigger("相对模式.txt", "relative mode remains compatible");
  assert.equal(path.resolve(relative.filename), path.resolve(downloadPath, "Relative/兼容/相对模式.txt"));
  assert.equal(await readFile(relative.filename, "utf8"), fixtureContent("相对模式.txt", "relative mode remains compatible"));
  assert.equal((await state()).pendingCount, 0, "relative downloads do not require native pending jobs");
  checks.push({ label: "relative mode remains compatible without a registered helper", filename: relative.filename });
  console.log(`PASS relative mode remains compatible without a registered helper`);
  await registerHost();
  await nativeUiSuite();
  assert.deepEqual(pageErrors, [], "extension pages have no uncaught errors");
}

let failure;
try {
  await Promise.race([
    suite(),
    new Promise((_, reject) => { globalTimer = setTimeout(() => reject(new Error("Native browser smoke suite exceeded 180 seconds.")), 180_000); }),
  ]);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  clearTimeout(globalTimer);
  let observedDownloads = [];
  let observedState = {};
  try { observedDownloads = await downloads(); } catch {}
  try { observedState = await state(); } catch {}
  if (context) await context.close().catch((error) => { failure ??= error; });
  await unregisterHost().catch((error) => { failure ??= error; console.error(`Test registry cleanup failed: ${error}`); });
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await mkdir(resultPath, { recursive: true });
  await writeFile(path.join(resultPath, "report.json"), JSON.stringify({
    ok: !failure, error: failure ? String(failure) : undefined,
    testHost, registryKey, registryKeyRemoved: !hostRegistered,
    checks, pageErrors, downloads: observedDownloads, state: observedState,
  }, null, 2));
}
if (failure) {
  process.exitCode = 1;
  console.error(`Failure evidence: ${resultPath}`);
} else {
  console.log(`Native browser smoke checks passed. Evidence: ${resultPath}`);
}
