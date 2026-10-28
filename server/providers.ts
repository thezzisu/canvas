import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSocketTunnels, ensureSocketTunnel } from "./ssh-tunnels.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "./state.ts";
import {
  observeTmuxWindow,
  pruneTmuxStatus,
  tmuxProgramStatus,
  disposeStatusSource,
  tmuxGeometryRevision,
} from "./tmux-status.ts";
export { disposeStatusSource, closeStatusObservers } from "./tmux-status.ts";
import {
  aggregateStatus,
  herdrStatus,
  tmuxProgressStatus,
  type PaneResource,
  type StatusDetails,
} from "./status.ts";

export type { Source } from "./state.ts";
export interface WindowResource extends StatusDetails {
  id: string;
  name: string;
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
  type: Source["type"];
  host: string;
  status: "online" | "offline";
  error?: string;
  spaces: SpaceResource[];
}
export interface NativeSize {
  cols: number;
  rows: number;
  token: string;
  policy?: string;
  effectivePolicy?: string;
  revision?: number;
  operationId?: string;
  recoveredFromToken?: string;
}
export class NativeGeometryConflictError extends Error {
  constructor() {
    super("Native window size changed while resizing");
    this.name = "NativeGeometryConflictError";
  }
}
interface PendingGeometryWrite {
  id: string;
  before: NativeSize;
  ambiguous: boolean;
}
async function recoverGeometryWrite(
  read: () => Promise<NativeSize>,
  pending: PendingGeometryWrite,
  failure: unknown,
): Promise<NativeSize> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = await read();
      if (current.operationId === pending.id) return current;
      if (current.token !== pending.before.token)
        throw new NativeGeometryConflictError();
    } catch (error) {
      if (error instanceof NativeGeometryConflictError) throw error;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw failure;
}
export interface TerminalCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cleanup(): Promise<void>;
  /** Client viewport geometry follows the provider's ordinary attach semantics. */
  geometryMode?: "client";
  initialSize?: NativeSize;
  readSize?(fresh?: boolean): Promise<NativeSize>;
  resize?(
    cols: number,
    rows: number,
    expectedToken?: string,
  ): Promise<NativeSize>;
  commitSize?(): Promise<void>;
  restoreSize?(
    before: NativeSize,
    expectedToken: string,
    prepare?: (size: NativeSize) => Promise<void>,
  ): Promise<NativeSize>;
  watchSize?(listener: () => void): () => void;
  connected?(): void;
}

const HELPER_PREFIX = "__canvas_";
const INSTANCE = randomUUID().replaceAll("-", "").slice(0, 12);
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
  host: string;
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
      host: `${host}${url.port ? `:${url.port}` : ""}`,
      ...(url.port ? { port: url.port } : {}),
    };
  }
  if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(target)) {
    throw new Error(
      "Use an SSH config alias, user@host, or ssh://[user@]host[:port]",
    );
  }
  return { destination: target, host: target.split("@").at(-1)! };
}

export function validateSource(source: Source): void {
  if (
    !source.id ||
    !source.name ||
    !["tmux", "herdr"].includes(source.type) ||
    !["local", "ssh"].includes(source.transport)
  )
    throw new Error("Invalid source");
  if (source.transport === "ssh") parseSshTarget(source.target ?? "");
  for (const value of [
    source.binary,
    source.tmuxSocket,
    source.herdrSession,
    source.sshIdentityFile,
    source.sshKnownHostsFile,
  ]) {
    if (value && /[\x00-\x1f\x7f]/u.test(value))
      throw new Error("Source values cannot contain control characters");
  }
  if (source.binary?.startsWith("-"))
    throw new Error("Binary must be an executable name or path");
}

// SSH does not normally run an interactive/login shell. Resolve only the
// selected remote executable without loading shell startup files.
const REMOTE_CLIENT = `
program=$1
shift
candidate=$(command -v "$program" 2>/dev/null) || candidate=
if [ -n "$candidate" ]; then
  exec "$candidate" "$@"
fi
if [ -n "\${HOME:-}" ]; then
  for directory in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    candidate="$directory/$program"
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      exec "$candidate" "$@"
    fi
  done
fi
for directory in /usr/local/bin /opt/homebrew/bin; do
  candidate="$directory/$program"
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done
printf 'Canvas could not find %s on the remote machine. Install it or set the connection executable to its full path.\\n' "$program" >&2
exit 127
`;

