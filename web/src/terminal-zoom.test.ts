import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { normalizeTerminalZoom, pruneTerminalZooms, terminalZoomKey, terminalZoomStorageKey, useTerminalZoom } from './terminal-zoom.ts'
import type { Source, SourceResource } from './types.ts'

const source: Source = { id: 'connection', name: 'Connection', transport: 'ssh', target: 'host', herdrSession: 'main' }
const resources = (ids: string[], status = 'online', error?: string): SourceResource[] => [{
  id: source.id, name: source.name, status, error, spaces: [{ id: 'space', name: 'Space', windows: ids.map(id => ({ id, name: 'Same name' })) }],
}]
function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear() }
}

test('concurrent views of different native tabs update isolated scalar keys and survive reopening', () => {
  const store = storage(), scope = effectScope(), firstKey = terminalZoomKey('backend', source, 'tab1'), secondKey = terminalZoomKey('backend', source, 'tab2')
  const { first, second } = scope.run(() => ({ first: useTerminalZoom(() => firstKey, store), second: useTerminalZoom(() => secondKey, store) }))!
  first.value = 140; second.value = 80; first.value = 150
  assert.equal(store.getItem(terminalZoomStorageKey(firstKey)), '150')
  assert.equal(store.getItem(terminalZoomStorageKey(secondKey)), '80')
  const reopened = scope.run(() => useTerminalZoom(() => secondKey, store))!
  assert.equal(reopened.value, 80)
  assert.equal(terminalZoomKey('backend', { ...source, name: 'Renamed' }, 'tab1'), firstKey)
  for (const key of [terminalZoomKey('other-backend', source, 'tab1'), terminalZoomKey('backend', { ...source, id: 'other' }, 'tab1'),
    terminalZoomKey('backend', source, 'new-tab'), terminalZoomKey('backend', { ...source, target: 'other-host' }, 'tab1')])
    assert.equal(scope.run(() => useTerminalZoom(() => key, store))!.value, 100)
  first.value = 100
  assert.equal(store.getItem(terminalZoomStorageKey(firstKey)), null)
  assert.equal(store.getItem(terminalZoomStorageKey(secondKey)), '80')
  scope.stop()
})

test('changing connection identity retires the previous binding without writing its value into the new key', () => {
  const store = storage(), scope = effectScope(), first = terminalZoomKey('backend', source, 'tab1'), second = terminalZoomKey('backend', { ...source, target: 'other' }, 'tab1')
  const key = ref(first), zoom = scope.run(() => useTerminalZoom(() => key.value, store))!
  zoom.value = 140; key.value = second
  assert.equal(zoom.value, 100); assert.equal(store.getItem(terminalZoomStorageKey(second)), null)
  zoom.value = 80
  assert.equal(store.getItem(terminalZoomStorageKey(first)), '140')
  assert.equal(store.getItem(terminalZoomStorageKey(second)), '80')
  scope.stop()
})

test('successful online discovery deletes only closed tab keys while offline or missing discovery preserves them', () => {
  const store = storage(), keep = terminalZoomStorageKey(terminalZoomKey('backend', source, 'keep')), closed = terminalZoomStorageKey(terminalZoomKey('backend', source, 'closed'))
  const other = terminalZoomStorageKey(terminalZoomKey('other-backend', source, 'closed'))
  for (const key of [keep, closed, other]) store.setItem(key, '140')
  for (const discovered of [[], resources([], 'offline'), resources([], 'online', 'Unavailable')]) {
    pruneTerminalZooms('backend', [source], discovered, store); assert.equal(store.length, 3)
  }
  store.setItem(keep, '160') // A peer writes while another view still has an older local value.
  pruneTerminalZooms('backend', [source], resources(['keep']), store)
  assert.equal(store.getItem(keep), '160'); assert.equal(store.getItem(closed), null); assert.equal(store.getItem(other), '140')
  pruneTerminalZooms('backend', [{ ...source, herdrSession: 'different' }], [], store)
  assert.equal(store.getItem(keep), null); assert.equal(store.getItem(other), '140')
})

test('invalid browser values default without accepting unbounded or nonfinite font sizes', () => {
  for (const value of [undefined, null, '125', 0, 49, 201, Infinity, NaN, {}]) assert.equal(normalizeTerminalZoom(value), 100)
  assert.equal(normalizeTerminalZoom(50), 50); assert.equal(normalizeTerminalZoom(200), 200)
  assert.equal(normalizeTerminalZoom(125.4), 125)
})
