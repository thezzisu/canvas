import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SocketTunnel {
  sockets: Record<string, string>;
  remoteSockets: Record<string, string>;
  alive(): boolean;
  close(): Promise<void>;
}

interface ManagedTunnel extends SocketTunnel {
  directory: string;
}

interface TunnelEntry {
  sourceId: string;
  closing: boolean;
  promise: Promise<ManagedTunnel>;
}

interface TunnelRequest {
  sourceId: string;
  key: string;
  /** Existing strict SSH options followed by -- and the destination. */
  sshArgs: string[];
  env: NodeJS.ProcessEnv;
  discover(): Promise<Record<string, string>>;
  reverse?: Record<string, { remotePath: string; localPath: string }>;
  cleanupRemote?(): Promise<void>;
}

const tunnels = new Map<string, TunnelEntry>();

function checkSocketPath(path: string): void {
  if (!path.startsWith("/") || /[:\x00-\x1f\x7f]/u.test(path))
    throw new Error("Unsupported remote Unix socket path");
}

async function startTunnel(request: TunnelRequest): Promise<ManagedTunnel> {
  const remote = await request.discover();
  const entries = Object.entries(remote);
  const reverse = Object.entries(request.reverse || {});
  if (!entries.length && !reverse.length)
    throw new Error("No Unix socket forwarding was requested");
  for (const [name, path] of entries) {
    if (!/^[a-z][a-z0-9-]*\.sock$/u.test(name))
      throw new Error("Invalid forwarded socket name");
    checkSocketPath(path);
  }
  for (const [name, endpoint] of reverse) {
    if (!/^[a-z][a-z0-9-]*\.sock$/u.test(name))
      throw new Error("Invalid reverse socket name");
    checkSocketPath(endpoint.remotePath);
    checkSocketPath(endpoint.localPath);
  }
  // Unix socket names are short on both Linux and macOS. mkdtemp creates an
  // owner-only directory; no global SSH configuration or existing socket changes.
  const directory = await mkdtemp(
    join(tmpdir().length < 50 ? tmpdir() : "/tmp", "canvas-s-"),
  );
  const sockets = Object.fromEntries(
    entries.map(([name]) => [name, join(directory, name)]),
  );
  const forwards = entries.flatMap(([name, remotePath]) => [
    "-L",
    `${sockets[name]}:${remotePath}`,
  ]);
  const reverseForwards = reverse.flatMap(([, endpoint]) => [
    "-R",
    `${endpoint.remotePath}:${endpoint.localPath}`,
  ]);
  const remoteSockets = Object.fromEntries(
    reverse.map(([name, endpoint]) => [name, endpoint.remotePath]),
  );
  const args = [
    "-N",
    "-T",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StreamLocalBindUnlink=no",
    ...forwards,
    ...reverseForwards,
    ...request.sshArgs,
  ];
  let stopped = false;
  let child: ChildProcess | undefined;
  let currentDone: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wakeRetry: (() => void) | undefined;
  let reconnecting: Promise<void> | undefined;
  async function terminate(): Promise<void> {
    child?.kill("SIGTERM");
    const escalation = setTimeout(() => child?.kill("SIGKILL"), 1000);
    escalation.unref();
    await currentDone;
    clearTimeout(escalation);
  }
  async function connect(): Promise<void> {
    await Promise.all(
      Object.values(sockets).map((path) => rm(path, { force: true })),
    );
    await Promise.all(Object.values(request.reverse || {}).map(async ({ localPath }) => {
      try {
        if (!(await lstat(localPath)).isSocket())
          throw new Error("Local reverse forwarding endpoint is not a socket");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error("Local reverse forwarding endpoint is unavailable");
        throw error;
      }
    }));
    if (stopped) throw new Error("SSH socket forwarding closed");
    const proc = (child = spawn("ssh", args, {
      env: request.env,
      stdio: ["ignore", "ignore", "pipe"],
    }));
    let failure: string | undefined;
    let exited = false;
    currentDone = new Promise<void>((resolve) => {
      proc.once("error", (error) => {
        failure = error.message;
      });
      proc.once("close", () => {
        exited = true;
        resolve();
      });
    });
    proc.stderr?.on("data", (data: Buffer) => {
      failure = `${failure ?? ""}${data.toString("utf8")}`.slice(-1200);
    });
    const deadline = Date.now() + 12_000;
    while (true) {
      if (exited) throw new Error(failure?.trim() || "SSH forwarding stopped");
      if (stopped) throw new Error("SSH socket forwarding closed");
      const ready = await Promise.all(
        Object.values(sockets).map(async (path) => {
          try {
            return (await lstat(path)).isSocket();
          } catch {
            return false;
          }
        }),
      );
      if (ready.every(Boolean)) return;
      if (Date.now() >= deadline) {
        await terminate();
        throw new Error("SSH socket forwarding timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const close = () =>
    (closing ??= (async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      wakeRetry?.();
      await terminate();
      await reconnecting;
      await rm(directory, { recursive: true, force: true });
      await request.cleanupRemote?.().catch(() => {});
    })());
  try {
    await connect();
    reconnecting = (async () => {
      let delay = 250;
      while (!stopped) {
        await currentDone;
        if (stopped) break;
        await new Promise<void>((resolve) => {
          wakeRetry = resolve;
          retry = setTimeout(resolve, delay);
          retry.unref();
        });
        wakeRetry = undefined;
        if (stopped) break;
        try {
          await connect();
          delay = 250;
        } catch {
          delay = Math.min(delay * 2, 5000);
        }
      }
    })();
    // Reuse the same local socket paths across SSH reconnection so existing
    // native clients can reconnect without changing their endpoint identity.
    return { sockets, remoteSockets, directory, alive: () => !stopped, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One SSH process per source configuration, shared by metadata and all tabs. */
export async function ensureSocketTunnel(
  request: TunnelRequest,
): Promise<SocketTunnel> {
  while (true) {
    let entry = tunnels.get(request.key);
    if (!entry) {
      const created: TunnelEntry = {
        sourceId: request.sourceId,
        closing: false,
        promise: Promise.resolve(undefined as never),
      };
      created.promise = startTunnel(request).then((tunnel) => {
        const close = tunnel.close;
        tunnel.close = async () => {
          if (tunnels.get(request.key) === created) tunnels.delete(request.key);
          created.closing = true;
          await close();
        };
        return tunnel;
      });
      entry = created;
      tunnels.set(request.key, entry);
    }
    let tunnel: ManagedTunnel;
    try {
      tunnel = await entry.promise;
    } catch (error) {
      if (tunnels.get(request.key) === entry) tunnels.delete(request.key);
      throw error;
    }
    if (entry.closing) {
      await tunnel.close();
      throw new Error("SSH socket forwarding closed");
    }
    if (tunnel.alive() && tunnels.get(request.key) === entry) return tunnel;
    await tunnel.close();
    if (tunnels.get(request.key) === entry) tunnels.delete(request.key);
  }
}

export async function closeSocketTunnels(sourceId?: string): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const [key, entry] of tunnels) {
    if (sourceId && sourceId !== entry.sourceId) continue;
    entry.closing = true;
    tunnels.delete(key);
    closing.push(
      entry.promise.then(
        (tunnel) => tunnel.close(),
        () => {},
      ),
    );
  }
  await Promise.all(closing);
}
