import { apiFetch, apiUrl, type ApiContext } from '../../api/api'
import {
  TerminalChannels,
  type ConnectionEvents,
  type TerminalConnection,
  type TerminalWindow,
} from '../../utils/terminal/terminal-channels'

/** One socket per signed-in instance. It lives from its first channel to its last. */
const sockets = new Map<string, TerminalChannels>()
const socketKey = (context: ApiContext) => `${context.base}\n${context.token}`

/** Opens a window's channel on the instance's socket, opening the socket for the first one. */
export function openTerminalConnection(
  context: ApiContext,
  window: TerminalWindow,
  events: ConnectionEvents,
): TerminalConnection {
  const key = socketKey(context)
  let channels = sockets.get(key)
  if (!channels) {
    const url = apiUrl('/api/terminal', context)
    url.searchParams.set('apiBase', context.base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const created = (channels = new TerminalChannels(new WebSocket(url), context.token, () => {
      if (sockets.get(key) === created) sockets.delete(key)
    }))
    sockets.set(key, created)
  }
  return channels.open(window, events)
}

const probes = new Map<string, Promise<ReadonlySet<string> | 'expired'>>()
/**
 * Whether the account still stands, and the sources it has. A socket's failure hides an HTTP
 * 401, so a window asks before it connects again; windows that lost the socket together share
 * one request.
 */
export function terminalAccess(context: ApiContext): Promise<ReadonlySet<string> | 'expired'> {
  const key = socketKey(context)
  let probe = probes.get(key)
  if (!probe) {
    probe = (async () => {
      const response = await apiFetch('/api/state', undefined, context)
      if (response.status === 401) return 'expired' as const
      if (!response.ok) throw new Error('State unavailable')
      const state = (await response.json()) as { sources: Array<{ id: string }> }
      return new Set(state.sources.map((source) => source.id))
    })()
    probes.set(key, probe)
    const settled = () => probes.delete(key)
    void probe.then(settled, settled)
  }
  return probe
}
