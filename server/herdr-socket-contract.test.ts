import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headless from '@xterm/headless'
import { herdrApiRequest } from './herdr/api.ts'
import { createHerdrClient, type HerdrClientTransport } from './herdr/client.ts'

const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exit; clearTimeout(deadline)
}

test('official TUI API and native surface use separate sockets owned by one server process', { timeout: 30000 }, async t => {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY
  if (!binary) { t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to official herdr for isolated socket acceptance'); return }
  if (process.platform !== 'linux') { t.skip('Linux SO_PEERCRED establishes listener process ownership'); return }
  const root = await mkdtemp(join(tmpdir(), 'cv-tui-contract-'))
  const config = join(root, 'config'), session = 'socket-contract'
  for (const dir of [join(config, 'herdr'), join(root, 'state'), join(root, 'run')]) await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(config, 'herdr', 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, USER: 'fixture', SHELL: '/bin/sh',
    PS1: 'SOCKET_CONTRACT_SHELL> ', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run') }
  const apiSocket = join(config, 'herdr', 'sessions', session, 'herdr.sock')
  const clientSocket = join(config, 'herdr', 'sessions', session, 'herdr-client.sock')
  // This is the only herdr process started by the fixture. All calls below are
  // native socket operations; there is no separately running TUI CLI client.
  const server = spawn(binary, ['--session', session, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  server.stdout?.on('data', value => { diagnostics = (diagnostics + value.toString()).slice(-2000) })
  server.stderr?.on('data', value => { diagnostics = (diagnostics + value.toString()).slice(-2000) })
  const screen = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  let client: HerdrClientTransport | undefined
  const text = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) || '').join('\n')
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const end = Date.now() + 10000
    while (Date.now() < end) { if (await check()) return; assert.equal(server.exitCode, null, diagnostics); await delay() }
    assert.fail(label + ': ' + diagnostics)
  }
  try {
    await until(async () => { try { await herdrApiRequest(apiSocket, 'session.snapshot', {}, { timeoutMs: 200 }); return true } catch { return false } }, 'private server API ready')
    assert.notEqual(apiSocket, clientSocket)
    const peers = JSON.parse(execFileSync('python3', ['-c', String.raw`import json,socket,struct,sys
result=[]
for path in sys.argv[1:]:
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.connect(path)
  pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
  result.append({'pid':pid,'uid':uid,'gid':gid})
print(json.dumps(result))`, apiSocket, clientSocket], { env, encoding: 'utf8', timeout: 3000 })) as Array<{ pid: number; uid: number; gid: number }>
    assert.equal(peers.length, 2)
    assert.equal(peers[0]!.pid, server.pid, 'the JSON API listener belongs to the spawned server')
    assert.deepEqual(peers[1], peers[0], 'the native endpoint listener belongs to that same server, not another client process')
    assert((await readFile(`/proc/${server.pid}/cmdline`)).includes(Buffer.from('server\0')))
    const before = await herdrApiRequest(apiSocket, 'session.snapshot')
    assert(before.snapshot && typeof before.snapshot === 'object', 'one public API socket is enough for resource discovery')
    const created = await herdrApiRequest(apiSocket, 'workspace.create', { label: 'Socket contract', focus: false })
    const tab = created.tab as { tab_id?: string } | undefined
    assert.equal(typeof tab?.tab_id, 'string')
    client = await createHerdrClient({ socketPath: clientSocket, tabId: tab!.tab_id!, cols: 80, rows: 24, handshakeTimeoutMs: 2000 })
    client.onData(data => screen.write(data))
    await until(() => text().includes('SOCKET_CONTRACT_SHELL>'), 'the native client socket supplies the live surface')
    client.write("printf 'NATIVE_%s\\n' INPUT_OK\r")
    await until(() => text().includes('NATIVE_INPUT_OK'), 'semantic input reaches the server-owned shell')
    const failedAt = Date.now()
    await assert.rejects(createHerdrClient({ socketPath: apiSocket, tabId: tab!.tab_id!, cols: 80, rows: 24, handshakeTimeoutMs: 250 }),
      /handshake|closed|frame|protocol|bytes|surface/iu, 'the bincode endpoint handshake cannot be sent to the newline-JSON API listener')
    assert(Date.now() - failedAt < 2000, 'incompatible endpoint attempt is bounded')
    const after = await herdrApiRequest(apiSocket, 'session.snapshot', {}, { timeoutMs: 1000 })
    assert((after.snapshot as { tabs: Array<{ tab_id: string }> }).tabs.some(item => item.tab_id === tab!.tab_id), 'a protocol mismatch does not affect the server or created tab')
    client.write("printf 'AFTER_%s\\n' MISMATCH\r")
    await until(() => text().includes('AFTER_MISMATCH'), 'the correct native endpoint remains usable after rejecting the wrong listener')
  } finally {
    client?.kill()
    await herdrApiRequest(apiSocket, 'server.stop', {}, { timeoutMs: 1000 }).catch(() => {})
    await stop(server)
    screen.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
