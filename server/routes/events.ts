// The live event stream of state changes and notifications.
import { bearerToken } from '../auth.ts'
import { type Source } from '../state.ts'
import type { CanvasNotification } from '../../shared/notification.ts'
import type { RouteContext } from './context.ts'

export function eventRoutes({ app, store, account, terminals }: RouteContext) {
  app.get('/api/events', (c) => {
    const session = bearerToken(c.req.header('authorization'))
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array>
    let pending: string | undefined
    const notificationQueue: string[] = []
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let notifications: Disposable | undefined
    let closed = false
    const flush = () => {
      if (!closed && (controller.desiredSize ?? 0) > 0) {
        const event = pending || notificationQueue.shift()
        if (event) {
          pending = undefined
          controller.enqueue(encoder.encode(event))
        }
      }
    }
    const close = (unauthorized = false) => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      notifications?.[Symbol.dispose]()
      notificationQueue.length = 0
      store.off('change', publish)
      store.off('sessions', checkSession)
      store.off('close', stopped)
      store.off('account', publishAccount)
      c.req.raw.signal.removeEventListener('abort', aborted)
      try {
        if (unauthorized) controller.enqueue(encoder.encode('event: unauthorized\ndata: {}\n\n'))
        controller.close()
      } catch {
        /* A disconnected reader is already closed. */
      }
    }
    const checkSession = () => {
      if (!store.hasSession(session)) {
        close(true)
        return false
      }
      return true
    }
    const publish = () => {
      if (closed || !checkSession()) return
      const snapshot = store.snapshot()
      // Keep only the latest snapshot when a browser is temporarily slow.
      pending = `event: state\nid: ${snapshot.instanceId}:${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`
      flush()
    }
    const stopped = () => close()
    const publishAccount = () => {
      if (!closed && checkSession())
        controller.enqueue(
          encoder.encode(
            `event: account\ndata: ${JSON.stringify({ username: account.username })}\n\n`,
          ),
        )
    }
    const publishNotification = (notification: CanvasNotification) => {
      if (closed || !checkSession() || !store.get<Source>('source', notification.sourceId)) return
      // Keep a small live burst, never a durable/reconnect notification history.
      if (notificationQueue.length === 32) notificationQueue.shift()
      notificationQueue.push(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`)
      flush()
    }
    const aborted = () => close()
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        notifications = terminals.notifications.subscribe(publishNotification)
        store.on('change', publish)
        store.on('sessions', checkSession)
        store.on('close', stopped)
        store.on('account', publishAccount)
        c.req.raw.signal.addEventListener('abort', aborted, { once: true })
        if (c.req.raw.signal.aborted) {
          close()
          return
        }
        heartbeat = setInterval(() => {
          if (!closed && checkSession() && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(': keepalive\n\n'))
        }, 15_000)
        heartbeat.unref()
        publish()
      },
      pull: flush,
      cancel: () => close(),
    })
    c.header('Content-Type', 'text/event-stream')
    c.header('X-Accel-Buffering', 'no')
    c.header('Connection', 'keep-alive')
    return c.body(stream)
  })
}
