import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(project, "native", "bin", "download-path-host.exe");
const origin = `chrome-extension://${"a".repeat(32)}/`;
const runRoot = path.join(project, "test-results", `native-host-${randomUUID()}`);
const windowsOnly = { skip: process.platform !== "win32" };

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function decodeFrames(bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(bytes.length - offset >= 4, "stdout must contain complete frame headers only");
    const length = bytes.readUInt32LE(offset);
    assert.ok(length > 0 && length <= 1024 * 1024, "response frame has a bounded length");
    offset += 4;
    assert.ok(bytes.length - offset >= length, "stdout must contain complete JSON frames only");
    frames.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return frames;
}

async function runRaw(bytes, { stateDirectory = path.join(runRoot, "protocol-state"), sourceOrigin = origin, fragmented = false } = {}) {
  await mkdir(stateDirectory, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [sourceOrigin], {
      cwd: project,
      env: { ...process.env, LOCALAPPDATA: stateDirectory },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Native host did not complete within 30 seconds")); }, 30_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    // A framing rejection may close stdin before all buffered bytes are consumed.
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(Buffer.concat(errors).toString("utf8"), "", "host must not emit unframed diagnostics");
        resolve({ code, responses: decodeFrames(Buffer.concat(output)) });
      } catch (error) { reject(error); }
    });
    if (fragmented) {
      for (let offset = 0; offset < bytes.length; offset += 3) child.stdin.write(bytes.subarray(offset, offset + 3));
      child.stdin.end();
    } else child.stdin.end(bytes);
  });
}

async function request(value, options) {
  const { responses, code } = await runRaw(frame(value), options);
  assert.equal(code, 0);
  assert.equal(responses.length, 1);
  return responses[0];
}

async function fixture({ basename = "安装 包.txt", contents = "download payload — 中文", sharedDestination } = {}) {
  const directory = path.join(runRoot, randomUUID());
  const jobId = randomUUID();
  const stageDirectory = path.join(directory, "stage", "_DownloadPathRouter", jobId);
  const sourcePath = path.join(stageDirectory, basename);
  const destinationDirectory = sharedDestination ?? path.join(directory, "destination");
  const stateDirectory = path.join(directory, "native-state");
  await mkdir(stageDirectory, { recursive: true });
  await writeFile(sourcePath, contents);
  const move = { operation: "move", jobId, sourcePath, destinationDirectory };
  return { directory, jobId, sourcePath, stageDirectory, destinationDirectory, stateDirectory, move, contents };
}

async function missing(filename) {
  await assert.rejects(stat(filename), { code: "ENOENT" });
}

async function seedMarker(f, { mode, state, finalPath, temporaryPath }) {
  const bytes = await readFile(f.sourcePath);
  const recordDirectory = path.join(f.stateDirectory, "DownloadPathRouter", "jobs");
  await mkdir(recordDirectory, { recursive: true });
  await writeFile(path.join(recordDirectory, `${f.jobId}.json`), JSON.stringify({
    Version: 1,
    JobId: f.jobId,
    SourcePath: f.sourcePath,
    DestinationDirectory: f.destinationDirectory,
    SourceLength: bytes.length,
    SourceHash: createHash("sha256").update(bytes).digest("hex"),
    FinalPath: finalPath,
    TemporaryPath: temporaryPath,
    Mode: mode,
    State: state,
  }));
}

test("native host handles fragmented framing, Unicode, and multiple frames without stdout noise", windowsOnly, async () => {
  const result = await runRaw(Buffer.concat([frame({ operation: "ping" }), frame({ operation: "ping", ignored: "中文" })]), { fragmented: true });
  assert.equal(result.code, 0);
  assert.deepEqual(result.responses, [{ ok: true, version: "0.2.0" }, { ok: true, version: "0.2.0" }]);
});

test("native host rejects malformed JSON, invalid UTF-8, operations, and origins", windowsOnly, async () => {
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.from("[]")]) {
    const { responses } = await runRaw(frame(bytes));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.equal(typeof responses[0].error, "string");
  }
  assert.equal((await request({ operation: "execute", command: "anything" })).ok, false);
  assert.equal((await request({ operation: "ping" }, { sourceOrigin: "https://evil.example/" })).ok, false);
});

test("native host bounds message lengths and rejects truncated frames", windowsOnly, async () => {
  for (const length of [0, 1024 * 1024 + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    const result = await runRaw(header);
    assert.equal(result.code, 1);
    assert.equal(result.responses[0]?.ok, false);
  }
  for (const bytes of [Buffer.from([1, 0]), Buffer.from([10, 0, 0, 0, 123])]) {
    const result = await runRaw(bytes);
    assert.equal(result.code, 1);
    assert.equal(result.responses[0]?.ok, false);
  }
});

test("native host moves a real completed staged file and removes only its empty job directory", windowsOnly, async () => {
  const f = await fixture();
  const response = await request(f.move, f);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.finalPath, path.join(f.destinationDirectory, "安装 包.txt"));
  assert.equal(await readFile(response.finalPath, "utf8"), f.contents);
  await missing(f.sourcePath);
  await missing(f.stageDirectory);
  assert.ok((await stat(path.dirname(f.stageDirectory))).isDirectory(), "staging root remains");
});

