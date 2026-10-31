import type { CanvasNode } from './types'

export type LayoutPatch = Partial<Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>>

/** One writer per canvas; pending includes the batch until its acknowledgement. */
export function createLayoutSaves() {
  const pending = new Map<string, Map<string, LayoutPatch>>()
  const running = new Map<string, Promise<void>>()
  let generation = 0

  function set(canvasId: string, id: string, patch: LayoutPatch) {
    const nodes = pending.get(canvasId) || new Map<string, LayoutPatch>()
    nodes.set(id, { ...nodes.get(id), ...patch })
    pending.set(canvasId, nodes)
  }

  function flush(canvasId: string, write: (batch: ReadonlyMap<string, LayoutPatch>) => Promise<void>, acknowledged?: () => void): Promise<void> {
    const existing = running.get(canvasId)
    if (existing) return existing
    const revision = generation
    const task = (async () => {
      while (generation === revision) {
        const nodes = pending.get(canvasId)
        if (!nodes?.size) { pending.delete(canvasId); return }
        const batch = new Map(nodes)
        await write(batch)
        if (generation !== revision) return
        if (pending.get(canvasId) === nodes) {
          for (const [id, patch] of batch) if (nodes.get(id) === patch) nodes.delete(id)
          if (!nodes.size) pending.delete(canvasId)
        }
        acknowledged?.()
      }
    })().finally(() => { if (running.get(canvasId) === task) running.delete(canvasId) })
    running.set(canvasId, task)
    return task
  }

  return {
    pending, set, flush,
    get saving() { return running.size > 0 },
    reset() { generation++; pending.clear(); running.clear() },
  }
}
