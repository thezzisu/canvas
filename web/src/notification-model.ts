import { isCompletionToken, sameCompletion } from '../../shared/completion'
import type { CanvasNotification } from '../../shared/notification'
import { aggregateStatus, type ProgramStatus } from '../../shared/status'
import type { SourceResource } from './types'

export function isCanvasNotification(value: unknown): value is CanvasNotification {
  if (!value || typeof value !== 'object') return false
  const event = value as CanvasNotification
  return typeof event.id === 'string' && typeof event.sourceId === 'string' && typeof event.title === 'string'
    && ['attention', 'done', 'update', 'custom'].includes(event.kind)
    && (event.completion === undefined || isCompletionToken(event.completion))
    && ['body', 'agent', 'spaceId', 'windowId', 'paneId'].every(key => {
      const field = event[key as keyof CanvasNotification]
      return field === undefined || typeof field === 'string'
    })
}

function notificationLocation(event: CanvasNotification, resources: readonly SourceResource[]) {
  const source = resources.find(source => source.id === event.sourceId)
  if (!source) return
  for (const space of source.spaces) for (const window of space.windows) {
    const pane = event.paneId ? window.panes?.find(pane => pane.id === event.paneId) : undefined
    if (event.paneId ? !!pane : event.windowId === window.id) return { source, space, window, pane }
  }
}

export function notificationTarget(event: CanvasNotification, resources: readonly SourceResource[]) {
  const target = notificationLocation(event, resources)
  return target?.source.status === 'online' && !target.source.error ? target : undefined
}

/** A displayed completion is an event, even after focus or live status changes. */
export function notificationPresent(event: CanvasNotification, resources: readonly SourceResource[]): boolean {
  const source = resources.find(source => source.id === event.sourceId)
  return !!source && (source.status !== 'online' || !!source.error || !!notificationLocation(event, resources))
}

export function attentionSummary(resources: readonly SourceResource[]) {
  const windows = new Map<string, 'attention' | 'done'>()
  for (const source of resources) {
    if (source.status !== 'online' || source.error) continue
    for (const space of source.spaces) for (const window of space.windows) {
      const states = window.panes?.length ? window.panes.map(pane => pane.status) : [window.status]
      const status = states.includes('attention') ? 'attention' : states.includes('done') ? 'done' : undefined
      if (status) windows.set(`${source.id}/${window.id}`, status)
    }
  }
  return { count: windows.size, status: [...windows.values()].includes('attention') ? 'attention' : windows.size ? 'done' : undefined } as const
}

/** Favicon reflects every native state; the badge only counts actionable windows. */
export function faviconStatus(resources: readonly SourceResource[]): ProgramStatus | undefined {
  const statuses = resources.filter(source => source.status === 'online' && !source.error)
    .flatMap(source => source.spaces.flatMap(space => space.windows.flatMap(window =>
      window.panes?.length ? window.panes.map(pane => pane.status) : [window.status || 'unknown'])))
  return statuses.length ? aggregateStatus(statuses) : undefined
}

export function notificationKey(event: CanvasNotification) {
  return event.paneId ? `${event.sourceId}/pane/${event.paneId}`
    : event.windowId ? `${event.sourceId}/window/${event.windowId}` : event.id
}

/** A completion remains the same event after its shared read state becomes Idle. */
export function notificationCurrent(event: CanvasNotification, resources: readonly SourceResource[]): boolean {
  const target = notificationTarget(event, resources)
  if (!target) return false
  return event.kind === 'done'
    ? !!event.completion && sameCompletion(event.completion, target.pane?.completion) && ['done', 'idle'].includes(target.pane?.status || '')
    : (target.pane?.status || target.window.status) === event.kind
}
