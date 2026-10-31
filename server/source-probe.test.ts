import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { Store } from './state.ts'
import { probeSource } from './providers.ts'
import type { TerminalManager } from './terminals.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cv-source-probe-')), clients = new Set<Socket>(), requests: string[] = []
  let version: unknown = '0.9.5-preview.probe', held = false, attachments = 0
  const socketPath = join(root, 'herdr.sock')
  const api = createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {})
    let input = ''
    socket.on('data', chunk => {
      input += chunk.toString(); if (!input.includes('\n')) return
      const request = JSON.parse(input.split('\n')[0]!); requests.push(request.method)
      if (held) return
      socket.end(JSON.stringify({ id: request.id, result: { snapshot: { version, protocol: 888, workspaces: [], tabs: [], panes: [] } } }) + '\n')
    })
  })
  const endpoint = createServer(socket => { attachments++; socket.destroy() })
  await Promise.all([new Promise<void>(resolve => api.listen(socketPath, resolve)), new Promise<void>(resolve => endpoint.listen(join(root, 'herdr-client.sock'), resolve))])
  const store = new Store(join(root, 'state.db')); store.addSession('DUMMY_PROBE_TOKEN')
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, { closeSource: async () => assert.fail('probe must not close an existing source') } as unknown as TerminalManager)
  t.after(async () => { for (const socket of clients) socket.destroy(); await Promise.all([api, endpoint].map(server => new Promise<void>(resolve => server.close(() => resolve())))); store.close(); await rm(root, { recursive: true, force: true }) })
  const draft = { transport: 'local' as const, herdrSocket: socketPath }
  const call = (body: unknown, authenticated = true) => app.request('http://localhost/api/sources/probe', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer DUMMY_PROBE_TOKEN' } : {}) }, body: JSON.stringify(body) })
  return { store, draft, call, requests, clients, get attachments() { return attachments }, set version(value: unknown) { version = value }, set held(value: boolean) { held = value } }
}

test('source draft probe is authenticated, name-independent and never persists or attaches', async t => {
  const f = await fixture(t), before = f.store.snapshot()
  assert.equal((await f.call(f.draft, false)).status, 401); assert.deepEqual(f.requests, [])
  assert.equal((await f.call({ ...f.draft, id: '55555555-5555-4555-8555-555555555555' })).status, 400)
  const response = await f.call(f.draft)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'online', serverVersion: '0.9.5-preview.probe' })
  assert.deepEqual(f.requests, ['session.snapshot']); assert.equal(f.attachments, 0)
  assert.deepEqual(f.store.snapshot(), before, 'the probe does not write a source, canvas, helper or geometry')
})

test('a draft without a valid server version is not approved for saving', async t => {
  const f = await fixture(t)
  for (const version of [undefined, '', 888]) {
    f.version = version
    const response = await f.call(f.draft)
    assert.equal(response.status, 400); assert.match((await response.json()).error, /version/)
  }
  assert.equal(f.attachments, 0); assert.deepEqual(f.store.list('source'), [])
})

test('cancelling a native draft probe closes its API socket promptly', async t => {
  const f = await fixture(t); f.held = true
  const controller = new AbortController(), result = probeSource(f.draft, controller.signal)
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 1000; const poll = () => f.requests.length ? resolve() : Date.now() > deadline ? reject(new Error('probe did not connect')) : setTimeout(poll, 5); poll() })
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 1000; const poll = () => f.clients.size === 0 ? resolve() : Date.now() > deadline ? reject(new Error('probe socket survived cancellation')) : setTimeout(poll, 5); poll() })
  assert.equal(f.attachments, 0)
})

test('cancelling remote discovery terminates only its probe SSH process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cv-probe-ssh-')), previousPath = process.env.PATH, marker = join(root, 'pid')
  await writeFile(join(root, 'ssh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)\n`, { mode: 0o700 })
  t.after(async () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }) })
  process.env.PATH = root
  const controller = new AbortController(), result = probeSource({ transport: 'ssh', target: 'ssh://fixture@example.test' }, controller.signal)
  let pid = 0
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 1000; const poll = async () => { try { pid = Number(await readFile(marker, 'utf8')); resolve() } catch { if (Date.now() > deadline) reject(new Error('probe SSH did not start')); else setTimeout(poll, 5) } }; void poll() })
  controller.abort(); await assert.rejects(result)
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 1500; const poll = () => { try { process.kill(pid, 0); if (Date.now() > deadline) reject(new Error('probe SSH survived cancellation')); else setTimeout(poll, 5) } catch { resolve() } }; poll() })
})
