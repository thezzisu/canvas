import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from './app.ts'
import { Store, noteNodeSchema, type Canvas, type Source, type TerminalNode } from './state.ts'
import type { TerminalManager } from './terminals.ts'
import { closeProviderConnections, createSpace, createWindow, listResources } from './providers.ts'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-close-'))
  const store = new Store(join(directory, 'canvas.db'))
  const sockets = new Set<Socket>(), requests: string[] = []
  const tabs = [
    { workspace_id: 'space', tab_id: 'closed', label: 'Window' },
    { workspace_id: 'space', tab_id: 'sibling', label: 'Sibling' },
    { workspace_id: 'other', tab_id: 'kept', label: 'Kept' },
  ]
  let fail = false, failDiscovery = false, hold: Promise<void> | undefined, notifyStarted: (() => void) | undefined
  const native = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', async chunk => {
      text += chunk.toString(); if (!text.includes('\n')) return
      const request = JSON.parse(text.slice(0, text.indexOf('\n'))); text = ''
      requests.push(request.method)
      if (request.method === 'session.snapshot') {
        if (failDiscovery) { socket.end(JSON.stringify({ id: request.id, error: { message: 'Discovery unavailable' } }) + '\n'); return }
        socket.end(JSON.stringify({ id: request.id, result: { snapshot: {
          version: 'fixture', workspaces: [{ workspace_id: 'space', label: 'Space' }, { workspace_id: 'other', label: 'Other' }], tabs, panes: [],
        } } }) + '\n'); return
      }
      notifyStarted?.()
      await hold
      if (fail) { socket.end(JSON.stringify({ id: request.id, error: { message: 'Close refused' } }) + '\n'); return }
      if (request.method === 'tab.close') {
        const index = tabs.findIndex(tab => tab.tab_id === request.params.tab_id)
        if (index >= 0) tabs.splice(index, 1)
      } else if (request.method === 'workspace.close') {
        for (let index = tabs.length - 1; index >= 0; index--) if (tabs[index]!.workspace_id === request.params.workspace_id) tabs.splice(index, 1)
      } else assert.fail(`Unexpected native operation ${request.method}`)
      socket.end(JSON.stringify({ id: request.id, result: {} }) + '\n')
    })
  })
  const client = createServer(socket => socket.destroy())
  const apiPath = join(directory, 'herdr.sock')
  await Promise.all([
    new Promise<void>(resolve => native.listen(apiPath, resolve)),
    new Promise<void>(resolve => client.listen(join(directory, 'herdr-client.sock'), resolve)),
  ])
  const source = store.put<Source>('source', { id: randomUUID(), name: 'Source', transport: 'local', herdrSocket: apiPath })
  const otherSource = store.put<Source>('source', { ...source, id: randomUUID(), name: 'Another connection' })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {
    closeAll: async () => {}, closeSource: async () => {}, onNotification: () => ({ dispose() {} }),
  } as unknown as TerminalManager)
  store.addSession('fixture')
  const headers = { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const close = (window = 'closed') => request(`/api/sources/${source.id}/spaces/space/windows/${window}`, 'DELETE')
  const node = (id: string, windowId: string, sourceId = source.id, spaceId = 'space'): TerminalNode =>
    ({ id, type: 'terminal', sourceId, spaceId, windowId, x: 0, y: 0, width: 480, height: 302 })
  const note = noteNodeSchema.parse({ id: randomUUID(), type: 'note', title: 'Note', content: 'Keep', color: 'yellow', x: 10, y: 20, width: 320, height: 240 })
  const a = store.put<Canvas>('canvas', { id: randomUUID(), name: 'A', nodes: [node('a-closed', 'closed', source.id, 'old-space'), node('a-kept', 'kept'), note] })
  const b = store.put<Canvas>('canvas', { id: randomUUID(), name: 'B', nodes: [node('b-closed', 'closed'), node('b-foreign', 'closed', otherSource.id)] })
  store.setWindowSize(source.id, 'closed', { width: 900, height: 600 })
  store.setWindowSize(source.id, 'kept', { width: 700, height: 400 })
  store.setWindowSize(otherSource.id, 'closed', { width: 800, height: 500 })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => native.close(() => resolve())), new Promise<void>(resolve => client.close(() => resolve()))])
    store.close(); await rm(directory, { recursive: true, force: true })
  })
  return { store, source, otherSource, app, a, b, node, requests, tabs, request, close,
    reject() { fail = true },
    rejectDiscovery() { failDiscovery = true },
    hold() {
      let release!: () => void
      hold = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { notifyStarted = resolve })
      return { started, release }
    },
    delayedLayout() {
      let release!: () => void
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ nodes: [{ id: 'a-closed', x: 900, width: 2000 }, { id: 'a-kept', x: 25 }] }))); controller.close() }
      } })
      return { release, result: app.request(`http://localhost/api/canvases/${a.id}/layout`, { method: 'PATCH', headers, body, duplex: 'half' } as RequestInit) }
    },
  }
}

