import test from 'node:test'
import assert from 'node:assert/strict'
import { orderedItems } from './sidebar-order.ts'

const ids = (items: { id: string }[]) => items.map(item => item.id)
const items = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'c', value: 3 }]

test('projecting shared order leaves source records intact and retains their identities', () => {
  const ordered = orderedItems(items, ['c', 'a', 'b'])
  assert.deepEqual(ids(ordered), ['c', 'a', 'b'])
  assert.deepEqual(ids(items), ['a', 'b', 'c'])
  assert.equal(ordered[0], items[2])
})

test('deleted, duplicate and invalid preferences do not hide new connections or canvases', () => {
  assert.deepEqual(ids(orderedItems(items, ['deleted', 'c', 'c', null, 5, 'b'])), ['c', 'b', 'a'])
  assert.deepEqual(ids(orderedItems([...items, { id: 'new', value: 4 }], ['b', 'a', 'c'])), ['b', 'a', 'c', 'new'])
  for (const invalid of [undefined, null, 'a', {}, 123]) assert.deepEqual(ids(orderedItems(items, invalid)), ['a', 'b', 'c'])
})

test('a drag reconciles stable IDs rather than stale indices after a concurrent list change', () => {
  const changed = [{ id: 'b' }, { id: 'c' }, { id: 'new' }]
  assert.deepEqual(ids(orderedItems(changed, ['c', 'a', 'b'])), ['c', 'b', 'new'])
})

test('shared-order saves coalesce per category and do not lose another category', async () => {
  const { effectScope, ref, nextTick } = await import('vue')
  const { useSidebarOrder } = await import('./sidebar-order.ts')
  const scope = effectScope(), instance = ref('a'), shared = ref({ canvases: ['a', 'b', 'c'], sources: ['x', 'y'] })
  const calls: Array<{ kind: 'canvases' | 'sources'; ids: string[]; resolve(): void }> = []
  const failures: unknown[] = []
  const manager = scope.run(() => useSidebarOrder(shared, instance, (kind, ids) => new Promise<void>(resolve => {
    calls.push({ kind, ids, resolve: () => { shared.value = { ...shared.value, [kind]: ids }; resolve() } })
  }), error => failures.push(error)))!
  manager.remember('canvases', ['b', 'a', 'c'])
  manager.remember('canvases', ['c', 'b', 'a'])
  manager.remember('sources', ['y', 'x'])
  assert.equal(calls.length, 2)
  assert.deepEqual(manager.order.value, { canvases: ['c', 'b', 'a'], sources: ['y', 'x'] })
  calls[0]!.resolve(); await new Promise(resolve => setImmediate(resolve)); await nextTick()
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2]!.ids, ['c', 'b', 'a'])
  calls[1]!.resolve(); calls[2]!.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(manager.order.value, shared.value)
  assert.deepEqual(failures, [])
  scope.stop()
})

test('instance change and failed saves release optimistic order without stale writes', async () => {
  const { effectScope, ref } = await import('vue')
  const { useSidebarOrder } = await import('./sidebar-order.ts')
  const scope = effectScope(), instance = ref('a'), shared = ref({ canvases: ['a', 'b'], sources: [] as string[] })
  const waits: Array<ReturnType<typeof Promise.withResolvers<void>>> = [], errors: unknown[] = []
  const manager = scope.run(() => useSidebarOrder(shared, instance, () => {
    const wait = Promise.withResolvers<void>(); waits.push(wait); return wait.promise
  }, error => errors.push(error)))!
  manager.remember('canvases', ['b', 'a'])
  manager.remember('canvases', ['a', 'b'])
  instance.value = 'b'; shared.value = { canvases: ['other'], sources: [] }
  waits[0]!.reject(new Error('old instance failure')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(waits.length, 1, 'old queued write never reaches the new instance')
  assert.deepEqual(manager.order.value, shared.value); assert.deepEqual(errors, [])
  manager.remember('canvases', ['new'])
  waits[1]!.reject(new Error('offline')); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(manager.order.value, shared.value); assert.equal(errors.length, 1)
  scope.stop()
})
