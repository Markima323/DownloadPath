import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// A fresh persistent profile exercises Chromium's real download target selection.
// This script never attaches to the user's browser or modifies their preferences.
const root = fileURLToPath(new URL("../", import.meta.url));
const extensionPath = path.join(root, "dist");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const resultPath = path.join(root, "test-results", `browser-${runId}`);
const profilePath = path.join(resultPath, "profile");
const downloadPath = path.join(resultPath, "downloads");
const checks = [];
const pageErrors = [];
let context;
let worker;
let optionsPage;
let server;
let localOrigin;
let cdnOrigin;

async function poll(operation, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function startServer() {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.searchParams.get("name") ?? "smoke.txt";
    const body = `download-path-smoke:${name}`;
    if (url.pathname === "/download") {
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="download.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { Location: `${cdnOrigin}/download?name=${encodeURIComponent(name)}` });
      response.end();
      return;
    }
    if (url.pathname === "/page") {
      const target = url.searchParams.get("target") ?? `${localOrigin}/download?name=${encodeURIComponent(name)}`;
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": url.searchParams.get("noReferrer") === "1" ? "no-referrer" : "unsafe-url",
      });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Download smoke fixture</title>
        <a id="download" href="${escapeAttribute(target)}">Download fixture</a>
        <button id="blob" type="button">Generate blob fixture</button>
        <script>document.getElementById('blob').onclick = () => {
          const name = new URL(location.href).searchParams.get('name') || 'generated.txt';
          const address = URL.createObjectURL(new Blob(['download-path-smoke:' + name], { type: 'text/plain' }));
          const anchor = document.createElement('a'); anchor.href = address; anchor.download = name;
          document.body.append(anchor); anchor.click(); anchor.remove();
          setTimeout(() => URL.revokeObjectURL(address), 10000);
        };</script></html>`);
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  localOrigin = `http://localhost:${port}`;
  cdnOrigin = `http://127.0.0.1:${port}`;
}

async function launch() {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1080 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--host-resolver-rules=MAP localhost 127.0.0.1",
    ],
    timeout: 30_000,
  });
  // Playwright otherwise sets deny or allowAndName. Restoring default behavior
  // leaves filename choice and subdirectory handling to Chrome and the extension.
  const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
  await cdp.detach();
  worker = context.serviceWorkers().find((entry) => entry.url().startsWith("chrome-extension://"))
    ?? await context.waitForEvent("serviceworker", { predicate: (entry) => entry.url().startsWith("chrome-extension://"), timeout: 20_000 });
  const extensionId = new URL(worker.url()).hostname;
  optionsPage = await context.newPage();
  optionsPage.on("pageerror", (error) => pageErrors.push(String(error)));
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await optionsPage.locator("#global-enabled").waitFor();
  await poll(() => optionsPage.locator("#global-enabled").isEnabled(), "options page connects to worker");
}

function makeSettings(source = "url", domain = "localhost", subdirectory = "Routed/软件", enabled = true) {
  return {
    version: 1,
    enabled,
    presets: [{ id: "smoke-preset", name: "浏览器验证", subdirectory }],
    rules: [{
      id: "smoke-rule", name: "本地烟雾测试", enabled: true,
      domain, includeSubdomains: false, source,
      presetId: "smoke-preset", priority: 10,
    }],
  };
}

async function setSettings(settings) {
  await worker.evaluate((value) => chrome.storage.local.set({ settings: value }), settings);
  await poll(async () => {
    const state = await optionsPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    return state.ok && JSON.stringify(state.settings) === JSON.stringify(settings);
  }, "worker observes saved settings");
}

async function allDownloads() {
  return worker.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 }));
}

async function storedSettings() {
  return worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
}

async function settingsMatch(predicate, label) {
  return poll(async () => {
    const settings = await storedSettings();
    return predicate(settings) ? settings : undefined;
  }, label);
}

async function route(name) {
  await optionsPage.locator(`[data-route="${name}"]`).click();
  await optionsPage.locator(`#panel-${name}`).waitFor({ state: "visible" });
}

async function confirm() {
  await optionsPage.locator("#confirm-dialog").waitFor({ state: "visible" });
  await optionsPage.locator("#confirm-accept").click();
  await optionsPage.locator("#confirm-dialog").waitFor({ state: "hidden" });
}

