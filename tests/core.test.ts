import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSettings,
  MAX_PRESETS,
  MAX_RULES,
  normalizeDomain,
  normalizeSubdirectory,
  resolveDownload,
  validateSettings,
  validateSubdirectory,
  type DownloadContext,
  type DownloadRule,
  type Settings,
} from "../src/shared/index.ts";

const download: DownloadContext = {
  url: "https://download.example.com/start?token=secret",
  finalUrl: "https://cdn.example.net/package.zip",
  referrer: "https://portal.example.com/releases",
  filename: "C:\\Users\\user\\Downloads\\安装包.zip",
};

function rule(overrides: Partial<DownloadRule> = {}): DownloadRule {
  return {
    id: "rule-1",
    name: "软件来源",
    enabled: true,
    domain: "portal.example.com",
    includeSubdomains: false,
    source: "referrer",
    presetId: "software",
    priority: 0,
    ...overrides,
  };
}

function settings(...rules: DownloadRule[]): Settings {
  return { ...createDefaultSettings(), rules };
}

test("defaults are unbound and independent", () => {
  const a = createDefaultSettings();
  const b = createDefaultSettings();
  assert.equal(a.rules.length, 0);
  assert.equal(a.presets.length, 3);
  a.presets[0]!.name = "changed";
  assert.equal(b.presets[0]!.name, "软件");
  assert.equal(resolveDownload(a, download).kind, "unmatched");
});

test("normalizes HTTP URLs, case, trailing root dot and IDN", () => {
  assert.equal(normalizeDomain(" HTTPS://Portal.Example.com/releases?q=1 "), "portal.example.com");
  assert.equal(normalizeDomain("example.com."), "example.com");
  assert.equal(normalizeDomain("例子.中国"), "xn--fsqu00a.xn--fiqs8s");
  assert.equal(normalizeDomain("localhost"), "localhost");
  assert.equal(normalizeDomain("[::1]"), "[::1]");
  assert.equal(normalizeDomain("https://example.com:8443/report"), "example.com");
});

test("rejects malformed, wildcard, non-HTTP or credentialed domains", () => {
  for (const domain of ["", "*.example.com", "https://", "a..com", "-a.com", "a-.com", "a b.com", "ftp://example.com", "example.com/path", "example.com:443", "https://user:password@example.com", "https://good.com\\@evil.com"]) {
    assert.throws(() => normalizeDomain(domain), { name: "Error" }, domain);
  }
});

test("validates and canonicalizes imported settings without mutating input", () => {
  const input = settings(rule({ domain: "HTTPS://PORTAL.EXAMPLE.COM/page" }));
  input.presets[0]!.subdirectory = "软件\\安装包";
  const validated = validateSettings(input);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.settings.rules[0]!.domain, "portal.example.com");
  assert.equal(validated.settings.presets[0]!.subdirectory, "软件/安装包");
  assert.equal(input.presets[0]!.subdirectory, "软件\\安装包");
  assert.notEqual(validated.settings, input);
});

test("retains Unicode basename and puts it in the preset subdirectory", () => {
  assert.deepEqual(resolveDownload(settings(rule()), download), {
    kind: "matched",
    rule: rule(),
    preset: { id: "software", name: "软件", subdirectory: "Software" },
    relativePath: "Software/安装包.zip",
  });
});

test("source choice distinguishes portal, initial link, and CDN", () => {
  for (const [source, domain] of [["referrer", "portal.example.com"], ["url", "download.example.com"], ["finalUrl", "cdn.example.net"]] as const) {
    assert.equal(resolveDownload(settings(rule({ source, domain })), download).kind, "matched");
    assert.equal(resolveDownload(settings(rule({ source, domain: "other.example.com" })), download).kind, "unmatched");
  }
});

test("missing referrer is not inferred from another URL", () => {
  const context = { ...download, referrer: undefined, url: "https://portal.example.com/file.zip" };
  assert.equal(resolveDownload(settings(rule()), context).kind, "unmatched");
  assert.equal(resolveDownload(settings(rule({ source: "url" })), context).kind, "matched");
});

test("final URL is not silently inferred from initial URL", () => {
  const context = { ...download, finalUrl: undefined };
  assert.equal(resolveDownload(settings(rule({ source: "finalUrl", domain: "download.example.com" })), context).kind, "unmatched");
});

test("exact domain and subdomain matches respect label boundaries", () => {
  const exact = settings(rule({ domain: "example.com" }));
  assert.equal(resolveDownload(exact, download).kind, "unmatched");
  const withSubs = settings(rule({ domain: "example.com", includeSubdomains: true }));
  assert.equal(resolveDownload(withSubs, download).kind, "matched");
  for (const hostname of ["notexample.com", "example.com.evil.test", "example-com.test"]) {
    assert.equal(resolveDownload(withSubs, { ...download, referrer: `https://${hostname}/` }).kind, "unmatched");
  }
  assert.equal(resolveDownload(withSubs, { ...download, referrer: "https://example.com/" }).kind, "matched");
});

test("highest priority wins and ties retain array order without sorting input", () => {
  const low = rule({ id: "low", priority: 1 });
  const high = rule({ id: "high", priority: 10, presetId: "documents" });
  const tied = rule({ id: "tie", priority: 10, presetId: "images" });
  const config = settings(low, high, tied);
  const result = resolveDownload(config, download);
  assert.equal(result.kind, "matched");
  if (result.kind === "matched") assert.equal(result.rule.id, "high");
  assert.deepEqual(config.rules.map((entry) => entry.id), ["low", "high", "tie"]);
});

