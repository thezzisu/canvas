// The connections Canvas holds to each source: SSH socket forwards and open terminals.
import { createHash, randomUUID } from 'node:crypto'
import { closeSocketTunnels, ensureSocketTunnel } from './ssh-tunnels.ts'
import { isLoopbackHost } from './loopback.ts'
import { sourceConnectionKey, type Source } from './state.ts'
import { commandEnvironment, sshOptions, validateSource } from './source-command.ts'

const active = new Set<{
  sourceId: string
  spaceId: string
  windowId: string
  cleanup(): Promise<void>
}>()
const preparing = new Map<string, number>()

async function releaseIdleConnections(sourceId: string): Promise<void> {
  if (!preparing.has(sourceId) && ![...active].some((item) => item.sourceId === sourceId))
    await closeRuntimeConnections(sourceId)
}

/** Quotes one argument for the remote POSIX login shell; never concatenate raw input. */

export async function prepareLoopback(source: Source, host: string, port: number) {
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid loopback endpoint')
  validateSource(source)
  if (source.transport === 'local') return { hostname: host, close: async () => {} }
  // Capture and URL previews own independent lifetimes, even at one endpoint.
  const key = `web:${socketTunnelIdentity(source, [host, String(port)])}:${randomUUID()}`
  const tunnel = await ensureSocketTunnel({
    sourceId: `web:${source.id}`,
    key,
    sshArgs: sshOptions(source),
    env: commandEnvironment(),
    discover: async () => ({}),
    tcp: { 'web.sock': { host, port } },
  })
  return { socketPath: tunnel.sockets['web.sock']!, close: () => tunnel.close() }
}

function socketTunnelIdentity(
  source: Source,
  paths: string[],
  reverse: Record<string, { remotePath: string; localPath: string }> = {},
): string {
  return createHash('sha256')
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
    .digest('hex')
}

export function tunnelRequest(
  source: Source,
  endpoints: Record<string, string>,
  reverse?: Record<string, { remotePath: string; localPath: string }>,
  cleanupRemote?: () => Promise<void>,
  lifecycleSourceId = source.id,
) {
  const ssh = sshOptions(source)
  return {
    sourceId: lifecycleSourceId,
    key: socketTunnelIdentity(source, Object.values(endpoints), reverse),
    sshArgs: ssh,
    env: commandEnvironment(),
    discover: async () => endpoints,
    ...(reverse ? { reverse } : {}),
    ...(cleanupRemote ? { cleanupRemote } : {}),
  }
}

const releases = new Set<(sourceId?: string) => void>()
/** Something a runtime keeps open for a source, released with the source's connections. */
export function onRelease(release: (sourceId?: string) => void) {
  releases.add(release)
}
const discovered = new Map<string, { sourceId: string; value: unknown }>()
/** Where the source's runtime listens, looked up again only after connecting there failed. */
export async function rememberEndpoint<T>(source: Source, discover: () => Promise<T>): Promise<T> {
  const key = sourceConnectionKey(source)
  const known = discovered.get(key)
  if (known) return known.value as T
  const value = await discover()
  discovered.set(key, { sourceId: source.id, value })
  return value
}
export function forgetEndpoint(source: Source) {
  discovered.delete(sourceConnectionKey(source))
}
/** Close only Canvas-owned socket forwards; no workstation SSH configuration changes. */
export async function closeRuntimeConnections(sourceId?: string): Promise<void> {
  for (const release of releases) release(sourceId)
  for (const [key, endpoint] of discovered)
    if (sourceId === undefined || endpoint.sourceId === sourceId) discovered.delete(key)
  await closeSocketTunnels(sourceId)
}

/** Keeps the source's connections up until the returned hold is released. */
export function holdConnections(source: Source): AsyncDisposable {
  preparing.set(source.id, (preparing.get(source.id) || 0) + 1)
  let held = true
  return {
    async [Symbol.asyncDispose]() {
      if (!held) return
      held = false
      const count = preparing.get(source.id)! - 1
      if (count) preparing.set(source.id, count)
      else preparing.delete(source.id)
      await releaseIdleConnections(source.id)
    },
  }
}
/** Keeps the source's connections up while `operation` runs, and releases them if unused after. */
export async function holding<T>(source: Source, operation: () => Promise<T>): Promise<T> {
  await using _held = holdConnections(source)
  return await operation()
}

/**
 * Keeps the source's connections up while a terminal of this window is open. The handle's cleanup
 * runs `close` once.
 */
export function trackTerminal(
  source: Source,
  spaceId: string,
  windowId: string,
  close: () => void = () => {},
) {
  let closed = false
  const handle = {
    sourceId: source.id,
    spaceId,
    windowId,
    cleanup: async () => {
      if (closed) return
      closed = true
      close()
      active.delete(handle)
      await releaseIdleConnections(source.id)
    },
  }
  active.add(handle)
  return handle
}

/** Closes the open terminals `match` picks. */
export async function closeTerminals(
  match: (terminal: { sourceId: string; spaceId: string; windowId: string }) => boolean,
) {
  await Promise.all([...active].filter(match).map((terminal) => terminal.cleanup()))
}