async function concurrencySuite() {
  const extensionId = new URL(worker.url()).hostname;
  const otherClient = await context.newPage();
  otherClient.on("pageerror", (error) => pageErrors.push(String(error)));
  await otherClient.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  try {
    const [a, b] = await Promise.all([
      optionsPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })),
      otherClient.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(typeof a.revision, "string", "state responses contain a revision");
    assert.equal(a.revision, b.revision, "two clients start with the same revision");
    const updateA = structuredClone(a.settings);
    const updateB = structuredClone(b.settings);
    updateA.rules[0].name = "并发保存 · A";
    updateB.rules[0].name = "旧快照覆盖 · B";
    const savedA = await optionsPage.evaluate((request) => chrome.runtime.sendMessage(request), {
      type: "SAVE_SETTINGS", settings: updateA, revision: a.revision,
    });
    assert.equal(savedA.ok, true, "first client saves its current revision");
    const rejectedB = await otherClient.evaluate((request) => chrome.runtime.sendMessage(request), {
      type: "SAVE_SETTINGS", settings: updateB, revision: b.revision,
    });
    assert.equal(rejectedB.ok, false, "stale second client cannot overwrite the first client's update");
    assert.deepEqual(await storedSettings(), updateA, "first client's complete configuration survives stale save");
    for (const enabled of [false, true]) {
      const toggled = await otherClient.evaluate((value) => chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: value }), enabled);
      assert.equal(toggled.ok, true, "atomic switch request succeeds");
      const latest = await storedSettings();
      assert.equal(latest.enabled, enabled);
      assert.deepEqual(latest.rules, updateA.rules, "atomic switch preserves newly saved rules");
      assert.deepEqual(latest.presets, updateA.presets, "atomic switch preserves newly saved presets");
    }
    await setSettings(a.settings);
    checks.push({ label: "two-client revision conflict rejection and atomic global switch" });
    console.log("PASS two-client revision conflict rejection and atomic global switch");
  } finally {
    await otherClient.close();
  }
}

