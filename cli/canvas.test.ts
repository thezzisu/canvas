import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./canvas", import.meta.url));
const routingError = (nativeSocket: string, message: string, pane = "w1:p2") =>
  `canvas: ${message}\n  HERDR_SOCKET_PATH=${JSON.stringify(nativeSocket)} HERDR_PANE_ID=${JSON.stringify(pane)}\n`;
interface Header {
  version: number; secret: string; nativeSocket: string;
  paneId: string; filename: string; size: number;
  kind: "file" | "directory" | "url"; path?: string; url?: string;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-open-"));
  const registry = join(root, "bridges");
  await mkdir(registry, { mode: 0o700 });
  const nativeSocket = join(root, "herdr.sock");
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", CANVAS_BRIDGE_REGISTRY_DIR: registry,
    HERDR_SOCKET_PATH: nativeSocket, HERDR_PANE_ID: "w1:p2" };
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (path: string, extra: NodeJS.ProcessEnv = {}, timeouts?: { start: number; idle: number }, tty = false,
    fault?: { stage: "registry" | "record" | "probe" | "connect"; errno: number }) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Load the real executable and shorten only its inactivity intervals. This
    // exercises the same main/transport code without adding a production env knob.
    const setup = ["import runpy, sys", "module = runpy.run_path(sys.argv.pop(1))"];
    if (timeouts) setup.push(`module["transfer_file"].__defaults__ = (None, ${timeouts.start}, ${timeouts.idle})`);
    if (timeouts) setup.push(`module["open_directory"].__defaults__ = (${timeouts.start},)`);
    if (tty) setup.push("sys.stderr.isatty = lambda: True");
    if (fault) {
      setup.push("import os, socket");
      if (fault.stage === "registry" || fault.stage === "record") setup.push(`original_open = os.open
def injected_open(path, flags, *args, **kwargs):
    if ${fault.stage === "registry" ? 'path == os.environ["CANVAS_BRIDGE_REGISTRY_DIR"]' : '"dir_fd" in kwargs'}:
        raise OSError(${fault.errno}, "private failure detail")
    return original_open(path, flags, *args, **kwargs)
os.open = injected_open`);
      else setup.push(`original_connect = socket.socket.connect
connect_calls = 0
def injected_connect(connection, address):
    global connect_calls
    connect_calls += 1
    if connect_calls == ${fault.stage === "probe" ? 1 : 2}:
        raise OSError(${fault.errno}, "private failure detail")
    return original_connect(connection, address)
socket.socket.connect = injected_connect`);
    }
    setup.push('sys.exit(module["main"]())');
    const args = timeouts || tty || fault ? ["-c", setup.join("\n"), helper, "open", "--", path] : [helper, "open", "--", path];
    const child = spawn("python3", args, { cwd: root, env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    const timeout = setTimeout(() => { child.kill(); reject(new Error("helper timed out")); }, 10000);
    child.once("close", () => clearTimeout(timeout));
  });
  async function endpoint(name: string, options: {
    reject?: boolean; finalReject?: boolean; nativeSocket?: string;
    acceptDelay?: number; rejectReason?: unknown; startResponse?: unknown; finalResponse?: unknown;
    cancelDelay?: number; pauseInput?: boolean; progressDelay?: number; neverComplete?: boolean;
    repeatedProgress?: boolean; directoryDelay?: number;
    closeWithoutReply?: boolean;
  } = {}) {
    const socket = join(root, `${name}.sock`), record = join(registry, `${name}.json`);
    const secret = randomBytes(32).toString("base64url");
    const headers: Omit<Header, "secret">[] = [], bodies: Buffer[] = [];
    const clients = new Set<Socket>();
    const timers = new Set<NodeJS.Timeout>();
    const later = (callback: () => void, milliseconds: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
      timers.add(timer);
    };
    const server = createServer({ allowHalfOpen: true }, client => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => {});
      let data = Buffer.alloc(0), accepted = false, body = Buffer.alloc(0), header: Header | undefined;
      const send = (message: unknown) => { if (!client.destroyed) client.write(JSON.stringify(message) + "\n"); };
      const consume = (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (!options.progressDelay) send({ state: "transferring", transferred: body.length, size: header!.size });
        if (options.progressDelay) {
          client.pause();
          later(() => { send({ state: "transferring", transferred: body.length, size: header!.size }); client.resume(); }, options.progressDelay);
        }
      };
      client.on("data", (input: Buffer) => {
        const chunk = Buffer.from(input);
        if (accepted) { consume(chunk); return; }
        assert.equal(header, undefined, "no file data before download acceptance");
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf(10);
        if (end < 0) return;
        header = JSON.parse(data.subarray(0, end).toString()) as Header;
        // Reject credentials without including their values in assertion output.
        if (header.secret !== secret) { client.end('{"ok":false}\n'); return; }
        const { secret: ignored, ...publicHeader } = header;
        headers.push(publicHeader);
        assert.equal(data.length, end + 1, "helper waits before transferring bytes");
        if (options.closeWithoutReply) { client.end(); return; }
        if (header.kind === "directory" || header.kind === "url") {
          if (options.neverComplete) return;
          const received = () => client.end(JSON.stringify(options.reject || options.rejectReason !== undefined
            ? { ok: false, reason: options.rejectReason ?? "not-attached" } : { ok: true }) + "\n");
          if (options.directoryDelay) later(received, options.directoryDelay); else received();
          return;
        }
        const accept = () => {
          if (options.reject || options.rejectReason !== undefined) {
            client.end(JSON.stringify({ ok: false, reason: options.rejectReason ?? "not-attached", error: "No active browser" }) + "\n"); return;
          }
          accepted = true;
          send(options.startResponse ?? { ok: true, state: "transferring", transferred: 0, size: header!.size });
          if (options.pauseInput) client.pause();
          if (options.cancelDelay !== undefined) later(() => send({ ok: false, state: "cancelled", reason: "cancelled" }), options.cancelDelay);
          if (options.repeatedProgress) {
            const repeat = () => { if (!client.destroyed) { send({ state: "transferring", transferred: 0, size: header!.size }); later(repeat, 20); } };
            repeat();
          }
        };
        if (options.acceptDelay !== undefined) {
          send({ state: "offered", transferred: 0, size: header.size });
          later(accept, options.acceptDelay);
        } else accept();
      });
      client.on("end", () => {
        if (header?.kind === "directory" || header?.kind === "url") return;
        if (!accepted) { client.end(); return; }
        bodies.push(body);
        if (options.neverComplete) return;
        const complete = () => {
          if (options.finalReject) client.end('{"ok":false}\n');
          else client.end(JSON.stringify(options.finalResponse ?? { ok: true, state: "completed", transferred: body.length, size: header!.size }) + "\n");
        };
        complete();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    t.after(() => new Promise<void>(resolve => { for (const timer of timers) clearTimeout(timer); for (const client of clients) client.destroy(); server.close(() => resolve()); }));
    await writeFile(record, JSON.stringify({ version: 1, nativeSocket: options.nativeSocket || nativeSocket, socket, secret }), { mode: 0o600 });
    return { headers, bodies, record };
  }
  return { root, registry, nativeSocket, run, endpoint };
}

test("canvas open streams binary files with relative, Unicode and spaced names", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("active");
  const name = "风景 文件.bin", content = randomBytes(1024 * 1024 + 71);
  await writeFile(join(f.root, name), content);
  const result = await f.run(name);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(endpoint.headers, [{ version: 1, kind: "file", nativeSocket: f.nativeSocket, paneId: "w1:p2", filename: name, size: content.length }]);
  assert.equal(endpoint.bodies.length, 1);
  assert(endpoint.bodies[0]!.equals(content), "download preserves every byte");
});