export function sourceCommand(
  source: Source,
  args: string[],
  tty = false,
): { file: string; args: string[] } {
  validateSource(source);
  const binary = source.binary || source.type;
  const base =
    source.type === "tmux"
      ? source.tmuxSocket
        ? [source.tmuxSocket.startsWith("/") ? "-S" : "-L", source.tmuxSocket]
        : []
      : ["--session", source.herdrSession || "default"];
  if (source.transport === "local")
    return { file: binary, args: [...base, ...args] };
  // Clear inherited nesting variables on the destination too. env -u is supported
  // by both GNU and BSD env, unlike shell-specific unset syntax.
  const remote = [
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "-u",
    "HERDR_SOCKET_PATH",
    "-u",
    "HERDR_CLIENT_SOCKET_PATH",
    "-u",
    "HERDR_PANE_ID",
    "-u",
    "HERDR_SESSION",
    "TERM=xterm-256color",
    ...(tty ? ["COLORTERM=truecolor"] : []),
    ...(source.binary
      ? [binary]
      : ["sh", "-c", REMOTE_CLIENT, "canvas-remote-client", source.type]),
    ...base,
    ...args,
  ];
  return {
    file: "ssh",
    args: [
      ...sshOptions(source, tty),
      `exec ${remote.map(shellQuote).join(" ")}`,
    ],
  };
}

function sshOptions(source: Source, tty = false): string[] {
  const ssh = parseSshTarget(source.target!);
  const options = [
    tty ? "-tt" : "-T",
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

function socketTunnelIdentity(source: Source, paths: string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.id,
        source.target,
        source.sshIdentityFile,
        source.sshKnownHostsFile,
        paths,
      ]),
    )
    .digest("hex");
}

function tunnelRequest(source: Source, endpoints: Record<string, string>) {
  const ssh = sshOptions(source);
  return {
    sourceId: source.id,
    key: socketTunnelIdentity(source, Object.values(endpoints)),
    sshArgs: ssh,
    env: commandEnvironment(),
    discover: async () => endpoints,
  };
}

function localHerdrClient(source: Source): string {
  if (source.transport === "local" && source.binary) return source.binary;
  return process.env.CANVAS_HERDR_BINARY || "herdr";
}

async function remoteHerdrSockets(source: Source): Promise<[string, string]> {
  const response = JSON.parse(await run(source, ["session", "list", "--json"]));
  if (!response || !Array.isArray(response.sessions))
    throw new Error("Unexpected remote herdr session list");
  const requested = source.herdrSession || "default";
  const session = response.sessions.find(
    (item: { name?: string } | null) => item?.name === requested,
  );
  if (session?.running !== true)
    throw new Error(`Remote herdr session '${requested}' is not running`);
  if (
    typeof session.socket_path !== "string" ||
    typeof session.session_dir !== "string"
  )
    throw new Error("Unexpected remote herdr socket paths");
  return [session.socket_path, join(session.session_dir, "herdr-client.sock")];
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

interface SshCommandPool {
  closing: boolean;
  key: string;
  path: string;
  controlArgs: string[];
  sources: Set<string>;
  lanes: Promise<void>[];
  nextLane: number;
}
const sshPools = new Map<string, SshCommandPool>();
let sshPoolRoot: Promise<string> | undefined;
async function shortCommandPool(source: Source): Promise<SshCommandPool> {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        source.target,
        source.sshIdentityFile,
        source.sshKnownHostsFile,
      ]),
    )
    .digest("hex");
  const directory = await (sshPoolRoot ??= mkdtemp(
    join(tmpdir(), `canvas-ssh-${process.pid}-`),
  ));
  let pool = sshPools.get(key);
  if (!pool) {
    const command = sourceCommand(source, []);
    pool = {
      closing: false,
      key,
      path: join(directory, randomUUID().replaceAll("-", "")),
      controlArgs: command.args.slice(0, -1),
      sources: new Set(),
      lanes: Array.from({ length: 4 }, () => Promise.resolve()),
      nextLane: 0,
    };
    sshPools.set(key, pool);
  }
  pool.sources.add(source.id);
  return pool;
}
async function closeSshPool(pool: SshCommandPool): Promise<void> {
  pool.closing = true;
  if (sshPools.get(pool.key) === pool) sshPools.delete(pool.key);
  await Promise.all(pool.lanes);
  await new Promise<void>((resolve) => {
    execFile(
      "ssh",
      ["-S", pool.path, "-O", "exit", ...pool.controlArgs],
      {
        env: commandEnvironment(),
        timeout: 3000,
        maxBuffer: 64 * 1024,
      },
      () => resolve(),
    );
  });
}

