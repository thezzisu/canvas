import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { normalizeRightClickMode, terminalSettingsKey, useTerminalSettings } from './terminal-settings.ts'
import { pruneTerminalPreferences, terminalIdentityKey } from './terminal-identity.ts'
import type { Source, SourceResource } from './types.ts'

const source: Source = { id: 'connection', name: 'Connection', transport: 'ssh', target: 'host', herdrSession: 'main' }
function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear() }
}

test('right-click preferences persist by native identity and reset without leaking between targets', () => {
  const store = storage(), scope = effectScope(), first = terminalIdentityKey('backend', source, 'first')
  const key = ref(first), mode = scope.run(() => useTerminalSettings(() => key.value, store))!
  assert.equal(mode.value, 'menu'); assert.equal(store.length, 0)
  mode.value = 'terminal'
  assert.equal(store.getItem(terminalSettingsKey(first)), 'terminal')
  assert.equal(scope.run(() => useTerminalSettings(() => first, store))!.value, 'terminal', 'another canvas reference restores the same native preference')
  assert.equal(terminalIdentityKey('backend', { ...source, name: 'Renamed' }, 'first'), first)
  for (const next of [terminalIdentityKey('other-backend', source, 'first'), terminalIdentityKey('backend', source, 'second'), terminalIdentityKey('backend', { ...source, target: 'other-host' }, 'first')]) {
    key.value = next; assert.equal(mode.value, 'menu'); assert.equal(store.getItem(terminalSettingsKey(next)), null)
  }
  key.value = first; assert.equal(mode.value, 'terminal')
  mode.value = 'menu'; assert.equal(store.getItem(terminalSettingsKey(first)), null)
  scope.stop()
})

test('settings prune only confirmed closed native identities and leave offline peers and unrelated storage alone', () => {
  const store = storage(), key = (instance: string, window: string) => terminalSettingsKey(terminalIdentityKey(instance, source, window))
  store.setItem(key('backend', 'keep'), 'terminal'); store.setItem(key('backend', 'closed'), 'terminal'); store.setItem(key('other', 'closed'), 'terminal')
  store.setItem('unrelated', 'value')
  const resources = (status: string, ids: string[]): SourceResource[] => [{ id: source.id, name: source.name, status, spaces: [{ id: 'space', name: 'Space', windows: ids.map(id => ({ id, name: id })) }] }]
  pruneTerminalPreferences('backend', [source], resources('offline', []), store); assert.equal(store.length, 4)
  pruneTerminalPreferences('backend', [source], resources('online', ['keep']), store)
  assert.equal(store.getItem(key('backend', 'closed')), null)
  assert.equal(store.getItem(key('backend', 'keep')), 'terminal'); assert.equal(store.getItem(key('other', 'closed')), 'terminal'); assert.equal(store.getItem('unrelated'), 'value')
  for (const value of [undefined, null, {}, 'unknown', true, 1]) assert.equal(normalizeRightClickMode(value), 'menu')
})
