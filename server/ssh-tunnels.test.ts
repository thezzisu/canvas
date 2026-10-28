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
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,args}) + '\\n');
const listeners = [];
const connections = new Set();
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-L') continue;
  const spec = args[++index];
  const split = spec.indexOf(':');
  const local = spec.slice(0, split), remote = spec.slice(split + 1);
  const listener = net.createServer((incoming) => {
    const outgoing = net.createConnection(remote);
    connections.add(incoming); connections.add(outgoing);
    incoming.pipe(outgoing); outgoing.pipe(incoming);
    incoming.on('error',()=>outgoing.destroy());
    outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>connections.delete(incoming));
    outgoing.on('close',()=>connections.delete(outgoing));
  });
  listener.listen(local); listeners.push(listener);
}
process.on('SIGTERM', () => {
  for (const socket of connections) socket.destroy();
  for (const listener of listeners) listener.close();
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
