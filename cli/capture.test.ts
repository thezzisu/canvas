import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const helper = fileURLToPath(new URL('./canvas', import.meta.url))
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
async function fixture(t: TestContext, holdPrepare = false) {
  const root = await mkdtemp(join(tmpdir(), 'cv-capture-cli-')), registry = join(root, 'bridges'), nativeSocket = join(root, 'native.sock')
  const capture = join(root, 'canvas')
  await copyFile(helper, capture)
  await mkdir(registry, { mode: 0o700 })
  const endpoint = join(root, 'bridge.sock'), secret = randomBytes(24).toString('base64url')
  const publicUrl = `http://127.0.0.1:31500/api/capture/${'x'.repeat(43)}/`
  const children: ChildProcess[] = [], sockets = new Set<Socket>(), messages: Record<string, unknown>[] = []
  let peer: Socket | undefined
  let prepare: (() => void) | undefined
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
          prepare = () => socket.write(JSON.stringify({ ok: true, state: 'prepared', id: 'x'.repeat(43), publicUrl }) + '\n')
          if (!holdPrepare) prepare()
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
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const child = spawn('python3', [capture, 'capture', ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8',
      HC_TERMINAL_SOCKET: nativeSocket, HC_TERMINAL_ID: 't7', CANVAS_BRIDGE_REGISTRY_DIR: registry, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout?.on('data', data => { stdout += data.toString() }); child.stderr?.on('data', data => { stderr += data.toString() })
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    return { child, exit, stdout: () => stdout, stderr: () => stderr }
  }
  return { root, publicUrl, messages, peer: () => peer, prepare: () => prepare?.(), run }
}

test('capture runs the selected command, keeps bootstrap credentials private and stops only through its owned bridge', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), port = await unusedPort(), ready = join(f.root, 'ready.json'), program = join(f.root, 'web.py')
  await writeFile(program, `import http.server,os,json,sys\ns=http.server.HTTPServer(('127.0.0.1',${port}),http.server.SimpleHTTPRequestHandler)\nfd=os.open(${JSON.stringify(ready)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,'w') as f:json.dump({'launchUrl':os.environ['CANVAS_CAPTURE_PUBLIC_URL']+'?token=bootstrap-fixture'},f)\nprint('SYNTHETIC_WEB_READY',flush=True)\ns.serve_forever()\n`)
  const run = f.run(['--port', String(port), '--bootstrap-file', ready, '--timeout', '5', '--', '/usr/bin/python3', program])
  await until(() => run.stderr().includes('Web view ready'), 'owned application did not enter Web view')
  assert.equal(f.messages[0]!.port, port)
  assert.deepEqual(f.messages[1], { action: 'ready', bootstrapUrl: f.publicUrl + '?token=bootstrap-fixture' })
  assert(run.stdout().includes('SYNTHETIC_WEB_READY'), 'ordinary stdout remains visible in the original terminal')
  assert(!run.stdout().includes('bootstrap-fixture') && !run.stderr().includes('bootstrap-fixture'), 'ready-file bootstrap is never echoed')
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n')
  assert.equal(await run.exit, 0)
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false } catch { return true } }, 'owned application remains listening after Stop')
})

