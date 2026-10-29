import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../cli/canvas", import.meta.url));
interface Header {
  version: number; secret: string; provider: string; nativeSocket: string;
  paneId: string; filename: string; size: number; progress: boolean;
  kind?: "directory"; path?: string;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-open-"));
  const registry = join(root, "bridges");
  await mkdir(registry, { mode: 0o700 });
  const nativeSocket = join(root, "herdr.sock");
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", CANVAS_BRIDGE_REGISTRY_DIR: registry,
    HERDR_SOCKET_PATH: nativeSocket, HERDR_PANE_ID: "w1:p2" };
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (path: string, extra: NodeJS.ProcessEnv = {}, timeouts?: { start: number; idle: number }, tty = false) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Load the real executable and shorten only its inactivity intervals. This
    // exercises the same main/transport code without adding a production env knob.
    const setup = ["import runpy, sys", "module = runpy.run_path(sys.argv.pop(1))"];
    if (timeouts) setup.push(`module["transfer_file"].__defaults__ = (None, ${timeouts.start}, ${timeouts.idle})`);
    if (timeouts) setup.push(`module["open_directory"].__defaults__ = (${timeouts.start},)`);
    if (tty) setup.push("sys.stderr.isatty = lambda: True");
    setup.push('sys.exit(module["main"]())');
    const args = timeouts || tty ? ["-c", setup.join("\n"), helper, "open", "--", path] : [helper, "open", "--", path];
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
    reject?: boolean; finalReject?: boolean; provider?: string; nativeSocket?: string;
    protocol?: boolean; acceptDelay?: number; rejectReason?: unknown; browserAccepted?: boolean;
    cancelDelay?: number; pauseInput?: boolean; progressDelay?: number; neverComplete?: boolean;
    repeatedProgress?: boolean; directoryDelay?: number;
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
      const send = (message: object) => { if (!client.destroyed) client.write(JSON.stringify(message) + "\n"); };
      const consume = (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (options.protocol && !options.progressDelay) send({ state: "transferring", transferred: body.length, size: header!.size });
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
        // Check credentials without including their values in assertion output.
        assert(header.secret === secret, "bridge credential matches");
        const { secret: ignored, ...publicHeader } = header;
        headers.push(publicHeader);
        assert.equal(data.length, end + 1, "helper waits before transferring bytes");
        if (header.kind === "directory") {
          if (options.neverComplete) return;
          const received = () => client.end(JSON.stringify(options.reject || options.rejectReason !== undefined
            ? { ok: false, reason: options.rejectReason } : { ok: true }) + "\n");
          if (options.directoryDelay) later(received, options.directoryDelay); else received();
          return;
        }
        const accept = () => {
          if (options.reject || options.rejectReason !== undefined) {
            client.end(JSON.stringify({ ok: false, reason: options.rejectReason, error: "No active browser" }) + "\n"); return;
          }
          accepted = true;
          send(options.protocol ? { ok: true, state: "transferring", transferred: 0, size: header!.size } : { ok: true });
          if (options.pauseInput) client.pause();
          if (options.cancelDelay !== undefined) later(() => send({ ok: false, state: "cancelled", reason: "cancelled" }), options.cancelDelay);
          if (options.repeatedProgress) {
            const repeat = () => { if (!client.destroyed) { send({ state: "transferring", transferred: 0, size: header!.size }); later(repeat, 20); } };
            repeat();
          }
        };
        if (options.acceptDelay !== undefined) {
          send({ state: "offered", transferred: 0, size: header.size });
          if (options.browserAccepted) send({ state: "accepted", transferred: 0, size: header.size });
          later(accept, options.acceptDelay);
        } else accept();
      });
      client.on("end", () => {
        if (header?.kind === "directory") return;
        if (!accepted) { client.end(); return; }
        bodies.push(body);
        if (options.neverComplete) return;
        const complete = () => {
          if (options.finalReject) client.end('{"ok":false}\n');
          else if (options.protocol) client.end(JSON.stringify({ ok: true, state: "completed", transferred: body.length, size: header!.size }) + "\n");
          else client.end('{"ok":true}\n');
        };
        complete();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    t.after(() => new Promise<void>(resolve => { for (const timer of timers) clearTimeout(timer); for (const client of clients) client.destroy(); server.close(() => resolve()); }));
    await writeFile(record, JSON.stringify({ version: 1, provider: options.provider || "herdr", nativeSocket: options.nativeSocket || nativeSocket, socket, secret }), { mode: 0o600 });
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
  assert.deepEqual(endpoint.headers, [{ version: 1, progress: true, provider: "herdr", nativeSocket: f.nativeSocket, paneId: "w1:p2", filename: name, size: content.length }]);
  assert.equal(endpoint.bodies.length, 1);
  assert(endpoint.bodies[0]!.equals(content), "download preserves every byte");
});

