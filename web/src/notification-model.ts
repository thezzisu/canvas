import type { CanvasNotification } from '../../shared/notification'
import type { SourceResource } from './types'

export function isCanvasNotification(value: unknown): value is CanvasNotification {
  if (!value || typeof value !== 'object') return false
  const event = value as CanvasNotification
  return typeof event.id === 'string' && typeof event.sourceId === 'string' && typeof event.title === 'string'
    && ['attention', 'done', 'update', 'custom'].includes(event.kind)
    && ['body', 'agent', 'spaceId', 'windowId', 'paneId'].every(key => {
      const field = event[key as keyof CanvasNotification]
      return field === undefined || typeof field === 'string'
    })
}

export function notificationTarget(event: CanvasNotification, resources: readonly SourceResource[]) {
  const source = resources.find(source => source.id === event.sourceId && source.status === 'online' && !source.error)
  if (!source) return
  for (const space of source.spaces) for (const window of space.windows) {
    const pane = event.paneId ? window.panes?.find(pane => pane.id === event.paneId) : undefined
    if (event.paneId ? !!pane : event.windowId === window.id) return { source, space, window, pane }
  }
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

export function notificationKey(event: CanvasNotification) {
  return event.paneId ? `${event.sourceId}/pane/${event.paneId}`
    : event.windowId ? `${event.sourceId}/window/${event.windowId}` : event.id
}
