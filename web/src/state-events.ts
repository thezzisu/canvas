import { apiContext, apiFetch, isCurrentApi } from './api'
import { readStateEvents } from './state-stream'

/** The server publishes complete snapshots; reconnecting never needs event replay. */
export function subscribeState(onState: (value: unknown) => void, onAccount?: (username: string) => void) {
  const controller = new AbortController(), context = apiContext()
  let timer: ReturnType<typeof setTimeout> | undefined
  const connect = async () => {
    if (controller.signal.aborted || !isCurrentApi(context)) return
    try {
      const response = await apiFetch('/api/events', { signal: controller.signal }, context)
      if (response.status === 401) return
      if (!response.ok || !response.body) throw new Error('State stream unavailable')
      await readStateEvents(response.body, (event, data) => {
        if (controller.signal.aborted || !isCurrentApi(context)) return
        if (event === 'unauthorized') window.dispatchEvent(new Event('canvas:unauthorized'))
        else if (event === 'state') { try { onState(JSON.parse(data)) } catch { /* A new snapshot follows. */ } }
        else if (event === 'account') { try { const value = JSON.parse(data); if (typeof value.username === 'string') onAccount?.(value.username) } catch { /* Ignore malformed metadata. */ } }
      })
    } catch { /* A dropped stream reconnects to a full snapshot. */ }
    if (!controller.signal.aborted && isCurrentApi(context)) timer = setTimeout(() => void connect(), 2000)
  }
  void connect()
  return { close() { controller.abort(); clearTimeout(timer) } }
}