test("canvas open transfers empty files and selects the inner tmux from inherited herdr env", async t => {
  const f = await fixture(t), nativeSocket = join(f.root, "tmux,server");
  const endpoint = await f.endpoint("inner", { provider: "tmux", nativeSocket });
  await writeFile(join(f.root, "empty"), "");
  const result = await f.run("empty", { TMUX: `${nativeSocket},123,0`, TMUX_PANE: "%7" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endpoint.headers[0]!.provider, "tmux");
  assert.equal(endpoint.headers[0]!.paneId, "%7");
  assert.equal(endpoint.headers[0]!.size, 0);
  assert.equal(endpoint.bodies[0]!.length, 0);
});

test("canvas open prefers a registered inner tmux and falls back to the enclosing herdr", async t => {
  const f = await fixture(t), tmuxSocket = join(f.root, "inner-tmux");
  const outer = await f.endpoint("outer");
  const file = "nested.bin"; await writeFile(join(f.root, file), "nested bytes");
  const env = { TMUX: `${tmuxSocket},123,0`, TMUX_PANE: "%9" };
  const fallback = await f.run(file, env);
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.equal(outer.headers[0]!.provider, "herdr");

  const inner = await f.endpoint("inner-tmux", { provider: "tmux", nativeSocket: tmuxSocket });
  const preferred = await f.run(file, env);
  assert.equal(preferred.code, 0, preferred.stderr);
  assert.equal(inner.headers[0]!.provider, "tmux");
  assert.equal(inner.headers[0]!.paneId, "%9");
  assert.equal(outer.headers.length, 1, "outer bridge was not sent a duplicate file");
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
  assert.equal(denied.code, 1); assert.match(denied.stderr, /no browser attached to this window/u);
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
  assert.deepEqual(endpoint.headers, [{ version: 1, provider: "herdr", nativeSocket: f.nativeSocket,
    paneId: "w1:p2", kind: "directory", path: directory }]);
  assert.deepEqual(endpoint.bodies, []);
});

test("canvas open directories fail promptly without a controlling browser and bound missing acknowledgements", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("directory", { rejectReason: "not-attached" });
  const rejected = await f.run(".");
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stderr, "canvas: no browser attached to this window\n");
  await rm(endpoint.record);
  await f.endpoint("unresponsive-directory", { neverComplete: true });
  const timedOut = await f.run(".", {}, { start: 0.1, idle: 1 });
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.stderr, "canvas: directory open timed out\n");
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

test("canvas open waits for server readiness and tolerates legacy offer and acceptance messages", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("delayed", { protocol: true, acceptDelay: 180, browserAccepted: true });
  const content = randomBytes(256 * 1024);
  await writeFile(join(f.root, "file"), content);
  const result = await f.run("file");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(endpoint.bodies.length, 1);
  assert(endpoint.bodies[0]!.equals(content));
});

test("canvas open exits promptly when the server rejects the copy", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("declined", { protocol: true, acceptDelay: 100, rejectReason: "cancelled" });
  await writeFile(join(f.root, "file"), randomBytes(1024 * 1024));
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy cancelled/u);
  assert.equal(endpoint.bodies.length, 0, "no file bytes were sent after rejection");
});

test("canvas open bounds a legacy server that never starts accepting file bytes", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("unanswered", { protocol: true, acceptDelay: 500 });
  await writeFile(join(f.root, "file"), "not accepted");
  const result = await f.run("file", {}, { start: 0.15, idle: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy did not start/u);
  assert.equal(endpoint.bodies.length, 0);
});

test("canvas open reads cancellation while its output is backpressured", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("cancelled", { protocol: true, pauseInput: true, cancelDelay: 80 });
  await writeFile(join(f.root, "file"), randomBytes(16 * 1024 * 1024));
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy cancelled/u);
  assert(Date.now() - began < 2000, "cancel is not blocked behind pending file data");
});

test("canvas open accepts old servers with only start and completion acknowledgements", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("legacy");
  const content = randomBytes(128 * 1024);
  await writeFile(join(f.root, "file"), content);
  const result = await f.run("file");
  assert.equal(result.code, 0, result.stderr);
  assert(endpoint.bodies[0]!.equals(content));
});

test("canvas open uses reported byte progress instead of a total file duration limit", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("slow-progress", { protocol: true, progressDelay: 80 });
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
  await f.endpoint("no-progress", { protocol: true, pauseInput: true, repeatedProgress: true });
  await writeFile(join(f.root, "file"), randomBytes(1024 * 1024));
  const result = await f.run("file", {}, { start: 1, idle: 0.2 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy timed out/u);
});

test("canvas open bounds a missing final acknowledgement for new and legacy servers", async t => {
  for (const protocol of [true, false]) {
    await t.test(protocol ? "progress server" : "legacy server", async t => {
      const f = await fixture(t), endpoint = await f.endpoint("no-final", { protocol, neverComplete: true });
      await writeFile(join(f.root, "file"), "all bytes sent");
      const result = await f.run("file", {}, { start: 1, idle: 0.2 });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /copy timed out/u);
      assert(endpoint.bodies[0]!.equals(Buffer.from("all bytes sent")));
    });
  }
});

test("canvas open never reflects a remote error or terminal controls", async t => {
  const f = await fixture(t);
  await f.endpoint("unsafe-error", { rejectReason: { reflectedSecret: "never-display\u001b[2J" } });
  await writeFile(join(f.root, "file"), "fixture");
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
});

test("canvas open exits promptly when no browser bridge is attached", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file"), "fixture");
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
  assert(Date.now() - began < 2000, "missing bridge must not wait for a browser decision");
});

test("canvas open exits promptly when the server has only passive browser viewers", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("passive", { rejectReason: "not-attached" });
  await writeFile(join(f.root, "file"), "fixture");
  const began = Date.now();
  const result = await f.run("file");
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "canvas: no browser attached to this window\n");
  assert.equal(endpoint.bodies.length, 0);
  assert(Date.now() - began < 2000, "passive viewers must not leave the helper waiting");
});

test("canvas open bounds a transfer that stops reporting progress", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("stalled", { protocol: true, pauseInput: true });
  await writeFile(join(f.root, "file"), randomBytes(4 * 1024 * 1024));
  const began = Date.now();
  const result = await f.run("file", {}, { start: 1, idle: 0.2 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /copy timed out/u);
  assert(Date.now() - began < 2000, "stall timeout is finite");
});

test("canvas open displays server copy progress only on a terminal", async t => {
  const f = await fixture(t), endpoint = await f.endpoint("tty", { protocol: true, acceptDelay: 30 });
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
