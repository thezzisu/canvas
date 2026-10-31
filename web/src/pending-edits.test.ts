import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPendingEdits, retargetNoteEdit } from './pending-edits.ts'
import type { Canvas } from './types.ts'

const canvases: Canvas[] = [{ id: 'canvas', name: 'Canvas', nodes: [
  { id: 'note', type: 'note', title: '', content: '', color: 'blue', minimized: false, x: 0, y: 0, width: 300, height: 200 },
] }]
function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}

test('pending notes and layout survive reload and remain bound to their original endpoint', () => {
  const session = storage(), drafts = createPendingEdits(session)
  drafts.save('https://first.example', new Map([['canvas', new Map([['note', { x: 120 }]])]]), [
    { canvasId: 'canvas', id: 'note', patch: { title: 'In-flight', content: 'Earlier' } },
    { canvasId: 'canvas', id: 'note', patch: { content: 'Latest' } },
  ])
  const restored = createPendingEdits(session)
  assert.deepEqual(restored.read('https://other.example', canvases), { layouts: [], notes: [] })
  assert.deepEqual(restored.read('https://first.example', canvases), {
    layouts: [['canvas', [['note', { x: 120 }]]]],
    notes: [{ canvasId: 'canvas', id: 'note', patch: { title: 'In-flight', content: 'Latest' } }],
  })
  restored.save('https://first.example', new Map(), [])
  assert.deepEqual(createPendingEdits(session).read('https://first.example', canvases), { layouts: [], notes: [] })
})

test('missing cards are not recreated or sent to unrelated canvas identities', () => {
  const drafts = createPendingEdits(storage())
  drafts.save('https://first.example', new Map([['gone', new Map([['note', { x: 120 }]])]]), [{ canvasId: 'canvas', id: 'removed', patch: { content: 'Draft' } }])
  assert.deepEqual(drafts.read('https://first.example', canvases), { layouts: [], notes: [] })
})

test('unavailable storage retains drafts in the same page', () => {
  const drafts = createPendingEdits({ getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('blocked') } })
  drafts.save('https://first.example', new Map(), [{ canvasId: 'canvas', id: 'note', patch: { content: 'Draft' } }])
  assert.equal(drafts.read('https://first.example', canvases).notes[0]?.patch.content, 'Draft')
})

test('removed note views retarget shared fields while local minimization stays with its canvas', () => {
  const edit = { canvasId: 'canvas', id: 'note', patch: { content: 'Unsaved shared text', minimized: true } }
  assert.equal(retargetNoteEdit(edit, canvases), edit)
  const survivor = [{ ...canvases[0]!, id: 'survivor' }]
  assert.deepEqual(retargetNoteEdit(edit, survivor), { canvasId: 'survivor', id: 'note', patch: { content: 'Unsaved shared text' } })
  assert.equal(retargetNoteEdit({ ...edit, patch: { minimized: true } }, survivor), undefined)
  assert.equal(retargetNoteEdit(edit, []), undefined, 'the final removed reference is never recreated')
})

test('restored drafts follow a surviving reference without moving layout or losing its own minimized state', () => {
  const session = storage(), drafts = createPendingEdits(session)
  drafts.save('https://first.example', new Map([['canvas', new Map([['note', { width: 700 }]])]]), [
    { canvasId: 'canvas', id: 'note', patch: { title: 'Shared title', content: 'Unsaved', minimized: true } },
    { canvasId: 'survivor', id: 'note', patch: { minimized: false } },
  ])
  assert.deepEqual(createPendingEdits(session).read('https://first.example', [{ ...canvases[0]!, id: 'survivor' }]), {
    layouts: [], notes: [{ canvasId: 'survivor', id: 'note', patch: { title: 'Shared title', content: 'Unsaved', minimized: false } }],
  })
})