test("canvas open transfers empty files from its herdr pane", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("empty");
  await writeFile(join(f.root, "empty"), "");
  const result = await f.run("empty");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endpoint.headers[0]!.paneId, "w1:p2");
  assert.equal(endpoint.headers[0]!.size, 0);
  assert.equal(endpoint.bodies[0]!.length, 0);
});

test("canvas open requires a valid herdr pane identity before opening a bridge", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("active");
  await writeFile(join(f.root, "file"), "must stay local");
  for (const environment of [
    { HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "" },
    { HERDR_SOCKET_PATH: "relative.sock" },
    { HERDR_PANE_ID: "" },
    { HERDR_PANE_ID: "pane\ncontrol" },
  ]) {
    const result = await f.run("file", environment);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "canvas: run this command inside a connected herdr pane\n");
  }
  assert.equal(endpoint.headers.length, 0);
});

test("canvas open canonicalizes native socket aliases and preserves leading-dash file names", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("active");
  const alias = join(f.root, "socket-alias");
  await symlink(f.nativeSocket, alias);
  await writeFile(join(f.root, "-report.txt"), "report");
  const result = await f.run("-report.txt", { HERDR_SOCKET_PATH: alias });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endpoint.headers[0]!.nativeSocket, f.nativeSocket);
  assert.equal(endpoint.headers[0]!.filename, "-report.txt");
});