test("global and rule switches stop intervention", () => {
  assert.equal(resolveDownload({ ...settings(rule()), enabled: false }, download).kind, "disabled");
  assert.equal(resolveDownload(settings(rule({ enabled: false })), download).kind, "unmatched");
});

test("accepts valid nested and Unicode paths with explicit separator normalization", () => {
  for (const path of ["Software", "工作/报表", "软件\\安装包", "one.two/three-four", "目录 名称"]) {
    assert.deepEqual(validateSubdirectory(path), [], path);
  }
  assert.equal(normalizeSubdirectory("工作\\报表"), "工作/报表");
  const config = settings(rule());
  config.presets[0]!.subdirectory = "工作\\报表";
  const result = resolveDownload(config, download);
  assert.equal(result.kind, "matched");
  if (result.kind === "matched") assert.equal(result.relativePath, "工作/报表/安装包.zip");
});

test("rejects path escape, absolute paths, ambiguous components and device names", () => {
  for (const path of ["", "../secret", "a/../../secret", "a/./b", ".", "..", "/tmp", "C:\\Work", "C:Work", "\\\\server\\share", "a//b", "a/", "a\\", "a?b", "a:b", "a\u0000b", "a\nb", "folder.", "folder ", "folder/CON", "NUL.txt", "COM1", "lpt9.csv", "COM¹.txt", "CON .txt", "a/ ", "a/.. "]) {
    assert.notEqual(validateSubdirectory(path).length, 0, JSON.stringify(path));
  }
});

test("unsafe preset data causes fallback rather than path suggestion", () => {
  const config = settings(rule());
  config.presets[0]!.subdirectory = "../../escape";
  assert.equal(resolveDownload(config, download).kind, "invalid");
  assert.equal(resolveDownload(settings(rule({ presetId: "missing" })), download).kind, "invalid");
});

test("download path components cannot escape selected directory", () => {
  const config = settings(rule());
  for (const filename of ["../../secret.zip", "..\\..\\secret.zip", "C:\\outside\\secret.zip", "/tmp/secret.zip"]) {
    const result = resolveDownload(config, { ...download, filename });
    assert.equal(result.kind, "matched");
    if (result.kind === "matched") assert.equal(result.relativePath, "Software/secret.zip");
  }
});

test("sanitizes invalid filename characters and device names while retaining extension", () => {
  for (const [filename, expected] of [["CON.zip", "_CON.zip"], ["CON .zip", "_CON .zip"], ["report?.csv", "report_.csv"], ["report.csv. ", "report.csv"], ["a\u0000b.txt", "a_b.txt"]]) {
    const result = resolveDownload(settings(rule()), { ...download, filename: filename! });
    assert.equal(result.kind, "matched");
    if (result.kind === "matched") assert.equal(result.relativePath, `Software/${expected}`);
  }
  for (const filename of ["", ".", "..", "a/", "a\\", "...   ", `${"a".repeat(256)}.zip`]) {
    assert.equal(resolveDownload(settings(rule()), { ...download, filename }).kind, "invalid", filename);
  }
});

test("handles HTTP-origin blob URLs but does not guess opaque or non-HTTP origins", () => {
  const config = settings(rule({ source: "url", domain: "portal.example.com" }));
  assert.equal(resolveDownload(config, { ...download, url: "blob:https://portal.example.com/1234" }).kind, "matched");
  for (const url of ["blob:null/1234", "data:application/pdf;base64,AA==", "file:///tmp/a.zip", "not-a-url", "about:blank"]) {
    assert.equal(resolveDownload(config, { ...download, url }).kind, "unmatched", url);
  }
});

test("malformed configurations and unknown versions are rejected", () => {
  for (const value of [null, [], "string", 42, {}, { ...settings(), version: 2 }, { ...settings(), enabled: "true" }, { ...settings(), presets: null }, { ...settings(), rules: {} }, { ...settings(), extra: true }]) {
    assert.equal(validateSettings(value).ok, false, JSON.stringify(value));
  }
});

test("rejects duplicate IDs, orphan rules, unsafe imported paths, and invalid fields", () => {
  const duplicatePresets = settings();
  duplicatePresets.presets.push({ ...duplicatePresets.presets[0]! });
  const invalidInputs: unknown[] = [
    duplicatePresets,
    settings(rule(), rule()),
    settings(rule({ presetId: "missing" })),
    settings(rule({ source: "page" as never })),
    settings(rule({ priority: 1.5 })),
    settings(rule({ priority: Infinity })),
    settings(rule({ priority: 10001 })),
    settings(rule({ name: " " })),
    settings(rule({ domain: "*" })),
    settings(rule({ id: "__proto__" })),
    { ...settings(), presets: [{ id: "x", name: "X", subdirectory: "../secret" }] },
    { ...settings(), presets: [{ id: "x", name: "X", subdirectory: "Folder", extra: true }] },
    { ...settings(), presets: [null] },
    { ...settings(), rules: [null] },
  ];
  for (const input of invalidInputs) assert.equal(validateSettings(input).ok, false, JSON.stringify(input));
});

test("settings limits bound configuration processing", () => {
  assert.equal(validateSettings({ ...settings(), presets: Array(MAX_PRESETS + 1).fill(null) }).ok, false);
  assert.equal(validateSettings({ ...settings(), rules: Array(MAX_RULES + 1).fill(null) }).ok, false);
});

test("an empty configuration is valid and unmatched", () => {
  const config: Settings = { version: 1, enabled: true, presets: [], rules: [] };
  assert.equal(validateSettings(config).ok, true);
  assert.equal(resolveDownload(config, download).kind, "unmatched");
});