test("native host never overwrites existing files and preserves extensions when numbering", windowsOnly, async () => {
  const f = await fixture();
  await mkdir(f.destinationDirectory, { recursive: true });
  const existing = path.join(f.destinationDirectory, "安装 包.txt");
  await writeFile(existing, "existing payload");
  const response = await request(f.move, f);
  assert.equal(response.ok, true, response.error);
  assert.equal(path.basename(response.finalPath), "安装 包 (1).txt");
  assert.equal(await readFile(existing, "utf8"), "existing payload");
  assert.equal(await readFile(response.finalPath, "utf8"), f.contents);
});

test("native host serializes the same job and atomically resolves concurrent filename collisions", windowsOnly, async () => {
  const destinationDirectory = path.join(runRoot, `concurrent-${randomUUID()}`);
  const a = await fixture({ sharedDestination: destinationDirectory, contents: "first" });
  const b = await fixture({ sharedDestination: destinationDirectory, contents: "second" });
  const [one, two] = await Promise.all([request(a.move, a), request(b.move, b)]);
  assert.equal(one.ok, true, one.error);
  assert.equal(two.ok, true, two.error);
  assert.notEqual(one.finalPath.toLowerCase(), two.finalPath.toLowerCase());
  assert.equal(await readFile(one.finalPath, "utf8"), "first");
  assert.equal(await readFile(two.finalPath, "utf8"), "second");
  const c = await fixture();
  const duplicates = await Promise.all([request(c.move, c), request(c.move, c)]);
  assert.equal(duplicates[0].ok, true, duplicates[0].error);
  assert.deepEqual(duplicates[1], duplicates[0]);
});

test("native host persists idempotency and never deletes a later replacement source", windowsOnly, async () => {
  const f = await fixture();
  const first = await request(f.move, f);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(await request(f.move, f), first, "a new host process loads the completed job marker");
  await mkdir(f.stageDirectory, { recursive: true });
  await writeFile(f.sourcePath, "later replacement must survive");
  assert.deepEqual(await request(f.move, f), first);
  assert.equal(await readFile(f.sourcePath, "utf8"), "later replacement must survive");
  const reused = await request({ ...f.move, destinationDirectory: path.join(f.directory, "another-target") }, f);
  assert.equal(reused.ok, false);
  assert.equal(await readFile(first.finalPath, "utf8"), f.contents);
  assert.equal(await readFile(f.sourcePath, "utf8"), "later replacement must survive");
});

test("native host only accepts the exact staging root, matching UUID, and completed ordinary files", windowsOnly, async () => {
  const f = await fixture();
  const outside = path.join(f.directory, "outside.txt");
  await writeFile(outside, "outside");
  for (const move of [
    { ...f.move, sourcePath: outside },
    { ...f.move, jobId: randomUUID() },
    { ...f.move, jobId: `{${f.jobId}}` },
    { ...f.move, jobId: ` ${f.jobId} ` },
    { ...f.move, sourcePath: f.sourcePath.replace("_DownloadPathRouter", "x_DownloadPathRouter") },
    { ...f.move, sourcePath: `${f.sourcePath}:stream` },
  ]) assert.equal((await request(move, f)).ok, false);
  const incomplete = await fixture({ basename: "file.CRDOWNLOAD" });
  assert.equal((await request(incomplete.move, incomplete)).ok, false);
  assert.equal(await readFile(incomplete.sourcePath, "utf8"), incomplete.contents);
  const directorySource = await fixture();
  const leafDirectory = path.join(directorySource.stageDirectory, "directory");
  await mkdir(leafDirectory);
  assert.equal((await request({ ...directorySource.move, sourcePath: leafDirectory }, directorySource)).ok, false);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.contents);
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("native host rejects traversal, UNC, device paths, ADS, illegal names, and relative destinations", windowsOnly, async () => {
  const f = await fixture();
  for (const destinationDirectory of [
    "relative-folder", "C:relative-folder", "\\\\server\\share", `\\\\?\\${f.destinationDirectory}`,
    `${f.destinationDirectory}\\..\\escape`, `${f.destinationDirectory}:stream`,
    `${f.destinationDirectory}\\NUL.txt`, `${f.destinationDirectory}\\invalid?name`,
    `${f.destinationDirectory}\\trailing.`, `${f.destinationDirectory}\\trailing `,
  ]) {
    const response = await request({ ...f.move, destinationDirectory }, f);
    assert.equal(response.ok, false, destinationDirectory);
    assert.equal(await readFile(f.sourcePath, "utf8"), f.contents);
  }
});

test("native host rejects junction ancestors for both source and destination", windowsOnly, async () => {
  const f = await fixture();
  const realDestination = path.join(f.directory, "real-destination");
  const linkedDestination = path.join(f.directory, "linked-destination");
  await mkdir(realDestination);
  await symlink(realDestination, linkedDestination, "junction");
  const rejectedDestination = await request({ ...f.move, destinationDirectory: path.join(linkedDestination, "child") }, f);
  assert.equal(rejectedDestination.ok, false);
  const alternateStage = path.join(f.directory, "alternate-stage");
  await mkdir(alternateStage);
  await symlink(path.dirname(f.stageDirectory), path.join(alternateStage, "_DownloadPathRouter"), "junction");
  const linkedSource = path.join(alternateStage, "_DownloadPathRouter", f.jobId, path.basename(f.sourcePath));
  assert.equal((await request({ ...f.move, sourcePath: linkedSource }, f)).ok, false);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.contents);
});

