import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSocketTunnels, ensureSocketTunnel } from "./ssh-tunnels.ts";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { Source } from "./state.ts";
import { createHerdrClient, type HerdrClientTransport } from "./herdr/client.ts";
import { discoverHerdrPython, herdrApiRequest, localHerdrSockets, parseHerdrSockets, validateHerdrLocation, type HerdrSockets } from "./herdr/api.ts";
import { aggregateStatus, herdrStatus, type ProgramStatus } from "../shared/status.ts";

export type { Source } from "./state.ts";
export interface PaneResource {
  id: string;
  name: string;
  active: boolean;
  agent?: string;
  terminalTitle?: string;
  status: ProgramStatus;
}
export interface WindowResource {
  id: string;
  name: string;
  status: ProgramStatus;
  panes: PaneResource[];
}
export interface SpaceResource {
  id: string;
  name: string;
  windows: WindowResource[];
}
export interface SourceResource {
  id: string;
  name: string;
  status: "online" | "offline";
  error?: string;
  spaces: SpaceResource[];
}
export interface TerminalHandle {
  connect(cols: number, rows: number): Promise<HerdrClientTransport>;
  cleanup(): Promise<void>;
}

const COMMAND_TIMEOUT = 15_000;
const active = new Set<{
  sourceId: string;
  spaceId: string;
  windowId: string;
  cleanup(): Promise<void>;
}>();
const preparing = new Map<string, number>();

async function releaseIdleConnections(sourceId: string): Promise<void> {
  if (
    !preparing.has(sourceId) &&
    ![...active].some((item) => item.sourceId === sourceId)
  )
    await closeProviderConnections(sourceId);
}

/** Quotes one argument for the remote POSIX login shell; never concatenate raw input. */
export function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new Error("NUL is not allowed in command arguments");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseSshTarget(target: string): {
  destination: string;
  port?: string;
} {
  if (!target || /[\s\x00-\x1f\x7f]/u.test(target))
    throw new Error("Invalid SSH target");
  if (target.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error("Invalid SSH URI");
    }
    if (
      url.protocol !== "ssh:" ||
      url.password ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Use ssh://[user@]host[:port] without passwords or paths",
      );
    }
    const user = decodeURIComponent(url.username);
    const host = url.hostname;
    if (
      !/^[a-zA-Z0-9_.-]*$/u.test(user) ||
      !/^(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\])$/u.test(host) ||
      host.startsWith("-")
    ) {
      throw new Error("Invalid SSH host or user");
    }
    if (url.port && (+url.port < 1 || +url.port > 65535))
      throw new Error("Invalid SSH port");
    return {
      destination: `${user ? `${user}@` : ""}${host}`,
      ...(url.port ? { port: url.port } : {}),
    };
  }
  if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(target)) {
    throw new Error(
      "Use an SSH config alias, user@host, or ssh://[user@]host[:port]",
    );
  }
  return { destination: target };
}

export function validateSource(source: Source): void {
  if (
    !source.id ||
    !source.name ||
    !["local", "ssh"].includes(source.transport)
  )
    throw new Error("Invalid source");
  if (source.transport === "ssh") parseSshTarget(source.target ?? "");
  validateHerdrLocation(source);
  for (const value of [
    source.herdrSession,
    source.sshIdentityFile,
    source.sshKnownHostsFile,
  ]) {
    if (value && /[\x00-\x1f\x7f]/u.test(value))
      throw new Error("Source values cannot contain control characters");
  }
}

