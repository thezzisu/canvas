import { Reread } from '../reread.ts'
import type { CoreRpc } from './rpc.ts'

// Follows one herdr-core through its event stream. An event says only that something changed:
// what Canvas lists is read again, after the subscription has started.

export interface CoreWatchHandlers<T> {
  snapshot(value: T, readAt: number): void
  /** Nothing is followed any more; changes since may be unknown. */
  ended(error: Error): void
}

/** Takes over `rpc`, and closes it when the watch closes or ends. */
export function watchCore<T>(
  rpc: Pick<CoreRpc, 'subscribe' | 'onClose' | 'close'>,
  read: () => Promise<T>,
  handlers: CoreWatchHandlers<T>,
): { refresh(): void; close(): void } {
  const owned = new DisposableStack()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    owned.dispose()
    rpc.close()
  }
  const fail = (error: Error) => {
    if (closed) return
    close()
    handlers.ended(error)
  }
  const reread = owned.use(
    new Reread(async (readAt) => {
      const value = await read()
      if (!closed) handlers.snapshot(value, readAt)
    }, fail),
  )
  owned.use(rpc.onClose(fail))
  void (async () => {
    const subscription = await rpc.subscribe({}, (event) => {
      if (event.method === 'heartbeat') return
      // `missed` says events were lost; a size is nothing Canvas lists.
      if (event.method === 'missed') void reread.now()
      else if (event.params.type !== 'size') reread.schedule()
    })
    if (closed) {
      subscription.close()
      return
    }
    owned.use(subscription.stream.onClose(() => fail(new Error('Core ended the event stream'))))
    subscription.start()
    await reread.now()
  })().catch((error) =>
    fail(error instanceof Error ? error : new Error('Core event subscription failed')),
  )
  return { refresh: () => reread.schedule(), close }
}