test("canvas open rejects nonfiles and reports unavailable recipients without sending file data", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("reject", { reject: true });
  await writeFile(join(f.root, "file"), "private fixture");
  const noFile = await f.run("missing");
  assert.equal(noFile.code, 1); assert.match(noFile.stderr, /file not found/u);
  const nonFile = await f.run("/dev/null");
  assert.equal(nonFile.code, 1); assert.match(nonFile.stderr, /file or directory/u);
  assert.equal(endpoint.headers.length, 0);
  const denied = await f.run("file");
  assert.equal(denied.code, 1); assert.equal(denied.stderr, routingError(f.nativeSocket, "no browser ready to receive from this pane"));
  assert.equal(denied.stdout, ""); assert.equal(endpoint.bodies.length, 0);
  assert.equal(endpoint.headers.length, 1);
});

test("canvas open sends a canonical directory path without copying its contents", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("directory", { directoryDelay: 60 });
  const directory = join(f.root, "目录 with spaces");
  await mkdir(directory);
  await writeFile(join(directory, "must-not-transfer.txt"), "private fixture");
  await symlink(directory, join(f.root, "directory-link"));
  const began = Date.now();
  const result = await f.run("directory-link/.");
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert(Date.now() - began >= 60, "success waits for the browser acknowledgement");
  assert.deepEqual(endpoint.headers, [{ version: 1, nativeSocket: f.nativeSocket,
    paneId: "w1:p2", kind: "directory", path: directory }]);
  assert.deepEqual(endpoint.bodies, []);
});

test("canvas open directories fail promptly without a controlling browser and bound missing acknowledgements", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("directory", { rejectReason: "not-attached" });
  const rejected = await f.run(".");
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stderr, routingError(f.nativeSocket, "no browser ready to receive from this pane"));
  await rm(endpoint.record);
  await f.endpoint("unresponsive-directory", { neverComplete: true });
  const timedOut = await f.run(".", {}, { start: 0.1, idle: 1 });
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.stderr, "canvas: open request timed out\n");
});

test("canvas open never retries after transfer acceptance", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("active", { finalReject: true });
  await writeFile(join(f.root, "file"), "single download");
  const rejected = await f.run("file");
  assert.equal(rejected.code, 1);
  assert.equal(endpoint.bodies.length, 1);
  assert(endpoint.bodies[0]!.equals(Buffer.from("single download")));
  assert.equal(endpoint.headers.length, 1);
});

test("canvas open waits for server readiness before sending file bytes", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("delayed", { acceptDelay: 180 });
  const content = randomBytes(256 * 1024);
  await writeFile(join(f.root, "file"), content);
  const result = await f.run("file");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endpoint.bodies.length, 1);
  assert(endpoint.bodies[0]!.equals(content));
});

test("canvas open exits promptly when the server rejects the copy", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("declined", { acceptDelay: 100, rejectReason: "cancelled" });
  await writeFile(join(f.root, "file"), randomBytes(1024 * 1024));
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy cancelled/u);
  assert.equal(endpoint.bodies.length, 0, "no file bytes were sent after rejection");
});

test("canvas open bounds a server that never starts accepting file bytes", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("unanswered", { acceptDelay: 500 });
  await writeFile(join(f.root, "file"), "not accepted");
  const result = await f.run("file", {}, { start: 0.15, idle: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy did not start/u);
  assert.equal(endpoint.bodies.length, 0);
});

test("canvas open reads cancellation while its output is backpressured", async t => {
  const f = await fixture(t);
  await f.endpoint("cancelled", { pauseInput: true, cancelDelay: 80 });
  await writeFile(join(f.root, "file"), randomBytes(16 * 1024 * 1024));
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy cancelled/u);
  assert(Date.now() - began < 2000, "cancel is not blocked behind pending file data");
});

test("canvas open uses reported byte progress instead of a total file duration limit", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("slow-progress", { progressDelay: 80 });
  const content = randomBytes(512 * 1024);
  await writeFile(join(f.root, "file"), content);
  const began = Date.now();
  const result = await f.run("file", {}, { start: 1, idle: 0.25 });
  assert.equal(result.code, 0, result.stderr);
  assert(Date.now() - began > 250, "transfer duration exceeds its inactivity interval");
  assert(endpoint.bodies[0]!.equals(content));
});

