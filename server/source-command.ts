// Running commands on a source: locally or over its SSH target.
import { execFile, spawn } from 'node:child_process'
import { hostname, userInfo } from 'node:os'
import type { Source } from './state.ts'
import { validateHerdrLocation } from './herdr/api.ts'

export const COMMAND_TIMEOUT = 15_000

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not allowed in command arguments')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function parseSshTarget(target: string): {
  destination: string
  port?: string
} {
  if (!target || /[\s\x00-\x1f\x7f]/u.test(target)) throw new Error('Invalid SSH target')
  if (target.startsWith('ssh://')) {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      throw new Error('Invalid SSH URI')
    }
    if (
      url.protocol !== 'ssh:' ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      throw new Error('Use ssh://[user@]host[:port] without passwords or paths')
    }
    const user = decodeURIComponent(url.username)
    const host = url.hostname
    if (
      !/^[a-zA-Z0-9_.-]*$/u.test(user) ||
      !/^(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\])$/u.test(host) ||
      host.startsWith('-')
    ) {
      throw new Error('Invalid SSH host or user')
    }
    if (url.port && (+url.port < 1 || +url.port > 65535)) throw new Error('Invalid SSH port')
    return {
      destination: `${user ? `${user}@` : ''}${host}`,
      ...(url.port ? { port: url.port } : {}),
    }
  }
  if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(target)) {
    throw new Error('Use an SSH config alias, user@host, or ssh://[user@]host[:port]')
  }
  return { destination: target }
}

export function validateSource(source: Source): void {
  if (!source.id || !source.name || !['local', 'ssh'].includes(source.transport))
    throw new Error('Invalid source')
  if (source.transport === 'ssh') parseSshTarget(source.target ?? '')
  if (!['herdr', 'hc'].includes(source.runtime)) throw new Error('Invalid runtime')
  validateHerdrLocation(source)
  for (const value of [source.herdrSession, source.sshIdentityFile, source.sshKnownHostsFile]) {
    if (value && /[\x00-\x1f\x7f]/u.test(value))
      throw new Error('Source values cannot contain control characters')
  }
}