test('explicit native close removes every matching reference and shared size in one snapshot', async t => {
  const f = await fixture(t), revision = f.store.revision, snapshots: ReturnType<Store['snapshot']>[] = []
  f.store.on('change', () => snapshots.push(f.store.snapshot()))
  const layout = f.delayedLayout()
  assert.equal((await f.close()).status, 200)
  assert.equal(f.store.revision, revision + 1)
  assert.equal(snapshots.length, 1)
  const state = snapshots[0]!
  assert.deepEqual(state.canvases.find(canvas => canvas.id === f.a.id)!.nodes.map(node => node.id), ['a-kept', f.a.nodes[2]!.id])
  assert.deepEqual(state.canvases.find(canvas => canvas.id === f.b.id)!.nodes.map(node => node.id), ['b-foreign'])
  assert.equal(state.windowSizes[`${f.source.id}/closed`], undefined)
  assert.deepEqual(state.windowSizes[`${f.source.id}/kept`], { width: 700, height: 400 })
  assert.deepEqual(state.windowSizes[`${f.otherSource.id}/closed`], { width: 800, height: 500 })
  assert(!f.tabs.some(tab => tab.tab_id === 'closed'))
  layout.release(); assert.equal((await layout.result).status, 200)
  assert.equal(f.store.get<Canvas>('canvas', f.a.id)!.nodes.find(node => node.id === 'a-kept')!.x, 25)
  assert(!f.store.get<Canvas>('canvas', f.a.id)!.nodes.some(node => node.id === 'a-closed'))
  assert.equal(f.store.get('window-size', `${f.source.id}/closed`), undefined, 'late layout must not recreate a deleted native size')
})

test('failed and unauthorized native closes preserve references and sizes', async t => {
  const f = await fixture(t), before = f.store.snapshot()
  const endpoint = `/api/sources/${f.source.id}/spaces/space/windows/closed`
  assert.equal((await f.app.request(`http://localhost${endpoint}`, { method: 'DELETE' })).status, 401)
  assert.deepEqual(f.requests, [])
  f.reject(); assert.equal((await f.close()).status, 400)
  assert.deepEqual(f.store.snapshot(), before)
  assert(f.tabs.some(tab => tab.tab_id === 'closed'))
})

test('an endpoint edit during native close cannot remove references for its replacement', async t => {
  const f = await fixture(t), gate = f.hold(), pending = f.close()
  await gate.started
  f.store.put('source', { ...f.source, herdrSocket: join('/replacement', 'herdr.sock') })
  const before = f.store.snapshot()
  gate.release(); assert.equal((await pending).status, 200)
  assert.deepEqual(f.store.snapshot(), before)
  assert(!f.tabs.some(tab => tab.tab_id === 'closed'), 'the original native operation still completed')
})

test('a display-name edit during native close still clears the same endpoint references', async t => {
  const f = await fixture(t), gate = f.hold(), pending = f.close()
  await gate.started
  f.store.put('source', { ...f.source, name: 'Renamed' })
  gate.release(); assert.equal((await pending).status, 200)
  assert(f.store.list<Canvas>('canvas').every(canvas => canvas.nodes.every(node => node.type !== 'terminal' || node.sourceId !== f.source.id || node.windowId !== 'closed')))
})

test('closing a space cleans its confirmed native windows rather than stale reference space IDs', async t => {
  const f = await fixture(t)
  f.store.put('canvas', { ...f.a, nodes: [...f.a.nodes, f.node('a-sibling', 'sibling', f.source.id, 'stale-space')] })
  const revision = f.store.revision
  assert.equal((await f.request(`/api/sources/${f.source.id}/spaces/space`, 'DELETE')).status, 200)
  assert.equal(f.store.revision, revision + 1)
  const terminals = f.store.list<Canvas>('canvas').flatMap(canvas => canvas.nodes.filter(node => node.type === 'terminal'))
  assert.deepEqual(terminals.map(node => node.id), ['a-kept', 'b-foreign'])
  assert.deepEqual(f.requests, ['session.snapshot', 'workspace.close', 'session.snapshot'])
})

