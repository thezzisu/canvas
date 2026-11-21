import { randomUUID } from 'node:crypto'
import { sameCompletion, type CompletionToken } from '../shared/completion.ts'
import type { CanvasNotification, NativeNotification } from '../shared/notification.ts'
import { Events } from './channels.ts'
import type { CompletionReads } from './completion-reads.ts'
import type { Source } from './state.ts'
import type { WindowTransport } from './transport.ts'

/** What the intake asks of an open window. */
interface Window {
  readonly closed: boolean
  readonly proc: Pick<WindowTransport, 'completionSnapshot'>
  agentReports(paneId?: string): boolean
}

/**
 * Native notifications of every source, each shown once.
 * - herdr sends a source's notices to every endpoint and Core to every window, so only the source's
 *   owner (one open window per connection) takes them in; closing it promotes the next.
 * - A program's own notice belongs to the one window showing it, unless its pane's agent reports
 *   its state and so says it already.
 * - A completion waits, briefly, until the source's read state says it is new.
 */
export class NotificationIntake implements Disposable {
  readonly notifications = new Events<CanvasNotification>()
  private readonly pending = new Map<
    string,
    { source: Source; notification: CanvasNotification; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly delivered = new Map<string, CompletionToken>()
  private readonly boots = new Map<string, string>()

  constructor(
    private readonly reads: CompletionReads | undefined,
    /** The open window that takes in the source's notices, if any. */
    private readonly owner: (source: Source) => Window | undefined,
    /** Whether the source's notices are wanted now. */
    private readonly accepting: (sourceId: string) => boolean,
  ) {}

  /** The source's windows or native state changed: read its completions through its owner. */
  observe(source: Source) {
    const owner = this.owner(source)
    const snapshot = owner?.proc.completionSnapshot()
    if (owner && snapshot) {
      this.reads?.observeSnapshot(source, snapshot.windows, snapshot.state, owner)
      if (this.boots.get(source.id) !== snapshot.state.bootId) {
        this.boots.set(source.id, snapshot.state.bootId)
        for (const window of snapshot.windows)
          for (const pane of window.panes) {
            const token = this.reads?.completion(source, pane.id)?.completion || pane.completion
            if (token) this.delivered.set(`${source.id}/${pane.id}`, token)
          }
      }
      this.flush(source.id)
    } else if (!owner) {
      this.reads?.disconnected(source.id)
      this.boots.delete(source.id)
    }
  }

  /** A notice that one of the source's windows raised. */
  receive(source: Source, window: Window, notification: NativeNotification) {
    if (!this.accepting(source.id) || window.closed) return
    if (notification.origin === 'program') {
      if (!window.agentReports(notification.paneId))
        this.notifications.emit({ ...notification, id: randomUUID(), sourceId: source.id })
      return
    }
    if (this.owner(source) !== window) return
    const event: CanvasNotification = { ...notification, id: randomUUID(), sourceId: source.id }
    if (notification.kind !== 'done' || !this.reads) {
      this.notifications.emit(event)
      return
    }
    if (!notification.paneId) return
    const key = `${source.id}/${notification.paneId}`
    clearTimeout(this.pending.get(key)?.timer)
    const timer = setTimeout(() => this.pending.delete(key), 1000)
    timer.unref()
    this.pending.set(key, { source, notification: event, timer })
    queueMicrotask(() => this.flush(source.id))
  }

  /** Forgets everything about the source, which is closing. */
  forget(sourceId: string) {
    this.boots.delete(sourceId)
    for (const [key, pending] of this.pending)
      if (pending.source.id === sourceId) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
      }
    for (const key of this.delivered.keys())
      if (key.startsWith(`${sourceId}/`)) this.delivered.delete(key)
  }

  private flush(sourceId: string) {
    if (!this.reads || !this.accepting(sourceId)) return
    for (const [key, pending] of this.pending) {
      if (pending.source.id !== sourceId) continue
      const completion = this.reads.completion(pending.source, pending.notification.paneId!)
      if (!completion) continue
      if (sameCompletion(this.delivered.get(key), completion.completion)) continue
      clearTimeout(pending.timer)
      this.pending.delete(key)
      this.delivered.set(key, completion.completion)
      if (this.delivered.size > 1000) this.delivered.delete(this.delivered.keys().next().value!)
      this.notifications.emit({
        ...pending.notification,
        windowId: completion.windowId,
        completion: completion.completion,
      })
    }
  }

  [Symbol.dispose]() {
    this.notifications[Symbol.dispose]()
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.delivered.clear()
    this.boots.clear()
  }
}
