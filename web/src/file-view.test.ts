import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { clearInstanceFileViews, fileMode, fileModeKey, fileReading, fileReadingKey, filePreferenceKeys, pruneFileViews, useFileView } from './file-view.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) }, clear() { values.clear() } }
}
function browser(localStorage: Storage) {
  // VueUse accepts an isolated window; this plain store uses its custom storage event.
  globalThis.Storage ??= class {} as typeof Storage
  return { window: Object.assign(new EventTarget(), { localStorage }) as Window }
}

test('file preference serializers retain only the intended modes and bounded reading positions', () => {
  assert.deepEqual(fileMode(undefined, true), { mode: 'rendered', wrap: false, formatted: false, highlighted: true })
  assert.equal(fileMode(undefined, false).mode, 'source')
  const value = { mode: 'source', wrap: true, source: { x: -1, y: Infinity }, rendered: { x: 12.5, y: 30 },
    text: 'private content', url: 'https://private.example', token: 'DUMMY_TOKEN' }
  assert.deepEqual(fileMode(value, true), { mode: 'source', wrap: true, formatted: false, highlighted: true })
  assert.deepEqual(fileReading(value), { source: { x: 0, y: 0 }, rendered: { x: 12.5, y: 30 } })
  assert.equal(fileMode({ mode: 'rendered' }, false).mode, 'source')
  assert.deepEqual(fileReading({ source: { x: 1e20, y: NaN } }).source, { x: 0, y: 0 })
  assert.equal(fileMode({ highlighted: false }, false).highlighted, false)
})

test('a file shares modes across canvases while source/rendered positions belong to each reference', () => {
  const store = storage(), options = browser(store), scope = effectScope()
  const first = scope.run(() => useFileView('instance', 'first', 'node', true, () => true, options))!
  assert.equal(store.length, 0)
  first.remember({ x: 0, y: 430 }); first.rendered.value = false; first.wrap.value = true
  first.formatted.value = true; first.highlighted.value = false; first.remember({ x: 80, y: 920 })
  const second = scope.run(() => useFileView('instance', 'second', 'node', true, () => true, options))!
  assert.equal(second.rendered.value, false); assert.equal(second.wrap.value, true)
  assert.equal(second.formatted.value, true); assert.equal(second.highlighted.value, false)
  assert.deepEqual(second.reading.value, { x: 0, y: 0 })
  second.remember({ x: 12, y: 270 }); second.rendered.value = true; second.remember({ x: 0, y: 500 })
  assert.equal(first.rendered.value, false, 'an already mounted reader is not moved by a peer')
  assert.deepEqual(first.reading.value, { x: 80, y: 920 })
  const restored = scope.run(() => useFileView('instance', 'first', 'node', true, () => true, options))!
  assert.equal(restored.rendered.value, true); assert.deepEqual(restored.reading.value, { x: 0, y: 430 })
  restored.rendered.value = false; assert.deepEqual(restored.reading.value, { x: 80, y: 920 })
  assert.equal(store.length, 3, 'one object mode plus two canvas reading records')
  scope.stop()
})

test('reactive keys switch reading references and objects without leaking previous writes', () => {
  const store = storage(), options = browser(store), scope = effectScope()
  const instance = ref('a'), canvas = ref('first'), node = ref('one'), renderable = ref(true)
  const view = scope.run(() => useFileView(instance, canvas, node, renderable, () => true, options))!
  view.wrap.value = true; view.remember({ x: 10, y: 800 })
  canvas.value = 'second'
  assert.equal(view.wrap.value, true); assert.deepEqual(view.reading.value, { x: 0, y: 0 })
  view.remember({ x: 20, y: 400 }); node.value = 'two'
  assert.equal(view.wrap.value, false); assert.equal(view.rendered.value, true); assert.deepEqual(view.reading.value, { x: 0, y: 0 })
  assert.equal(store.getItem(fileModeKey('a', 'two')), null)
  node.value = 'one'; canvas.value = 'first'
  assert.equal(view.wrap.value, true); assert.deepEqual(view.reading.value, { x: 10, y: 800 })
  const before = [...Array(store.length)].map((_, i) => [store.key(i), store.getItem(store.key(i)!)])
  renderable.value = false; assert.equal(view.rendered.value, false)
  renderable.value = true; assert.equal(view.rendered.value, true)
  assert.deepEqual([...Array(store.length)].map((_, i) => [store.key(i), store.getItem(store.key(i)!)]), before, 'capability/default changes never write')
  instance.value = 'b'; assert.equal(view.wrap.value, false); assert.deepEqual(view.reading.value, { x: 0, y: 0 })
  scope.stop()
})