test('a standalone helper without Node or sibling modules captures Python HTTP on PORT', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t)
  const tools = join(f.root, 'python-only'); await mkdir(tools); await symlink('/usr/bin/python3', join(tools, 'python3'))
  assert.equal(await access(join(f.root, 'capture.py')).then(() => true, () => false), false)
  await writeFile(join(f.root, 'synthetic.txt'), 'owned Python web content')
  const run = f.run(['--timeout', '5', '-c', 'exec python3 -m http.server "$PORT" --bind 127.0.0.1'], { PATH: tools })
  await until(() => run.stderr().includes('Web view ready'), 'Python capture did not become ready on PORT')
  const port = Number(f.messages[0]!.port)
  assert.deepEqual(f.messages[1], { action: 'ready' }); assert(port > 0 && port <= 65535)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/synthetic.txt`)).text(), 'owned Python web content')
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await run.exit, 0)
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false } catch { return true } }, 'Python application was not stopped')
})

test('PORT and child env aliases work without interpreting argv, while explicit shell mode expands its script', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), program = join(f.root, 'web.mjs'), observed = join(f.root, 'child.json')
  await writeFile(program, `import http from 'node:http';import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({port:process.env.PORT,capture:process.env.CANVAS_CAPTURE_PORT,alias:process.env.APP_PORT,composed:process.env.COMPOSED,dollar:process.env.LITERAL,args:process.argv.slice(2)}));http.createServer((req,res)=>res.end('node application')).listen(Number(process.env.APP_PORT),'127.0.0.1');`)
  const run = f.run(['--env', 'APP_PORT=$PORT', '--env', 'COMPOSED=${APP_PORT}:child', '--env', 'LITERAL=$$UNCHANGED', '--timeout', '5',
    process.execPath, program, '$PORT', '${NOT_DEFINED_IN_COMMAND}', '$(printf no-eval)'])
  await until(() => run.stderr().includes('Web view ready'), 'Node did not receive the injected port')
  const child = JSON.parse(await readFile(observed, 'utf8')), port = Number(f.messages[0]!.port)
  assert.equal(child.port, String(port)); assert.equal(child.capture, String(port)); assert.equal(child.alias, String(port))
  assert.equal(child.composed, `${port}:child`); assert.equal(child.dollar, '$UNCHANGED')
  assert.deepEqual(child.args, ['$PORT', '${NOT_DEFINED_IN_COMMAND}', '$(printf no-eval)'], 'ordinary command argv is never expanded or evaluated')
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await run.exit, 0)

  const first = f.messages.length
  const shell = f.run(['--timeout', '5', '-c', 'exec python3 -m http.server "$PORT" --bind 127.0.0.1'])
  await until(() => shell.stderr().includes('Web view ready'), 'explicit shell did not expand PORT')
  assert(Number(f.messages[first]!.port) > 0); assert.equal(f.messages[first + 1]!.port, undefined)
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await shell.exit, 0)

  const marker = join(f.root, 'undefined-must-not-start')
  const invalid = f.run(['--env', 'APP_PORT=${NOT_DEFINED_IN_CHILD_ENV}', 'python3', '-c', `open(${JSON.stringify(marker)},'w').write('started')`])
  assert.equal(await invalid.exit, 1); assert.match(invalid.stderr(), /undefined child environment variable/u)
  assert.equal(await access(marker).then(() => true, () => false), false, 'invalid env aliases fail before starting the application')
  const incompatible = f.run(['-c', 'exit 0', 'python3'])
  assert.equal(await incompatible.exit, 2); assert.match(incompatible.stderr(), /cannot be combined/u)
})

test('HTTP startup waits through 503 and an explicit probe requires 2xx at its selected path', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), program = join(f.root, 'health.mjs'), seen = join(f.root, 'probes.jsonl')
  await writeFile(program, `import http from 'node:http';import fs from 'node:fs';let count=0;http.createServer((req,res)=>{fs.appendFileSync(${JSON.stringify(seen)},JSON.stringify({path:req.url,count:++count})+'\\n');res.writeHead(count<3?503:req.url==='/health'?204:401);res.end()}).listen(Number(process.env.PORT),'127.0.0.1');`)
  const run = f.run(['--timeout', '5', process.execPath, program])
  await until(() => run.stderr().includes('Web view ready'), 'default HTTP readiness did not recover from 503')
  assert((await readFile(seen, 'utf8')).trim().split('\n').length >= 3)
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await run.exit, 0)

  await writeFile(seen, '')
  const health = f.run(['--probe', '/health', '--timeout', '5', process.execPath, program])
  await until(() => health.stderr().includes('Web view ready'), 'explicit health probe did not become ready')
  const probes = (await readFile(seen, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert(probes.length >= 3); assert(probes.every(probe => probe.path === '/health'))
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await health.exit, 0)

  const strict = f.run(['--probe', '/', '--timeout', '0.6', process.execPath, program])
  assert.equal(await strict.exit, 1, 'a 401 response is online for default readiness but cannot satisfy an explicit 2xx probe')
  assert.match(strict.stderr(), /startup deadline/u)
})

test('TCP and bounded custom readiness use the assigned port and never expose probe output', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), program = join(f.root, 'tcp.py'), probe = join(f.root, 'probe.py'), ready = join(f.root, 'probe-ready')
  await writeFile(program, `import os,socket,time,threading\ns=socket.socket();s.bind(('127.0.0.1',int(os.environ['PORT'])));s.listen()\ndef publish():\n time.sleep(.25)\n open(${JSON.stringify(ready)},'w').write(str(s.getsockname()[1]))\nthreading.Thread(target=publish,daemon=True).start()\nwhile True:\n c,_=s.accept();c.close()\n`)
  await writeFile(probe, `import os,sys\nprint('PRIVATE_PROBE_OUTPUT')\ntry:ready=open(${JSON.stringify(ready)}).read()\nexcept FileNotFoundError:sys.exit(1)\nsys.exit(0 if ready==os.environ['PORT']==os.environ['CANVAS_CAPTURE_PORT'] else 1)\n`)
  const custom = f.run(['--probe-command', `python3 ${probe}`, '--timeout', '5', 'python3', program])
  await until(() => custom.stderr().includes('Web view ready'), 'custom readiness did not receive the assigned port')
  assert(!custom.stdout().includes('PRIVATE_PROBE_OUTPUT') && !custom.stderr().includes('PRIVATE_PROBE_OUTPUT'))
  assert.equal(Number(await readFile(ready, 'utf8')), f.messages[0]!.port)
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await custom.exit, 0)

  const first = f.messages.length, tcp = f.run(['--ready', 'tcp', '--timeout', '5', 'python3', program])
  await until(() => tcp.stderr().includes('Web view ready'), 'TCP readiness incorrectly required HTTP')
  assert(Number(f.messages[first]!.port) > 0)
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n'); assert.equal(await tcp.exit, 0)

  const timeout = f.run(['--probe-command', 'sleep 30', '--timeout', '0.3', 'python3', program])
  const started = Date.now(); assert.equal(await timeout.exit, 1); assert(Date.now() - started < 4000, 'a hung probe is bounded by the startup deadline')
})

test('Stop also closes an owned server when its shell wrapper exits before a TERM-resistant child', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), program = join(f.root, 'stubborn.py')
  await writeFile(program, "import http.server,os,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nhttp.server.HTTPServer(('127.0.0.1',int(os.environ['PORT'])),http.server.SimpleHTTPRequestHandler).serve_forever()\n")
  const run = f.run(['--timeout', '5', '-c', `trap 'exit 0' TERM; python3 '${program}' & wait`])
  await until(() => run.stderr().includes('Web view ready'), 'wrapped server did not become ready')
  const port = Number(f.messages[0]!.port)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  f.peer()!.write(JSON.stringify({ action: 'stop' }) + '\n')
  assert.equal(await run.exit, 0)
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}/`); return false } catch { return true } }, 'the server survived its exited wrapper after Stop')
})

