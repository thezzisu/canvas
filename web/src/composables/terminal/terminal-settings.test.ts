import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import {
  defaultTerminalSettings,
  normalizeTerminalOverrides,
  terminalDefaultsKey,
  terminalSettingsKey,
  useTerminalDefaults,
  useTerminalSettings,
} from './terminal-settings.ts'
import {
  pruneTerminalPreferences,
  terminalIdentityKey,
} from '../../utils/terminal/terminal-identity.ts'
import { pruneInstancePreferences } from '../../utils/local-preferences.ts'
import type { Source, SourceResource } from '../../api/types.ts'

const source: Source = {
  id: 'connection',
  name: 'Connection',
  transport: 'ssh',
  target: 'host',
  herdrSession: 'main',
}
function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] || null,
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
function browser(localStorage: Storage) {
  globalThis.Storage ??= class {} as typeof Storage
  return { window: Object.assign(new EventTarget(), { localStorage }) as Window }
}

test('terminal defaults remain reactive while each explicit field overrides independently', async () => {
  const store = storage(),
    scope = effectScope(),
    options = browser(store),
    identity = terminalIdentityKey('backend', source, 'tab')
  const { defaults, terminal } = scope.run(() => ({
    defaults: useTerminalDefaults(options),
    terminal: useTerminalSettings(identity, options),
  }))!
  assert.deepEqual(terminal.effective.value, defaultTerminalSettings)
  assert.equal(store.length, 0)
  terminal.overrides.value = { rightClick: 'menu' }
  assert.deepEqual(JSON.parse(store.getItem(terminalSettingsKey(identity))!), {
    rightClick: 'menu',
  })
  await nextTick()
  defaults.value = {
    rightClick: 'terminal',
    shiftPaste: 'terminal',
    mouseHover: false,
    maximizedZoom: 125,
  }
  assert.deepEqual(terminal.effective.value, {
    rightClick: 'menu',
    shiftPaste: 'terminal',
    mouseHover: false,
    maximizedZoom: 125,
  })
  terminal.zoom.value = 100
  assert.equal(terminal.zoom.value, 100, 'explicit 100 differs from inheriting 125')
  await nextTick()
  defaults.value = { ...defaults.value, maximizedZoom: 150 }
  assert.equal(terminal.zoom.value, 100)
  terminal.resetZoom()
  assert.equal(terminal.zoom.value, 150)
  await nextTick()
  terminal.overrides.value = {}
  assert.equal(store.getItem(terminalSettingsKey(identity)), null)
  assert.equal(terminal.effective.value.rightClick, 'terminal')
  pruneInstancePreferences([{ id: 'backend' }], store)
  assert(
    store.getItem(terminalDefaultsKey),
    'browser defaults are not mistaken for per-instance state',
  )
  scope.stop()
})

test('native identities isolate overrides across tabs and runtimes while defaults survive reload', async () => {
  const store = storage(),
    scope = effectScope(),
    options = browser(store),
    first = terminalIdentityKey('backend', source, 'first')
  const key = ref(first),
    terminal = scope.run(() => useTerminalSettings(key, options))!
  terminal.overrides.value = { mouseHover: false }
  await nextTick()
  terminal.zoom.value = 140
  const other = scope.run(() => useTerminalSettings(first, options))!
  assert.equal(other.effective.value.mouseHover, false)
  assert.equal(other.zoom.value, 140)
  assert.equal(terminalIdentityKey('backend', { ...source, name: 'Renamed' }, 'first'), first)
  for (const identity of [
    terminalIdentityKey('other', source, 'first'),
    terminalIdentityKey('backend', source, 'new'),
    terminalIdentityKey('backend', { ...source, runtime: 'core' }, 'first'),
  ]) {
    key.value = identity
    assert.deepEqual(terminal.effective.value, defaultTerminalSettings)
    assert.equal(store.getItem(terminalSettingsKey(identity)), null)
  }
  key.value = first
  assert.equal(terminal.zoom.value, 140)
  scope.stop()
  const reopened = effectScope(),
    value = reopened.run(() => useTerminalSettings(first, options))!
  assert.equal(value.zoom.value, 140)
  assert.equal(value.effective.value.mouseHover, false)
  reopened.stop()
})

test('confirmed native closure removes its overrides; offline discovery and other instances do not', () => {
  const store = storage(),
    key = (instance: string, tab: string) =>
      terminalSettingsKey(terminalIdentityKey(instance, source, tab))
  for (const id of [key('backend', 'keep'), key('backend', 'closed'), key('other', 'closed')])
    store.setItem(id, '{"maximizedZoom":125}')
  store.setItem(terminalDefaultsKey, '{"mouseHover":false}')
  store.setItem('unrelated', 'keep')
  const resources = (status: string, ids: string[]): SourceResource[] => [
    {
      id: source.id,
      name: source.name,
      status,
      spaces: [{ id: 'space', name: 'Space', windows: ids.map((id) => ({ id, name: id })) }],
    },
  ]
  pruneTerminalPreferences('backend', [source], resources('offline', []), store)
  assert.equal(store.length, 5)
  pruneTerminalPreferences('backend', [source], resources('online', ['keep']), store)
  assert.equal(store.getItem(key('backend', 'closed')), null)
  assert(store.getItem(key('backend', 'keep')))
  assert(store.getItem(key('other', 'closed')))
  assert(store.getItem(terminalDefaultsKey))
  pruneTerminalPreferences(
    'backend',
    [{ ...source, runtime: 'core' }],
    resources('offline', []),
    store,
  )
  assert.equal(store.getItem(key('backend', 'keep')), null)
})

test('invalid overrides inherit rather than overwrite explicit valid defaults', () => {
  for (const value of [
    null,
    undefined,
    true,
    'bad',
    { rightClick: 'bad', mouseHover: 'false', maximizedZoom: 201 },
  ])
    assert.deepEqual(normalizeTerminalOverrides(value), {})
  assert.deepEqual(
    normalizeTerminalOverrides({
      rightClick: 'menu',
      shiftPaste: 'terminal',
      mouseHover: false,
      maximizedZoom: 100,
    }),
    { rightClick: 'menu', shiftPaste: 'terminal', mouseHover: false, maximizedZoom: 100 },
  )
})
