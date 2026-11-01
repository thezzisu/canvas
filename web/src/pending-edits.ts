import type { Canvas, NotePatch } from './types'
import type { LayoutPatch } from './layout-saves'

export interface NoteEdit { canvasId: string; id: string; patch: NotePatch }
export interface PendingEdits { layouts: [string, [string, LayoutPatch][]][]; notes: NoteEdit[] }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Shared content survives removal of an individual canvas reference. */
export function retargetNoteEdit(edit: NoteEdit, canvases: Canvas[]): NoteEdit | undefined {
  const contains = (canvas: Canvas) => canvas.nodes.some(node => node.id === edit.id && node.type === 'note')
  if (canvases.some(canvas => canvas.id === edit.canvasId && contains(canvas))) return edit
  const target = canvases.find(contains)
  return target && Object.keys(edit.patch).length ? { ...edit, canvasId: target.id } : undefined
}

/** Drafts belong to the endpoint, even if another tab changes its local entry. */
export function createPendingEdits(storage?: Storage) {
  const memory = new Map<string, string>()
  const key = (base: string) => `canvas:pending-edits:${encodeURIComponent(base)}`
  function save(base: string, layouts: Map<string, Map<string, LayoutPatch>>, notes: Iterable<NoteEdit>) {
    if (!base) return
    const merged = new Map<string, NoteEdit>()
    for (const note of notes) {
      const id = JSON.stringify([note.canvasId, note.id])
      merged.set(id, { ...note, patch: { ...merged.get(id)?.patch, ...note.patch } })
    }
    const value: PendingEdits = { layouts: [...layouts].filter(([, nodes]) => nodes.size).map(([id, nodes]) => [id, [...nodes]]), notes: [...merged.values()] }
    const serialized = value.layouts.length || value.notes.length ? JSON.stringify(value) : ''
    if (serialized) memory.set(base, serialized); else memory.delete(base)
    try { if (serialized) storage?.setItem(key(base), serialized); else storage?.removeItem(key(base)) } catch { /* Keep the current-page copy if session storage is unavailable. */ }
  }
  function read(base: string, canvases: Canvas[]): PendingEdits {
    const empty: PendingEdits = { layouts: [], notes: [] }
    try {
      const raw = memory.get(base) ?? storage?.getItem(key(base))
      if (!raw) return empty
      const value: PendingEdits = JSON.parse(raw)
      for (const [canvasId, entries] of value.layouts || []) {
        const canvas = canvases.find(canvas => canvas.id === canvasId)
        if (!canvas) continue
        const nodes: [string, LayoutPatch][] = []
        for (const [id, entry] of entries) {
          if (!canvas.nodes.some(node => node.id === id)) continue
          const patch = Object.fromEntries(['x', 'y', 'width', 'height'].flatMap(key => {
            const number = entry[key as keyof LayoutPatch]
            return typeof number === 'number' && Number.isFinite(number) ? [[key, number]] : []
          }))
          if (Object.keys(patch).length) nodes.push([id, patch])
        }
        if (nodes.length) empty.layouts.push([canvasId, nodes])
      }
      const notes = new Map<string, NoteEdit>()
      for (const edit of value.notes || []) {
        const patch: NotePatch = {}
        if (typeof edit.patch.title === 'string') patch.title = edit.patch.title
        if (typeof edit.patch.content === 'string') patch.content = edit.patch.content
        if (['yellow', 'blue', 'green', 'pink', 'neutral'].includes(edit.patch.color || '')) patch.color = edit.patch.color
        const target = Object.keys(patch).length && retargetNoteEdit({ canvasId: edit.canvasId, id: edit.id, patch }, canvases)
        if (target) {
          const id = JSON.stringify([target.canvasId, target.id])
          notes.set(id, { ...target, patch: { ...notes.get(id)?.patch, ...target.patch } })
        }
      }
      empty.notes = [...notes.values()]
      return empty
    } catch { return { layouts: [], notes: [] } }
  }
  return { save, read }
}