function sshOptions(source: Source): string[] {
  const ssh = parseSshTarget(source.target!);
  const options = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (ssh.port) options.push("-p", ssh.port);
  if (source.sshIdentityFile)
    options.push("-i", source.sshIdentityFile, "-o", "IdentitiesOnly=yes");
  if (source.sshKnownHostsFile)
    options.push(
      "-o",
      `UserKnownHostsFile="${source.sshKnownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    );
  return [...options, "--", ssh.destination];
}

/** One scoped process for file transfer; no terminal or provider state is changed. */
export function sourcePythonCommand(source: Source, script: string, args: string[]) {
  validateSource(source);
  const command = ["python3", "-c", script, ...args];
  return source.transport === "local"
    ? { file: command[0]!, args: command.slice(1), env: commandEnvironment() }
    : { file: "ssh", args: [...sshOptions(source), `exec ${command.map(shellQuote).join(" ")}`], env: commandEnvironment() };
}

export async function editorAuthority(source: Source): Promise<{ hostName: string; user: string; port: number }> {
  if (source.transport === "local") {
    const listener = process.env.CANVAS_HOST;
    const hostName = process.env.CANVAS_PUBLIC_SSH_HOST ||
      (listener && !["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"].includes(listener) ? listener : hostname());
    return { hostName, user: userInfo().username, port: Number(process.env.CANVAS_PUBLIC_SSH_PORT || 22) };
  }
  // Resolve an existing source's SSH alias and defaults on the Canvas server.
  // Only these three non-secret fields leave this function; identity paths,
  // jump commands and the rest of the client's configuration never enter URLs.
  const config = await execute({ file: "ssh", args: ["-G", ...sshOptions(source)] });
  const fields = new Map(config.split(/\r?\n/u).flatMap(line => {
    const match = /^(hostname|user|port)\s+(.+)$/u.exec(line);
    return match ? [[match[1]!, match[2]!] as const] : [];
  }));
  const hostName = fields.get("hostname")?.replace(/^\[|\]$/g, "");
  const user = fields.get("user");
  const port = Number(fields.get("port"));
  if (!hostName || !user || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH editor address could not be resolved");
  return { hostName, user, port };
}

function socketTunnelIdentity(
  source: Source,
  paths: string[],
  reverse: Record<string, { remotePath: string; localPath: string }> = {},
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.id,
        source.target,
        source.sshIdentityFile,
        source.sshKnownHostsFile,
        paths,
        Object.entries(reverse).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

function tunnelRequest(
  source: Source,
  endpoints: Record<string, string>,
  reverse?: Record<string, { remotePath: string; localPath: string }>,
  cleanupRemote?: () => Promise<void>,
  lifecycleSourceId = source.id,
) {
  const ssh = sshOptions(source);
  return {
    sourceId: lifecycleSourceId,
    key: socketTunnelIdentity(source, Object.values(endpoints), reverse),
    sshArgs: ssh,
    env: commandEnvironment(),
    discover: async () => endpoints,
    ...(reverse ? { reverse } : {}),
    ...(cleanupRemote ? { cleanupRemote } : {}),
  };
}

async function discoverHerdrSockets(source: Source): Promise<HerdrSockets> {
  validateHerdrLocation(source);
  if (source.transport === "local") return localHerdrSockets(source);
  const location = { herdrSocket: source.herdrSocket, herdrSession: source.herdrSession };
  return parseHerdrSockets(await execute(sourcePythonCommand(source, discoverHerdrPython, [JSON.stringify(location)])));
}

async function connectedHerdrSockets(source: Source): Promise<HerdrSockets> {
  const paths = await discoverHerdrSockets(source);
  if (source.transport === "local") return paths;
  const tunnel = await ensureSocketTunnel(tunnelRequest(source, { "herdr.sock": paths.api, "herdr-client.sock": paths.client }));
  return { api: tunnel.sockets["herdr.sock"]!, client: tunnel.sockets["herdr-client.sock"]! };
}

async function requestHerdr(source: Source, method: string, params: Record<string, unknown> = {}) {
  validateSource(source);
  preparing.set(source.id, (preparing.get(source.id) || 0) + 1);
  try { return await herdrApiRequest((await connectedHerdrSockets(source)).api, method, params); }
  finally {
    const count = preparing.get(source.id)! - 1;
    if (count) preparing.set(source.id, count); else preparing.delete(source.id);
    await releaseIdleConnections(source.id);
  }
}

async function runRemoteShell(source: Source, command: string): Promise<string> {
  if (source.transport !== "ssh") throw new Error("Remote shell is only available for SSH sources");
  return await execute({ file: "ssh", args: [...sshOptions(source), command] });
}

async function runRemoteShellWithInput(source: Source, command: string, input: Buffer | string): Promise<string> {
  if (source.transport !== "ssh") throw new Error("Remote shell is only available for SSH sources");
  const child = spawn("ssh", [...sshOptions(source), command], {
    env: commandEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", settled = false;
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const result = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(stdout.trimEnd());
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(new Error("SSH registry command timed out"));
  }, COMMAND_TIMEOUT);
  timer.unref();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1200);
  });
  child.once("error", error => finish(error));
  child.stdin?.once("error", error => finish(error));
  child.once("close", code => {
    if (code === 0) finish();
    else finish(new Error(stderr.trim() || `SSH registry command exited with code ${code}`));
  });
  child.stdin?.end(input);
  return await result;
}

export async function nativeSocketForSource(source: Source): Promise<string> {
  validateSource(source);
  return (await discoverHerdrSockets(source)).api;
}

export interface OpenBridgeRecord {
  version: 1;
  nativeSocket: string;
  socket: string;
  secret: string;
}

const bridgeRegistryPython = String.raw`import hashlib,json,os,pathlib,secrets,stat,sys
os.umask(0o077)
record=json.loads(sys.stdin.buffer.read())
base=pathlib.Path.home()/'.local/state/canvas/bridges'
base.mkdir(mode=0o700,parents=True,exist_ok=True)
info=base.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077: raise SystemExit('Canvas bridge registry directory is not private')
key=hashlib.sha256((record['nativeSocket']+'\0'+record['secret']).encode()).hexdigest()
target=base/(key+'.json')
body=(json.dumps(record,separators=(',',':'))+'\n').encode()
if sys.argv[1]=='remove':
 try: info=target.lstat()
 except FileNotFoundError: info=None
 if info is not None:
  if not stat.S_ISREG(info.st_mode) or target.is_symlink(): raise SystemExit('Canvas bridge registry changed; leaving it untouched')
  if target.read_bytes()!=body: raise SystemExit('Canvas bridge registry changed; leaving it untouched')
  target.unlink()
 print(str(target)); raise SystemExit(0)
try: info=target.lstat()
except FileNotFoundError: info=None
if info is not None:
 if not stat.S_ISREG(info.st_mode) or target.is_symlink(): raise SystemExit('Canvas bridge registry key collision')
 if target.read_bytes()==body: print(str(target)); raise SystemExit(0)
 raise SystemExit('Canvas bridge registry key collision')
temporary=base/('.'+key+'.'+secrets.token_hex(8)+'.tmp')
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
 with os.fdopen(fd,'wb') as handle:
  handle.write(body);handle.flush();os.fsync(handle.fileno())
 os.link(temporary,target)
finally:
 temporary.unlink(missing_ok=True)
directory=os.open(base,os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
print(str(target))`;

function validateBridgeRecord(record: OpenBridgeRecord): void {
  if (record.version !== 1 ||
      !record.nativeSocket.startsWith("/") || !record.socket.startsWith("/") ||
      /[:\x00-\x1f\x7f]/u.test(record.nativeSocket + record.socket) ||
      record.secret.length < 32 || record.secret.length > 256 || /[^A-Za-z0-9_-]/u.test(record.secret))
    throw new Error("Invalid Canvas bridge registry record");
}

export async function writeRemoteBridgeRegistry(
  source: Source,
  record: OpenBridgeRecord,
): Promise<() => Promise<void>> {
  validateSource(source);
  if (source.transport !== "ssh") throw new Error("Remote bridge registry requires an SSH source");
  validateBridgeRecord(record);
  const expected = JSON.stringify(record);
  const python = `python3 -c ${shellQuote(bridgeRegistryPython)}`;
  await runRemoteShellWithInput(source, `${python} write`, expected);
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    await runRemoteShellWithInput(source, `${python} remove`, expected);
    cleaned = true;
  };
}

// The same locked transaction runs locally and over SSH. The pending hash is
// durable before a target replacement, so interruption can never orphan ownership.
const helperInstallPython = String.raw`import fcntl,hashlib,json,os,re,secrets,stat,sys
os.umask(0o077)
expected=sys.argv[1]
payload=sys.stdin.buffer.read(8*1024*1024+1)
if not payload or len(payload)>8*1024*1024 or hashlib.sha256(payload).hexdigest()!=expected: raise SystemExit('Canvas helper checksum mismatch')
uid=os.getuid()
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
refusal='Canvas helper path is unsafe; refusing to overwrite it'
def owned(info,directory=False,private=False):
 if info.st_uid!=uid or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)): raise SystemExit(refusal)
 if info.st_mode & (0o077 if private else 0o002 if directory else 0o022): raise SystemExit(refusal)
 if private and stat.S_IMODE(info.st_mode)!=(0o700 if directory else 0o600): raise SystemExit(refusal)
 if private and not directory and info.st_nlink!=1: raise SystemExit(refusal)
def directory(parent,name,private=False):
 try: os.mkdir(name,0o700,dir_fd=parent)
 except FileExistsError: pass
 fd=os.open(name,flags|os.O_DIRECTORY,dir_fd=parent)
 owned(os.fstat(fd),True,private)
 return fd
home=os.environ.get('HOME')
if not home or not os.path.isabs(home): raise SystemExit('HOME is required to install the Canvas helper')
root=os.open(home,flags|os.O_DIRECTORY)
owned(os.fstat(root),True)
local=directory(root,'.local')
state=directory(directory(local,'state'),'canvas',True)
bin=directory(local,'bin')
lock=os.open('helper-install.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=state)
owned(os.fstat(lock),private=True)
fcntl.flock(lock,fcntl.LOCK_EX)
locked=os.stat('helper-install.lock',dir_fd=state,follow_symlinks=False)
if (locked.st_dev,locked.st_ino)!=(os.fstat(lock).st_dev,os.fstat(lock).st_ino): raise SystemExit(refusal)
marker='.canvas-managed-sha256'
def read(name,private=False):
 try: fd=os.open(name,flags,dir_fd=bin)
 except FileNotFoundError: return None,None
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno());owned(info,private=private)
  if info.st_size>(65536 if private else 8*1024*1024): raise SystemExit(refusal)
  return stream.read(),info
def temporary(body,mode):
 name='.canvas.'+secrets.token_hex(16)+'.tmp'
 fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=bin)
 with os.fdopen(fd,'wb') as stream:
  stream.write(body);stream.flush();os.fchmod(stream.fileno(),mode);os.fsync(stream.fileno())
 return name