/** Close only Canvas-owned multiplexers; no workstation SSH configuration changes. */
export async function closeProviderConnections(
  sourceId?: string,
): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const pool of sshPools.values()) {
    if (sourceId) pool.sources.delete(sourceId);
    else pool.sources.clear();
    if (!pool.sources.size) closing.push(closeSshPool(pool));
  }
  await Promise.all(closing);
  await closeSocketTunnels(sourceId);
  if (!sourceId && sshPoolRoot) {
    const directory = await sshPoolRoot;
    sshPoolRoot = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(source: Source, args: string[]): Promise<string> {
  const command = sourceCommand(source, args);
  if (source.transport === "ssh") {
    let pool = await shortCommandPool(source);
    while (pool.closing) pool = await shortCommandPool(source);
    command.args.unshift(
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=30",
      "-o",
      `ControlPath=${pool.path}`,
    );
    // Short commands share a connection and four slots. PTYs and persistent
    // control observers use sourceCommand directly and never consume this pool.
    const lane = pool.nextLane++ % pool.lanes.length;
    const task = pool.lanes[lane]!.then(() => execute(command, source.type));
    pool.lanes[lane] = task.then(
      () => {},
      () => {},
    );
    return await task;
  }
  return await execute(command, source.type);
}

async function execute(
  command: { file: string; args: string[] },
  type: Source["type"],
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
          reject(new Error(`${type}: ${detail}`));
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
  if (value.startsWith(HELPER_PREFIX))
    throw new Error("This name is reserved for Canvas clients");
  return value.trim();
}

// tmux itself recognizes a trailing semicolon as a command separator even when
// execFile bypasses the shell. Escape it in user-provided positional arguments.
function tmuxArgument(value: string): string {
  return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

function dimensions(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 10 ||
    rows < 3 ||
    cols > 500 ||
    rows > 250
  )
    throw new Error("Invalid terminal dimensions");
}

function nativeId(composite: string, kind: "$" | "@"): string {
  const pattern = kind === "$" ? /^\d+\.\d+:\$\d+$/u : /^\d+\.\d+:@\d+$/u;
  if (!pattern.test(composite)) throw new Error("Invalid tmux resource ID");
  return composite.slice(composite.indexOf(":") + 1);
}

async function tmuxSpaces(source: Source): Promise<SpaceResource[]> {
  let result: string;
  // tmux sanitizes literal control characters in command arguments on some SSH
  // environments. A fresh printable separator also tolerates names containing
  // punctuation without relying on shell escapes or locale-specific encoding.
  const separator = `__canvas_field_${randomUUID().replaceAll("-", "")}__`;
  try {
    result = await run(source, [
      "list-panes",
      "-a",
      "-F",
      [
        "#{pid}.#{start_time}",
        "#{session_id}",
        "#{session_name}",
        "#{window_id}",
        "#{window_name}",
        "#{@canvas-helper}",
        "#{pane_id}",
        "#{pane_index}",
        "#{pane_current_command}",
        "#{pane_active}",
        "#{pane_pb_state}",
        "#{pane_pb_progress}",
        "#{pane_dead}",
      ].join(separator),
    ]);
  } catch (error) {
    // Listing must not auto-create a server. An empty machine is a usable source.
    if (
      error instanceof Error &&
      /(?:no server running|no sessions|error connecting to .*No such file|failed to connect to server)/u.test(
        error.message,
      )
    ) {
      disposeStatusSource(source.id);
      return [];
    }
    throw error;
  }
  const spaces = new Map<string, SpaceResource>();
  const deadPanes = new Set<string>();
  for (const line of result.split("\n").filter(Boolean)) {
    const [
      generation,
      session,
      sessionName,
      window,
      windowName,
      helper,
      paneId,
      paneIndex,
      command,
      paneActive,
      progressState,
      progress,
      dead,
    ] = line.split(separator);
    if (!generation || !session || !window)
      throw new Error("Unexpected tmux resource response");
    if (helper || sessionName?.startsWith(HELPER_PREFIX)) continue;
    if (paneId && dead === "1") deadPanes.add(paneId);
    const id = `${generation}:${session}`;
    let space = spaces.get(id);
    if (!space) {
      space = { id, name: sessionName || session, windows: [] };
      spaces.set(id, space);
    }
    const windowId = `${generation}:${window}`;
    let resource = space.windows.find((w) => w.id === windowId);
    if (!resource) {
      resource = {
        id: windowId,
        name: windowName || window,
        status: "unknown",
        statusSource: "none",
        panes: [],
      };
      space.windows.push(resource);
    }
    if (paneId)
      resource.panes.push({
        id: `${generation}:${paneId}`,
        name: `${paneIndex ?? paneId}${command ? ` · ${command}` : ""}`,
        active: paneActive === "1",
        ...tmuxProgressStatus(progressState, progress),
      });
  }
  for (const space of spaces.values())
    for (const window of space.windows) {
      pruneTmuxStatus(
        source.id,
        window.id,
        new Set(
          window.panes.map((pane) => pane.id.slice(pane.id.indexOf(":") + 1)),
        ),
      );
      for (const pane of window.panes) {
        const reported = tmuxProgramStatus(
          source.id,
          window.id,
          pane.id.slice(pane.id.indexOf(":") + 1),
          deadPanes.has(pane.id.slice(pane.id.indexOf(":") + 1)),
        );
        if (reported) {
          delete pane.progress;
          delete pane.nativeStatus;
          Object.assign(pane, reported);
        }
      }
      Object.assign(window, aggregateStatus(window.panes));
    }
  return [...spaces.values()];
}

async function herdrSpaces(source: Source): Promise<SpaceResource[]> {
  const response = JSON.parse(await run(source, ["api", "snapshot"]));
  if (response.error)
    throw new Error(
      `herdr: ${response.error.message || JSON.stringify(response.error)}`,
    );
  const snapshot = response.result?.snapshot ?? response.result ?? response;
  if (!Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs))
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
                  ...(pane.display_agent || pane.agent
                    ? { agent: pane.display_agent || pane.agent }
                    : {}),
                  ...herdrStatus(pane.agent_status),
                }),
              );
            return {
              id: tab.tab_id,
              name: tab.label || tab.tab_id,
              ...(panes.length
                ? aggregateStatus(panes)
                : herdrStatus(tab.agent_status)),
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
    type: source.type,
    host:
      source.transport === "ssh"
        ? parseSshTarget(source.target!).host
        : hostname(),
    status: "online",
    spaces: [],
  };
  try {
    result.spaces =
      source.type === "tmux"
        ? await tmuxSpaces(source)
        : await herdrSpaces(source);
  } catch (error) {
    disposeStatusSource(source.id);
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
  label: string,
): Promise<void> {
  label = name(label);
  if (source.type === "tmux")
    await run(source, ["new-session", "-d", "-s", tmuxArgument(label)]);
  else
    await run(source, ["workspace", "create", "--label", label, "--no-focus"]);
}
export async function renameSpace(
  source: Source,
  spaceId: string,
  label: string,
): Promise<void> {
  label = name(label);
  await requireResource(source, spaceId);
  if (source.type === "tmux")
    await run(source, [
      "rename-session",
      "-t",
      nativeId(spaceId, "$"),
      "--",
      tmuxArgument(label),
    ]);
  else await run(source, ["workspace", "rename", spaceId, label]);
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
  if (source.type === "tmux")
    await run(source, ["kill-session", "-t", nativeId(spaceId, "$")]);
  else await run(source, ["workspace", "close", spaceId]);
}
export async function createWindow(
  source: Source,
  spaceId: string,
  label: string,
): Promise<void> {
  label = name(label);
  await requireResource(source, spaceId);
  if (source.type === "tmux")
    await run(source, [
      "new-window",
      "-d",
      "-t",
      `${nativeId(spaceId, "$")}:`,
      "-n",
      tmuxArgument(label),
    ]);
  else
    await run(source, [
      "tab",
      "create",
      "--workspace",
      spaceId,
      "--label",
      label,
      "--no-focus",
    ]);
}
export async function renameWindow(
  source: Source,
  spaceId: string,
  windowId: string,
  label: string,
): Promise<void> {
  label = name(label);
  await requireResource(source, spaceId, windowId);
  if (source.type === "tmux")
    await run(source, [
      "rename-window",
      "-t",
      nativeId(windowId, "@"),
      "--",
      tmuxArgument(label),
    ]);
  else await run(source, ["tab", "rename", windowId, label]);
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
  if (source.type === "tmux")
    await run(source, ["kill-window", "-t", nativeId(windowId, "@")]);
  else await run(source, ["tab", "close", windowId]);
}

