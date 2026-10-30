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
  const call = (body?: unknown, token = 'fixture', origin = 'http://localhost') => app.request('http://localhost/api/settings', {
    method: body ? 'PATCH' : 'GET', headers: { Host: 'localhost', Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    { stack: [{ family: 'monospace', unknown: true }], ligatures: false },
    { stack: [{ family: 'monospace' }], ligatures: 'false' },
    { ...defaultSettings().contentFont, unknown: true },
  ]) assert.equal((await call({ contentFont })).status, 400)
})

test('invalid stored settings fail explicitly without overwriting their document or substituting defaults', t => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-settings-invalid-'))
  const store = new Store(join(directory, 'canvas.db'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  let changes = 0
  store.on('change', () => changes++)
  for (const invalid of [null, {}, { contentFont: { stack: [], ligatures: false } }, { contentFont: { stack: [{ family: 'monospace', unknown: true }], ligatures: true } }]) {
    const raw = JSON.stringify(invalid)
    store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('settings','global',?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").run(raw)
    assert.throws(() => store.settings())
    assert.throws(() => store.snapshot())
    assert.equal(store.db.prepare("SELECT body FROM documents WHERE kind='settings' AND id='global'").get()!.body, raw)
  }
  assert.equal(changes, 0)
  assert.equal(store.revision, 0)
})
