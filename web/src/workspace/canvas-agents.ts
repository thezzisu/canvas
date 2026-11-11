import { statusPriority, type ProgramStatus } from '../../../shared/status'
import type { OverviewOrder } from '../canvas/overview'
import type { Canvas, PaneResource, SourceResource, WindowResource } from '../api/types'

export interface CanvasAgent {
  key: string
  sourceId: string
  windowId: string
  pane: PaneResource
  window: WindowResource
  context: string
  status: ProgramStatus
  available: boolean
}

/** Use the same displayed resources as the canvas dot; filtering never hides agents here. */
export function canvasAgents(
  canvas: Canvas | undefined,
  resources: readonly SourceResource[],
  order: OverviewOrder = 'native',
): CanvasAgent[] {
  const windows =
    canvas &&
    new Set(
      canvas.nodes.flatMap((node) =>
        node.type === 'terminal' ? [`${node.sourceId}/${node.windowId}`] : [],
      ),
    )
  const agents = new Map<string, CanvasAgent>()
  for (const source of resources)
    for (const space of source.spaces)
      for (const window of space.windows) {
        if (windows && !windows.has(`${source.id}/${window.id}`)) continue
        for (const pane of window.panes || []) {
          if (!pane.agent?.trim() && pane.status === 'unknown') continue
          const key = `${source.id}/${window.id}/${pane.id}`
          const available = source.status === 'online' && !source.error
          if (!agents.has(key))
            agents.set(key, {
              key,
              sourceId: source.id,
              windowId: window.id,
              pane,
              window,
              context: [source.name, space.name].filter(Boolean).join(' / '),
              status: available ? pane.status : 'unknown',
              available,
            })
        }
      }
  const result = [...agents.values()]
  return order === 'status'
    ? result.sort((a, b) => statusPriority[b.status] - statusPriority[a.status])
    : result
}
