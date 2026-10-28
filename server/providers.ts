import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Source } from "./state.ts";
import {
  observeTmuxWindow,
  pruneTmuxStatus,
  tmuxProgramStatus,
  disposeStatusSource,
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
export interface TerminalCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cleanup(): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
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

function sourceCommand(
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
      `UserKnownHostsFile=${shellQuote(source.sshKnownHostsFile)}`,
    );
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
    binary,
    ...base,
    ...args,
  ];
  return {
    file: "ssh",
    args: [
      ...options,
      "--",
      ssh.destination,
      `exec ${remote.map(shellQuote).join(" ")}`,
    ],
  };
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

async function run(source: Source, args: string[]): Promise<string> {
  const command = sourceCommand(source, args);
  return await new Promise((resolve, reject) => {
    execFile(
      command.file,
      command.args,
      {
        env: commandEnvironment(),
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(0, 1200) || error.message;
          reject(new Error(`${source.type}: ${detail}`));
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
  dimensions(cols, rows);
  await requireResource(source, spaceId, windowId);
  if (source.type === "herdr") {
    let supported = false;
    try {
      const capabilities = JSON.parse(
        await run(source, ["canvas-capabilities"]),
      );
      supported = capabilities.bare_tab === true && capabilities.version === 1;
    } catch {
      // Older upstream clients do not expose the bare-tab command.
    }
    if (!supported) {
      throw new Error(
        "Select the Canvas herdr fork executable; this client does not support bare tabs.",
      );
    }
    return {
      ...sourceCommand(source, ["tab", "attach", windowId, "--bare"], true),
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      async cleanup() {},
    };
  }
  const window = nativeId(windowId, "@");
  const generation = windowId.split(":")[0]!;
  const helper = `${HELPER_PREFIX}${INSTANCE}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  let exactHelper = helper;
  // Preserve an explicitly configured policy, including the distinction between
  // a per-window value and an inherited global default.
  const previousPolicy = await run(source, [
    "show-options",
    "-w",
    "-t",
    window,
    "window-size",
  ]);
  let closed = false;
  let stopStatusObserver: (() => void) | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const handle = { sourceId: source.id, spaceId, windowId, cleanup };
  async function cleanup(): Promise<void> {
    if (closed) return;
    closed = true;
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
      )
        return;
    } catch {
      return;
    }
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
    try {
      const currentPolicy = await run(source, [
        "show-options",
        "-w",
        "-t",
        window,
        "window-size",
      ]);
      if (currentPolicy === "window-size manual") {
        if (previousPolicy)
          await run(source, [
            "set-option",
            "-w",
            "-t",
            window,
            "window-size",
            previousPolicy.split(" ").at(-1)!,
          ]);
        else
          await run(source, [
            "set-option",
            "-w",
            "-u",
            "-t",
            window,
            "window-size",
          ]);
      }
    } catch {
      /* The original window may already have exited. */
    }
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
      String(cols),
      "-y",
      String(rows),
      "exec sleep 86400",
    ]);
    const restorePolicy = previousPolicy
      ? `set-option -w -t ${window} window-size ${previousPolicy.split(" ").at(-1)}`
      : `set-option -w -u -t ${window} window-size`;
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
    const nativeDetachCleanup = `if-shell -F -t ${window} '#{==:#{window-size},manual}' ${shellQuote(restorePolicy)} ; if-shell -F -t ${exactHelper} '#{&&:#{==:#{session_windows},1},#{==:#{window_id},${window}}}' ${shellQuote(`kill-session -t ${exactHelper}`)} ${shellQuote(preserveSession)}`;
    // A passive control client can disconnect while the native terminal stays
    // attached. Its departure must not close the shared bare view.
    const detachHook = `if-shell -F -t ${exactHelper} '#{==:#{session_attached},0}' ${shellQuote(nativeDetachCleanup)}`;
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
      ";",
      "set-hook",
      "-t",
      exactHelper,
      "client-detached",
      detachHook,
    ]);
    await run(source, [
      "resize-window",
      "-t",
      window,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
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
      ...sourceCommand(source, ["attach-session", "-t", exactHelper], true),
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
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
          );
      },
      async resize(newCols, newRows) {
        dimensions(newCols, newRows);
        if (!closed)
          await run(source, [
            "resize-window",
            "-t",
            window,
            "-x",
            String(newCols),
            "-y",
            String(newRows),
          ]);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
