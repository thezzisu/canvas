import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './state.ts'
import { createApp } from './app.ts'
import type { TerminalManager } from './terminals.ts'
import { defaultSettings } from '../shared/settings.ts'

test('global font defaults do not write data; generic chains persist and publish only real changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-settings-'))
  const file = join(directory, 'canvas.db')
  let store = new Store(file)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.deepEqual(store.settings(), defaultSettings())
  assert.equal(store.get('settings', 'global'), undefined)
  let changes = 0
  store.on('change', () => changes++)
  store.updateSettings(defaultSettings())
  assert.equal(changes, 0)
  assert.equal(store.get('settings', 'global'), undefined)
  const settings = { contentFont: { stack: [{ family: 'Future Bundled Font Compact' }, { family: '本机字体' }, { family: 'monospace' }], ligatures: true } }
  store.updateSettings(settings)
  assert.equal(changes, 1)
  assert.deepEqual(store.snapshot().settings, settings)
  store.updateSettings(settings)
  assert.equal(changes, 1)
  store.close(); store = new Store(file)
  assert.deepEqual(store.settings(), settings)
  assert.equal(store.revision, 0)
})

test('settings routes enforce account/origin boundaries and validate family names independently of catalog', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-settings-api-'))
  const store = new Store(join(directory, 'canvas.db'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.addSession('fixture')
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager)
  const call = (body?: unknown, cookie = 'fixture', origin = 'http://localhost') => app.request('http://localhost/api/settings', {
    method: body ? 'PATCH' : 'GET', headers: { Host: 'localhost', Origin: origin, Cookie: `canvas_session=${cookie}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  assert.equal((await call(undefined, 'missing')).status, 401)
  assert.equal((await call(defaultSettings(), 'fixture', 'https://elsewhere.test')).status, 403)
  const good = { contentFont: { stack: [{ family: '  New Font  ' }, { family: 'new font' }, { family: 'Maple Mono NF CN' }, { family: 'Maple Mono Normal NF CN' }, { family: 'monospace' }], ligatures: true } }
  assert.equal((await call(good)).status, 200)
  assert.deepEqual((await (await call()).json()).contentFont.stack, [{ family: 'New Font' }, { family: 'Maple Mono NF CN' }, { family: 'Maple Mono Normal NF CN' }, { family: 'monospace' }])
  for (const contentFont of [
    { stack: [], ligatures: false },
    { stack: [{ family: 'font; color:red' }], ligatures: false },
    { stack: [{ family: 'url(https://font.test)' }], ligatures: false },
    { stack: [{ family: 'font\nface' }], ligatures: false },
    { stack: [{ family: 'monospace', variant: '../other' }], ligatures: false },
    { stack: [{ family: 'Maple Mono NF CN', variant: 'normal' }], ligatures: false },
    { stack: [{ family: 'monospace', variant: 'default' }], ligatures: false },
    { stack: [{ family: 'monospace' }], ligatures: 'false' },
    { ...defaultSettings().contentFont, normal: true },
  ]) assert.equal((await call({ contentFont })).status, 400)
})

test('legacy settings resolve to independent font names without rewriting storage on read or no-op save', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-settings-legacy-'))
  const file = join(directory, 'canvas.db')
  let store = new Store(file)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const legacy = { contentFont: { stack: [
    { family: 'Maple Mono NF CN', variant: 'normal' },
    { family: 'Maple Mono Normal NF CN' },
    { family: 'Cascadia Code PL', variant: 'future' },
    { family: 'Local Font', variant: 'compact' },
    { family: 'monospace' },
  ], ligatures: true } }
  const original = JSON.stringify(legacy)
  store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('settings','global',?)").run(original)
  const canonical = { contentFont: { stack: [
    { family: 'Maple Mono Normal NF CN' }, { family: 'Cascadia Code PL' },
    { family: 'Local Font' }, { family: 'monospace' },
  ], ligatures: true } }
  const raw = () => store.db.prepare("SELECT body FROM documents WHERE kind='settings' AND id='global'").get()!.body
  let changes = 0
  store.on('change', () => changes++)
  assert.deepEqual(store.settings(), canonical)
  assert.deepEqual(store.snapshot().settings, canonical)
  assert.deepEqual(store.updateSettings(canonical), canonical)
  assert.equal(raw(), original)
  assert.equal(store.revision, 0)
  assert.equal(changes, 0)
  store.close(); store = new Store(file)
  assert.deepEqual(store.settings(), canonical)
  assert.equal(raw(), original)
  const changed = { contentFont: { ...canonical.contentFont, ligatures: false } }
  store.updateSettings(changed)
  assert.deepEqual(JSON.parse(String(raw())), changed)
  assert.equal(store.revision, 1)
})

test('legacy family-first deduplication and unknown variants retain their original fallback behavior', t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-settings-legacy-dedupe-'))
  const store = new Store(join(directory, 'canvas.db'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const cases = [
    { stack: [{ family: 'Maple Mono NF CN', variant: 'normal' }, { family: 'maple mono nf cn', variant: 'default' }], expected: [{ family: 'Maple Mono Normal NF CN' }] },
    { stack: [{ family: 'Maple Mono NF CN', variant: 'default' }, { family: 'maple mono nf cn', variant: 'normal' }], expected: [{ family: 'Maple Mono NF CN' }] },
    { stack: [{ family: '  maple mono nf cn  ', variant: ' normal ' }, { family: 'Maple Mono Normal NF CN' }], expected: [{ family: 'Maple Mono Normal NF CN' }] },
    { stack: [{ family: 'Maple Mono NF CN', variant: 'future' }, { family: 'Future Font', variant: 'normal' }], expected: [{ family: 'Maple Mono NF CN' }, { family: 'Future Font' }] },
  ]
  for (const { stack, expected } of cases) {
    const original = JSON.stringify({ contentFont: { stack, ligatures: false } })
    store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('settings','global',?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").run(original)
    assert.deepEqual(store.settings().contentFont.stack, expected)
    assert.equal(store.db.prepare("SELECT body FROM documents WHERE kind='settings' AND id='global'").get()!.body, original)
  }
  const invalid = { contentFont: { stack: [{ family: 'Maple Mono NF CN', variant: { name: 'normal' } }], ligatures: true } }
  store.db.prepare("UPDATE documents SET body=? WHERE kind='settings' AND id='global'").run(JSON.stringify(invalid))
  assert.deepEqual(store.settings(), defaultSettings(), 'invalid legacy fields are not silently accepted')
  assert.equal(store.revision, 0)
})