test('default modes and zero reading positions remove their own record only', () => {
  const store = storage(), scope = effectScope(), options = browser(store)
  const view = scope.run(() => useFileView('a', 'canvas', 'node', true, () => true, options))!
  view.wrap.value = true; view.highlighted.value = false; view.remember({ x: 10, y: 20 })
  assert.equal(store.length, 2)
  view.wrap.value = false; view.highlighted.value = true
  assert.equal(store.getItem(fileModeKey('a', 'node')), null)
  assert.notEqual(store.getItem(fileReadingKey('a', 'canvas', 'node')), null)
  view.remember({ x: 0, y: 0 }); assert.equal(store.length, 0)
  scope.stop()
})

test('a removed reference cannot resurrect modes or positions during child unmount', () => {
  const store = storage(), scope = effectScope(); let current = true
  const view = scope.run(() => useFileView('a', 'canvas', 'node', true, () => current, browser(store)))!
  view.wrap.value = true; view.remember({ x: 0, y: 400 })
  current = false; pruneFileViews('a', [], store)
  view.remember({ x: 0, y: 500 }); view.wrap.value = false; view.rendered.value = false
  assert.equal(store.length, 0)
  scope.stop(); assert.equal(store.length, 0)
})

test('pruning one reference preserves object modes and other references; Undo retains both removed keys', () => {
  const store = storage(), scope = effectScope(), options = browser(store)
  const first = scope.run(() => useFileView('a', 'first', 'node', true, () => true, options))!
  first.rendered.value = false; first.wrap.value = true; first.remember({ x: 23, y: 740 })
  const second = scope.run(() => useFileView('a', 'second', 'node', true, () => true, options))!
  second.remember({ x: 0, y: 330 }); scope.stop()
  const remaining = [{ id: 'second', nodes: [{ id: 'node', type: 'file' }] }]
  pruneFileViews('a', remaining, store, new Set(filePreferenceKeys('a', 'first', 'node')))
  assert.equal(store.length, 3)
  pruneFileViews('a', remaining, store)
  assert.equal(store.length, 2); assert.equal(store.getItem(fileReadingKey('a', 'first', 'node')), null)
  const restored = effectScope(), reader = restored.run(() => useFileView('a', 'second', 'node', true, () => true, options))!
  assert.equal(reader.rendered.value, false); assert.equal(reader.wrap.value, true); assert.deepEqual(reader.reading.value, { x: 0, y: 330 })
  restored.stop(); pruneFileViews('a', [], store); assert.equal(store.length, 0)
})

test('pruning respects instance and object identity without touching camera or other local state', () => {
  const store = storage()
  for (const [instance, canvas, node] of [['a', 'canvas', 'keep'], ['a', 'canvas', 'deleted'], ['a', 'removed', 'node'], ['b', 'canvas', 'node']])
    for (const key of filePreferenceKeys(instance!, canvas!, node!)) store.setItem(key, '{}')
  store.setItem('canvas:view:a:canvas', 'camera')
  pruneFileViews('a', [{ id: 'canvas', nodes: [{ id: 'keep', type: 'file' }, { id: 'deleted', type: 'note' }] }], store)
  assert.equal(store.length, 5)
  for (const key of [...filePreferenceKeys('a', 'canvas', 'keep'), ...filePreferenceKeys('b', 'canvas', 'node')]) assert.notEqual(store.getItem(key), null)
  clearInstanceFileViews('a', store); assert.equal(store.length, 3); assert.equal(store.getItem('canvas:view:a:canvas'), 'camera')
})

test('invalid or unavailable storage does not break reading; reading records never retain content', () => {
  const store = storage(), scope = effectScope()
  store.setItem(fileModeKey('a', 'node'), '{invalid')
  store.setItem(fileReadingKey('a', 'canvas', 'node'), JSON.stringify({ source: { x: 20, y: 55 }, rendered: { x: 2, y: 10 }, content: 'private' }))
  const view = scope.run(() => useFileView('a', 'canvas', 'node', true, () => true, browser(store)))!
  assert.equal(view.rendered.value, true); assert.deepEqual(view.reading.value, { x: 2, y: 10 })
  view.wrap.value = true; view.remember({ x: 0, y: 25 })
  assert.deepEqual(JSON.parse(store.getItem(fileReadingKey('a', 'canvas', 'node'))!), { source: { x: 20, y: 55 }, rendered: { x: 0, y: 25 } })
  const blocked = { ...storage(), getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }
  const local = scope.run(() => useFileView('a', 'canvas', 'node', true, () => true, browser(blocked)))!
  local.wrap.value = true; assert.equal(local.wrap.value, true)
  assert.doesNotThrow(() => clearInstanceFileViews('a', blocked)); scope.stop()
})
