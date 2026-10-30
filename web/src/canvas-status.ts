import { aggregateStatus, type ProgramStatus } from '../../shared/status'
import { isTerminalNode, type Canvas, type SourceResource, type WindowResource } from './types'

export interface WindowVisualState { status: ProgramStatus; fresh: boolean; pulse: boolean }
export interface CanvasIndicator { count: number; status: ProgramStatus | null; pulse: boolean }
export const needsAttention = (status?: ProgramStatus) => status === 'attention' || status === 'done'

/** A retained snapshot is useful for layout, but cannot announce current work. */
export function windowVisualState(source: SourceResource | undefined, window: WindowResource | undefined, fresh: boolean): WindowVisualState {
  const current = fresh && !!window && source?.status === 'online' && !source.error
  const status = current && window.status && window.status !== 'error' ? window.status : 'unknown'
  return { status, fresh: current, pulse: current && needsAttention(status) }
}

/** Summaries are independent of the active canvas, filters and mounted terminals. */
export function canvasIndicators(canvases: readonly Canvas[], resources: readonly SourceResource[], fresh: boolean): Record<string, CanvasIndicator> {
  const windows = new Map<string, WindowVisualState>()
  for (const source of resources) for (const space of source.spaces) for (const window of space.windows) {
    windows.set(`${source.id}/${window.id}`, windowVisualState(source, window, fresh))
  }
  const indicator = (states: WindowVisualState[], count: number): CanvasIndicator => {
    const status = states.length ? aggregateStatus(states.map(state => state.status)) : null
    return { count, status, pulse: needsAttention(status || undefined) && states.some(state => state.fresh && state.status === status) }
  }
  const result: Record<string, CanvasIndicator> = { overview: indicator([...windows.values()], windows.size) }
  for (const canvas of canvases) {
    const states = canvas.nodes.filter(isTerminalNode).map(node => windows.get(`${node.sourceId}/${node.windowId}`)
      || { status: 'unknown' as const, fresh: false, pulse: false })
    result[canvas.id] = indicator(states, canvas.nodes.length)
  }
  return result
}
