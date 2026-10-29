import * as pty from "node-pty";
import type { TerminalCommand } from "./providers.ts";

export interface TerminalTransport {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
}

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
  ]) if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

export async function openTerminalTransport(command: TerminalCommand, cols: number, rows: number): Promise<TerminalTransport> {
  if (command.connect) return command.connect(cols, rows);
  return pty.spawn(command.file, command.args, {
    name: "xterm-256color", cols, rows, cwd: process.env.HOME,
    env: { ...terminalEnvironment(), ...command.env },
  });
}