export function sshOptions(source: Source): string[] {
  const ssh = parseSshTarget(source.target!)
  const options = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
  ]
  if (ssh.port) options.push('-p', ssh.port)
  if (source.sshIdentityFile) options.push('-i', source.sshIdentityFile, '-o', 'IdentitiesOnly=yes')
  if (source.sshKnownHostsFile)
    options.push(
      '-o',
      `UserKnownHostsFile="${source.sshKnownHostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
    )
  return [...options, '--', ssh.destination]
}

/** One scoped process for file transfer; no terminal or runtime state is changed. */
export function sourcePythonCommand(source: Source, script: string, args: string[]) {
  validateSource(source)
  const command = ['python3', '-c', script, ...args]
  return source.transport === 'local'
    ? { file: command[0]!, args: command.slice(1), env: commandEnvironment() }
    : {
        file: 'ssh',
        args: [...sshOptions(source), `exec ${command.map(shellQuote).join(' ')}`],
        env: commandEnvironment(),
      }
}

/** Private loopback transport for an explicitly opened web application. */

/** How long a helper on a source may go without a sign of life. */
const HELPER_IDLE_MS = 60_000
/** How long a helper asked to stop has before it is killed. */
const HELPER_KILL_MS = 2000

/**
 * Runs a Python helper on the source for one transfer. It fails as stalled once `renew` has not
 * been called for a minute, or as cancelled when `signal` aborts; `stop` asks it to end, and
 * kills it if it has not two seconds later. `exited` resolves with its exit code.
 */
export function runSourceHelper(
  source: Source,
  script: string,
  args: string[],
  options: {
    signal: AbortSignal
    failed(reason: 'stalled' | 'cancelled'): void
  },
) {
  const command = sourcePythonCommand(source, script, args)
  const child = spawn(command.file, command.args, {
    env: command.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let ended = false,
    idle: ReturnType<typeof setTimeout> | undefined,
    killing: ReturnType<typeof setTimeout> | undefined
  const cancelled = () => options.failed('cancelled')
  options.signal.addEventListener('abort', cancelled, { once: true })
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      ended = true
      clearTimeout(idle)
      clearTimeout(killing)
      options.signal.removeEventListener('abort', cancelled)
      resolve(code)
    }),
  )
  const renew = () => {
    clearTimeout(idle)
    if (ended) return
    idle = setTimeout(() => options.failed('stalled'), HELPER_IDLE_MS)
    idle.unref()
  }
  renew()
  return {
    child,
    exited,
    renew,
    stop() {
      if (ended) return
      child.stdin.destroy()
      child.kill('SIGTERM')
      killing ??= setTimeout(() => child.kill('SIGKILL'), HELPER_KILL_MS)
      killing.unref()
    },
  }
}

export async function editorAuthority(
  source: Source,
): Promise<{ hostName: string; user: string; port: number }> {
  if (source.transport === 'local') {
    const listener = process.env.CANVAS_HOST
    const hostName =
      process.env.CANVAS_PUBLIC_SSH_HOST ||
      (listener && !['0.0.0.0', '::', '127.0.0.1', 'localhost', '::1'].includes(listener)
        ? listener
        : hostname())
    return {
      hostName,
      user: userInfo().username,
      port: Number(process.env.CANVAS_PUBLIC_SSH_PORT || 22),
    }
  }
  // Resolve an existing source's SSH alias and defaults on the Canvas server.
  // Only these three non-secret fields leave this function; identity paths,
  // jump commands and the rest of the client's configuration never enter URLs.
  const config = await execute({ file: 'ssh', args: ['-G', ...sshOptions(source)] })
  const fields = new Map(
    config.split(/\r?\n/u).flatMap((line) => {
      const match = /^(hostname|user|port)\s+(.+)$/u.exec(line)
      return match ? [[match[1]!, match[2]!] as const] : []
    }),
  )
  const hostName = fields.get('hostname')?.replace(/^\[|\]$/g, '')
  const user = fields.get('user')
  const port = Number(fields.get('port'))
  if (!hostName || !user || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SSH editor address could not be resolved')
  return { hostName, user, port }
}

export async function runRemoteShell(source: Source, command: string): Promise<string> {
  if (source.transport !== 'ssh') throw new Error('Remote shell is only available for SSH sources')
  return await execute({ file: 'ssh', args: [...sshOptions(source), command] })
}

export async function runRemoteShellWithInput(
  source: Source,
  command: string,
  input: Buffer | string,
): Promise<string> {
  if (source.transport !== 'ssh') throw new Error('Remote shell is only available for SSH sources')
  const child = spawn('ssh', [...sshOptions(source), command], {
    env: commandEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    settled = false
  let resolve!: (value: string) => void
  let reject!: (reason: Error) => void
  const result = new Promise<string>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(stdout.trimEnd())
  }
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    finish(new Error('SSH registry command timed out'))
  }, COMMAND_TIMEOUT)
  timer.unref()
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-64 * 1024)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1200)
  })
  child.once('error', (error) => finish(error))
  child.stdin?.once('error', (error) => finish(error))
  child.once('close', (code) => {
    if (code === 0) finish()
    else finish(new Error(stderr.trim() || `SSH registry command exited with code ${code}`))
  })
  child.stdin?.end(input)
  return await result
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSH_AUTH_SOCK',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_DATA_HOME',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

/** Close only Canvas-owned socket forwards; no workstation SSH configuration changes. */

export async function execute(
  command: { file: string; args: string[] },
  env = commandEnvironment(),
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      command.file,
      command.args,
      {
        env,
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(0, 1200) || error.message
          reject(new Error(detail))
        } else resolve(stdout.trimEnd())
      },
    )
  })
}