test('a tab moved out during space closure retains its references and shared size', async t => {
  const f = await fixture(t), gate = f.hold()
  f.store.put('canvas', { ...f.a, nodes: [...f.a.nodes, f.node('a-sibling', 'sibling')] })
  const pending = f.request(`/api/sources/${f.source.id}/spaces/space`, 'DELETE')
  await gate.started
  f.tabs.find(tab => tab.tab_id === 'closed')!.workspace_id = 'other'
  gate.release(); assert.equal((await pending).status, 200)
  const ids = f.store.list<Canvas>('canvas').flatMap(canvas => canvas.nodes.map(node => node.id))
  assert(ids.includes('a-closed') && ids.includes('b-closed'))
  assert(!ids.includes('a-sibling'))
  assert.deepEqual(f.store.windowSize(f.source.id, 'closed'), { width: 900, height: 600 })
})

test('a successful space close with unavailable follow-up discovery keeps references', async t => {
  const f = await fixture(t), before = f.store.snapshot(), gate = f.hold()
  const pending = f.request(`/api/sources/${f.source.id}/spaces/space`, 'DELETE')
  await gate.started
  f.rejectDiscovery(); gate.release()
  assert.equal((await pending).status, 200, 'verification failure does not report an already completed native close as failed')
  assert.deepEqual(f.store.snapshot(), before)
  assert(!f.tabs.some(tab => tab.workspace_id === 'space'))
})

test('reference cleanup rolls back every canvas and size when a write fails', async t => {
  const f = await fixture(t), before = f.store.snapshot()
  f.store.db.exec(`CREATE TRIGGER refuse_reference_cleanup BEFORE UPDATE ON documents WHEN OLD.kind='canvas' AND OLD.id='${f.b.id}' BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END;`)
  assert.throws(() => f.store.removeWindowReferences(f.source, ['closed']), /fixture write failed/)
  assert.deepEqual(f.store.snapshot(), before)
})

test('official herdr closure removes all canvas references while leaving another native window alive', async t => {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY
  if (!binary) { t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server'); return }
  const directory = await mkdtemp(join(tmpdir(), 'canvas-close-native-')), config = join(directory, 'config')
  await mkdir(join(config, 'herdr'), { recursive: true })
  await writeFile(join(config, 'herdr/config.toml'), 'onboarding=false\n[terminal]\ndefault_shell="/bin/sh"\nshell_mode="non_login"\n')
  const env = { PATH: process.env.PATH, HOME: directory, USER: 'fixture', LANG: 'C.UTF-8', XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(directory, 'state') }
  const native = spawn(binary, ['--session', 'close-reference', 'server'], { env, stdio: 'ignore' })
  const store = new Store(join(directory, 'canvas.db'))
  const source = store.put<Source>('source', { id: randomUUID(), name: 'Isolated native', transport: 'local',
    herdrSocket: join(config, 'herdr/sessions/close-reference/herdr.sock') })
  t.after(async () => {
    await closeProviderConnections(source.id)
    if (native.exitCode === null && native.signalCode === null) {
      const done = new Promise<void>(resolve => native.once('exit', () => resolve()))
      native.kill(); const timer = setTimeout(() => native.kill('SIGKILL'), 3000); await done; clearTimeout(timer)
    }
    store.close(); await rm(directory, { recursive: true, force: true })
  })
  const deadline = Date.now() + 10000
  while ((await listResources(source)).status !== 'online') {
    assert(Date.now() < deadline && native.exitCode === null, 'isolated native server did not become ready')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const space = await createSpace(source, 'Close fixture'), other = await createWindow(source, space.spaceId, 'Keep')
  const node = (id: string, windowId: string): TerminalNode => ({ id, sourceId: source.id, spaceId: space.spaceId, windowId,
    type: 'terminal', x: 0, y: 0, width: 480, height: 302 })
  store.put<Canvas>('canvas', { id: randomUUID(), name: 'One', nodes: [node('one', space.windowId), node('kept', other.windowId)] })
  store.put<Canvas>('canvas', { id: randomUUID(), name: 'Two', nodes: [node('two', space.windowId)] })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager)
  store.addSession('fixture')
  const close = await app.request(`http://localhost/api/sources/${source.id}/spaces/${space.spaceId}/windows/${space.windowId}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
  })
  assert.equal(close.status, 200)
  assert.deepEqual(store.list<Canvas>('canvas').map(canvas => canvas.nodes.map(node => node.id)), [['kept'], []])
  const snapshot = await listResources(source)
  assert(snapshot.spaces.some(space => space.windows.some(window => window.id === other.windowId)))
  assert(snapshot.spaces.every(group => group.windows.every(window => window.id !== space.windowId)))
})
