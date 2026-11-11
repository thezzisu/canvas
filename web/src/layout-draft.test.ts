import test from 'node:test'
import assert from 'node:assert/strict'
import { LayoutDraft } from './layout-draft.ts'

test('layout drafts contain only changed geometry with original field expectations', () => {
  const draft = new LayoutDraft('canvas', [{ id: 'a', x: 1, y: 2, width: 300, height: 200 }])
  draft.update('a', { x: 20 })
  draft.update('a', { width: 400 })
  assert.deepEqual(
    [...draft.changes.values()],
    [{ id: 'a', x: 20, width: 400, expected: { x: 1, width: 300 } }],
  )
  draft.update('a', { x: 1 })
  assert.deepEqual(draft.geometry('a'), { width: 400 })
  draft.update('a', { width: 300 })
  draft.update('missing', { x: 10 })
  assert.equal(draft.changes.size, 0)
  assert.deepEqual(draft.baseline.get('a'), { x: 1, y: 2, width: 300, height: 200 })
})

test('a peer-added card captures geometry once without replacing existing expectations', () => {
  const draft = new LayoutDraft('canvas', [{ id: 'a', x: 1, y: 2, width: 300, height: 200 }])
  draft.capture('a', { x: 9, y: 8, width: 600, height: 400 })
  draft.capture('new', { x: 30, y: 40, width: 400, height: 300 })
  draft.update('a', { x: 7 })
  draft.update('new', { width: 500 })
  assert.equal(draft.changes.get('a')?.expected?.x, 1)
  assert.equal(draft.changes.get('new')?.expected?.width, 400)
})
