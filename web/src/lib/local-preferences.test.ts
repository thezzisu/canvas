import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearInstancePreferences,
  pruneCanvasLocations,
  pruneInstancePreferences,
} from './local-preferences'
import { terminalIdentityKey } from '../terminal/terminal-identity'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}
test('instance retirement clears every owned view without touching auth, browser settings or other instances', () => {
  const saved = storage(),
    source = { id: 'source', name: 'Same', transport: 'local' as const }
  const retired = [
    'canvas:last-canvas:a',
    'canvas:view:a:one',
    'canvas:view:a:one:free',
    'canvas:overview:a:order',
    'canvas:overview:a:statuses',
    'canvas:file-mode:a:file',
    'canvas:file-view:a:one:file',
    'canvas:note-scroll:a:one:note',
    'canvas:card-zoom:a:note',
    'canvas:capture-view:a:source/window',
    ...['terminal-settings', 'window-canvas'].map(
      (kind) => `canvas:${kind}:${terminalIdentityKey('a', source, 'tab')}`,
    ),
  ]
  const retained = [
    'canvas:language',
    'canvas:session:a',
    'canvas:view:navigation',
    'canvas:view:auto-yield-controls',
    'canvas:view:b:one',
    'canvas:file-mode:ab:file',
    'canvas:last-canvas:b',
    'canvas:notifications:delivered:a',
    `canvas:terminal-settings:${terminalIdentityKey('b', source, 'tab')}`,
  ]
  for (const key of [...retired, ...retained]) saved.setItem(key, 'value')
  clearInstancePreferences('a', saved)
  for (const key of retired) assert.equal(saved.getItem(key), null, key)
  for (const key of retained) assert.equal(saved.getItem(key), 'value', key)
})
test('canvas removal prunes only obsolete camera entries and leaves object modes intact', () => {
  const saved = storage()
  for (const key of [
    'canvas:view:a:keep',
    'canvas:view:a:keep:free',
    'canvas:view:a:gone',
    'canvas:view:a:gone:free',
    'canvas:view:a:overview',
    'canvas:view:b:gone',
    'canvas:file-mode:a:file',
  ])
    saved.setItem(key, 'saved')
  saved.setItem('canvas:last-canvas:a', 'gone')
  pruneCanvasLocations('a', [{ id: 'keep' }], saved)
  assert.equal(saved.getItem('canvas:view:a:gone'), null)
  assert.equal(saved.getItem('canvas:view:a:gone:free'), null)
  assert.equal(saved.getItem('canvas:last-canvas:a'), null)
  assert.equal(saved.length, 5)
})
test('blocked storage does not prevent instance or canvas retirement', () => {
  const blocked = {
    get length() {
      throw new Error('blocked')
    },
    getItem() {
      throw new Error('blocked')
    },
  } as unknown as Storage
  assert.doesNotThrow(() => clearInstancePreferences('a', blocked))
  assert.doesNotThrow(() => pruneCanvasLocations('a', [], blocked))
})
test('unregistered preference namespaces are retired without touching sessions or unrelated browser data', () => {
  const saved = storage(),
    source = { id: 's', name: 'Source', transport: 'local' as const }
  const keep = [
    'canvas:view:minimap',
    'canvas:view:navigation',
    'canvas:view:auto-yield-controls',
    'canvas:session:old-boot',
    'canvas:notifications:delivered:old-boot',
    'unrelated',
    'canvas:language',
    'canvas:instances',
    'canvas:card-zoom:a:note',
    `canvas:terminal-settings:${terminalIdentityKey('a', source, 'tab')}`,
  ]
  const retire = [
    'canvas:card-zoom:old-boot:note',
    'canvas:note-scroll:old-boot:c:note',
    'canvas:capture-hidden:expired-lease',
    'canvas:overview:statuses',
    'canvas:overview:order',
    'canvas:last-canvas:removed',
    `canvas:terminal-settings:${terminalIdentityKey('old-boot', source, 'tab')}`,
  ]
  for (const key of [...keep, ...retire]) saved.setItem(key, 'saved')
  pruneInstancePreferences([{ id: 'a' }], saved)
  for (const key of keep) assert.equal(saved.getItem(key), 'saved', key)
  for (const key of retire) assert.equal(saved.getItem(key), null, key)
})