export async function openTerminal(
  source: Source,
  spaceId: string,
  windowId: string,
  cols: number,
  rows: number,
): Promise<TerminalCommand> {
  preparing.set(source.id, (preparing.get(source.id) || 0) + 1);
  try {
    return await prepareTerminal(source, spaceId, windowId, cols, rows);
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
  cols: number,
  rows: number,
): Promise<TerminalCommand> {
  dimensions(cols, rows);
  await requireResource(source, spaceId, windowId);
  if (source.type === "herdr") {
    let clientFile: string;
    let clientArgs: string[];
    let clientEnv: Record<string, string> = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    if (source.transport === "ssh") {
      const localClient = localHerdrClient(source);
      let capabilities: { bare_tab?: boolean };
      try {
        capabilities = JSON.parse(
          await execute(
            {
              file: localClient,
              args: ["canvas-capabilities"],
            },
            "herdr",
          ),
        );
      } catch {
        throw new Error(
          "The local Canvas herdr client is unavailable or lacks bare-tab support; configure CANVAS_HERDR_BINARY on the Canvas server",
        );
      }
      if (capabilities.bare_tab !== true)
        throw new Error(
          "The local Canvas herdr client lacks bare-tab support; configure CANVAS_HERDR_BINARY on the Canvas server",
        );
      // The remote machine supplies only the official server sockets. The
      // Canvas fork remains a local client and receives both sockets over SSH.
      const [apiSocket, clientSocket] = await remoteHerdrSockets(source);
      const tunnel = await ensureSocketTunnel(
        tunnelRequest(source, {
          "herdr.sock": apiSocket,
          "herdr-client.sock": clientSocket,
        }),
      );
      clientFile = localClient;
      clientArgs = ["tab", "attach", windowId, "--bare"];
      clientEnv = {
        ...clientEnv,
        HERDR_SOCKET_PATH: tunnel.sockets["herdr.sock"]!,
        HERDR_CLIENT_SOCKET_PATH: tunnel.sockets["herdr-client.sock"]!,
        // Match upstream remote attach: remote files are not local files and
        // handshakes may take longer than a local Unix socket round trip.
        HERDR_REMOTE_KEYBINDINGS: "local",
      };
    } else {
      let supported = false;
      try {
        const capabilities = JSON.parse(
          await run(source, ["canvas-capabilities"]),
        );
        supported = capabilities.bare_tab === true;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(
            error instanceof Error &&
            /(?:unrecognized subcommand|unrecognized command|unexpected argument|unknown command)[^\n]*canvas-capabilities/u.test(
              error.message,
            )
          )
        )
          throw error;
      }
      if (!supported)
        throw new Error(
          "Select the current Canvas herdr fork executable; this client does not support bare tabs.",
        );
      clientFile = source.binary || source.type;
      clientArgs = [
        "--session",
        source.herdrSession || "default",
        "tab",
        "attach",
        windowId,
        "--bare",
      ];
    }
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
      file: clientFile,
      args: clientArgs,
      env: clientEnv,
      geometryMode: "client",
      // This describes our PTY, not an authoritative native tab size. The
      // unmodified herdr server retains its ordinary client geometry rules.
      initialSize: { cols, rows, token: "0" },
      cleanup,
    };
  }

  const window = nativeId(windowId, "@");
  const generation = windowId.split(":")[0]!;
  const helper = `${HELPER_PREFIX}${INSTANCE}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  let exactHelper = helper;
  let closed = false;
  let stopStatusObserver: (() => void) | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sizeListeners = new Set<() => void>();
  let ownedSize: { before: NativeSize; token: string } | undefined;
  let pendingWrite: PendingGeometryWrite | undefined;
  const revisionOption = `@canvas_geometry_${helper.slice(HELPER_PREFIX.length)}`;
  const receiptOption = `${revisionOption}_receipt`;
  const receiptRevisionOption = `${revisionOption}_receipt_revision`;
  const writerOption = `${revisionOption}_writer`;
  const requestOption = `${revisionOption}_request`;
  const nativeOptions = [
    revisionOption,
    receiptOption,
    receiptRevisionOption,
    writerOption,
    requestOption,
  ];
  const hookIndex = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 7),
    16,
  );
  const geometryHooks: { scope: string[]; name: string }[] = [];
  let detachCleanup = "";
  function nativeCondition(current: NativeSize): string {
    return `#{&&:#{==:#{${revisionOption}},${current.revision}},#{&&:#{==:#{window_width},${current.cols}},#{&&:#{==:#{window_height},${current.rows}},#{==:#{window-size},${current.effectivePolicy}}}}}`;
  }
  function receiptCondition(operationId: string): string {
    return `#{&&:#{==:#{${receiptOption}},${operationId}},#{&&:#{==:#{${receiptRevisionOption}},#{${revisionOption}}},#{&&:#{==:#{${requestOption}},#{window_width}x#{window_height}},#{==:#{window-size},manual}}}}`;
  }
  function nativeRestore(before: NativeSize): string {
    return `resize-window -t ${window} -x ${before.cols} -y ${before.rows} ; ${nativePolicy(before)}`;
  }
  function nativePolicy(before: NativeSize): string {
    return before.policy
      ? `set-option -w -t ${window} window-size ${before.policy.split(" ").at(-1)}`
      : `set-option -w -u -t ${window} window-size`;
  }
  function nativeHookCleanup(): string {
    return geometryHooks
      .map(
        ({ scope, name }) =>
          `set-hook ${scope.join(" ")} -u ${name}[${hookIndex}]`,
      )
      .concat(
        nativeOptions.map(
          (option) => `set-option -w -u -t ${window} ${option}`,
        ),
      )
      .join(" ; ");
  }
  async function updateDetachHook(
    current?: NativeSize,
    operationId?: string,
  ): Promise<void> {
    if (!detachCleanup) return;
    const guard = operationId
      ? receiptCondition(operationId)
      : current
        ? nativeCondition(current)
        : undefined;
    const restore =
      guard && ownedSize
        ? `if-shell -F -t ${window} ${shellQuote(guard)} ${shellQuote(nativeRestore(ownedSize.before))} ; `
        : "";
    await run(source, [
      "set-hook",
      "-t",
      exactHelper,
      "client-detached",
      `if-shell -F -t ${exactHelper} '#{==:#{session_attached},0}' ${shellQuote(`${restore}${nativeHookCleanup()} ; ${detachCleanup}`)}`,
    ]);
    for (const hook of geometryHooks.filter(
      (item) => item.name === "client-resized",
    ))
      await run(source, [
        "set-hook",
        ...hook.scope,
        `${hook.name}[${hookIndex}]`,
        geometryHookCommand(hook.name, guard),
      ]);
  }
  function geometryHookCommand(hookName: string, guard?: string): string {
    const counter = `set-option -w -F -t ${window} ${revisionOption} '#{e|+:#{${revisionOption}},1}'`;
    const clearReceipt = `set-option -w -u -t ${window} ${receiptOption}`;
    const stampReceipt = `set-option -w -F -t ${window} ${receiptRevisionOption} '#{${revisionOption}}'`;
    let action = `${counter} ; ${clearReceipt}`;
    let condition = `#{==:#{window_id},${window}}`;
    if (hookName === "after-resize-window")
      action = `${counter} ; if-shell -F '#{==:#{hook_flag_t_0},#{${writerOption}}}' ${shellQuote(stampReceipt)} ${shellQuote(clearReceipt)}`;
    if (hookName === "window-resized") {
      const ownResize = `#{&&:#{==:#{${requestOption}},#{window_width}x#{window_height}},#{&&:#{==:#{window-size},manual},#{==:#{${receiptRevisionOption}},#{e|-:#{${revisionOption}},1}}}}`;
      action = `${counter} ; if-shell -F ${shellQuote(ownResize)} ${shellQuote(stampReceipt)} ${shellQuote(clearReceipt)}`;
    }
    if (hookName === "after-set-option") {
      // tmux exposes the original option name to after-command hooks. Track
      // window-size (including its unambiguous abbreviations), while plugin
      // metadata, colors and other options must not end a geometry lease.
      condition = `#{&&:${condition},#{m:window-si*,#{hook_argument_0}}}`;
    }
    if (hookName === "client-resized") {
      condition = `#{&&:${condition},#{!=:#{session_id},${exactHelper}}}`;
      if (guard && ownedSize && ownedSize.before.effectivePolicy !== "manual")
        action = `if-shell -F -t ${window} ${shellQuote(guard)} ${shellQuote(nativePolicy(ownedSize.before))} ; ${counter} ; ${clearReceipt}`;
    }
    return `if-shell -F ${shellQuote(condition)} ${shellQuote(action)}`;
  }
  async function readSize(): Promise<NativeSize> {
    // The event stream wakes viewers promptly; a native hook counter also keeps
    // rapid A→B→A changes that tmux coalesces into a single layout notification.
    let revision = await tmuxGeometryRevision(source.id, windowId);
    for (let attempt = 0; ; attempt++) {
      const response = await run(source, [
        "display-message",
        "-p",
        "-t",
        window,
        `#{pid}.#{start_time}:#{window_width}:#{window_height}:#{window-size}:#{${revisionOption}}:#{${receiptOption}}:#{${receiptRevisionOption}}:#{${requestOption}}`,
        ";",
        "show-options",
        "-w",
        "-t",
        window,
        "window-size",
      ]);
      const [values, policy = ""] = response.split("\n");
      const [
        nativeGeneration,
        width,
        height,
        effectivePolicy,
        counter,
        operationId,
        receiptRevision,
        receiptSize,
      ] = values!.split(":");
      if (nativeGeneration !== generation)
        throw new Error("The tmux server restarted");
      const cols = Number(width),
        rows = Number(height);
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 1 ||
        rows < 1
      )
        throw new Error("Unexpected tmux window geometry");
      const nextRevision = await tmuxGeometryRevision(source.id, windowId);
      if (revision !== nextRevision && attempt < 3) {
        revision = nextRevision;
        continue;
      }
      const token = JSON.stringify([
        cols,
        rows,
        policy,
        effectivePolicy,
        counter || "0",
      ]);
      const received =
        !!operationId &&
        receiptRevision === counter &&
        receiptSize === `${width}x${height}` &&
        effectivePolicy === "manual";
      const current: NativeSize = {
        cols,
        rows,
        policy,
        effectivePolicy,
        revision: Number(counter || 0),
        token,
        ...(received ? { operationId } : {}),
      };
      if (
        pendingWrite?.ambiguous &&
        received &&
        operationId === pendingWrite.id
      ) {
        if (ownedSize) ownedSize.token = current.token;
        current.recoveredFromToken = pendingWrite.before.token;
      }
      return current;
    }
  }
  async function restoreSize(
    before: NativeSize,
    expectedToken: string,
    prepare?: (size: NativeSize) => Promise<void>,
  ): Promise<NativeSize> {
    const current = await readSize();
    if (current.token !== expectedToken) {
      ownedSize = undefined;
      pendingWrite = undefined;
      await updateDetachHook();
      return current;
    }
    if (prepare) {
      // With no other client tmux falls back even to ignore-size clients. Move
      // our native PTY while manual sizing still protects the shared window,
      // then restore the old automatic policy after tmux sees its new viewport.
      await prepare(before);
      for (let attempt = 0; attempt < 50; attempt++) {
        const clients = (
          await run(source, [
            "list-clients",
            "-t",
            exactHelper,
            "-F",
            "#{client_control_mode}:#{client_width}:#{client_height}",
          ])
        ).split("\n");
        const native = clients.filter((line) => line.startsWith("0:"));
        if (
          !native.length ||
          native.every((line) => line === `0:${before.cols}:${before.rows}`)
        )
          break;
        if (attempt === 49)
          throw new Error(
            "Native terminal did not acknowledge its restored viewport",
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    // Keep the compare and mutation in tmux's own command queue. An external
    // native resize between our read and this command always wins.
    await run(source, [
      "if-shell",
      "-F",
      "-t",
      window,
      nativeCondition(current),
      nativeRestore(before),
    ]);
    ownedSize = undefined;
    pendingWrite = undefined;
    await updateDetachHook();
    return await readSize();
  }
  let initialSize = await readSize();
  const handle = { sourceId: source.id, spaceId, windowId, cleanup };
  async function releaseSourceConnections() {
    await releaseIdleConnections(source.id);
  }
  async function cleanup(): Promise<void> {
    if (closed) return;
    closed = true;
    if (pendingWrite?.ambiguous) await readSize().catch(() => {});
    if (ownedSize) {
      // A fallback close has no PTY callback. Remove our clients before restoring
      // an automatic policy so tmux cannot reuse their focused viewport.
      await run(source, ["detach-client", "-s", exactHelper]).catch(() => {});
      await restoreSize(ownedSize.before, ownedSize.token).catch(() => {});
    }
    stopStatusObserver?.();
    if (timer) clearInterval(timer);
    active.delete(handle);
    // Native IDs are daemon-local. Never act on a reused ID after a restart.
    try {
      if (
        (await run(source, [
          "display-message",
          "-p",
          "#{pid}.#{start_time}",
        ])) !== generation
      ) {
        await releaseSourceConnections();
        return;
      }
    } catch {
      await releaseSourceConnections();
      return;
    }
    for (const hook of geometryHooks)
      await run(source, [
        "set-hook",
        ...hook.scope,
        "-u",
        `${hook.name}[${hookIndex}]`,
      ]).catch(() => {});
    for (const option of nativeOptions)
      await run(source, ["set-option", "-w", "-u", "-t", window, option]).catch(
        () => {},
      );
    // Do not kill any extra windows a native client or external tool may have
    // created in this helper. Preserve those as a visible ordinary session.
    try {
      const windows = (
        await run(source, [
          "list-windows",
          "-t",
          exactHelper,
          "-F",
          "#{window_id}",
        ])
      )
        .split("\n")
        .filter(Boolean);
      if (windows.some((id) => id !== window)) {
        if (windows.includes(window))
          await run(source, [
            "unlink-window",
            "-k",
            "-t",
            `${exactHelper}:${window}`,
          ]);
        for (const option of [
          "@canvas-helper",
          "prefix",
          "prefix2",
          "status",
          "mouse",
          "detach-on-destroy",
        ])
          await run(source, ["set-option", "-u", "-t", exactHelper, option]);
        await run(source, [
          "set-hook",
          "-u",
          "-t",
          exactHelper,
          "client-detached",
        ]);
        await run(source, [
          "rename-session",
          "-t",
          exactHelper,
          `canvas-detached-${helper.slice(-10)}`,
        ]);
      } else await run(source, ["kill-session", "-t", exactHelper]);
    } catch {
      /* The session/server may already have exited. */
    }
    await releaseSourceConnections();
  }
  try {
    exactHelper = await run(source, [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}",
      "-s",
      helper,
      "-x",
      String(initialSize.cols),
      "-y",
      String(initialSize.rows),
      "exec sleep 86400",
    ]);
    const preserveSession = [
      "@canvas-helper",
      "prefix",
      "prefix2",
      "status",
      "mouse",
      "detach-on-destroy",
    ]
      .map((option) => `set-option -u -t ${exactHelper} ${option}`)
      .concat(
        `set-hook -u -t ${exactHelper} client-detached`,
        `rename-session -t ${exactHelper} canvas-detached-${helper.slice(-10)}`,
      )
      .join(" ; ");
    detachCleanup = `if-shell -F -t ${exactHelper} '#{&&:#{==:#{session_windows},1},#{==:#{window_id},${window}}}' ${shellQuote(`kill-session -t ${exactHelper}`)} ${shellQuote(preserveSession)}`;
    await run(source, [
      "set-option",
      "-t",
      exactHelper,
      "@canvas-helper",
      INSTANCE,
      ";",
      "set-option",
      "-t",
      exactHelper,
      "status",
      "off",
      ";",
      "set-option",
      "-t",
      exactHelper,
      "prefix",
      "None",
      ";",
      "set-option",
      "-t",
      exactHelper,
      "prefix2",
      "None",
      ";",
      "set-option",
      "-t",
      exactHelper,
      "detach-on-destroy",
      "on",
      ";",
      "set-option",
      "-t",
      exactHelper,
      "mouse",
      "on",
      ";",
      "link-window",
      "-k",
      "-s",
      window,
      "-t",
      `${exactHelper}:0`,
    ]);
    await run(source, ["set-option", "-w", "-t", window, revisionOption, "0"]);
    const linkedSessions = (
      await run(source, [
        "list-windows",
        "-a",
        "-F",
        "#{window_id}:#{session_id}",
      ])
    )
      .split("\n")
      .filter((line) => line.startsWith(`${window}:`))
      .map((line) => line.split(":")[1]!);
    for (const hookName of [
      "window-resized",
      "after-resize-window",
      "after-set-option",
      "client-resized",
    ]) {
      const scopes = [["-g"]];
      // Add to an existing local array only when it already shadows the global
      // array. Creating a new local array would hide the user's inherited hooks.
      for (const scope of [
        ["-w", "-t", window],
        ...linkedSessions.map((id) => ["-t", id]),
      ])
        if (await run(source, ["show-options", ...scope, hookName]))
          scopes.push(scope);
      for (const scope of scopes) {
        const existing = await run(source, [
          "show-options",
          ...scope,
          hookName,
        ]);
        if (existing.includes(`[${hookIndex}]`))
          throw new Error("Native hook slot is already in use");
        const command = geometryHookCommand(hookName);
        await run(source, [
          "set-hook",
          ...scope,
          `${hookName}[${hookIndex}]`,
          command,
        ]);
        geometryHooks.push({ scope, name: hookName });
      }
    }
    await updateDetachHook();
    initialSize = await readSize();
    active.add(handle);
    // If the original session/link is removed outside Canvas, our auxiliary
    // reference must not keep that window alive indefinitely.
    timer = setInterval(async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const resources = await listResources(source);
        if (
          resources.status === "online" &&
          !resources.spaces.some(
            (s) => s.id === spaceId && s.windows.some((w) => w.id === windowId),
          )
        )
          await cleanup();
      } finally {
        busy = false;
      }
    }, 2500);
    timer.unref();
    return {
      ...sourceCommand(
        source,
        ["attach-session", "-f", "ignore-size", "-t", exactHelper],
        true,
      ),
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      initialSize,
      readSize,
      restoreSize,
      async commitSize() {
        ownedSize = undefined;
        pendingWrite = undefined;
        await updateDetachHook();
      },
      watchSize(listener) {
        sizeListeners.add(listener);
        return () => sizeListeners.delete(listener);
      },
      cleanup,
      connected() {
        if (!closed && !stopStatusObserver)
          stopStatusObserver = observeTmuxWindow(
            source.id,
            windowId,
            sourceCommand(source, [
              "-C",
              "attach-session",
              "-E",
              "-f",
              "ignore-size",
              "-t",
              exactHelper,
            ]),
            commandEnvironment(),
            {
              initial: initialSize,
              changed: () => {
                for (const listener of sizeListeners) listener();
              },
            },
          );
      },
      async resize(newCols, newRows, expectedToken) {
        dimensions(newCols, newRows);
        if (closed) throw new Error("Terminal is closed");
        const before = await readSize();
        if (expectedToken !== undefined && before.token !== expectedToken)
          throw new NativeGeometryConflictError();
        if (!ownedSize || ownedSize.token !== before.token)
          ownedSize = { before, token: before.token };
        const conflict = "__canvas_native_geometry_changed__";
        const operation: PendingGeometryWrite = {
          id: randomUUID(),
          before,
          ambiguous: false,
        };
        pendingWrite = operation;
        let current: NativeSize;
        try {
          await updateDetachHook(undefined, operation.id);
          // tmux uses the last repeated target and exposes every original value
          // in its after-command hook. The first target is a write receipt nonce;
          // the final target keeps normal window and user-hook resolution intact.
          const ownWrite = [
            `set-option -w -t ${window} ${writerOption} '${operation.id}'`,
            `set-option -w -t ${window} ${requestOption} '${newCols}x${newRows}'`,
            `set-option -w -t ${window} ${receiptOption} '${operation.id}'`,
            `resize-window -t '${operation.id}' -t ${window} -x ${newCols} -y ${newRows}`,
          ].join(" ; ");
          const response = await run(source, [
            "if-shell",
            "-F",
            "-t",
            window,
            nativeCondition(before),
            ownWrite,
            `display-message -p ${conflict}`,
          ]);
          if (response.includes(conflict))
            throw new NativeGeometryConflictError();
          current = await readSize();
          if (current.operationId !== operation.id)
            throw new NativeGeometryConflictError();
        } catch (error) {
          if (error instanceof NativeGeometryConflictError) {
            pendingWrite = undefined;
            ownedSize = undefined;
            await updateDetachHook();
            throw error;
          }
          operation.ambiguous = true;
          current = await recoverGeometryWrite(readSize, operation, error);
        }
        if (ownedSize) ownedSize.token = current.token;
        await updateDetachHook(current);
        return current;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
