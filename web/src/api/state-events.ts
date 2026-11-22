import { apiContext, apiFetch, isCurrentApi } from './api'
import { readStateEvents } from './state-stream'

/** The server sends a keepalive every 15 s: two missed and the stream is taken for stuck. */
const SILENCE_MS = 35_000

/** The server publishes complete snapshots; reconnecting never needs event replay. */
export function subscribeState(receive: {
  /** A stream began; everything is about to be sent again. */
  connected(): void
  /** The stream ended: what was received may no longer hold. */
  disconnected(): void
  state(value: unknown): void
  resources(value: unknown): void
  account(username: string): void
  notification(value: unknown): void
}) {
  const controller = new AbortController(),
    context = apiContext()
  let timer: ReturnType<typeof setTimeout> | undefined
  const connect = async () => {
    if (controller.signal.aborted || !isCurrentApi(context)) return
    // A stream can stop without ending: the phone's network changed, or its link is stuck.
    const silent = new AbortController()
    let silence: ReturnType<typeof setTimeout> | undefined
    const alive = () => {
      clearTimeout(silence)
      silence = setTimeout(() => silent.abort(), SILENCE_MS)
    }
    alive()
    try {
      const signal = AbortSignal.any([controller.signal, silent.signal])
      const response = await apiFetch('/api/events', { signal }, context)
      if (response.status === 401) return
      if (!response.ok || !response.body) throw new Error('State stream unavailable')
      receive.connected()
      await readStateEvents(
        response.body,
        (event, data) => {
          if (controller.signal.aborted || !isCurrentApi(context)) return
          if (event === 'unauthorized') {
            window.dispatchEvent(new Event('canvas:unauthorized'))
            return
          }
          let value
          try {
            value = JSON.parse(data)
          } catch {
            return // A whole value follows; live events are not replayed.
          }
          if (event === 'state') receive.state(value)
          else if (event === 'resources') receive.resources(value)
          else if (event === 'notification') receive.notification(value)
          else if (event === 'account' && typeof value.username === 'string')
            receive.account(value.username)
        },
        alive,
      )
    } catch {
      /* A dropped stream reconnects to a full snapshot. */
    } finally {
      clearTimeout(silence)
    }
    if (!controller.signal.aborted && isCurrentApi(context)) {
      receive.disconnected()
      timer = setTimeout(() => void connect(), 2000)
    }
  }
  void connect()
  return {
    close() {
      controller.abort()
      clearTimeout(timer)
    },
  }
}
