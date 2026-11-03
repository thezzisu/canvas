import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreRpc } from './core/rpc.ts'
import { CoreLayout } from './core/layout.ts'
import { closeProviderConnections, createSpace, listResources, type Source } from './providers.ts'

const pause = (ms = 25) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exited; clearTimeout(deadline)
}

interface TerminalFact {
  address: string
  pid: number | null
  state: string
  status: { state: string } | null
  records?: Record<string, unknown>
  turn: number
  reported: boolean
  labels: Record<string, string>
}
interface ServerFact { pid: number; holder: { pid: number; instance: string } | null }

test('official core persists native state across a core-only restart and clears lost program status without resetting shared identity', { timeout: 45000 }, async t => {
  const binary = process.env.CANVAS_TEST_CORE_BINARY
  if (!binary) { t.skip('Set CANVAS_TEST_CORE_BINARY to official isolated herdr-core 0.1.17+'); return }
  const root = await mkdtemp(join(tmpdir(), 'cv-core-persist-'))
  const socket = join(root, 'core.sock'), control = join(root, 'control'), program = join(root, 'program.py')
  const session = 'canvas-persist'
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, USER: 'fixture', LANG: 'C.UTF-8', TERM: 'xterm-256color',
    HC_SESSION: session, HC_SOCKET: socket, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'),
  }
  const source: Source = { id: 'core-persistence', name: 'Core persistence', provider: 'core', transport: 'local', herdrSocket: socket }
  for (const path of [join(root, 'config/herdr-core'), join(root, 'state'), join(root, 'run')]) await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(program, `import os,time,sys\ncontrol=${JSON.stringify(control)}\nlast=None\nos.write(1,b'CORE_PERSISTENCE_FIXTURE\\r\\n')\nwhile True:\n try:\n  with open(control) as f:value=f.read().strip()\n except FileNotFoundError:value=''\n if value and value!=last:\n  last=value\n  if value=='exit':sys.exit(0)\n  os.write(1,('\\x1b]7501;state='+value+':app=canvas-fixture\\x1b\\\\').encode())\n time.sleep(.02)\n`)
  await writeFile(join(root, 'config/herdr-core/config.toml'), `shell = ["/usr/bin/python3", ${JSON.stringify(program)}]\nnotes = false\n`)
  const cores: ChildProcess[] = []
  const ownedPids = new Set<number>()
  const remember = (pid: number | null | undefined) => { if (typeof pid === 'number') ownedPids.add(pid) }
  const start = () => { const core = spawn(binary, ['serve'], { env, stdio: 'ignore' }); cores.push(core); return core }
  let rpc: CoreRpc | undefined
  const until = async (check: () => boolean | Promise<boolean>, description: string, timeout = 12000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await check()) return; await pause() }
    assert.fail(description)
  }
  const connect = async () => {
    await until(async () => {
      try { rpc = await CoreRpc.connect(socket, { timeoutMs: 500 }); return true } catch { return false }
    }, 'the owned core did not open its private socket')
    return rpc!
  }
  t.after(async () => {
    // Every reachable object belongs to this scratch socket, never a user core.
    if (!rpc?.connected) {
      try { rpc = await CoreRpc.connect(socket, { timeoutMs: 1000 }) }
      catch {
        // A failed restart may leave a holder alive but no core; re-open only
        // this private state so its terminal.kill/server.stop path can drain it.
        start()
        try { await connect() } catch {}
      }
    }
    if (rpc?.connected) {
      try {
        const { terminals } = await rpc.call<{ terminals: TerminalFact[] }>('terminal.list', { all: true })
        const server = await rpc.call<ServerFact>('server.status')
        remember(server.holder?.pid)
        for (const terminal of terminals) {
          remember(terminal.pid)
          if (terminal.state === 'live') await rpc.call('terminal.kill', { terminal: terminal.address }, { timeoutMs: 2000 })
        }
        await rpc.call('server.stop', {}, { timeoutMs: 1000 }).catch(() => {})
      } catch { /* A failed startup can leave no reachable private server. */ }
    }
    rpc?.close()
    for (const core of cores) await stop(core)
    // PID reuse is guarded by the private program/holder path, not just a saved
    // number. No process environment or unrelated command line is printed.
    const privateProcess = async (pid: number) => {
      try { return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(root + '/') } catch { return false }
    }
    for (const pid of ownedPids) if (await privateProcess(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      const end = Date.now() + 2000
      while (Date.now() < end && await privateProcess(pid)) await pause()
      if (await privateProcess(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
      await until(async () => !await privateProcess(pid), 'an owned fixture program did not stop', 2000)
    }
    await closeProviderConnections(source.id)
    await rm(root, { recursive: true, force: true })
  })

  const first = start()
  await connect()
  const created = await createSpace(source, 'Persistent native space')
  const layout = new CoreLayout(rpc!)
  const initial = await layout.snapshot()
  const terminalId = initial.spaces.find(space => space.id === created.spaceId)!.tabs[0]!.root.children![0]!.content!.terminal!
  const get = async () => { const terminal = await rpc!.call<TerminalFact>('terminal.get', { terminal: terminalId }); remember(terminal.pid); return terminal }
  await writeFile(control, 'working')
  await until(async () => (await get()).status?.state === 'working', 'program status did not reach the core')
  await writeFile(control, 'done')
  await until(async () => (await get()).status?.state === 'done' && (await get()).turn === 1, 'completion did not reach the core registry')
  await layout.markSeen(terminalId, 1)
  const before = await get(), beforeServer = await rpc!.call<ServerFact>('server.status')
  remember(beforeServer.holder?.pid)
  const documentBefore = await rpc!.call('doc.get', { name: 'herdr-app' })
  const identity = rpc!.hello.core.id
  assert.equal(before.reported, true); assert.equal(before.labels['herdr.seen'], '1')
  assert.equal(typeof before.pid, 'number'); assert(beforeServer.holder)
  assert.equal((await listResources(source)).spaces.find(space => space.id === created.spaceId)!.windows[0]!.status, 'idle')
  // Inspect only the named contract fields; registry records may contain private env.
  const saved = JSON.parse(await readFile(join(root, 'state/herdr-core', session, 'terminals.json'), 'utf8')) as { terminals: Record<string, TerminalFact> }
  const savedTerminal = Object.values(saved.terminals).find(terminal => terminal.address === terminalId)!
  assert.equal(savedTerminal.status?.state, 'done'); assert.equal(savedTerminal.turn, 1); assert.equal(savedTerminal.labels['herdr.seen'], '1')

  await rpc!.call('server.restart')
  await until(() => first.exitCode !== null || first.signalCode !== null, 'planned core handover did not finish')
  rpc!.close()
  const second = start()
  await connect()
  assert.equal(second.exitCode, null)
  const after = await get(), afterServer = await rpc!.call<ServerFact>('server.status')
  assert.notEqual(afterServer.pid, beforeServer.pid, 'the core process itself must change')
  assert.equal(rpc!.hello.core.id, identity, 'core identity survives process restart')
  assert.equal(after.pid, before.pid, 'the existing holder program survives the core-only restart')
  assert.equal(afterServer.holder?.pid, beforeServer.holder!.pid, 'the original holder is reused')
  assert.equal(afterServer.holder?.instance, beforeServer.holder!.instance)
  assert.equal(after.status?.state, 'done'); assert.equal(after.turn, 1); assert.equal(after.reported, true)
  assert.equal(after.labels['herdr.seen'], '1')
  assert.deepEqual(await rpc!.call('doc.get', { name: 'herdr-app' }), documentBefore)
  const restored = await new CoreLayout(rpc!).snapshot()
  const restoredTerminal = restored.terminals.find(terminal => terminal.address === terminalId)!
  assert.equal(restoredTerminal.status?.state, 'done'); assert.equal(restoredTerminal.turn, 1); assert.equal(restoredTerminal.labels['herdr.seen'], '1')
  assert.equal((await listResources(source)).spaces.find(space => space.id === created.spaceId)!.windows[0]!.status, 'idle', 'a new Canvas read uses native persisted status and seen')

  await writeFile(control, '')
  process.kill(after.pid!, 'SIGTERM')
  await until(async () => { const next = await get(); return next.state === 'live' && !!next.pid && next.pid !== after.pid }, 'kept terminal did not replace the lost program with a fresh shell')
  const replacement = await get()
  assert.equal(replacement.status, null, 'a new shell cannot inherit the old program completion status')
  assert.equal(replacement.reported, false); assert.equal(replacement.turn, 1)
  assert.equal(replacement.labels['herdr.seen'], '1', 'the terminal identity and shared read label remain native records')
  assert.equal((await listResources(source)).spaces.find(space => space.id === created.spaceId)!.windows[0]!.status, 'unknown', 'persisted turn alone does not fabricate done for an unreported shell')
  await writeFile(control, 'exit')
  await until(async () => (await get()).state === 'finished', 'normal program exit should finish even a kept terminal')
  const finished = await get()
  assert.equal(finished.status, null); assert.equal(finished.turn, 1); assert.equal(finished.labels['herdr.seen'], '1')
})