test('capture never searches for an alternative when its assigned port is not ready', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
  const f = await fixture(t), unrelated = createHttpServer((_req, res) => res.end('unrelated service'))
  await new Promise<void>(resolve => unrelated.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => unrelated.close(() => resolve())))
  const address = unrelated.address(); assert(address && typeof address !== 'string')
  const ended = join(f.root, 'stopped'), sleeper = join(f.root, 'sleep.py')
  await writeFile(sleeper, `import signal,time,sys\ndef stop(*_):\n open(${JSON.stringify(ended)},'w').write('stopped');sys.exit(0)\nsignal.signal(signal.SIGTERM,stop);time.sleep(30)\n`)
  const run = f.run(['--timeout', '0.3', 'python3', sleeper])
  assert.equal(await run.exit, 1); assert.match(run.stderr(), /startup deadline/u)
  assert.equal(await readFile(ended, 'utf8'), 'stopped', 'failed readiness terminates the owned command')
  assert.equal(f.messages.length, 1, 'no unowned listener becomes an iframe')
  assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'unrelated service')

  const program = join(f.root, 'ambiguous.mjs'), portsFile = join(f.root, 'ports.json')
  await writeFile(program, `import http from 'node:http';import fs from 'node:fs';const ports=[];for(let i=0;i<2;i++){const s=http.createServer((req,res)=>res.end('owned'));s.listen(0,'127.0.0.1',()=>{ports.push(s.address().port);if(ports.length===2)fs.writeFileSync(${JSON.stringify(portsFile)},JSON.stringify(ports))})}`)
  const ambiguous = f.run(['--timeout', '.5', process.execPath, program])
  assert.equal(await ambiguous.exit, 1); assert.match(ambiguous.stderr(), /startup deadline/u)
  for (const port of JSON.parse(await readFile(portsFile, 'utf8'))) {
    await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false } catch { return true } }, 'ignored-port command left a listening service behind')
  }
})

test('an occupied port never starts the command and revoking a pending capture stops startup', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') { t.skip('Capture uses POSIX process groups'); return }
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


test('capture enforces the declared port contract before starting a child', async t => {
  const f = await fixture(t), marker = join(f.root, 'must-not-start')
  const changed = f.run(['--env', 'PORT=1', 'python3', '-c', `open(${JSON.stringify(marker)},'w').write('started')`])
  assert.equal(await changed.exit, 1)
  assert.match(changed.stderr(), /use --port/u)
  assert.equal(await access(marker).then(() => true, () => false), false)
  const zero = f.run(['--port', '0', 'python3', '-c', 'pass'])
  assert.equal(await zero.exit, 2)
})


test('cancellation before bridge preparation never launches the command', async t => {
  const f = await fixture(t, true), marker = join(f.root, 'must-not-start')
  const run = f.run(['python3', '-c', `open(${JSON.stringify(marker)},'w').write('started')`])
  await until(() => f.messages.length === 1, 'capture never requested preparation')
  run.child.kill('SIGINT'); await delay(50); f.prepare()
  assert.equal(await run.exit, 130)
  assert.equal(await access(marker).then(() => true, () => false), false)
})

test('interrupt preserves signal exit status and cleans a resistant child without echoing argv', { timeout: 15000 }, async t => {
  const f = await fixture(t), program = join(f.root, 'resistant.py')
  const privateArgument = randomBytes(20).toString('hex')
  await writeFile(program, "import http.server,os,signal\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nhttp.server.HTTPServer(('127.0.0.1',int(os.environ['PORT'])),http.server.SimpleHTTPRequestHandler).serve_forever()\n")
  const run = f.run(['--timeout', '5', 'python3', program, privateArgument])
  await until(() => run.stderr().includes('Web view ready'), 'resistant child did not start')
  run.child.kill('SIGINT')
  assert.equal(await run.exit, 130)
  assert(!run.stderr().includes(privateArgument))
  const port = Number(f.messages[0]!.port)
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false } catch { return true } }, 'resistant child survived interrupt cleanup')
})
