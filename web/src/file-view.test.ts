import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { clearInstanceFileViews, fileView, fileViewKey, pruneFileViews, useFileView } from './file-view.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) }, clear() { values.clear() } }
}

test('file view defaults and stored values contain only mode, wrap and bounded numeric positions', () => {
  assert.deepEqual(fileView(undefined, true), { mode: 'rendered', wrap: false, source: { x: 0, y: 0 }, rendered: { x: 0, y: 0 } })
  assert.equal(fileView(undefined, false).mode, 'source')
  const clean = fileView({ mode: 'source', wrap: true, source: { x: -1, y: Infinity }, rendered: { x: 12.5, y: 30 },
    text: 'private content', url: 'https://private.example', token: 'DUMMY_TOKEN' }, true)
  assert.deepEqual(clean, { mode: 'source', wrap: true, source: { x: 0, y: 0 }, rendered: { x: 12.5, y: 30 } })
  assert.equal(fileView({ mode: 'rendered' }, false).mode, 'source')
  assert.deepEqual(fileView({ source: { x: 1e20, y: NaN } }, true).source, { x: 0, y: 0 })
})

test('card and fullscreen mounts restore separate source/rendered reading positions without rewriting defaults', () => {
  const store = storage(), scope = effectScope()
  const view = scope.run(() => useFileView('instance', 'canvas', 'node', true, () => true, store))!
  assert.equal(store.length, 0)
  view.remember({ x: 0, y: 430 })
  view.rendered.value = false
  view.wrap.value = true
  view.remember({ x: 80, y: 920 })
  view.rendered.value = true
  assert.deepEqual(view.reading.value, { x: 0, y: 430 })
  view.rendered.value = false
  scope.stop()
  const reopened = effectScope(), restored = reopened.run(() => useFileView('instance', 'canvas', 'node', true, () => true, store))!
  assert.equal(restored.rendered.value, false); assert.equal(restored.wrap.value, true)
  assert.deepEqual(restored.reading.value, { x: 80, y: 920 })
  restored.rendered.value = true
  assert.deepEqual(restored.reading.value, { x: 0, y: 430 })
  reopened.stop()
})

test('instance, canvas and node scopes are independent and mounted readers do not follow another view', () => {
  const store = storage(), scope = effectScope()
  const values = scope.run(() => ({
    first: useFileView('a', 'canvas', 'node', true, () => true, store),
    peer: useFileView('a', 'canvas', 'node', true, () => true, store),
    instance: useFileView('b', 'canvas', 'node', true, () => true, store),
    canvas: useFileView('a', 'other', 'node', true, () => true, store),
    node: useFileView('a', 'canvas', 'other', true, () => true, store),
  }))!
  values.first.rendered.value = false; values.first.wrap.value = true; values.first.remember({ x: 40, y: 800 })
  for (const view of [values.peer, values.instance, values.canvas, values.node]) {
    assert.equal(view.rendered.value, true); assert.equal(view.wrap.value, false)
    assert.deepEqual(view.reading.value, { x: 0, y: 0 })
  }
  assert.equal(store.length, 1)
  scope.stop()
})

test('deleted nodes and changed instance addresses cannot resurrect preferences before child unmount', () => {
  const store = storage(), scope = effectScope()
  let current = true
  const view = scope.run(() => useFileView('a', 'canvas', 'node', true, () => current, store))!
  view.remember({ x: 0, y: 400 })
  current = false
  pruneFileViews('a', [], store)
  view.remember({ x: 0, y: 0 }); view.wrap.value = true; view.rendered.value = false
  assert.equal(store.length, 0)
  scope.stop()
  assert.equal(store.length, 0)
})

test('authoritative pruning removes only missing file cards in the owning instance', () => {
  const store = storage()
  for (const [instance, canvas, node] of [['a', 'canvas', 'keep'], ['a', 'canvas', 'deleted'], ['a', 'removed', 'node'], ['b', 'canvas', 'node']])
    store.setItem(fileViewKey(instance!, canvas!, node!), '{}')
  store.setItem('canvas:view:a:canvas', 'camera')
  pruneFileViews('a', [{ id: 'canvas', nodes: [{ id: 'keep', type: 'file' }, { id: 'deleted', type: 'note' }] }], store)
  assert.equal(store.length, 3)
  assert.notEqual(store.getItem(fileViewKey('a', 'canvas', 'keep')), null)
  assert.notEqual(store.getItem(fileViewKey('b', 'canvas', 'node')), null)
  assert.equal(store.getItem('canvas:view:a:canvas'), 'camera')
  clearInstanceFileViews('a', store)
  assert.equal(store.length, 2)
})

test('invalid and unavailable browser storage leave file reading usable', () => {
  const store = storage(), scope = effectScope()
  store.setItem(fileViewKey('a', 'canvas', 'node'), '{invalid')
  const view = scope.run(() => useFileView('a', 'canvas', 'node', true, () => true, store))!
  assert.equal(view.rendered.value, true)
  view.wrap.value = true
  assert.equal(JSON.parse(store.getItem(fileViewKey('a', 'canvas', 'node'))!).wrap, true)
  const blocked = { ...storage(), getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }
  const local = scope.run(() => useFileView('a', 'canvas', 'node', true, () => true, blocked))!
  local.wrap.value = true
  assert.equal(local.wrap.value, true)
  assert.doesNotThrow(() => clearInstanceFileViews('a', blocked))
  scope.stop()
})