def write_marker(value):
 # Check every replacement; an existing symlink or unowned marker is never adopted.
 read(marker,True)
 name=temporary((json.dumps(value,separators=(',',':'))+'\n').encode(),0o600)
 try: os.replace(name,marker,src_dir_fd=bin,dst_dir_fd=bin);os.fsync(bin)
 finally:
  try: os.unlink(name,dir_fd=bin)
  except FileNotFoundError: pass
current_body,current_info=read('canvas')
current=hashlib.sha256(current_body).hexdigest() if current_body is not None else None
marker_body,_=read(marker,True)
managed=None
if marker_body is not None:
 try: managed=json.loads(marker_body)
 except ValueError: raise SystemExit(refusal)
 if not isinstance(managed,dict) or managed.get('version')!=1: raise SystemExit(refusal)
 for key in ('current','pending'):
  value=managed.get(key)
  if value is not None and (not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value)): raise SystemExit(refusal)
 history=managed.get('history')
 if not isinstance(history,list) or len(history)>256 or any(not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value) for value in history): raise SystemExit(refusal)
if managed and managed.get('pending')==current and current is not None:
 history=managed['history'][:]
 if managed.get('current') and managed['current']!=current and managed['current'] not in history: history.append(managed['current'])
 managed={'version':1,'current':current,'history':history[-256:]};write_marker(managed)
