import { herdrApiRequest } from './api.ts'
import { subscribeHerdrEvents } from './events.ts'
import type { PaneRecord } from './pane-titles.ts'
import { Reread } from '../reread.ts'

// Follows one herdr server through its API. An event says only that something changed: what the
// server holds is read again from `session.snapshot`, after each subscription has started, so
// no change falls between the two.
//
// herdr announces no event for a pane's new label. Canvas reads again after the changes it
// makes itself (`refresh`); one made elsewhere shows with the server's next event.

/**
 * The events after which a snapshot may list something else. Which tab or workspace has the
 * focus is not among what Canvas lists, and Canvas itself moves it before each burst of input.
 */
const CHANGES = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
].map((type) => ({ type }))

const RETRY_MS = 1000

export interface HerdrWatchHandlers {
  /** The result of a `session.snapshot`. */
  snapshot(result: Record<string, unknown>, readAt: number): void
  /** One pane's record, as an event carried it ahead of the next snapshot. */
  pane(record: PaneRecord): void
  /** Nothing is followed any more; changes since may be unknown. */
  ended(error: Error): void
}

/**
 * A status change has no server-wide event: it is subscribed pane by pane. herdr serves each of
 * those with a read every 100 ms, so only panes with an agent get one. `pane.agent_detected`
 * announces the panes that gain or lose one.
 */
function agentPanes(result: Record<string, unknown>): string[] {
  const panes = (result.snapshot as { panes?: unknown } | undefined)?.panes
  if (!Array.isArray(panes)) return []
  return panes
    .filter((pane) => typeof pane?.pane_id === 'string' && (pane.agent || pane.display_agent))
    .map((pane) => pane.pane_id as string)
    .sort()
}

export function watchHerdr(
  api: string,
  handlers: HerdrWatchHandlers,
): { refresh(): void; close(): void } {
  const aborted = new AbortController()
  let statuses: { close(): void } | undefined,
    starting: { close(): void } | undefined,
    // The panes whose status is subscribed or being subscribed.
    followed = ''

  const close = () => {
    if (aborted.signal.aborted) return
    aborted.abort()
    reread[Symbol.dispose]()
    events.close()
    statuses?.close()
    starting?.close()
  }
  const fail = (error: Error) => {
    if (aborted.signal.aborted) return
    close()
    handlers.ended(error)
  }
  const followStatuses = (panes: string[]) => {
    const key = JSON.stringify(panes)
    if (key === followed) return
    followed = key
    starting?.close()
    starting = undefined
    if (!panes.length) {
      statuses?.close()
      statuses = undefined
      return
    }
    const next = subscribeHerdrEvents(
      api,
      panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      {
        started() {
          // The new list holds before the old one goes.
          statuses?.close()
          statuses = next
          starting = undefined
          reread.schedule()
        },
        event: () => reread.schedule(),
        // A pane that closed meanwhile refuses the whole list: read again and follow what is left.
        ended() {
          if (starting === next) starting = undefined
          else if (statuses === next) statuses = undefined
          else return
          followed = ''
          reread.schedule(RETRY_MS)
        },
      },
    )
    starting = next
  }
  const reread = new Reread(async (readAt) => {
    const result = await herdrApiRequest(api, 'session.snapshot', {}, { signal: aborted.signal })
    if (aborted.signal.aborted) return
    followStatuses(agentPanes(result))
    handlers.snapshot(result, readAt)
  }, fail)
  let lostAt = -Infinity
  const followChanges = (): { close(): void } =>
    subscribeHerdrEvents(api, CHANGES, {
      started: () => void reread.now(),
      event(name, data) {
        if (name === 'pane_updated' && data.pane && typeof data.pane === 'object')
          handlers.pane(data.pane as PaneRecord)
        reread.schedule()
      },
      // herdr dropped events it could not deliver, and its socket holds: follow again and read
      // anew. Events lost again at once are taken for a break.
      ended(error, lost) {
        const now = performance.now()
        if (!lost || now - lostAt < RETRY_MS || aborted.signal.aborted) {
          fail(error)
          return
        }
        lostAt = now
        events = followChanges()
      },
    })
  let events = followChanges()
  return { refresh: () => reread.schedule(), close }
}
