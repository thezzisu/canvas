import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackHost } from "./loopback.ts";

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
  tcp?: Record<string, { host: string; port: number }>;
  reverse?: Record<string, { remotePath: string; localPath: string }>;
  cleanupRemote?(): Promise<void>;
  signal?: AbortSignal;
}

const tunnels = new Map<string, TunnelEntry>();

function checkSocketPath(path: string): void {
  if (!path.startsWith("/") || /[:\x00-\x1f\x7f]/u.test(path))
    throw new Error("Unsupported remote Unix socket path");
}

// OpenSSH leaves reverse Unix socket names behind when its channel exits.
// Only remove an inode previously observed in our private endpoint directory,
// and only after its listener has gone away. Never replace another listener.
const reverseSocketPython = String.raw`import errno,json,os,socket,stat,sys
operation=sys.argv[1]
entries=json.loads(sys.argv[2])
result={}
for path,expected in entries.items():
 parent=os.lstat(os.path.dirname(path))
 if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or parent.st_mode&0o077:
  raise SystemExit('Reverse socket directory is not private')
 try: info=os.lstat(path)
 except FileNotFoundError:
  if operation=='ready': raise SystemExit('Reverse socket is not ready')
  continue
 if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid(): raise SystemExit('Reverse socket path is not owned by Canvas')
 identity=str(info.st_dev)+':'+str(info.st_ino)
 if operation=='ready':
  result[path]=identity; continue
 if expected!=identity: raise SystemExit('Reverse socket was replaced; leaving it untouched')
 connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 connection.settimeout(0.2)
 try:
  connection.connect(path)
 except OSError as error:
  if error.errno not in (errno.ECONNREFUSED,errno.ENOENT): raise
 else:
  raise SystemExit('Previous reverse socket listener is still active')
 finally:
  connection.close()
 try: current=os.lstat(path)
 except FileNotFoundError: continue
 if (current.st_dev,current.st_ino)!=(info.st_dev,info.st_ino): raise SystemExit('Reverse socket changed during cleanup')
 os.unlink(path)
print(json.dumps(result))`;

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function remoteSocketState(
  request: TunnelRequest,
  operation: "prepare" | "ready" | "clean",
  identities: Record<string, string | null>,
): Promise<Record<string, string>> {
  return await new Promise((resolve, reject) => {
    const command = ["python3", "-c", reverseSocketPython, operation, JSON.stringify(identities)].map(shellArgument).join(" ");
    execFile("ssh", [...request.sshArgs, command], {
      env: request.env, timeout: 8000, maxBuffer: 64 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim().slice(-1200) || "Reverse socket inspection failed")); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid reverse socket inspection response")); }
    });
  });
}

async function startTunnel(request: TunnelRequest): Promise<ManagedTunnel> {
  request.signal?.throwIfAborted();
  const remote = await request.discover();
  request.signal?.throwIfAborted();
  const entries = Object.entries(remote);
  const reverse = Object.entries(request.reverse || {});
  const tcp = Object.entries(request.tcp || {});
  if (!entries.length && !reverse.length && !tcp.length)
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
  for (const [name, endpoint] of tcp) {
    if (!/^[a-z][a-z0-9-]*\.sock$/u.test(name) || !isLoopbackHost(endpoint.host)
        || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)
      throw new Error("Invalid loopback forwarding endpoint");
  }
  // Unix socket names are short on both Linux and macOS. mkdtemp creates an
  // owner-only directory; no global SSH configuration or existing socket changes.
  const directory = await mkdtemp(
    join(tmpdir().length < 50 ? tmpdir() : "/tmp", "canvas-s-"),
  );
  const sockets = Object.fromEntries(
    [...entries, ...tcp].map(([name]) => [name, join(directory, name)]),
  );
  const forwards = entries.flatMap(([name, remotePath]) => [
    "-L",
    `${sockets[name]}:${remotePath}`,
  ]);
  forwards.push(...tcp.flatMap(([name, endpoint]) => ["-L",
    `${sockets[name]}:${endpoint.host === "::1" ? "[::1]" : endpoint.host}:${endpoint.port}`]));
  const reverseForwards = reverse.flatMap(([, endpoint]) => [
    "-R",
    `${endpoint.remotePath}:${endpoint.localPath}`,
  ]);
  const remoteSockets = Object.fromEntries(
    reverse.map(([name, endpoint]) => [name, endpoint.remotePath]),
  );
  const reverseIdentities: Record<string, string | null> = Object.fromEntries(reverse.map(([, endpoint]) => [endpoint.remotePath, null]));
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
    if (reverse.length) await remoteSocketState(request, "prepare", reverseIdentities);
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
    try { while (true) {
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
      let reverseReady = !reverse.length;
      if (reverse.length) {
        try {
          Object.assign(reverseIdentities, await remoteSocketState(request, "ready", reverseIdentities));
          reverseReady = true;
        } catch {
          // Remote bind follows SSH authentication and may not exist yet.
        }
      }
      if (ready.every(Boolean) && reverseReady && !exited && !stopped) return;
      if (Date.now() >= deadline) {
        await terminate();
        throw new Error("SSH socket forwarding timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } } catch (error) { await terminate(); throw error; }
  }
  const close = () =>
    (closing ??= (async () => {
      stopped = true;
      request.signal?.removeEventListener("abort", aborted);
      if (retry) clearTimeout(retry);
      wakeRetry?.();
      await terminate();
      await reconnecting;
      await rm(directory, { recursive: true, force: true });
      if (reverse.length) {
        const deadline = Date.now() + 3000;
        while (true) {
          try { await remoteSocketState(request, "clean", reverseIdentities); break; }
          catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      await request.cleanupRemote?.();
    })());
  const aborted = () => { stopped = true; child?.kill("SIGTERM"); wakeRetry?.(); };
  request.signal?.addEventListener("abort", aborted, { once: true });
  if (request.signal?.aborted) aborted();
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