if current is not None and current!=expected and (not managed or managed.get('current')!=current): raise SystemExit('A different canvas helper already exists; refusing to overwrite it')
if managed and current!=expected and expected in managed['history']: raise SystemExit('A previously replaced Canvas helper cannot overwrite the current version')
if current==expected:
 if current_info.st_mode & 0o111 != 0o111: raise SystemExit('Canvas helper is not executable; leaving it untouched')
 write_marker({'version':1,'current':current,'history':managed['history'] if managed else []})
 raise SystemExit(0)
history=managed['history'][:] if managed else []
write_marker({'version':1,'current':current,'pending':expected,'history':history})
name=temporary(payload,0o755)
try:
 # Refresh the identity immediately before publication. The lock serializes all
 # Canvas writers; the initial hard link also protects against unrelated writers.
 fresh,fresh_info=read('canvas')
 if current_info is None:
  os.link(name,'canvas',src_dir_fd=bin,dst_dir_fd=bin,follow_symlinks=False)
 else:
  if fresh_info is None or (fresh_info.st_dev,fresh_info.st_ino)!=(current_info.st_dev,current_info.st_ino) or hashlib.sha256(fresh).hexdigest()!=current: raise SystemExit(refusal)
  os.replace(name,'canvas',src_dir_fd=bin,dst_dir_fd=bin)
 os.fsync(bin)
