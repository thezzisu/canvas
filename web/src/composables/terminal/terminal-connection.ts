import { apiFetch, apiUrl, type ApiContext } from '../../api/api'
import {
  TerminalChannels,
  type ConnectionEvents,
  type TerminalConnection,
  type TerminalWindow,
} from '../../utils/terminal/terminal-channels'
import type { TerminalView } from '../../utils/terminal/terminal-view'
import { log } from '../../utils/diagnostics/log'

/** One socket per signed-in instance. It lives from its first channel to its last. */
const sockets = new Map<string, TerminalChannels>()
const socketKey = (context: ApiContext) => `${context.base}\n${context.token}`
/** The probe before a reconnect, which a stuck link must not hold past the handshake's limit. */
const ACCESS_TIMEOUT_MS = 8000
let following = false
/** Sockets judge nothing while the page is hidden, and again once it shows. */
function followPage() {
  if (following) return
  following = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const channels of sockets.values()) channels.shown()
  })
}

/** Opens a window's channel on the instance's socket, opening the socket for the first one. */
export function openTerminalConnection(
  context: ApiContext,
  window: TerminalWindow,
  view: TerminalView,
  events: ConnectionEvents,
): TerminalConnection {
  followPage()
  const key = socketKey(context)
  let channels = sockets.get(key)
  if (!channels) {
    const url = apiUrl('/api/terminal', context)
    url.searchParams.set('apiBase', context.base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    log('socket', { state: 'opening' })
    socket.addEventListener('open', () => log('socket', { state: 'open' }))
    socket.addEventListener('error', () => log('socket', { state: 'error' }))
    socket.addEventListener('close', ({ code, wasClean }) =>
      log('socket', { state: 'close', code, clean: wasClean }),
    )
    const created = (channels = new TerminalChannels(socket, context.token, () => {
      if (sockets.get(key) === created) sockets.delete(key)
    }))
    sockets.set(key, created)
  }
  return channels.open(window, view, events)
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
      const response = await apiFetch(
        '/api/state',
        // Windows that lost the socket together share this: hung, it would hang every retry.
        { signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS) },
        context,
      )
      if (response.status === 401) return 'expired' as const
      if (!response.ok) throw new Error('State unavailable')
      const state = (await response.json()) as { sources: Array<{ id: string }> }
      return new Set(state.sources.map((source) => source.id))
    })()
    probes.set(key, probe)
    void probe.then(
      (sources) => log('probe', { state: sources === 'expired' ? 'expired' : 'ok' }),
      () => log('probe', { state: 'failed' }),
    )
    const settled = () => probes.delete(key)
    void probe.then(settled, settled)
  }
  return probe
}
