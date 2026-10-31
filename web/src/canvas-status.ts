import { aggregateStatus, type ProgramStatus } from '../../shared/status'
import { isTerminalNode, type Canvas, type SourceResource, type WindowResource } from './types'

export interface WindowVisualState { status: ProgramStatus; fresh: boolean }
export interface CanvasIndicator { count: number; status: ProgramStatus | null }
export const needsAttention = (status?: ProgramStatus) => status === 'attention' || status === 'done'

/** Freshness gates attention animation; a background tab keeps its known status. */
export function windowVisualState(source: SourceResource | undefined, window: WindowResource | undefined, fresh: boolean): WindowVisualState {
  const available = !!window && source?.status === 'online' && !source.error
  const current = fresh && available
  const status = available && window.status && window.status !== 'error' ? window.status : 'unknown'
  return { status, fresh: current }
}

/** Summaries are independent of the active canvas, filters and mounted terminals. */
export function canvasIndicators(canvases: readonly Canvas[], resources: readonly SourceResource[]): Record<string, CanvasIndicator> {
  const windows = new Map<string, ProgramStatus>()
  for (const source of resources) for (const space of source.spaces) for (const window of space.windows) {
    windows.set(`${source.id}/${window.id}`, windowVisualState(source, window, true).status)
  }
  const indicator = (states: ProgramStatus[], count: number): CanvasIndicator => {
    const status = states.length ? aggregateStatus(states) : null
    return { count, status }
  }
  const result: Record<string, CanvasIndicator> = { overview: indicator([...windows.values()], windows.size) }
  for (const canvas of canvases) {
    const states = canvas.nodes.filter(isTerminalNode).map(node => windows.get(`${node.sourceId}/${node.windowId}`) || 'unknown')
    result[canvas.id] = indicator(states, canvas.nodes.length)
  }
  return result
}
