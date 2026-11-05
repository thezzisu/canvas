import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { normalizeTerminalSettings, terminalSettingsKey, useTerminalSettings } from './terminal-settings.ts'
import { pruneTerminalPreferences, terminalIdentityKey } from './terminal-identity.ts'
import { terminalZoomStorageKey } from './terminal-zoom.ts'
import type { Source, SourceResource } from './types.ts'

const source: Source = { id: 'connection', name: 'Connection', transport: 'ssh', target: 'host', herdrSession: 'main' }
function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear() }
}

test('terminal preferences persist by native identity and reset without leaking between targets', () => {
  const store = storage(), scope = effectScope(), first = terminalIdentityKey('backend', source, 'first')
  const key = ref(first), settings = scope.run(() => useTerminalSettings(() => key.value, store))!
  assert.deepEqual(settings.value, { rightClick: 'menu', shiftPaste: 'paste' }); assert.equal(store.length, 0)
  settings.value = { ...settings.value, rightClick: 'terminal' }
  assert.deepEqual(JSON.parse(store.getItem(terminalSettingsKey(first))!), { rightClick: 'terminal', shiftPaste: 'paste' })
  assert.equal(scope.run(() => useTerminalSettings(() => first, store))!.value.rightClick, 'terminal', 'another canvas reference restores the same native preference')
  settings.value = { ...settings.value, shiftPaste: 'terminal' }
  assert.equal(scope.run(() => useTerminalSettings(() => first, store))!.value.shiftPaste, 'terminal')
  assert.equal(terminalIdentityKey('backend', { ...source, name: 'Renamed' }, 'first'), first)
  for (const next of [terminalIdentityKey('other-backend', source, 'first'), terminalIdentityKey('backend', source, 'second'), terminalIdentityKey('backend', { ...source, target: 'other-host' }, 'first'),
    terminalIdentityKey('backend', { ...source, runtime: 'core' }, 'first')]) {
    key.value = next; assert.equal(settings.value.rightClick, 'menu'); assert.equal(store.getItem(terminalSettingsKey(next)), null)
  }
  key.value = first; assert.equal(settings.value.rightClick, 'terminal')
  settings.value = { rightClick: 'menu', shiftPaste: 'paste' }; assert.equal(store.getItem(terminalSettingsKey(first)), null)
  scope.stop()
})

test('settings prune only confirmed closed native identities and leave offline peers and unrelated storage alone', () => {
  const store = storage(), key = (instance: string, window: string) => terminalSettingsKey(terminalIdentityKey(instance, source, window))
  const saved = JSON.stringify({ rightClick: 'terminal' }); store.setItem(key('backend', 'keep'), saved); store.setItem(key('backend', 'closed'), saved); store.setItem(key('other', 'closed'), saved)
  store.setItem('unrelated', 'value')
  const resources = (status: string, ids: string[]): SourceResource[] => [{ id: source.id, name: source.name, status, spaces: [{ id: 'space', name: 'Space', windows: ids.map(id => ({ id, name: id })) }] }]
  pruneTerminalPreferences('backend', [source], resources('offline', []), store); assert.equal(store.length, 4)
  pruneTerminalPreferences('backend', [source], resources('online', ['keep']), store)
  assert.equal(store.getItem(key('backend', 'closed')), null)
  assert.equal(store.getItem(key('backend', 'keep')), saved); assert.equal(store.getItem(key('other', 'closed')), saved); assert.equal(store.getItem('unrelated'), 'value')
  const core = { ...source, runtime: 'core' as const }, coreIdentity = terminalIdentityKey('backend', core, 'keep')
  const previousZoom = terminalZoomStorageKey(terminalIdentityKey('backend', source, 'keep')), coreZoom = terminalZoomStorageKey(coreIdentity)
  store.setItem(previousZoom, '140'); store.setItem(coreZoom, '80'); store.setItem(terminalSettingsKey(coreIdentity), JSON.stringify({ rightClick: 'terminal' }))
  pruneTerminalPreferences('backend', [core], resources('offline', []), store)
  assert.equal(store.getItem(previousZoom), null); assert.equal(store.getItem(key('backend', 'keep')), null, 'switching runtime retires both preference types for the old runtime')
  assert.equal(store.getItem(coreZoom), '80'); assert.equal(store.getItem(terminalSettingsKey(coreIdentity)), JSON.stringify({ rightClick: 'terminal' }), 'offline discovery preserves preferences for the configured runtime')
  assert.equal(store.getItem(key('other', 'closed')), saved); assert.equal(store.getItem('unrelated'), 'value')
  for (const value of [undefined, null, {}, 'unknown', true, 1, { rightClick: 'other', shiftPaste: 1 }]) assert.deepEqual(normalizeTerminalSettings(value), { rightClick: 'menu', shiftPaste: 'paste' })
})
