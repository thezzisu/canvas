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
  paneId: string; filename: string; size: number;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-open-"));
  const registry = join(root, "bridges");
  await mkdir(registry, { mode: 0o700 });
  const nativeSocket = join(root, "herdr.sock");
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", CANVAS_BRIDGE_REGISTRY_DIR: registry,
    HERDR_SOCKET_PATH: nativeSocket, HERDR_PANE_ID: "w1:p2" };
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (path: string, extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", [helper, "open", "--", path], { cwd: root, env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    const timeout = setTimeout(() => { child.kill(); reject(new Error("helper timed out")); }, 10000);
    child.once("close", () => clearTimeout(timeout));
  });
  async function endpoint(name: string, options: { reject?: boolean; finalReject?: boolean; provider?: string; nativeSocket?: string } = {}) {
    const socket = join(root, `${name}.sock`), record = join(registry, `${name}.json`);
    const secret = randomBytes(32).toString("base64url");
    const headers: Omit<Header, "secret">[] = [], bodies: Buffer[] = [];
    const clients = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, client => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => {});
      let data = Buffer.alloc(0), accepted = false, body = Buffer.alloc(0);
      client.on("data", (input: Buffer) => {
        const chunk = Buffer.from(input);
        if (accepted) { body = Buffer.concat([body, chunk]); return; }
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf(10);
        if (end < 0) return;
        const header = JSON.parse(data.subarray(0, end).toString()) as Header;
        // Check credentials without including their values in assertion output.
        assert(header.secret === secret, "bridge credential matches");
        const { secret: ignored, ...publicHeader } = header;
        headers.push(publicHeader);
        assert.equal(data.length, end + 1, "helper waits before transferring bytes");
        if (options.reject) { client.end('{"ok":false,"error":"No active browser"}\n'); return; }
        accepted = true;
        client.write('{"ok":true}\n');
      });
      client.on("end", () => {
        if (!accepted) return;
        bodies.push(body);
        client.end(options.finalReject ? '{"ok":false}\n' : '{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    t.after(() => new Promise<void>(resolve => { for (const client of clients) client.destroy(); server.close(() => resolve()); }));
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
  assert.deepEqual(endpoint.headers, [{ version: 1, provider: "herdr", nativeSocket: f.nativeSocket, paneId: "w1:p2", filename: name, size: content.length }]);
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
  const directory = await f.run(".");
  assert.equal(directory.code, 1); assert.match(directory.stderr, /regular file/u);
  assert.equal(endpoint.headers.length, 0);
  const denied = await f.run("file");
  assert.equal(denied.code, 1); assert.match(denied.stderr, /no Canvas tab/u);
  assert.equal(denied.stdout, ""); assert.equal(endpoint.bodies.length, 0);
  assert.equal(endpoint.headers.length, 1);
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
