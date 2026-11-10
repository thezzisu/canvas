import { statusPriority, type ProgramStatus } from '../../shared/status.ts'
import type { SourceResource } from './types'

export const overviewStatuses = ['attention', 'done', 'working', 'idle', 'unknown'] as const
/** The task-focused preset keeps windows that need attention or are active. */
export const overviewFocusStatuses = ['attention', 'done', 'working'] as const
export const overviewPerRowChoices = [0, 1, 2, 3, 4, 6, 8] as const
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

export type OverviewCard = { width: number; height: number }
export type OverviewCardPlacement = OverviewCard & { x: number; y: number }

/** Lay out one space's cards from `origin`, starting a continuation line every
 * `perRow` cards (0 keeps one line). A create card takes the next slot, sized
 * like the last window but as tall as its line's tallest card. */
export function overviewSpaceLayout(windows: readonly OverviewCard[], perRow: number, create: boolean, fallback: OverviewCard, origin = { x: 0, y: 0 }) {
  const gap = 16
  const lines: OverviewCard[][] = [[]]
  const openLine = () => { if (perRow > 0 && lines.at(-1)!.length === perRow) lines.push([]); return lines.at(-1)! }
  for (const window of windows) openLine().push(window)
  if (create) {
    const last = windows.at(-1) ?? fallback, row = openLine()
    row.push({ width: last.width, height: Math.max(last.height, ...row.map(card => card.height)) })
  }
  const cards: OverviewCardPlacement[] = []
  let y = origin.y, width = 0
  for (const line of lines) {
    let x = origin.x
    for (const card of line) { cards.push({ ...card, x, y }); x += card.width + gap }
    width = Math.max(width, x - gap - origin.x)
    y += Math.max(0, ...line.map(card => card.height)) + gap
  }
  return { cards, width, height: y - gap - origin.y }
}
