import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createConnection, type Server } from "node:net";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeSocketTunnels, ensureSocketTunnel } from "./ssh-tunnels.ts";

async function waitFor<T>(
  action: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (predicate(value)) return value;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for socket state");
}

async function echo(path: string, value: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () =>
      socket.destroy(new Error("Socket response timed out")),
    );
    socket.once("connect", () => socket.write(value));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.toString());
    });
    socket.once("error", reject);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cs-test-"));
  const remotePath = join(root, "remote.sock");
  const log = join(root, "starts");
  const servers: Server[] = [];
  const remote = createServer((socket) =>
    socket.on("data", (data) => socket.write(data)),
  );
  servers.push(remote);
  await new Promise<void>((resolve) => remote.listen(remotePath, resolve));
  await writeFile(
    join(root, "ssh"),
    `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if(!args.includes('-N')) {
  const result=cp.spawnSync('/bin/sh',['-c',args.at(-1)],{encoding:'utf8',env:{...process.env,PATH:'/usr/bin:/bin'}});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,args}) + '\\n');
const listeners = [];
const reverseListeners = [];
const connections = new Set();
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-L') continue;
  const spec = args[++index];
  const split = spec.indexOf(':');
  const local = spec.slice(0, split), remote = spec.slice(split + 1);
  const tcp = /^(127[.][0-9]+[.][0-9]+[.][0-9]+|\\[::1\\]):([0-9]+)$/.exec(remote);
  const listener = net.createServer((incoming) => {
    const outgoing = tcp ? net.createConnection({host:tcp[1].replace(/[\\[\\]]/g,''),port:Number(tcp[2])}) : net.createConnection(remote);
    connections.add(incoming); connections.add(outgoing);
    incoming.pipe(outgoing); outgoing.pipe(incoming);
    incoming.on('error',()=>outgoing.destroy());
    outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>connections.delete(incoming));
    outgoing.on('close',()=>connections.delete(outgoing));
  });
  listener.listen(local); listeners.push(listener);
}
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-R') continue;
  const spec = args[++index], split = spec.indexOf(':');
  const remote = spec.slice(0, split), local = spec.slice(split + 1);
  const listener = net.createServer((incoming) => {
    const outgoing = net.createConnection(local);
    connections.add(incoming); connections.add(outgoing);
    incoming.pipe(outgoing); outgoing.pipe(incoming);
    incoming.on('error',()=>outgoing.destroy());
    outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>connections.delete(incoming));
    outgoing.on('close',()=>connections.delete(outgoing));
  });
  listener.listen(remote); reverseListeners.push(listener);
}
process.on('SIGTERM', () => {
  for (const socket of connections) socket.destroy();
  for (const listener of listeners) listener.close();
  for (const listener of reverseListeners) listener.close();
  process.exit(0);
});
`,
    { mode: 0o700 },
  );
  const request = {
    sourceId: "source-a",
    key: `source-a-${root}`,
    sshArgs: [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      "example.test",
    ],
    env: { PATH: root },
    discover: async () => ({
      "herdr.sock": remotePath,
      "herdr-client.sock": remotePath,
    }),
  };
  return {
    root,
    log,
    request,
    async close() {
      await closeSocketTunnels();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("SSH socket forwarding shares an owner-only endpoint and reconnects without changing client paths", async () => {
  const setup = await fixture();
  try {
    const [first, second] = await Promise.all([
      ensureSocketTunnel(setup.request),
      ensureSocketTunnel(setup.request),
    ]);
    assert.equal(first, second);
    assert.equal(
      (await stat(dirname(first.sockets["herdr.sock"]!))).mode & 0o777,
      0o700,
    );
    assert.equal(
      await echo(first.sockets["herdr.sock"]!, "api request\n"),
      "api request\n",
    );
    assert.equal(
      await echo(first.sockets["herdr-client.sock"]!, "\x00binary\xff"),
      "\x00binary\xff",
    );
    const starts = (await readFile(setup.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(starts.length, 1);
    assert.ok(starts[0].args.includes("StrictHostKeyChecking=yes"));
    assert.ok(starts[0].args.includes("ControlPath=none"));
    process.kill(starts[0].pid, "SIGKILL");
    await waitFor(
      () => echo(first.sockets["herdr.sock"]!, "reconnected"),
      (value) => value === "reconnected",
    );
    assert.equal(await ensureSocketTunnel(setup.request), first);
    assert.equal(
      (await readFile(setup.log, "utf8")).trim().split("\n").length,
      2,
    );
    await closeSocketTunnels(setup.request.sourceId);
    await assert.rejects(stat(dirname(first.sockets["herdr.sock"]!)), {
      code: "ENOENT",
    });
  } finally {
    await setup.close();
  }
});

test("closing one source does not disconnect another source tunnel", async () => {
  const setup = await fixture();
  try {
    const first = await ensureSocketTunnel(setup.request);
    const second = await ensureSocketTunnel({
      ...setup.request,
      sourceId: "source-b",
      key: `source-b-${setup.root}`,
    });
    await closeSocketTunnels("source-a");
    assert.equal(first.alive(), false);
    assert.equal(
      await echo(second.sockets["herdr.sock"]!, "still connected"),
      "still connected",
    );
    await closeSocketTunnels("source-b");
    assert.equal(second.alive(), false);
  } finally {
    await setup.close();
  }
});

test("aborting a draft forward during startup removes only its own process and socket directory", async () => {
  const setup = await fixture();
  try {
    const live = await ensureSocketTunnel(setup.request);
    await writeFile(join(setup.root, "ssh"), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(setup.log)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const opening = ensureSocketTunnel({ ...setup.request, sourceId: "draft-probe", key: `draft-${setup.root}`, signal: controller.signal });
    const starts = await waitFor(async () => (await readFile(setup.log, "utf8")).trim().split("\n").map(line => JSON.parse(line)), rows => rows.length === 2);
    const probe = starts[1]!, forwarded = probe.args[probe.args.indexOf("-L") + 1].split(":")[0];
    controller.abort();
    await assert.rejects(opening);
    assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
    await assert.rejects(stat(dirname(forwarded)), { code: "ENOENT" });
    assert.equal(await echo(live.sockets["herdr.sock"]!, "still-connected"), "still-connected");
  } finally { await setup.close(); }
});

test("SSH TCP loopback forwarding uses a private Unix listener and rejects arbitrary destinations", async () => {
  const setup = await fixture();
  const target = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
  await new Promise<void>(resolve => target.listen(0, "127.0.0.2", resolve));
  const address = target.address(); assert(address && typeof address !== "string");
  try {
    for (const endpoint of [{ host: "example.test", port: 8080 }, { host: "192.168.1.2", port: 80 },
      { host: "127.0.0.1", port: 0 }, { host: "127.0.0.1", port: 65536 }])
      await assert.rejects(ensureSocketTunnel({ ...setup.request, key: `${setup.request.key}-${endpoint.host}-${endpoint.port}`,
        discover: async () => ({}), tcp: { "web.sock": endpoint } }), /Invalid loopback forwarding endpoint/u);
    const tunnel = await ensureSocketTunnel({ ...setup.request, discover: async () => ({}),
      tcp: { "web.sock": { host: "127.0.0.2", port: address.port } } });
    assert.equal(await echo(tunnel.sockets["web.sock"]!, "web application"), "web application");
    assert.equal((await stat(dirname(tunnel.sockets["web.sock"]!))).mode & 0o777, 0o700);
    const starts = (await readFile(setup.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert(starts.at(-1).args.includes(`${tunnel.sockets["web.sock"]}:127.0.0.2:${address.port}`));
    const ipv6 = await ensureSocketTunnel({ ...setup.request, key: `${setup.request.key}-ipv6`, discover: async () => ({}),
      tcp: { "web.sock": { host: "::1", port: address.port } } });
    const last = JSON.parse((await readFile(setup.log, "utf8")).trim().split("\n").at(-1)!);
    assert(last.args.includes(`${ipv6.sockets["web.sock"]}:[::1]:${address.port}`));
    await tunnel.close(); await ipv6.close();
    await assert.rejects(stat(dirname(tunnel.sockets["web.sock"]!)), { code: "ENOENT" });
  } finally {
    await setup.close(); await new Promise<void>(resolve => target.close(() => resolve()));
  }
});

test("SSH reverse socket forwarding shares local and remote endpoints and cleans only its tunnel", async () => {
  const setup = await fixture();
  const localPath = join(setup.root, "bridge.sock"), remotePath = join(setup.root, "remote-bridge.sock");
  const bridgeServer = createServer(socket => socket.on("data", data => socket.write(Buffer.from(`download:${data}`))));
  await new Promise<void>(resolve => bridgeServer.listen(localPath, resolve));
  let remoteCleanup = 0;
  try {
    const request = {
      ...setup.request,
      key: `${setup.request.key}-reverse`,
      reverse: { "open.sock": { remotePath, localPath } },
      cleanupRemote: async () => { remoteCleanup++; },
    };
    const tunnel = await ensureSocketTunnel(request);
    assert.equal(tunnel.remoteSockets["open.sock"], remotePath);
    assert.equal(await echo(remotePath, "ticket"), "download:ticket");
    const starts = (await readFile(setup.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const matching = starts.at(-1).args;
    assert.ok(matching.includes("-L"));
    assert.ok(matching.includes("-R"));
    assert.ok(matching.includes(`${remotePath}:${localPath}`));
    assert.ok(matching.includes("StreamLocalBindUnlink=no"));
    process.kill(starts.at(-1).pid, "SIGKILL");
    await waitFor(() => echo(remotePath, "after reconnect"), value => value === "download:after reconnect");
    assert.equal(await ensureSocketTunnel(request), tunnel, "reconnect retains the published reverse endpoint");
    assert.equal((await readFile(setup.log, "utf8")).trim().split("\n").length, 2);
    await tunnel.close();
    assert.equal(tunnel.alive(), false);
    assert.equal(remoteCleanup, 1);
    await assert.rejects(stat(setup.root).then(() => echo(remotePath, "closed")), /ENOENT|ECONNREFUSED/u);
  } finally {
    await closeSocketTunnels();
    await new Promise<void>(resolve => bridgeServer.close(() => resolve()));
    await setup.close();
  }
});

test("reverse forwarding rejects an existing socket without replacing or removing it", async () => {
  const setup = await fixture();
  try {
    const remotePath = join(setup.root, "remote.sock");
    await assert.rejects(ensureSocketTunnel({
      ...setup.request,
      key: `${setup.request.key}-collision`,
      reverse: { "open.sock": { remotePath, localPath: remotePath } },
    }), /Reverse socket was replaced/u);
    assert.equal(await echo(remotePath, "untouched"), "untouched");
  } finally { await setup.close(); }
});

test("closing during endpoint discovery cancels that open without resurrecting its tunnel", async () => {
  const setup = await fixture();
  let allowDiscovery!: () => void;
  const discovery = new Promise<void>((resolve) => {
    allowDiscovery = resolve;
  });
  try {
    const opening = ensureSocketTunnel({
      ...setup.request,
      discover: async () => {
        await discovery;
        return await setup.request.discover();
      },
    });
    const rejected = assert.rejects(opening, /SSH socket forwarding closed/u);
    const closing = closeSocketTunnels(setup.request.sourceId);
    allowDiscovery();
    await Promise.all([rejected, closing]);
    const starts = (await readFile(setup.log, "utf8")).trim().split("\n");
    assert.equal(starts.length, 1);
    const pid = JSON.parse(starts[0]!).pid;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    allowDiscovery();
    await setup.close();
  }
});

test("forwarding rejects unsafe paths and propagates SSH failure without reusing a failed tunnel", async () => {
  const setup = await fixture();
  try {
    for (const path of ["relative.sock", "/tmp/a\nb.sock", "/tmp/a:b.sock"])
      await assert.rejects(
        ensureSocketTunnel({
          ...setup.request,
          discover: async () => ({ "herdr.sock": path }),
        }),
        /Unsupported remote Unix socket path/u,
      );
    await writeFile(
      join(setup.root, "ssh"),
      "#!/bin/sh\necho 'Host key verification failed' >&2\nexit 255\n",
      { mode: 0o700 },
    );
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(
        ensureSocketTunnel(setup.request),
        /Host key verification failed/u,
      );
  } finally {
    await setup.close();
  }
});
