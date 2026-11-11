import { layoutFields, type LayoutGeometry, type LayoutUpdate } from '../../../shared/layout'

/** Only geometry is staged. Content and unrelated peer changes never enter a draft. */
export class LayoutDraft {
  readonly baseline: Map<string, LayoutGeometry>
  readonly changes = new Map<string, LayoutUpdate>()
  constructor(
    readonly canvasId: string,
    nodes: Array<{ id: string } & LayoutGeometry>,
  ) {
    this.baseline = new Map(
      nodes.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]),
    )
  }
  capture(id: string, geometry: LayoutGeometry) {
    if (!this.baseline.has(id)) this.baseline.set(id, { ...geometry })
  }
  update(id: string, value: Partial<LayoutGeometry>) {
    const before = this.baseline.get(id)
    if (!before) return
    const patch = { ...this.changes.get(id), ...value },
      next: LayoutUpdate = { id, expected: {} }
    for (const field of layoutFields)
      if (patch[field] !== undefined && patch[field] !== before[field]) {
        next[field] = patch[field]
        next.expected![field] = before[field]
      }
    if (Object.keys(next.expected!).length) this.changes.set(id, next)
    else this.changes.delete(id)
  }
  geometry(id: string) {
    const { expected: _, id: __, ...patch } = this.changes.get(id) || { id }
    return patch
  }
}
