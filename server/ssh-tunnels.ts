import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isLoopbackHost } from './loopback.ts'
import { log, warn } from './log.ts'
import { logIdentifier } from '../shared/log-line.ts'

export interface SocketTunnel {
  sockets: Record<string, string>
  remoteSockets: Record<string, string>
  alive(): boolean
  close(): Promise<void>
}

interface ManagedTunnel extends SocketTunnel {
  directory: string
}

interface TunnelEntry {
  sourceId: string
  closing: boolean
  promise: Promise<ManagedTunnel>
}

interface TunnelRequest {
  sourceId: string
  key: string
  /** Existing strict SSH options followed by -- and the destination. */
  sshArgs: string[]
  env: NodeJS.ProcessEnv
  discover(): Promise<Record<string, string>>
  tcp?: Record<string, { host: string; port: number }>
  reverse?: Record<string, { remotePath: string; localPath: string }>
  cleanupRemote?(): Promise<void>
  signal?: AbortSignal
}

const tunnels = new Map<string, TunnelEntry>()

function checkSocketPath(path: string): void {
  if (!path.startsWith('/') || /[:\x00-\x1f\x7f]/u.test(path))
    throw new Error('Unsupported remote Unix socket path')
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
print(json.dumps(result))`

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function remoteSocketState(
  request: TunnelRequest,
  operation: 'prepare' | 'ready' | 'clean',
  identities: Record<string, string | null>,
): Promise<Record<string, string>> {
  return await new Promise((resolve, reject) => {
    const command = ['python3', '-c', reverseSocketPython, operation, JSON.stringify(identities)]
      .map(shellArgument)
      .join(' ')
    execFile(
      'ssh',
      [...request.sshArgs, command],
      {
        env: request.env,
        timeout: 8000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim().slice(-1200) || 'Reverse socket inspection failed'))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('Invalid reverse socket inspection response'))
        }
      },
    )
  })
}

const NAME = /^[a-z][a-z0-9-]*\.sock$/u
/** How long an SSH process has to bring up every forward. */
const OPEN_MS = 12_000
const FIRST_RETRY_MS = 250
const LAST_RETRY_MS = 5000
const closedError = () => new Error('SSH socket forwarding closed')

/** Refuses anything but owner-named sockets, absolute socket paths and loopback ports. */
function checkForwarding(request: TunnelRequest, remote: Record<string, string>) {
  const reverse = Object.entries(request.reverse || {}),
    tcp = Object.entries(request.tcp || {})
  if (!Object.keys(remote).length && !reverse.length && !tcp.length)
    throw new Error('No Unix socket forwarding was requested')
  for (const [name, path] of Object.entries(remote)) {
    if (!NAME.test(name)) throw new Error('Invalid forwarded socket name')
    checkSocketPath(path)
  }
  for (const [name, endpoint] of reverse) {
    if (!NAME.test(name)) throw new Error('Invalid reverse socket name')
    checkSocketPath(endpoint.remotePath)
    checkSocketPath(endpoint.localPath)
  }
  for (const [name, { host, port }] of tcp)
    if (
      !NAME.test(name) ||
      !isLoopbackHost(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error('Invalid loopback forwarding endpoint')
}
const isSocket = async (path: string) => {
  try {
    return (await lstat(path)).isSocket()
  } catch {
    return false
  }
}
async function requireLocalSocket(path: string) {
  let found
  try {
    found = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Local reverse forwarding endpoint is unavailable')
    throw error
  }
  if (!found.isSocket()) throw new Error('Local reverse forwarding endpoint is not a socket')
}
/** Tries `attempt` until it succeeds or `ms` have passed, then fails as it did. */
async function retrying<T>(attempt: () => Promise<T>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  while (true) {
    try {
      return await attempt()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(50)
    }
  }
}

/**
 * One SSH process forwarding a source's sockets, started again whenever it ends until the
 * tunnel is closed. Its local socket paths stay the same across restarts, so clients reconnect
 * to the endpoint they know.
 */
class Tunnel implements ManagedTunnel {
  readonly sockets: Record<string, string>
  readonly remoteSockets: Record<string, string>
  private readonly args: string[]
  private readonly reverse: boolean
  /** The remote reverse sockets as seen when ready, so only those are removed after. */
  private readonly reverseIdentities: Record<string, string | null>
  private readonly stopping = new AbortController()
  private child?: ChildProcess
  /** Resolves when the current SSH process has exited. */
  private exited: Promise<void> = Promise.resolve()
  /** The loop that starts SSH again after a break. */
  private kept?: Promise<void>
  private closing?: Promise<void>
  constructor(
    private readonly request: TunnelRequest,
    remote: Record<string, string>,
    readonly directory: string,
    /** Runs as the tunnel starts to close, before it has. */
    private readonly onClose: () => void,
  ) {
    const reverse = Object.values(request.reverse || {}),
      tcp = Object.entries(request.tcp || {})
    this.sockets = Object.fromEntries(
      [...Object.keys(remote), ...tcp.map(([name]) => name)].map((name) => [
        name,
        join(directory, name),
      ]),
    )
    this.remoteSockets = Object.fromEntries(
      Object.entries(request.reverse || {}).map(([name, endpoint]) => [name, endpoint.remotePath]),
    )
    this.reverse = reverse.length > 0
    this.reverseIdentities = Object.fromEntries(reverse.map(({ remotePath }) => [remotePath, null]))
    this.args = [
      '-N',
      '-T',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StreamLocalBindUnlink=no',
      ...Object.entries(remote).flatMap(([name, path]) => ['-L', `${this.sockets[name]}:${path}`]),
      ...tcp.flatMap(([name, { host, port }]) => [
        '-L',
        `${this.sockets[name]}:${host === '::1' ? '[::1]' : host}:${port}`,
      ]),
      ...reverse.flatMap(({ remotePath, localPath }) => ['-R', `${remotePath}:${localPath}`]),
      ...request.sshArgs,
    ]
  }
  private get stopped() {
    return this.stopping.signal.aborted
  }
  alive() {
    return !this.stopped
  }
  /** Connects once. The request's signal cancels only this: once open, the tunnel is shared. */
  async open() {
    const { signal } = this.request
    const aborted = () => this.stop()
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
    try {
      await this.connect()
    } catch (error) {
      await this.close()
      throw error
    } finally {
      signal?.removeEventListener('abort', aborted)
    }
    const tunnel = logIdentifier(this.request.sourceId)
    log('source', 'tunnel', { tunnel, state: 'open' })
    this.kept = this.keep(tunnel)
  }
  /** Starts SSH again after each break, sooner after one that lasted. */
  private async keep(tunnel: ReturnType<typeof logIdentifier>) {
    const { signal } = this.stopping
    let delay = FIRST_RETRY_MS,
      broken = false
    while (!signal.aborted) {
      await this.exited
      if (signal.aborted) return
      // One warning for each break, however many attempts it takes to mend.
      if (!broken) warn('CANVAS_TUNNEL', 'tunnel', { tunnel, state: 'close' })
      broken = true
      await sleep(delay, undefined, { signal, ref: false }).catch(() => {})
      if (signal.aborted) return
      try {
        await this.connect()
        delay = FIRST_RETRY_MS
        broken = false
        log('source', 'tunnel', { tunnel, state: 'open' })
      } catch {
        delay = Math.min(delay * 2, LAST_RETRY_MS)
      }
    }
  }
  /** Starts SSH and resolves once every forward is listening. */
  private async connect() {
    const { request } = this
    await Promise.all(Object.values(this.sockets).map((path) => rm(path, { force: true })))
    await Promise.all(
      Object.values(request.reverse || {}).map((r) => requireLocalSocket(r.localPath)),
    )
    if (this.reverse) await remoteSocketState(request, 'prepare', this.reverseIdentities)
    if (this.stopped) throw closedError()
    const child = (this.child = spawn('ssh', this.args, {
      env: request.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    }))
    let failure: string | undefined,
      exited = false
    this.exited = new Promise<void>((resolve) => {
      child.once('error', (error) => (failure = error.message))
      child.once('close', () => {
        exited = true
        resolve()
      })
    })
    child.stderr?.on('data', (data: Buffer) => {
      failure = `${failure ?? ''}${data.toString('utf8')}`.slice(-1200)
    })
    const deadline = Date.now() + OPEN_MS
    try {
      while (true) {
        if (exited) throw new Error(failure?.trim() || 'SSH forwarding stopped')
        if (this.stopped) throw closedError()
        if ((await this.listening()) && !exited && !this.stopped) return
        if (Date.now() >= deadline) throw new Error('SSH socket forwarding timed out')
        await sleep(25)
      }
    } catch (error) {
      await this.terminate()
      throw error
    }
  }
  /** Whether every forward listens, local and remote. */
  private async listening() {
    if (!(await Promise.all(Object.values(this.sockets).map(isSocket))).every(Boolean)) return false
    if (!this.reverse) return true
    try {
      Object.assign(
        this.reverseIdentities,
        await remoteSocketState(this.request, 'ready', this.reverseIdentities),
      )
      return true
    } catch {
      // The remote bind follows SSH authentication and may not exist yet.
      return false
    }
  }
  private stop() {
    this.stopping.abort()
    this.child?.kill('SIGTERM')
  }
  private async terminate() {
    const child = this.child
    child?.kill('SIGTERM')
    const escalation = setTimeout(() => child?.kill('SIGKILL'), 1000)
    escalation.unref()
    await this.exited
    clearTimeout(escalation)
  }
  close() {
    return (this.closing ??= (async () => {
      this.onClose()
      this.stop()
      await this.terminate()
      await this.kept
      await rm(this.directory, { recursive: true, force: true })
      if (this.reverse)
        await retrying(() => remoteSocketState(this.request, 'clean', this.reverseIdentities), 3000)
      await this.request.cleanupRemote?.()
    })())
  }
}

async function startTunnel(request: TunnelRequest, onClose: () => void): Promise<ManagedTunnel> {
  request.signal?.throwIfAborted()
  const remote = await request.discover()
  request.signal?.throwIfAborted()
  checkForwarding(request, remote)
  // Unix socket names are short on both Linux and macOS. mkdtemp creates an
  // owner-only directory; no global SSH configuration or existing socket changes.
  const directory = await mkdtemp(join(tmpdir().length < 50 ? tmpdir() : '/tmp', 'canvas-s-'))
  const tunnel = new Tunnel(request, remote, directory, onClose)
  await tunnel.open()
  return tunnel
}

/** One SSH process per source configuration, shared by metadata and all tabs. */
export async function ensureSocketTunnel(request: TunnelRequest): Promise<SocketTunnel> {
  while (true) {
    let entry = tunnels.get(request.key)
    if (!entry) {
      const created = { sourceId: request.sourceId, closing: false } as TunnelEntry
      created.promise = startTunnel(request, () => {
        if (tunnels.get(request.key) === created) tunnels.delete(request.key)
        created.closing = true
      })
      tunnels.set(request.key, (entry = created))
    }
    let tunnel: ManagedTunnel
    try {
      tunnel = await entry.promise
    } catch (error) {
      if (tunnels.get(request.key) === entry) tunnels.delete(request.key)
      throw error
    }
    if (entry.closing) {
      await tunnel.close()
      throw new Error('SSH socket forwarding closed')
    }
    if (tunnel.alive() && tunnels.get(request.key) === entry) return tunnel
    await tunnel.close()
    if (tunnels.get(request.key) === entry) tunnels.delete(request.key)
  }
}

export async function closeSocketTunnels(sourceId?: string): Promise<void> {
  const closing: Promise<void>[] = []
  for (const [key, entry] of tunnels) {
    if (sourceId && sourceId !== entry.sourceId) continue
    entry.closing = true
    tunnels.delete(key)
    closing.push(
      entry.promise.then(
        (tunnel) => tunnel.close(),
        () => {},
      ),
    )
  }
  await Promise.all(closing)
}
