import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

// One `events.subscribe` stream of a herdr API socket.

const MAX_LINE = 1024 * 1024

export interface HerdrEventHandlers {
  /** The subscription holds: what changes from now on is announced. */
  started(): void
  event(name: string, data: Record<string, unknown>): void
  /**
   * It ended without `close`: what changed since may have gone unannounced. `lost` says herdr
   * ended it for events it could not deliver, over a socket that still works.
   */
  ended(error: Error, lost: boolean): void
}

export function subscribeHerdrEvents(
  socketPath: string,
  subscriptions: readonly Record<string, string>[],
  handlers: HerdrEventHandlers,
  options: { timeoutMs?: number } = {},
): { close(): void } {
  const id = randomUUID(),
    socket = createConnection(socketPath)
  let buffer = Buffer.alloc(0),
    started = false,
    done = false
  const close = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    socket.destroy()
  }
  const end = (reason: string, lost = false) => {
    if (done) return
    close()
    handlers.ended(new Error(reason), lost)
  }
  const timer = setTimeout(
    () => end('Herdr did not start the event subscription'),
    options.timeoutMs ?? 15_000,
  )
  timer.unref()
  socket.once('connect', () =>
    socket.write(
      JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n',
    ),
  )
  socket.on('error', (error) => end(`Herdr API connection failed: ${error.message}`))
  socket.once('close', () => end('Herdr ended the event subscription'))
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (let index; !done && (index = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, index).toString('utf8')
      buffer = buffer.subarray(index + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        end('Invalid herdr event')
        return
      }
      if (message?.id === id) {
        // After the start this is how herdr says that events were lost.
        if (started || message.error || message.result?.type !== 'subscription_started') {
          end(`Herdr ended the event subscription: ${message.error?.code || 'refused'}`, started)
          return
        }
        started = true
        clearTimeout(timer)
        handlers.started()
      } else if (started && typeof message?.event === 'string')
        handlers.event(
          message.event,
          message.data && typeof message.data === 'object' ? message.data : {},
        )
    }
    if (buffer.length > MAX_LINE) end('Herdr event is too large')
  })
  return { close }
}
