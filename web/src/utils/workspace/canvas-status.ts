import { aggregateStatus, type ProgramStatus } from '../../../../shared/status'
import {
  isTerminalNode,
  type Canvas,
  type SourceResource,
  type WindowResource,
} from '../../api/types'

export interface WindowVisualState {
  status: ProgramStatus
  fresh: boolean
}
export interface CanvasIndicator {
  count: number
  status: ProgramStatus | null
}
export const needsAttention = (status?: ProgramStatus) =>
  status === 'attention' || status === 'done'

/** Freshness gates attention animation; a background tab keeps its known status. */
export function windowVisualState(
  source: SourceResource | undefined,
  window: WindowResource | undefined,
  fresh: boolean,
): WindowVisualState {
  const available = !!window && source?.status === 'online' && !source.error
  const current = fresh && available
  const status = available && window.status && window.status !== 'error' ? window.status : 'unknown'
  return { status, fresh: current }
}

const indicator = (states: ProgramStatus[], count = states.length): CanvasIndicator => ({
  count,
  status: states.length ? aggregateStatus(states) : null,
})

/** Summaries are independent of the active canvas, filters and mounted terminals. */
export function canvasIndicators(
  canvases: readonly Canvas[],
  resources: readonly SourceResource[],
): Record<string, CanvasIndicator> {
  const windows = new Map<string, ProgramStatus>()
  for (const source of resources)
    for (const space of source.spaces)
      for (const window of space.windows) {
        windows.set(`${source.id}/${window.id}`, windowVisualState(source, window, true).status)
      }
  const result: Record<string, CanvasIndicator> = { overview: indicator([...windows.values()]) }
  for (const canvas of canvases) {
    const states = canvas.nodes
      .filter(isTerminalNode)
      .map((node) => windows.get(`${node.sourceId}/${node.windowId}`) || 'unknown')
    result[canvas.id] = indicator(states, canvas.nodes.length)
  }
  return result
}

/** An online connection summarizes its windows; otherwise only its failure, or the connecting label, remains. */
export function connectionIndicator(
  source: SourceResource | undefined,
  connecting: string,
): { indicator: CanvasIndicator } | { unavailable: string } {
  if (source?.status !== 'online' || source.error)
    return { unavailable: source?.error || connecting }
  return {
    indicator: indicator(
      source.spaces.flatMap((space) =>
        space.windows.map((window) => windowVisualState(source, window, true).status),
      ),
    ),
  }
}

/** Agents, like canvas cards, report their highest-priority status; nothing is shown without agents. */
export function agentIndicator(
  agents: readonly { status: ProgramStatus }[],
): CanvasIndicator | undefined {
  return agents.length ? indicator(agents.map((agent) => agent.status)) : undefined
}
