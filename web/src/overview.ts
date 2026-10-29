import { statusPriority, type ProgramStatus } from '../../shared/status.ts'
import type { SourceResource } from './types'

export const overviewStatuses = ['attention', 'done', 'working', 'idle', 'unknown'] as const
export type OverviewOrder = 'native' | 'status'

/** Project window aggregates without mutating native order or pane details. */
export function overviewResources(resources: readonly SourceResource[], statuses: readonly ProgramStatus[], order: OverviewOrder): SourceResource[] {
  const selected = new Set(statuses)
  return resources.flatMap(source => {
    const spaces = source.spaces.flatMap(space => {
      const windows = space.windows.filter(window => selected.has(window.status || 'unknown'))
      if (order === 'status') windows.sort((a, b) => statusPriority[b.status || 'unknown'] - statusPriority[a.status || 'unknown'])
      return windows.length ? [{ ...space, windows }] : []
    })
    return spaces.length ? [{ ...source, spaces }] : []
  })
}

export function overviewLayoutKey(resources: readonly SourceResource[]): string {
  return JSON.stringify(resources.map(source => [source.id, source.spaces.map(space => [space.id, space.windows.map(window => window.id)])]))
}