test("native host keeps all source data when a destination cannot be created", windowsOnly, async () => {
  const f = await fixture();
  const blocker = path.join(f.directory, "occupied-by-file");
  await writeFile(blocker, "do not modify");
  const response = await request({ ...f.move, destinationDirectory: path.join(blocker, "child") }, f);
  assert.equal(response.ok, false);
  assert.equal(await readFile(f.sourcePath, "utf8"), f.contents);
  assert.equal(await readFile(blocker, "utf8"), "do not modify");
});

test("native host leaves a nonempty job directory and unrelated staged files intact", windowsOnly, async () => {
  const f = await fixture();
  const unrelated = path.join(f.stageDirectory, "unrelated.txt");
  await writeFile(unrelated, "retain this file");
  const response = await request(f.move, f);
  assert.equal(response.ok, true, response.error);
  assert.equal(await readFile(unrelated, "utf8"), "retain this file");
});

test("native host recovers the crash window after a same-volume rename", windowsOnly, async () => {
  const f = await fixture();
  await mkdir(f.destinationDirectory);
  const finalPath = path.join(f.destinationDirectory, path.basename(f.sourcePath));
  await seedMarker(f, { mode: "rename", state: "planned", finalPath, temporaryPath: path.join(f.destinationDirectory, `.download-path-router-${f.jobId}-recovery.partial`) });
  await rename(f.sourcePath, finalPath);
  const response = await request(f.move, f);
  assert.deepEqual(response, { ok: true, finalPath });
  assert.equal(await readFile(finalPath, "utf8"), f.contents);
  assert.deepEqual(await request(f.move, f), response);
});

test("native host recovers a committed cross-volume copy before deleting its verified source", windowsOnly, async () => {
  const f = await fixture();
  await mkdir(f.destinationDirectory);
  const finalPath = path.join(f.destinationDirectory, path.basename(f.sourcePath));
  await seedMarker(f, { mode: "copy", state: "copied", finalPath, temporaryPath: path.join(f.destinationDirectory, `.download-path-router-${f.jobId}-recovery.partial`) });
  await writeFile(finalPath, await readFile(f.sourcePath));
  const response = await request(f.move, f);
  assert.deepEqual(response, { ok: true, finalPath });
  await missing(f.sourcePath);
  assert.equal(await readFile(finalPath, "utf8"), f.contents);
});

test("native host refuses to delete a changed source when recovering an earlier committed copy", windowsOnly, async () => {
  const f = await fixture();
  await mkdir(f.destinationDirectory);
  const finalPath = path.join(f.destinationDirectory, path.basename(f.sourcePath));
  await seedMarker(f, { mode: "copy", state: "committed", finalPath, temporaryPath: path.join(f.destinationDirectory, `.download-path-router-${f.jobId}-recovery.partial`) });
  await writeFile(finalPath, await readFile(f.sourcePath));
  await writeFile(f.sourcePath, "changed source");
  const response = await request(f.move, f);
  assert.equal(response.ok, false);
  assert.equal(await readFile(f.sourcePath, "utf8"), "changed source");
  assert.equal(await readFile(finalPath, "utf8"), f.contents);
});

test("native host performs a real cross-drive copy, verifies bytes, and then removes source", windowsOnly, async (context) => {
  if (path.parse(project).root.toLowerCase() === path.parse(os.tmpdir()).root.toLowerCase()) {
    context.skip("No second local drive is available for a real cross-drive test");
    return;
  }
  const destinationDirectory = path.join(os.tmpdir(), `download-path-native-${randomUUID()}`);
  const payload = Buffer.alloc(1024 * 1024 + 31);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const f = await fixture({ basename: "cross-drive.bin", contents: payload, sharedDestination: destinationDirectory });
  const response = await request(f.move, f);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(await readFile(response.finalPath), payload);
  await missing(f.sourcePath);
  assert.deepEqual(await request(f.move, f), response);
});
