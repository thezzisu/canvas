import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayoutSaves, type LayoutPatch } from './layout-saves.ts'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('serializes a canvas and drains edits made while its first save is pending', async () => {
  const saves = createLayoutSaves(),
    first = gate(),
    second = gate()
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
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(
    [...batches[1]!],
    [
      ['card', { x: 30, y: 20 }],
      ['other', { width: 400 }],
    ],
  )
  assert.equal(saves.pending.get('canvas')?.get('card')?.x, 30)
  second.resolve()
  await result
  assert.equal(saves.pending.size, 0)
  assert.equal(saves.saving, false)
})

test('failure retains the latest patch for a deliberate retry', async () => {
  const saves = createLayoutSaves(),
    held = gate()
  saves.set('canvas', 'card', { width: 400 })
  const result = saves.flush('canvas', async () => {
    await held.promise
    throw new Error('offline')
  })
  saves.set('canvas', 'card', { height: 300 })
  held.resolve()
  await assert.rejects(result, /offline/)
  assert.deepEqual(saves.pending.get('canvas')?.get('card'), { width: 400, height: 300 })
  await saves.flush('canvas', async (batch) => {
    assert.deepEqual(batch.get('card'), { width: 400, height: 300 })
  })
  assert.equal(saves.pending.size, 0)
})

test('an old instance acknowledgement cannot erase or write new instance drafts', async () => {
  const saves = createLayoutSaves(),
    held = gate()
  let oldWrites = 0,
    oldAcknowledgements = 0
  saves.set('same-canvas', 'same-card', { x: 10 })
  const old = saves.flush(
    'same-canvas',
    async () => {
      oldWrites++
      await held.promise
    },
    () => {
      oldAcknowledgements++
    },
  )
  saves.reset()
  saves.set('same-canvas', 'same-card', { x: 99 })
  held.resolve()
  await old
  assert.equal(oldWrites, 1)
  assert.equal(oldAcknowledgements, 0)
  assert.equal(saves.pending.get('same-canvas')?.get('same-card')?.x, 99)
  await saves.flush('same-canvas', async (batch) => {
    assert.equal(batch.get('same-card')?.x, 99)
  })
  assert.equal(saves.pending.size, 0)
})

test('different canvases can save independently', async () => {
  const saves = createLayoutSaves(),
    held = gate()
  saves.set('a', 'card', { x: 1 })
  saves.set('b', 'card', { x: 2 })
  const first = saves.flush('a', async () => held.promise)
  await saves.flush('b', async () => {})
  assert.equal(saves.pending.has('b'), false)
  assert.equal(saves.pending.has('a'), true)
  held.resolve()
  await first
})

test('removing the last pending card leaves no empty canvas to block a drain', async () => {
  const saves = createLayoutSaves()
  saves.set('canvas', 'card', { x: 1 })
  saves.pending.get('canvas')?.delete('card')
  await saves.flush('canvas', async () => {
    assert.fail('no empty batch should be written')
  })
  assert.equal(saves.pending.size, 0)
})

test('a keepalive flush copies every pending patch at once while the running save still confirms them', async () => {
  const saves = createLayoutSaves(),
    first = gate(),
    second = gate()
  const batches: ReadonlyMap<string, LayoutPatch>[] = [],
    copies: ReadonlyMap<string, LayoutPatch>[] = []
  const write = async (batch: ReadonlyMap<string, LayoutPatch>) => {
    batches.push(batch)
    await (batches.length === 1 ? first : second).promise
  }
  saves.set('canvas', 'card', { x: 10 })
  const result = saves.flush('canvas', write)
  saves.set('canvas', 'card', { y: 20 })
  saves.set('canvas', 'other', { width: 400 })
  const keepalive = saves.flush(
    'canvas',
    async (batch) => {
      copies.push(batch)
      throw new Error('page closed')
    },
    undefined,
    true,
  )
  assert.equal(keepalive, result, 'the copy does not replace the running save')
  assert.deepEqual(
    copies.map((batch) => [...batch]),
    [
      [
        ['card', { x: 10, y: 20 }],
        ['other', { width: 400 }],
      ],
    ],
  )
  assert.equal(batches.length, 1)
  first.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(
    [...batches[1]!],
    [
      ['card', { x: 10, y: 20 }],
      ['other', { width: 400 }],
    ],
  )
  second.resolve()
  await result
  assert.equal(saves.pending.size, 0)
  assert.equal(saves.saving, false)
})

test('a page hidden again while a save runs copies only what no keepalive request holds', async () => {
  const saves = createLayoutSaves(),
    held = gate()
  const copies: ReadonlyMap<string, LayoutPatch>[] = []
  let offline = false
  const copy = async (batch: ReadonlyMap<string, LayoutPatch>) => {
    copies.push(batch)
    if (offline) throw new Error('offline')
  }
  const hide = () => saves.flush('canvas', copy, undefined, true)
  saves.set('canvas', 'card', { x: 10 })
  const result = saves.flush('canvas', async () => held.promise)
  void hide()
  void hide()
  assert.equal(
    copies.length,
    1,
    'the ordinary save may be cancelled, so one copy outlives the page',
  )
  saves.set('canvas', 'card', { x: 20 })
  offline = true
  void hide()
  assert.equal(copies.length, 2, 'a newer patch needs its own copy')
  await Promise.resolve()
  await Promise.resolve()
  void hide()
  assert.equal(copies.length, 3, 'a copy that failed is sent again')
  held.resolve()
  await result.catch(() => {})
})

test('a save sent as a keepalive request needs no copy of the same patches', async () => {
  const saves = createLayoutSaves(),
    held = gate()
  let writes = 0
  const write = async () => {
    writes++
    await held.promise
  }
  saves.set('canvas', 'card', { x: 10 })
  const result = saves.flush('canvas', write, undefined, true)
  void saves.flush('canvas', write, undefined, true)
  assert.equal(writes, 1)
  saves.set('canvas', 'card', { x: 20 })
  void saves.flush('canvas', write, undefined, true)
  assert.equal(writes, 2)
  held.resolve()
  await result
})

test('a patch restored after a newer batch went out is copied again', async () => {
  const saves = createLayoutSaves(),
    first = gate(),
    second = gate()
  let batches = 0,
    copies = 0
  const write = async () => {
    await (++batches === 1 ? first : second).promise
  }
  const hide = () =>
    saves.flush(
      'canvas',
      async () => {
        copies++
      },
      undefined,
      true,
    )
  saves.set('canvas', 'card', { x: 10 })
  const result = saves.flush('canvas', write)
  saves.set('canvas', 'card', { x: 20 })
  void hide()
  saves.set('canvas', 'card', { x: 30 })
  first.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(batches, 2, 'the newer patch is in flight as an ordinary save')
  saves.set('canvas', 'card', { x: 20 })
  void hide()
  assert.equal(copies, 2)
  second.resolve()
  await result
})
