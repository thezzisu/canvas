import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import headless from '@xterm/headless'
import { CoreRpc } from './core/rpc.ts'
import { closeProviderConnections, closeSpace, createSpace, installCanvasHelper, listResources, nativeSocketForSource, openTerminal,
  prepareOpenBridge, probeSource, renameSpace, renameWindow, shellQuote, sourcePythonCommand, writeRemoteBridgeRegistry, type Source } from './providers.ts'
import { readSourceFile, regularSourceFiles } from './source-file.ts'
import { removeInboxFiles, writeInboxFile } from './inbox.ts'
import type { HerdrClientTransport } from './herdr/client.ts'

const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  await done; clearTimeout(timer)
}
const exists = (path: string) => access(path).then(() => true, () => false)

test('official core over private loopback SSH shares one forward, preserves terminal IO and scopes files/helpers to that source', { timeout: 60000 }, async t => {
  const binary = process.env.CANVAS_TEST_CORE_BINARY, sshdBinary = process.env.CANVAS_TEST_SSHD_BINARY
  if (!binary || !sshdBinary) { t.skip('Set CANVAS_TEST_CORE_BINARY and CANVAS_TEST_SSHD_BINARY for isolated native loopback SSH acceptance'); return }
  const root = await mkdtemp(join(tmpdir(), 'cv-core-ssh-')), remoteHome = join(root, 'remote'), sshRoot = join(root, 'ssh'), socket = join(root, 'core.sock')
  const inputLog = join(root, 'input'), forwarding = join(root, 'forwarding.jsonl'), receiver = join(root, 'receiver.py')
  for (const path of [remoteHome, sshRoot, join(root, 'bin'), join(root, 'config/herdr-core'), join(root, 'state'), join(root, 'run')]) await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(receiver, `import os,tty,signal\ntty.setraw(0)\ndef draw(*_):\n c,r=os.get_terminal_size(1);os.write(1,('\\x1b[2J\\x1b[HCORE_SSH_FIXTURE '+str(c)+'x'+str(r)+'\\r\\n').encode())\nsignal.signal(signal.SIGWINCH,draw);draw()\nwhile True:\n value=os.read(0,65536)\n if not value:break\n with open(${JSON.stringify(inputLog)},'ab') as f:f.write(value)\n`)
  await writeFile(join(root, 'config/herdr-core/config.toml'), `shell = ["/usr/bin/python3", ${JSON.stringify(receiver)}]\nnotes = false\nheadless = "80x24"\n`)
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: remoteHome, LANG: 'C.UTF-8', TERM: 'xterm-256color', HC_SESSION: 'canvas-ssh', HC_SOCKET: socket,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run') }
  const core = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  core.stderr?.on('data', value => { diagnostics = (diagnostics + value.toString()).slice(-2000) })
  let sshd: ChildProcess | undefined, rpc: CoreRpc | undefined, client: HerdrClientTransport | undefined
  let bridge: Awaited<ReturnType<typeof prepareOpenBridge>> | undefined, removeRegistry: (() => Promise<void>) | undefined
  const handles: Awaited<ReturnType<typeof openTerminal>>[] = [], bridgeClients = new Set<Socket>()
  const bridgeServer = createServer(peer => {
    bridgeClients.add(peer); peer.on('close', () => bridgeClients.delete(peer)); peer.on('error', () => {})
    peer.on('data', data => peer.end(Buffer.concat([Buffer.from('delivered:'), Buffer.isBuffer(data) ? data : Buffer.from(data)])))
  })
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address(); assert(address && typeof address === 'object'); const port = address.port
  await new Promise<void>(resolve => portServer.close(() => resolve()))
  const user = userInfo().username, previousPath = process.env.PATH
  const source: Source = { id: `core-ssh-${randomUUID()}`, name: 'Core SSH fixture', provider: 'core', transport: 'ssh', target: `ssh://${user}@127.0.0.1:${port}`,
    herdrSocket: socket, sshIdentityFile: join(sshRoot, 'client'), sshKnownHostsFile: join(sshRoot, 'known_hosts') }
  const screen = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const text = () => Array.from({ length: screen.buffer.active.length }, (_, n) => screen.buffer.active.getLine(n)?.translateToString(true) || '').join('\n')
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) { if (await check()) return; if (core.exitCode !== null || sshd && sshd.exitCode !== null) assert.fail(`${label}: ${diagnostics}`); await delay() }
    assert.fail(`${label}: ${diagnostics}`)
  }
  t.after(async () => {
    client?.kill(); for (const handle of handles) await handle.cleanup()
    await removeRegistry?.(); await bridge?.cleanup(); await closeProviderConnections(source.id)
    for (const peer of bridgeClients) peer.destroy()
    if (bridgeServer.listening) await new Promise<void>(resolve => bridgeServer.close(() => resolve()))
    try {
      rpc ||= await CoreRpc.connect(socket, { timeoutMs: 1000 })
      const state = await rpc.call<{ terminals: Array<{ address: string; state: string }> }>('terminal.list', { all: true })
      for (const terminal of state.terminals) if (terminal.state === 'live') await rpc.call('terminal.kill', { terminal: terminal.address }, { timeoutMs: 3000 })
      await rpc.call('server.stop', {}, { timeoutMs: 1000 }).catch(() => {})
    } catch { /* Only the task-owned core may already be stopped. */ }
    rpc?.close(); await stop(core); await stop(sshd); screen.dispose()
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  })
  for (const name of ['host', 'client']) execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(sshRoot, name)])
  await writeFile(join(sshRoot, 'authorized_keys'), await readFile(join(sshRoot, 'client.pub')), { mode: 0o600 })
  const [keyType, key] = (await readFile(join(sshRoot, 'host.pub'), 'utf8')).trim().split(' ')
  await writeFile(join(sshRoot, 'known_hosts'), `[127.0.0.1]:${port} ${keyType} ${key}\n`, { mode: 0o600 })
  const forced = join(sshRoot, 'command')
  await writeFile(forced, `#!/bin/sh\nexport HOME=${shellQuote(remoteHome)}\nexport PATH=${shellQuote(join(remoteHome, '.local/bin') + ':/usr/bin:/bin')}\nexport XDG_CONFIG_HOME=${shellQuote(join(root, 'config'))}\nexport XDG_STATE_HOME=${shellQuote(join(root, 'state'))}\nexport XDG_RUNTIME_DIR=${shellQuote(join(root, 'run'))}\nexport HC_SOCKET=${shellQuote(socket)}\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 })
  await writeFile(join(sshRoot, 'config'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(sshRoot, 'host')}\nPidFile ${join(sshRoot, 'pid')}\nAuthorizedKeysFile ${join(sshRoot, 'authorized_keys')}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nAllowUsers ${user}\nAllowTcpForwarding yes\nAllowStreamLocalForwarding yes\nPermitTTY no\nForceCommand ${forced}\nLogLevel ERROR\n`)
  sshd = spawn(sshdBinary, ['-D', '-e', '-f', join(sshRoot, 'config')], { stdio: ['ignore', 'pipe', 'pipe'] })
  sshd.stderr?.on('data', value => { diagnostics = (diagnostics + value.toString()).slice(-2000) })
  // Log only selected forwarding addresses, never full command lines or auth state.
  await writeFile(join(root, 'bin/ssh'), `#!/usr/bin/python3\nimport os,sys,json\na=sys.argv[1:];forward=[a[i+1] for i,v in enumerate(a[:-1]) if v=='-L']\nif forward:\n with open(${JSON.stringify(forwarding)},'a') as f:f.write(json.dumps(forward)+'\\n')\nos.execv('/usr/bin/ssh',['ssh']+a)\n`, { mode: 0o700 })
  process.env.PATH = join(root, 'bin') + ':' + (previousPath || '/usr/bin:/bin')
  await until(async () => { try { return (await probeSource(source)).status === 'online' } catch { return false } }, 'isolated SSH/core did not start')
  assert.equal(await nativeSocketForSource(source), socket)
  const created = await createSpace(source, 'SSH space')
  await renameSpace(source, created.spaceId, 'SSH renamed'); await renameWindow(source, created.spaceId, created.windowId, 'SSH terminal')
  const resource = await listResources(source), space = resource.spaces.find(item => item.id === created.spaceId)!
  assert.equal(space.name, 'SSH renamed'); assert.equal(space.windows[0]!.name, 'SSH terminal')
  const first = await openTerminal(source, created.spaceId, created.windowId); handles.push(first)
  client = await first.connect(80, 24); client.onData(data => screen.write(data))
  await until(() => text().includes('CORE_SSH_FIXTURE'), 'native output did not cross SSH')
  const forwards = async (): Promise<string[][]> => (await readFile(forwarding, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const forwardCount = (await forwards()).length
  const second = await openTerminal(source, created.spaceId, created.windowId); handles.push(second)
  assert.equal((await listResources(source)).status, 'online'); assert.equal((await forwards()).length, forwardCount, 'handles and metadata reuse one SSH process')
  const forward = (await forwards()).at(-1)!
  assert.equal(forward.length, 1, 'core forwards one native socket')
  assert(forward[0]!.endsWith(':' + socket))
  const localForward = forward[0]!.slice(0, -socket.length - 1)
  const input = 'SSH 中文🙂 literal \\u4e3a'
  client.write(`\x1b[200~${input}\x1b[201~`)
  await until(async () => { try { return (await readFile(inputLog)).includes(Buffer.from(input)) } catch { return false } }, 'native Unicode input did not cross SSH')
  screen.resize(100, 30); client.resize(100, 30)
  await until(() => text().includes('100x30'), 'native resize did not cross SSH')
  const selected = join(remoteHome, 'source 中文.txt'), bytes = Buffer.from('Source-bound exact bytes\0\xff中文')
  await writeFile(selected, bytes)
  assert.deepEqual([...await regularSourceFiles(source, ['~/source 中文.txt', '~/missing.txt'], new AbortController().signal)], [['~/source 中文.txt', '~/source 中文.txt']])
  const file = await readSourceFile(source, '~/source 中文.txt', new AbortController().signal), chunks: Buffer[] = []
  try { for await (const chunk of file.chunks) chunks.push(Buffer.from(chunk)) } finally { await file.close() }
  assert.equal(file.filename, 'source 中文.txt'); assert.deepEqual(Buffer.concat(chunks), bytes)
  const uploaded = await writeInboxFile(source, { name: 'upload 中文.bin', size: bytes.length }, (async function* () { yield bytes })(), new AbortController().signal, () => {})
  assert(uploaded.startsWith(join(remoteHome, '.local/share/canvas/inbox/'))); assert.deepEqual(await readFile(uploaded), bytes)
  await removeInboxFiles(source, [uploaded]); assert.equal(await exists(uploaded), false)
  await installCanvasHelper(source, await readFile(new URL('../cli/canvas', import.meta.url)))
  assert.deepEqual(await readFile(join(remoteHome, '.local/bin/canvas')), await readFile(new URL('../cli/canvas', import.meta.url)))
  const bridgeSocket = join(root, 'open.sock'); await new Promise<void>(resolve => bridgeServer.listen(bridgeSocket, resolve))
  bridge = await prepareOpenBridge(source, bridgeSocket)
  assert.equal(bridge.nativeSocket, socket); assert(bridge.remoteSocket)
  removeRegistry = await writeRemoteBridgeRegistry(source, { version: 1, nativeSocket: socket, socket: bridge.remoteSocket!, secret: randomUUID().replaceAll('-', '').repeat(2) })
  const command = sourcePythonCommand(source, 'import socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.sendall(b"core-bridge");print(s.recv(100).decode())', [bridge.remoteSocket!])
  const delivered = await new Promise<string>((resolve, reject) => execFile(command.file, command.args, { env: command.env, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
  assert.equal(delivered, 'delivered:core-bridge', 'helper reverse bridge carries bytes through the selected SSH source')
  const remoteBridgeDirectory = dirname(bridge.remoteSocket!)
  await removeRegistry(); removeRegistry = undefined; await bridge.cleanup(); bridge = undefined
  assert.equal(await exists(remoteBridgeDirectory), false)
  client.kill(); await first.cleanup(); await second.cleanup(); await closeProviderConnections(source.id)
  await until(async () => !await exists(dirname(localForward)), 'forwarding socket directory was not cleaned up')
  await closeSpace(source, created.spaceId)
  assert(!(await listResources(source)).spaces.some(item => item.id === created.spaceId))
})
