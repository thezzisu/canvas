import { canvasAgents, type CanvasAgent } from './canvas-agents'
import type { SourceResource } from './types'

/** A settled (idle or unknown) window stays in the working set this long after it was last read. */
export const WORKING_SET_RECENT_MS = 15 * 60_000

/** Agent panes of every read, available window: most recently read window first, native pane
 * order within it. The list is LRU-ordered, so its tail is trimmed while entries are both
 * settled and not read within the recent window. */
export function workingSet(resources: readonly SourceResource[], reads: Readonly<Record<string, number>>, now = Date.now()): CanvasAgent[] {
  const read = (agent: CanvasAgent) => reads[`${agent.sourceId}/${agent.windowId}`]
  const entries = canvasAgents(undefined, resources).filter(agent => agent.available && read(agent) !== undefined)
    .sort((a, b) => read(b)! - read(a)!)
  const kept = (entry: CanvasAgent) => entry.status !== 'idle' && entry.status !== 'unknown' || now - read(entry)! < WORKING_SET_RECENT_MS
  return entries.slice(0, entries.findLastIndex(kept) + 1)
}