test("canvas open does not count repeated status messages as download progress", async t => {
  const f = await fixture(t);
  await f.endpoint("no-progress", { pauseInput: true, repeatedProgress: true });
  await writeFile(join(f.root, "file"), randomBytes(1024 * 1024));
  const result = await f.run("file", {}, { start: 1, idle: 0.2 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy timed out/u);
});

test("canvas open bounds a missing final acknowledgement", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("no-final", { neverComplete: true });
  await writeFile(join(f.root, "file"), "all bytes sent");
  const result = await f.run("file", {}, { start: 1, idle: 0.2 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy timed out/u);
  assert(endpoint.bodies[0]!.equals(Buffer.from("all bytes sent")));
});

test("canvas open validates transfer state and byte counts before accepting acknowledgements", async t => {
  for (const response of [{ ok: true }, { ok: true, state: "ready", transferred: 0, size: 7 },
    { ok: true, state: "transferring", transferred: 1, size: 7 }]) {
    await t.test(JSON.stringify(response), async t => {
      const f = await fixture(t), endpoint = await f.endpoint("invalid-start", { startResponse: response });
      await writeFile(join(f.root, "file"), "fixture");
      const result = await f.run("file");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /invalid copy response/u);
      assert(endpoint.bodies.every(body => body.length === 0), "invalid acknowledgement never releases file bytes");
    });
  }
  for (const response of [{ ok: true }, { ok: true, state: "completed", transferred: 6, size: 7 }]) {
    await t.test(JSON.stringify(response), async t => {
      const f = await fixture(t);
      await f.endpoint("invalid-complete", { finalResponse: response });
      await writeFile(join(f.root, "file"), "fixture");
      const result = await f.run("file");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /invalid copy response/u);
    });
  }
});

test("canvas open never reflects a remote error or terminal controls", async t => {
  const f = await fixture(t);
  await f.endpoint("unsafe-error", { rejectReason: { reflectedSecret: "never-display\u001b[2J" } });
  await writeFile(join(f.root, "file"), "fixture");
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: open request rejected\n");
});

test("canvas open exits promptly when no browser bridge is attached", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file"), "fixture");
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, routingError(f.nativeSocket, "no Canvas bridge for this herdr socket"));
  assert(Date.now() - began < 2000, "missing bridge must not wait for a browser decision");
});

test("canvas open distinguishes denied bridge access from absent browsers without sending file data", async t => {
  for (const errno of [1, 13]) {
    for (const stage of ["registry", "record", "probe", "connect"] as const) await t.test(`${stage}: errno ${errno}`, async t => {
      const f = await fixture(t), endpoint = await f.endpoint("active");
      await writeFile(join(f.root, "file"), "must not be sent");
      assert.deepEqual(await f.run("file", {}, undefined, false, { stage, errno }), {
        code: 1, stdout: "", stderr: "canvas: cannot access Canvas bridge: permission denied\n",
      });
      assert.equal(endpoint.headers.length, 0);
      assert.equal(endpoint.bodies.length, 0);
    });
  }
});

test("canvas open distinguishes stale or refused bridges from a pane without a browser", async t => {
  for (const errno of [2, 111]) await t.test(`errno ${errno}`, async t => {
    const f = await fixture(t), endpoint = await f.endpoint("stale");
    await writeFile(join(f.root, "file"), "must not be sent");
    assert.deepEqual(await f.run("file", {}, undefined, false, { stage: "probe", errno }), {
      code: 1, stdout: "", stderr: routingError(f.nativeSocket, "no Canvas bridge for this herdr socket"),
    });
    assert.equal(endpoint.headers.length, 0);
  });
});

test("canvas open exits promptly when the server has only passive browser viewers", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("passive", { rejectReason: "not-attached" });
  await writeFile(join(f.root, "file"), "fixture");
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, routingError(f.nativeSocket, "no browser ready to receive from this pane"));
  assert.equal(endpoint.bodies.length, 0);
  assert(Date.now() - began < 2000, "passive viewers must not leave the helper waiting");
});