finally:
 try: os.unlink(name,dir_fd=bin)
 except FileNotFoundError: pass
if current and current not in history: history.append(current)
write_marker({'version':1,'current':expected,'history':history[-256:]})`;

async function installLocalHelper(bytes: Buffer, expectedHash: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", ["-c", helperInstallPython, expectedHash], {
      env: commandEnvironment(), stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT);
    timer.unref();
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-1200); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.once("error", () => {});
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Canvas helper installation failed"));
    });
    child.stdin.end(bytes);
  });
}

export async function installCanvasHelper(source: Source, helperBytes: Buffer): Promise<void> {
  validateSource(source);
  if (!Buffer.isBuffer(helperBytes) || helperBytes.length === 0 || helperBytes.length > 8 * 1024 * 1024)
    throw new Error("Canvas helper size is invalid");
  const expectedHash = createHash("sha256").update(helperBytes).digest("hex");
  if (source.transport === "local") return await installLocalHelper(helperBytes, expectedHash);
  const command = `python3 -c ${shellQuote(helperInstallPython)} ${expectedHash}`;
  await runRemoteShellWithInput(source, command, helperBytes);
}

export async function prepareOpenBridge(
  source: Source,
  localUnixSocket: string,
): Promise<{ nativeSocket: string; remoteSocket?: string; cleanup(): Promise<void> }> {
  validateSource(source);
  if (!localUnixSocket.startsWith("/") || /[:\x00-\x1f\x7f]/u.test(localUnixSocket))
    throw new Error("Local bridge socket path is invalid");
  const nativeSocket = await nativeSocketForSource(source);
  if (source.transport !== "ssh") return { nativeSocket, cleanup: async () => {} };

  const prefix = createHash("sha256").update(source.id).digest("hex").slice(0, 12);
  const remoteDirectory = `/tmp/canvas-bridge-${prefix}-${randomUUID().replaceAll("-", "")}`;
  const remoteSocket = join(remoteDirectory, "open.sock");
  await runRemoteShell(source, `umask 077 && mkdir -m 700 -- ${shellQuote(remoteDirectory)}`);
  const cleanupRemote = async () => {
    await runRemoteShell(source, `rmdir -- ${shellQuote(remoteDirectory)}`);
  };
  try {
    const tunnel = await ensureSocketTunnel(tunnelRequest(
      source,
      {},
      { "open.sock": { remotePath: remoteSocket, localPath: localUnixSocket } },
      cleanupRemote,
      `${source.id}:canvas-open`,
    ));
    try {
      await runRemoteShell(source,
        `i=0; while [ "$i" -lt 400 ]; do if [ -S ${shellQuote(remoteSocket)} ]; then exit 0; fi; i=$((i+1)); sleep 0.025; done; exit 1`,
      );
    } catch (error) {
      await tunnel.close();
      throw error;
    }
    let cleaned = false;
    return {
      nativeSocket,
      remoteSocket: tunnel.remoteSockets["open.sock"],
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await tunnel.close();
      },
    };
  } catch (error) {
    await cleanupRemote().catch(() => {});
    throw error;
  }
}

/** Minimal named environment for provider commands; never forwards server secrets. */
function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Close only Canvas-owned socket forwards; no workstation SSH configuration changes. */
export async function closeProviderConnections(sourceId?: string): Promise<void> {
  await closeSocketTunnels(sourceId);
}

async function execute(
  command: { file: string; args: string[] },
  env = commandEnvironment(),
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      command.file,
      command.args,
      {
        env,
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(0, 1200) || error.message;
          reject(new Error(detail));
        } else resolve(stdout.trimEnd());
      },
    );
  });
}

function name(value: string): string {
  if (!value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/u.test(value))
    throw new Error(
      "Name must contain 1–100 characters without control characters",
    );
  return value.trim();
}

async function herdrSpaces(source: Source): Promise<SpaceResource[]> {
  const response = await requestHerdr(source, "session.snapshot");
  const snapshot = response.snapshot as {
    workspaces: Array<{ workspace_id: string; label: string }>;
    tabs: Array<{ workspace_id: string; tab_id: string; label: string; agent_status?: string }>;
    panes?: Array<{ tab_id: string; pane_id: string; label?: string; display_agent?: string; agent?: string; focused?: boolean; agent_status?: string; terminal_title_stripped?: string }>;
  };
  if (!snapshot || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs))
    throw new Error("Unexpected herdr snapshot response");
  return snapshot.workspaces.map(
    (workspace: { workspace_id: string; label: string }) => ({
      id: workspace.workspace_id,
      name: workspace.label || workspace.workspace_id,
      windows: snapshot.tabs
        .filter(
          (tab: { workspace_id: string }) =>
            tab.workspace_id === workspace.workspace_id,
        )
        .map(
          (tab: { tab_id: string; label: string; agent_status?: string }) => {
            const panes: PaneResource[] = (
              Array.isArray(snapshot.panes) ? snapshot.panes : []
            )
              .filter((pane: { tab_id: string }) => pane.tab_id === tab.tab_id)
              .map(
                (
                  pane: {
                    pane_id: string;
                    label?: string;
                    display_agent?: string;
                    agent?: string;
                    focused?: boolean;
                    agent_status?: string;
                    terminal_title_stripped?: string;
                  },
                  index: number,
                ) => ({
                  id: pane.pane_id,
                  name:
                    pane.label ||
                    pane.display_agent ||
                    pane.agent ||
                    String(index + 1),
                  active: pane.focused === true,
                  terminalTitle: typeof pane.terminal_title_stripped === "string"
                    ? Array.from(pane.terminal_title_stripped.replace(/[\x00-\x1f\x7f-\x9f]/gu, "").trim()).slice(0, 1024).join("") : "",
                  ...(pane.display_agent || pane.agent
                    ? { agent: pane.display_agent || pane.agent }
                    : {}),
                  status: herdrStatus(pane.agent_status),
                }),
              );
            return {
              id: tab.tab_id,
              name: tab.label || tab.tab_id,
              status: panes.length
                ? aggregateStatus(panes.map(pane => pane.status))
                : herdrStatus(tab.agent_status),
              panes,
            };
          },
        ),
    }),
  );
}

export async function listResources(source: Source): Promise<SourceResource> {
  validateSource(source);
  const result: SourceResource = {
    id: source.id,
    name: source.name,
    status: "online",
    spaces: [],
  };
  try {
    result.spaces = await herdrSpaces(source);
  } catch (error) {
    result.status = "offline";
    result.error = error instanceof Error ? error.message : "Connection failed";
  }
  return result;
}

async function requireResource(
  source: Source,
  spaceId: string,
  windowId?: string,
): Promise<SpaceResource> {
  const snapshot = await listResources(source);
  if (snapshot.status !== "online")
    throw new Error(snapshot.error || "Source is offline");
  const space = snapshot.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error("Space no longer exists; refresh the overview");
  if (windowId && !space.windows.some((w) => w.id === windowId))
    throw new Error(
      "Window no longer belongs to this space; refresh the overview",
    );
  return space;
}

export async function createSpace(
  source: Source,
  label?: string,
  sourceSpaceId?: string,
): Promise<{ spaceId: string; windowId: string }> {
  if (sourceSpaceId) await requireResource(source, sourceSpaceId);
  return createdWindow(await requestHerdr(source, "workspace.create", {
    ...(label?.trim() ? { label: name(label) } : {}),
    ...(sourceSpaceId ? { source_workspace_id: sourceSpaceId } : {}),
    focus: false,
  }));
}

function createdWindow(response: Record<string, unknown>): { spaceId: string; windowId: string } {
  const tab = response.tab as { workspace_id?: unknown; tab_id?: unknown } | undefined;
  if (typeof tab?.workspace_id !== "string" || !tab.workspace_id || typeof tab.tab_id !== "string" || !tab.tab_id)
    throw new Error("Unexpected herdr creation response");
  return { spaceId: tab.workspace_id, windowId: tab.tab_id };
}
export async function renameSpace(
  source: Source,
  spaceId: string,
  label: string,
): Promise<void> {
  label = name(label);
  await requireResource(source, spaceId);
  await requestHerdr(source, "workspace.rename", { workspace_id: spaceId, label });
}
export async function closeSpace(
  source: Source,
  spaceId: string,
): Promise<void> {
  await requireResource(source, spaceId);
  await Promise.all(
    [...active]
      .filter(
        (handle) => handle.sourceId === source.id && handle.spaceId === spaceId,
      )
      .map((handle) => handle.cleanup()),
  );
  await requestHerdr(source, "workspace.close", { workspace_id: spaceId });
}
export async function createWindow(
  source: Source,
  spaceId: string,
  label?: string,
): Promise<{ spaceId: string; windowId: string }> {
  await requireResource(source, spaceId);
  return createdWindow(await requestHerdr(source, "tab.create", {
    workspace_id: spaceId,
    ...(label?.trim() ? { label: name(label) } : {}),
    focus: false,
  }));
}
export async function renameWindow(
  source: Source,
  spaceId: string,
  windowId: string,
  label: string,
): Promise<void> {
  label = name(label);
  await requireResource(source, spaceId, windowId);
  await requestHerdr(source, "tab.rename", { tab_id: windowId, label });
}
export async function closeWindow(
  source: Source,
  spaceId: string,
  windowId: string,
): Promise<void> {
  await requireResource(source, spaceId, windowId);
  await Promise.all(
    [...active]
      .filter(
        (handle) =>
          handle.sourceId === source.id && handle.windowId === windowId,
      )
      .map((handle) => handle.cleanup()),
  );
  await requestHerdr(source, "tab.close", { tab_id: windowId });
}

export async function openTerminal(
  source: Source,
  spaceId: string,
  windowId: string,
): Promise<TerminalHandle> {
  preparing.set(source.id, (preparing.get(source.id) || 0) + 1);
  try {
    return await prepareTerminal(source, spaceId, windowId);
  } finally {
    const count = preparing.get(source.id)! - 1;
    if (count) preparing.set(source.id, count);
    else preparing.delete(source.id);
    await releaseIdleConnections(source.id);
  }
}

async function prepareTerminal(
  source: Source,
  spaceId: string,
  windowId: string,
): Promise<TerminalHandle> {
  await requireResource(source, spaceId, windowId);
  const sockets = await connectedHerdrSockets(source);
  let closed = false;
  const handle = { sourceId: source.id, spaceId, windowId, cleanup };
  async function cleanup() {
    if (closed) return;
    closed = true;
    active.delete(handle);
    await releaseIdleConnections(source.id);
  }
  active.add(handle);
  return {
    connect: (cols, rows) => createHerdrClient({ socketPath: sockets.client, tabId: windowId, cols, rows,
      readSelection: params => herdrApiRequest(sockets.api, "pane.selection.read", params) }),
    cleanup,
  };
}
