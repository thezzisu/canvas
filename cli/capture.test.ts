import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const capture = fileURLToPath(new URL('./capture.py', import.meta.url))
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 6000
  while (Date.now() < end) { if (await check()) return; await delay() }
  assert.fail(label)
}
async function unusedPort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cv-capture-cli-')), registry = join(root, 'bridges'), nativeSocket = join(root, 'native.sock')
  await mkdir(registry, { mode: 0o700 })
  const endpoint = join(root, 'bridge.sock'), secret = randomBytes(24).toString('base64url')
  const publicUrl = `http://127.0.0.1:31500/api/capture/${'x'.repeat(43)}/`
  const children: ChildProcess[] = [], sockets = new Set<Socket>(), messages: Record<string, unknown>[] = []
  let peer: Socket | undefined
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let bytes = ''
    socket.on('data', data => {
      bytes += data.toString()
      while (bytes.includes('\n')) {
        const at = bytes.indexOf('\n'), value = JSON.parse(bytes.slice(0, at)); bytes = bytes.slice(at + 1)
        if (value.kind === 'capture') {
          assert(value.secret === secret, 'the helper authenticates through the private source bridge')
          assert.equal(value.nativeSocket, nativeSocket); assert.equal(value.paneId, 't7')
          delete value.secret; messages.push(value); peer = socket
          socket.write(JSON.stringify({ ok: true, state: 'prepared', id: 'x'.repeat(43), publicUrl }) + '\n')
        } else {
          messages.push(value)
          socket.write(JSON.stringify({ ok: true, state: 'ready' }) + '\n')
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(endpoint, resolve))
  await writeFile(join(registry, 'bridge.json'), JSON.stringify({ version: 1, nativeSocket, socket: endpoint, secret }), { mode: 0o600 })
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const child of children) await until(() => child.exitCode !== null || child.signalCode !== null, 'capture helper cleanup')
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true })
  })
  const run = (args: string[]) => {
    const child = spawn('python3', [capture, ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8',
      HC_TERMINAL_SOCKET: nativeSocket, HC_TERMINAL_ID: 't7', CANVAS_BRIDGE_REGISTRY_DIR: registry }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout?.on('data', data => { stdout += data.toString() }); child.stderr?.on('data', data => { stderr += data.toString() })
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    return { child, exit, stdout: () => stdout, stderr: () => stderr }
  }
  return { root, publicUrl, messages, peer: () => peer, run }
}

test('capture runs the selected command, keeps bootstrap credentials private and stops only through its owned bridge', { timeout: 15000 }, async t => {
  if (process.platform !== 'linux') { t.skip('Capture preview uses Linux listener ownership'); return }
  const f = await fixture(t), port = await unusedPort(), ready = join(f.root, 'ready.json'), program = join(f.root, 'web.py')
  await writeFile(program, `import http.server,os,json,sys\ns=http.server.HTTPServer(('127.0.0.1',${port}),http.server.SimpleHTTPRequestHandler)\nfd=os.open(${JSON.stringify(ready)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,'w') as f:json.dump({'launchUrl':os.environ['CANVAS_CAPTURE_PUBLIC_URL']+'?token=bootstrap-fixture'},f)\nprint('SYNTHETIC_WEB_READY',flush=True)\ns.serve_forever()\n`)
  const run = f.run(['--port', String(port), '--ready-file', ready, '--timeout', '5', '--', '/usr/bin/python3', program])
  await until(() => run.stderr().includes('Web view ready'), 'owned application did not enter Web view')
  assert.equal(f.messages[0]!.port, port)
  assert.deepEqual(f.messages[1], { action: 'ready', bootstrapUrl: f.publicUrl + '?token=bootstrap-fixture' })
  assert(run.stdout().includes('SYNTHETIC_WEB_READY'), 'ordinary stdout remains visible in the original terminal')
  assert(!run.stdout().includes('bootstrap-fixture') && !run.stderr().includes('bootstrap-fixture'), 'ready-file bootstrap is never echoed')
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n')
  assert.equal(await run.exit, 0)
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false } catch { return true } }, 'owned application remains listening after Stop')
})

test('an occupied port never starts the command and revoking a pending capture stops startup', { timeout: 15000 }, async t => {
  if (process.platform !== 'linux') { t.skip('Capture preview uses Linux listener ownership'); return }
  const f = await fixture(t), existing = createServer(socket => socket.destroy())
  await new Promise<void>(resolve => existing.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => existing.close(() => resolve())))
  const address = existing.address(); assert(address && typeof address !== 'string')
  const marker = join(f.root, 'must-not-start')
  const occupied = f.run(['--port', String(address.port), '--', '/usr/bin/python3', '-c', `open(${JSON.stringify(marker)},'w').write('started')`])
  assert.equal(await occupied.exit, 1); assert.match(occupied.stderr(), /already in use/u)
  assert.equal(await access(marker).then(() => true, () => false), false)
  assert.equal(f.messages.length, 0, 'occupied port is rejected before any capture is registered')
  const port = await unusedPort(), startup = join(f.root, 'startup.py'), ended = join(f.root, 'ended')
  await writeFile(startup, `import signal,time,sys\ndef stop(*_):\n open(${JSON.stringify(ended)},'w').write('closed');sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('OWNED_STARTING',flush=True)\ntime.sleep(30)\n`)
  const pending = f.run(['--port', String(port), '--timeout', '5', '--', '/usr/bin/python3', startup])
  await until(() => pending.stdout().includes('OWNED_STARTING'), 'pending command did not start')
  f.peer()!.end()
  assert.equal(await pending.exit, 1)
  assert.equal(await readFile(ended, 'utf8'), 'closed', 'revocation terminates only the command started by this capture')
})
