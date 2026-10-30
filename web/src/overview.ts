import { statusPriority, type ProgramStatus } from '../../shared/status.ts'
import type { SourceResource } from './types'

export const overviewStatuses = ['attention', 'done', 'working', 'idle', 'unknown'] as const
/** The task-focused preset keeps windows that need attention or are active. */
export const overviewFocusStatuses = ['attention', 'done', 'working'] as const
export type OverviewOrder = 'native' | 'status'
export type OverviewInteraction = { sourceId: string; windowId: string }

/** Project window aggregates without mutating native order or pane details. */
export function overviewResources(resources: readonly SourceResource[], statuses: readonly ProgramStatus[], order: OverviewOrder, interacting?: OverviewInteraction): SourceResource[] {
  const selected = new Set(statuses)
  return resources.flatMap(source => {
    const spaces = source.spaces.flatMap(space => {
      const windows = space.windows.filter(window => selected.has(window.status || 'unknown') || (source.id === interacting?.sourceId && window.id === interacting.windowId))
      if (order === 'status') windows.sort((a, b) => statusPriority[b.status || 'unknown'] - statusPriority[a.status || 'unknown'])
      return windows.length ? [{ ...space, windows }] : []
    })
    return spaces.length ? [{ ...source, spaces }] : []
  })
}

export function overviewLayoutKey(resources: readonly SourceResource[]): string {
  return JSON.stringify(resources.map(source => [source.id, source.spaces.map(space => [space.id, space.windows.map(window => window.id)])]))
}
