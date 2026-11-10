import { canvasAgents, type CanvasAgent } from './canvas-agents'
import type { SourceResource } from './types'

/** Agent panes of every read, available window: most recently read window first,
 * native pane order within it, without the settled tail after the last active pane. */
export function workingSet(resources: readonly SourceResource[], reads: Readonly<Record<string, number>>): CanvasAgent[] {
  const read = (agent: CanvasAgent) => reads[`${agent.sourceId}/${agent.windowId}`]
  const entries = canvasAgents(undefined, resources).filter(agent => agent.available && read(agent) !== undefined)
    .sort((a, b) => read(b)! - read(a)!)
  return entries.slice(0, entries.findLastIndex(entry => entry.status !== 'idle' && entry.status !== 'unknown') + 1)
}