async function uiSuite() {
  const presetName = "工作报表 · 界面验证";
  const initialRuleName = "本地报表 · 界面验证";
  const editedRuleName = "本地报表 · 已编辑";

  await optionsPage.reload();
  await poll(() => optionsPage.locator("#global-enabled").isEnabled(), "options reconnects after reload");
  assert.equal(await optionsPage.locator("#rules-list tr").count(), 1, "saved rule appears in settings");
  await route("presets");
  await optionsPage.locator("#preset-name").fill(presetName);
  await optionsPage.locator("#preset-directory").fill("Work/Reports");
  await optionsPage.locator("#save-preset").click();
  let saved = await settingsMatch((settings) => settings.presets.length === 2, "new preset saved from form");
  const createdPreset = saved.presets.find((preset) => preset.name === presetName);
  assert.equal(createdPreset.subdirectory, "Work/Reports");

  await route("rules");
  await optionsPage.locator("#rule-name").fill(initialRuleName);
  await optionsPage.locator("#rule-domain").fill(`${localOrigin}/reports`);
  await optionsPage.locator("#rule-source").selectOption("url");
  await optionsPage.locator("#rule-preset").selectOption(createdPreset.id);
  await optionsPage.locator("#rule-priority").fill("20");
  await optionsPage.locator("#save-rule").click();
  saved = await settingsMatch((settings) => settings.rules.length === 2, "new rule saved from form");
  const createdRule = saved.rules.find((rule) => rule.name === initialRuleName);
  assert.equal(createdRule.domain, "localhost", "pasted URL is normalized to hostname");
  assert.equal(createdRule.presetId, createdPreset.id);
  await poll(() => optionsPage.locator("#rules-list tr").count().then((count) => count === 2), "two rules rendered");

  await optionsPage.getByRole("button", { name: `编辑规则“${initialRuleName}”`, exact: true }).click();
  await optionsPage.locator("#rule-name").fill(editedRuleName);
  await optionsPage.locator("#rule-priority").fill("25");
  await optionsPage.locator("#save-rule").click();
  saved = await settingsMatch((settings) => settings.rules.some((rule) => rule.id === createdRule.id && rule.name === editedRuleName && rule.priority === 25), "edited rule saved in place");
  assert.equal(saved.rules.length, 2, "editing does not create a duplicate rule");

  await optionsPage.locator("#test-referrer").fill("");
  await optionsPage.locator("#test-url").fill(`${localOrigin}/download?name=preview.txt`);
  await optionsPage.locator("#test-filename").fill("preview.txt");
  await optionsPage.locator('#test-form button[type="submit"]').click();
  await poll(() => optionsPage.locator("#test-result").innerText().then((text) => text.includes("Work/Reports/preview.txt")), "matching preview reflects saved rule");
  assert.match(await optionsPage.locator("#test-result").innerText(), /本地报表 · 已编辑/);
  await triggerDownload({ name: "ui-created-rule.txt", expectedRelativePath: "Work/Reports/ui-created-rule.txt", label: "rule created and edited in settings routes a real file" });

  await optionsPage.getByRole("button", { name: `暂停规则“${editedRuleName}”`, exact: true }).click();
  await settingsMatch((settings) => settings.rules.find((rule) => rule.id === createdRule.id)?.enabled === false, "rule pause button persists state");
  await optionsPage.getByRole("button", { name: `启用规则“${editedRuleName}”`, exact: true }).click();
  await settingsMatch((settings) => settings.rules.find((rule) => rule.id === createdRule.id)?.enabled === true, "rule enable button persists state");

  const beforeExport = await storedSettings();
  const beforeDownloadIds = new Set((await allDownloads()).map((item) => item.id));
  await optionsPage.locator("#export-config").click();
  const exported = await poll(async () => {
    const item = (await allDownloads()).find((entry) => !beforeDownloadIds.has(entry.id));
    if (item?.state === "interrupted") throw new Error(`Configuration export interrupted: ${item.error}`);
    return item?.state === "complete" ? item : undefined;
  }, "configuration export is really downloaded");
  assert.equal(path.dirname(exported.filename), downloadPath, "export uses default root");
  const exportedBytes = await readFile(exported.filename);
  assert.deepEqual(JSON.parse(exportedBytes.toString("utf8")), beforeExport, "export contains exactly settings without logs");

  await route("presets");
  await optionsPage.getByRole("button", { name: `删除预设“${presetName}”`, exact: true }).click();
  await poll(() => optionsPage.locator("#toast").innerText().then((text) => text.includes("仍有关联")), "referenced preset deletion is blocked");
  assert.equal(await optionsPage.locator("#confirm-dialog").isVisible(), false, "referenced preset does not open deletion confirmation");
  assert.deepEqual(await storedSettings(), beforeExport, "blocked preset deletion preserves configuration");

  await route("rules");
  await optionsPage.getByRole("button", { name: `删除规则“${editedRuleName}”`, exact: true }).click();
  await confirm();
  await settingsMatch((settings) => settings.rules.length === 1, "rule removed after confirmation");
  await route("presets");
  await optionsPage.getByRole("button", { name: `删除预设“${presetName}”`, exact: true }).click();
  await confirm();
  await settingsMatch((settings) => settings.presets.length === 1, "unreferenced preset removed after confirmation");

  await route("rules");
  const beforeBadImport = await storedSettings();
  await optionsPage.locator("#import-file").setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{not JSON") });
  await poll(() => optionsPage.locator("#toast").innerText().then((text) => text.includes("不是有效的 JSON")), "malformed JSON import shows error");
  assert.deepEqual(await storedSettings(), beforeBadImport, "malformed JSON does not change configuration");
  await optionsPage.locator("#import-file").setInputFiles({ name: "unsupported.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...beforeBadImport, version: 999 })) });
  await poll(() => optionsPage.locator("#toast").innerText().then((text) => text.includes("不支持此配置版本")), "invalid configuration import shows error");
  assert.deepEqual(await storedSettings(), beforeBadImport, "invalid configuration does not change configuration");

  await optionsPage.locator("#import-file").setInputFiles({ name: "restored.json", mimeType: "application/json", buffer: exportedBytes });
  await confirm();
  await settingsMatch((settings) => JSON.stringify(settings) === JSON.stringify(beforeExport), "valid import restores exported configuration after confirmation");
  await poll(() => optionsPage.locator("#rules-list tr").count().then((count) => count === 2), "imported rules rendered");

  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  popup.on("pageerror", (error) => pageErrors.push(String(error)));
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await poll(() => popup.locator("#enabled").isEnabled(), "popup connects to worker");
  await popup.locator("#enabled").uncheck();
  await settingsMatch((settings) => settings.enabled === false, "popup switch persists paused state");
  await poll(() => optionsPage.locator("#global-enabled").isChecked().then((checked) => !checked), "popup switch updates open settings");
  await popup.reload();
  await poll(() => popup.locator("#enabled").isEnabled(), "popup reconnects");
  assert.equal(await popup.locator("#enabled").isChecked(), false, "paused state survives popup reload");
  await popup.locator("#enabled").check();
  await settingsMatch((settings) => settings.enabled === true, "popup switch re-enables routing");
  await poll(() => optionsPage.locator("#global-enabled").isChecked(), "settings observes popup re-enable");
  await popup.screenshot({ path: path.join(resultPath, "popup.png"), fullPage: true, animations: "disabled" });
  await popup.close();

  await route("logs");
  await poll(() => optionsPage.locator("#logs-list article").count().then((count) => count > 0), "real download logs are visible");
  await optionsPage.screenshot({ path: path.join(resultPath, "logs.png"), fullPage: true, animations: "disabled" });
  await optionsPage.locator("#clear-logs").click();
  await confirm();
  await poll(async () => (await worker.evaluate(() => chrome.storage.local.get("logs"))).logs?.length === 0, "clear logs persists empty history");
  assert.equal(await readFile(path.join(downloadPath, "Work/Reports/ui-created-rule.txt"), "utf8"), "download-path-smoke:ui-created-rule.txt", "clearing logs does not remove downloaded files");

  await route("rules");
  await optionsPage.locator("#toast").waitFor({ state: "hidden" });
  await optionsPage.evaluate(() => scrollTo(0, 0));
  await optionsPage.mouse.move(1400, 20);
  await optionsPage.screenshot({ path: path.join(resultPath, "options.png"), fullPage: true, animations: "disabled" });
  assert.deepEqual(pageErrors, [], "extension pages have no uncaught JavaScript errors");
  checks.push({ label: "settings CRUD, validation, import/export, popup synchronization, and log cleanup" });
  console.log("PASS settings CRUD, matching preview, import/export, popup synchronization, and log cleanup");
}

async function triggerDownload({ name, target, expectedRelativePath, blob = false, noReferrer = false, label }) {
  const before = new Set((await allDownloads()).map((item) => item.id));
  const page = await context.newPage();
  const pageUrl = new URL(`${localOrigin}/page`);
  pageUrl.searchParams.set("name", name);
  if (target) pageUrl.searchParams.set("target", target);
  if (noReferrer) pageUrl.searchParams.set("noReferrer", "1");
  try {
    await page.goto(pageUrl.href);
    await page.locator(blob ? "#blob" : "#download").click();
    const item = await poll(async () => {
      const latest = (await allDownloads()).find((entry) => !before.has(entry.id));
      if (latest?.state === "interrupted") throw new Error(`${label}: download interrupted (${latest.error})`);
      return latest?.state === "complete" ? latest : undefined;
    }, `${label}: download completes`);
    assert.equal(path.resolve(item.filename), path.resolve(downloadPath, expectedRelativePath), `${label}: actual Chrome target`);
    assert.equal(await readFile(item.filename, "utf8"), `download-path-smoke:${name}`, `${label}: actual file content`);
    checks.push({ label, filename: item.filename, url: item.url, finalUrl: item.finalUrl, referrer: item.referrer });
    console.log(`PASS ${label} -> ${path.relative(downloadPath, item.filename)}`);
    return item;
  } finally {
    await page.close();
  }
}

async function suite() {
  await access(path.join(extensionPath, "manifest.json")).catch(() => {
    throw new Error("dist/manifest.json is missing. Run npm run build before npm run test:browser.");
  });
  await access(chromium.executablePath()).catch(() => {
    throw new Error("Playwright Chromium is missing. Run npx playwright install chromium first.");
  });
  await mkdir(path.join(profilePath, "Default"), { recursive: true });
  await mkdir(downloadPath, { recursive: true });
  await writeFile(path.join(profilePath, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloadPath, prompt_for_download: false, directory_upgrade: true },
    browser: { check_default_browser: false },
  }));
  await startServer();
  await launch();

  await setSettings(makeSettings());
  await triggerDownload({ name: "安装包.txt", expectedRelativePath: "Routed/软件/安装包.txt", label: "initial URL routing with Unicode path and filename" });
  await triggerDownload({ name: "安装包.txt", expectedRelativePath: "Routed/软件/安装包 (1).txt", label: "duplicate filenames are uniquified" });
  assert.equal(await readFile(path.join(downloadPath, "Routed/软件/安装包.txt"), "utf8"), "download-path-smoke:安装包.txt", "original duplicate file preserved");

  await setSettings(makeSettings("url", "unmatched.example"));
  await triggerDownload({ name: "unmatched.txt", expectedRelativePath: "unmatched.txt", label: "unmatched download uses native default root" });

  await setSettings(makeSettings("referrer", "localhost", "Routed/Referrer"));
  const referrer = await triggerDownload({
    name: "referrer.txt", target: `${localOrigin}/redirect?name=referrer.txt`,
    expectedRelativePath: "Routed/Referrer/referrer.txt", label: "source page survives cross-domain CDN redirect",
  });
  assert.equal(new URL(referrer.referrer).hostname, "localhost");
  assert.equal(new URL(referrer.finalUrl).hostname, "127.0.0.1");

  await triggerDownload({
    name: "no-referrer.txt", target: `${cdnOrigin}/download?name=no-referrer.txt`, noReferrer: true,
    expectedRelativePath: "no-referrer.txt", label: "missing referrer does not guess source page",
  });

  await setSettings(makeSettings("finalUrl", "127.0.0.1", "Routed/Final"));
  await triggerDownload({
    name: "final.txt", target: `${localOrigin}/redirect?name=final.txt`,
    expectedRelativePath: "Routed/Final/final.txt", label: "final CDN URL routing",
  });

  await setSettings(makeSettings("url", "localhost", "Routed/Blob"));
  await triggerDownload({ name: "generated.txt", blob: true, expectedRelativePath: "Routed/Blob/generated.txt", label: "HTTP-origin blob download routing" });

  await setSettings(makeSettings("url", "localhost", "Routed/Disabled", false));
  await triggerDownload({ name: "disabled.txt", expectedRelativePath: "disabled.txt", label: "global switch leaves downloads in default root" });

  const persistentSettings = makeSettings("url", "localhost", "Routed/Persisted");
  await setSettings(persistentSettings);
  await context.close();
  context = undefined;
  await launch();
  const restored = await worker.evaluate(() => chrome.storage.local.get("settings"));
  assert.deepEqual(restored.settings, persistentSettings, "rules persist through browser restart");
  await triggerDownload({ name: "restarted.txt", expectedRelativePath: "Routed/Persisted/restarted.txt", label: "saved routing works after a real browser restart" });

  await concurrencySuite();
  await uiSuite();
}

let globalTimer;
try {
  await Promise.race([
    suite(),
    new Promise((_, reject) => {
      globalTimer = setTimeout(() => reject(new Error("Browser smoke suite exceeded 180 seconds.")), 180_000);
    }),
  ]);
  await writeFile(path.join(resultPath, "report.json"), JSON.stringify({ ok: true, checks, pageErrors }, null, 2));
  console.log(`Browser smoke checks passed. Evidence: ${resultPath}`);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  await mkdir(resultPath, { recursive: true });
  let downloads = [];
  let storage = {};
  try { downloads = await allDownloads(); } catch {}
  try { storage = await worker.evaluate(() => chrome.storage.local.get(null)); } catch {}
  await writeFile(path.join(resultPath, "report.json"), JSON.stringify({ ok: false, error: String(error), checks, pageErrors, downloads, storage }, null, 2));
  console.error(`Failure evidence: ${resultPath}`);
} finally {
  clearTimeout(globalTimer);
  if (context) await context.close().catch(() => undefined);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
