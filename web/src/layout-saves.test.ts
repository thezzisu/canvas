import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayoutSaves, type LayoutPatch } from './layout-saves.ts'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('serializes a canvas and drains edits made while its first save is pending', async () => {
  const saves = createLayoutSaves(), first = gate(), second = gate()
  const batches: ReadonlyMap<string, LayoutPatch>[] = []
  const write = async (batch: ReadonlyMap<string, LayoutPatch>) => {
    batches.push(batch)
    await (batches.length === 1 ? first : second).promise
  }
  saves.set('canvas', 'card', { x: 10, y: 20 })
  const result = saves.flush('canvas', write)
  saves.set('canvas', 'card', { x: 30 })
  saves.set('canvas', 'other', { width: 400 })
  assert.equal(saves.flush('canvas', write), result)
  assert.equal(batches.length, 1)
  assert.equal(saves.saving, true)
  first.resolve()
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual([...batches[1]!], [['card', { x: 30, y: 20 }], ['other', { width: 400 }]])
  assert.equal(saves.pending.get('canvas')?.get('card')?.x, 30)
  second.resolve(); await result
  assert.equal(saves.pending.size, 0)
  assert.equal(saves.saving, false)
})

test('failure retains the latest patch for a deliberate retry', async () => {
  const saves = createLayoutSaves(), held = gate()
  saves.set('canvas', 'card', { width: 400 })
  const result = saves.flush('canvas', async () => { await held.promise; throw new Error('offline') })
  saves.set('canvas', 'card', { height: 300 })
  held.resolve()
  await assert.rejects(result, /offline/)
  assert.deepEqual(saves.pending.get('canvas')?.get('card'), { width: 400, height: 300 })
  await saves.flush('canvas', async batch => { assert.deepEqual(batch.get('card'), { width: 400, height: 300 }) })
  assert.equal(saves.pending.size, 0)
})

test('an old instance acknowledgement cannot erase or write new instance drafts', async () => {
  const saves = createLayoutSaves(), held = gate()
  let oldWrites = 0, oldAcknowledgements = 0
  saves.set('same-canvas', 'same-card', { x: 10 })
  const old = saves.flush('same-canvas', async () => { oldWrites++; await held.promise }, () => { oldAcknowledgements++ })
  saves.reset()
  saves.set('same-canvas', 'same-card', { x: 99 })
  held.resolve(); await old
  assert.equal(oldWrites, 1)
  assert.equal(oldAcknowledgements, 0)
  assert.equal(saves.pending.get('same-canvas')?.get('same-card')?.x, 99)
  await saves.flush('same-canvas', async batch => { assert.equal(batch.get('same-card')?.x, 99) })
  assert.equal(saves.pending.size, 0)
})

test('different canvases can save independently', async () => {
  const saves = createLayoutSaves(), held = gate()
  saves.set('a', 'card', { x: 1 }); saves.set('b', 'card', { x: 2 })
  const first = saves.flush('a', async () => held.promise)
  await saves.flush('b', async () => {})
  assert.equal(saves.pending.has('b'), false)
  assert.equal(saves.pending.has('a'), true)
  held.resolve(); await first
})

test('removing the last pending card leaves no empty canvas to block a drain', async () => {
  const saves = createLayoutSaves()
  saves.set('canvas', 'card', { x: 1 })
  saves.pending.get('canvas')?.delete('card')
  await saves.flush('canvas', async () => { assert.fail('no empty batch should be written') })
  assert.equal(saves.pending.size, 0)
})