test("routing diagnostics quote inherited identities instead of rendering terminal controls", async t => {
  const f = await fixture(t);
  await f.endpoint("passive", { rejectReason: "not-attached" });
  await writeFile(join(f.root, "file"), "fixture");
  const pane = 'pane"\u009b31m\u202e';
  const result = await f.run("file", { HERDR_PANE_ID: pane });
  assert.equal(result.code, 1);
  assert(result.stderr.includes('HERDR_PANE_ID="pane\\"\\u009b31m\\u202e"'));
  assert(!result.stderr.includes('\u009b')); assert(!result.stderr.includes('\u202e'));
  assert(!result.stderr.includes("No active browser"));
});

test("canvas open bounds a transfer that stops reporting progress", async t => {
  const f = await fixture(t);
  await f.endpoint("stalled", { pauseInput: true });
  await writeFile(join(f.root, "file"), randomBytes(4 * 1024 * 1024));
  const began = Date.now();
  const result = await f.run("file", {}, { start: 1, idle: 0.2 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy timed out/u);
  assert(Date.now() - began < 2000, "stall timeout is finite");
});

test("canvas open displays server copy progress only on a terminal", async t => {
  const f = await fixture(t);
  await f.endpoint("tty", { acceptDelay: 30 });
  await writeFile(join(f.root, "file"), randomBytes(32 * 1024));
  const result = await f.run("file", {}, undefined, true);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Copying to Canvas/u);
  assert.match(result.stderr, /100%/u);
  assert(result.stderr.endsWith("\n"));
});

test("canvas open fails closed when two Canvas backends claim the same native terminal", async t => {
  const f = await fixture(t), first = await f.endpoint("first"), second = await f.endpoint("second");
  await writeFile(join(f.root, "file"), "must not be duplicated");
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /multiple Canvas connections/u);
  assert.equal(first.headers.length, 0);
  assert.equal(second.headers.length, 0);
  assert.equal(first.bodies.length + second.bodies.length, 0);
});

test("canvas open ignores unsafe, unrelated and symlinked registry records", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("unsafe");
  await writeFile(join(f.root, "file"), "fixture");
  await chmod(endpoint.record, 0o644);
  assert.equal((await f.run("file")).code, 1);
  await chmod(endpoint.record, 0o600);
  const moved = join(f.root, "outside.json");
  await rename(endpoint.record, moved);
  await symlink(moved, endpoint.record);
  assert.equal((await f.run("file")).code, 1);
  assert.equal(endpoint.headers.length, 0, "symlinked record was not read");
  await rm(endpoint.record);
  await rename(moved, endpoint.record);
  const unrelated = await f.endpoint("unrelated", { nativeSocket: "/unrelated/native.sock" });
  assert.equal((await f.run("file", { HERDR_SOCKET_PATH: "/different/native.sock" })).code, 1);
  assert.equal(endpoint.headers.length, 0); assert.equal(unrelated.headers.length, 0);
  await chmod(f.registry, 0o755);
  assert.equal((await f.run("file")).code, 1);
  assert.equal(endpoint.headers.length, 0);
});

test("file, directory and URL calls ignore dead bridge records but never retry an expired bridge credential", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("active");
  await writeFile(join(f.root, "file"), "scoped fixture");
  const record = JSON.parse(await readFile(endpoint.record, "utf8"));
  await writeFile(join(f.registry, "stale.json"), JSON.stringify({ ...record, socket: join(f.root, "gone.sock") }), { mode: 0o600 });
  for (const path of ["file", ".", "https://example.test/fixture"]) assert.deepEqual(await f.run(path), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(endpoint.headers.map(header => header.kind), ["file", "directory", "url"]);
  const bodyCount = endpoint.bodies.length;
  await writeFile(endpoint.record, JSON.stringify({ ...record, secret: "expired-fixture-credential" }), { mode: 0o600 });
  for (const path of ["file", ".", "https://example.test/fixture"]) {
    assert.deepEqual(await f.run(path), { code: 1, stdout: "", stderr: "canvas: open request rejected\n" });
  }
  assert.equal(endpoint.headers.length, 3);
  assert.equal(endpoint.bodies.length, bodyCount, "expired credentials release no file bytes or references");
});

test("directory and URL peer closure is immediate and distinct from a timeout", async t => {
  const f = await fixture(t);
  await f.endpoint("closed", { closeWithoutReply: true });
  for (const path of [".", "https://example.test/fixture"]) {
    const start = Date.now();
    assert.deepEqual(await f.run(path), { code: 1, stdout: "", stderr: "canvas: open connection closed\n" });
    assert(Date.now() - start < 2000);
  }
});
