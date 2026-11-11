import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import headless from '@xterm/headless'
import {
  closeRuntimeConnections,
  closeSpace,
  closeWindow,
  createSpace,
  createWindow,
  listResources,
  openTerminal,
  probeSource,
  renameSpace,
  renameWindow,
  type Source,
} from './runtimes.ts'
import { CoreRpc } from './core/rpc.ts'
import { CoreLayout } from './core/layout.ts'
import type { HerdrClientTransport } from './herdr/client.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import type { PaneContext } from '../shared/pane-context.ts'

const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  await done
  clearTimeout(timer)
}

test(
  'official core runtime retains Canvas window, pane, input, geometry, status and lifecycle behavior',
  { timeout: 60000 },
  async (t) => {
    const binary = process.env.CANVAS_TEST_CORE_BINARY
    if (!binary) {
      t.skip('Set CANVAS_TEST_CORE_BINARY to official isolated herdr-core 0.1.17+')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'cv-core-native-'))
    const socket = join(root, 'core.sock'),
      inputLog = join(root, 'input.jsonl'),
      control = join(root, 'status'),
      receiver = join(root, 'receiver.py')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      USER: 'fixture',
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      HC_SESSION: 'canvas-native',
      HC_SOCKET: socket,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_RUNTIME_DIR: join(root, 'run'),
    }
    for (const path of [join(root, 'config/herdr-core'), join(root, 'state'), join(root, 'run')])
      await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(root, '文件 (one).txt'), 'Synthetic visible file\n')
    await writeFile(
      receiver,
      `import os,sys,tty,json,signal,select\ntty.setraw(0)\nlog=open(${JSON.stringify(inputLog)},'a',buffering=1)\ncontrol=${JSON.stringify(control)}\ndef record(value):\n value['terminal']=os.environ.get('HC_TERMINAL_ID');value['pid']=os.getpid();log.write(json.dumps(value)+'\\n')\ndef draw(*_):\n cols,rows=os.get_terminal_size(1);record({'kind':'size','cols':cols,'rows':rows});os.write(1,('\\x1b[?2004h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HCORE_NATIVE_FIXTURE PID='+str(os.getpid())+'\\r\\nPROGRAM │─\\r\\n文件 (one).txt\\r\\n\\x1b]8;;https://example.test/fixture\\x1b\\\\Synthetic link\\x1b]8;;\\x1b\\\\\\r\\n').encode())\nsignal.signal(signal.SIGWINCH,draw);draw();last=None\nwhile True:\n try:\n  with open(control) as f:state=f.read().strip()\n except FileNotFoundError:state=''\n if state and state!=last:\n  last=state\n  if state=='draw':draw()\n  else:os.write(1,('\\x1b]7501;state='+state+':app=canvas-fixture\\x1b\\\\').encode())\n  record({'kind':'reported','state':state})\n if select.select([0],[],[],.03)[0]:\n  value=os.read(0,65536)\n  if not value:break\n  record({'kind':'input','hex':value.hex()})\n`,
    )
    await writeFile(
      join(root, 'config/herdr-core/config.toml'),
      `shell = ["/usr/bin/python3", ${JSON.stringify(receiver)}]\nnotes = false\nheadless = "90x25"\n`,
    )
    const core = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    core.stdout?.on('data', (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-2000)
    })
    core.stderr?.on('data', (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-2000)
    })
    let rpc: CoreRpc | undefined
    const handles: Awaited<ReturnType<typeof openTerminal>>[] = [],
      clients: HerdrClientTransport[] = []
    const source: Source = {
      id: 'core-native',
      name: 'Core native fixture',
      runtime: 'core',
      transport: 'local',
      herdrSocket: socket,
    }
    const screen = new headless.Terminal({ cols: 90, rows: 25, allowProposedApi: true })
    const screenText = () =>
      Array.from(
        { length: screen.buffer.active.length },
        (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) || '',
      ).join('\n')
    const records = async (): Promise<
      Array<{
        terminal: string
        pid: number
        kind: string
        hex?: string
        cols?: number
        rows?: number
        state?: string
      }>
    > => {
      try {
        return (await readFile(inputLog, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    }
    const until = async (
      check: () => boolean | Promise<boolean>,
      description: string,
      timeout = 12000,
    ) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await check()) return
        if (core.exitCode !== null) assert.fail(`Fixture core stopped: ${diagnostics}`)
        await delay()
      }
      assert.fail(`${description}\n${screenText()}\n${diagnostics}`)
    }
    t.after(async () => {
      for (const client of clients) client.kill()
      for (const handle of handles) await handle.cleanup()
      await closeRuntimeConnections(source.id)
      try {
        rpc ||= await CoreRpc.connect(socket, { timeoutMs: 1000 })
        const listed = await rpc.call<{ terminals: Array<{ address: string; state: string }> }>(
          'terminal.list',
          { all: true },
        )
        for (const terminal of listed.terminals)
          if (terminal.state === 'live')
            await rpc.call('terminal.kill', { terminal: terminal.address }, { timeoutMs: 3000 })
        await rpc.call('server.stop', {}, { timeoutMs: 1000 }).catch(() => {})
      } catch {
        /* The fixture may already have shut down. */
      }
      rpc?.close()
      await stop(core)
      screen.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await until(
      async () => (await listResources(source)).status === 'online',
      'isolated core did not start',
    )
    rpc = await CoreRpc.connect(socket)
    assert.equal(
      (await probeSource({ runtime: 'core', transport: 'local', herdrSocket: socket }))
        .serverVersion,
      rpc.hello.version,
    )
    const created = await createSpace(source, 'Synthetic')
    const layout = new CoreLayout(rpc)
    let resource = await listResources(source),
      space = resource.spaces.find((item) => item.id === created.spaceId)!
    assert.equal(space.name, 'Synthetic')
    assert.equal(space.windows[0]!.id, created.windowId)
    const originalPane = space.windows[0]!.panes[0]!,
      terminalId = originalPane.terminalId!
    assert(terminalId)
    assert.equal(originalPane.status, 'unknown', 'unreported programs have no guessed agent state')
    await renameSpace(source, created.spaceId, 'Renamed space')
    await renameWindow(source, created.spaceId, created.windowId, 'Renamed window')
    resource = await listResources(source)
    space = resource.spaces.find((item) => item.id === created.spaceId)!
    assert.equal(space.name, 'Renamed space')
    assert.equal(space.windows[0]!.name, 'Renamed window')
    const other = await createWindow(source, created.spaceId, 'Second window')
    assert(
      (await listResources(source)).spaces
        .find((item) => item.id === created.spaceId)!
        .windows.some((item) => item.id === other.windowId),
    )
    await closeWindow(source, created.spaceId, other.windowId)
    const handle = await openTerminal(source, created.spaceId, created.windowId)
    handles.push(handle)
    const client = await handle.connect(90, 25)
    clients.push(client)
    let frame: WindowMetadata | undefined
    client.onData((data) => screen.write(data))
    client.onFrame((metadata) => {
      frame = metadata
    })
    await until(
      () => screenText().includes('CORE_NATIVE_FIXTURE') && !!frame?.layout,
      'core first paint was not composed',
    )
    const context = (): PaneContext => {
      assert(frame?.layout)
      for (let row = 1; row < 8; row++)
        for (let column = 1; column < 8; column++) {
          const result = client.paneContext({
            column,
            row,
            cols: 90,
            rows: 25,
            layout: frame.layout,
          })
          if (result) return result
        }
      assert.fail('a painted core pane must have a safe context target')
    }
    const target = context()
    await client.paneAction(target, { action: 'rename', name: 'Pane 中文' })
    await until(
      async () =>
        (await listResources(source)).spaces
          .find((item) => item.id === created.spaceId)!
          .windows[0]!.panes.some((item) => item.name === 'Pane 中文'),
      'pane rename was not shared',
    )
    const unicode = '中文🙂 literal \\u4e3a'
    client.write(`\x1b[200~${unicode}\x1b[201~`)
    await until(
      async () =>
        (await records())
          .filter((item) => item.kind === 'input' && item.terminal === terminalId)
          .map((item) => item.hex || '')
          .join('')
          .includes(Buffer.from(unicode).toString('hex')),
      'Unicode paste did not reach native terminal intact',
    )
    const inputBefore = (await records())
      .filter((item) => item.kind === 'input' && item.terminal === terminalId)
      .map((item) => item.hex || '')
      .join('')
    client.write('\x1b[13;5u')
    await until(
      async () =>
        (await records())
          .filter((item) => item.kind === 'input' && item.terminal === terminalId)
          .map((item) => item.hex || '')
          .join('').length > inputBefore.length,
      'modified key did not reach native terminal',
    )
    const mouseBefore = (await records())
      .filter((item) => item.kind === 'input' && item.terminal === terminalId)
      .map((item) => item.hex || '')
      .join('')
    client.write('\x1b[<0;4;4M\x1b[<0;4;4m')
    await until(
      async () =>
        (await records())
          .filter((item) => item.kind === 'input' && item.terminal === terminalId)
          .map((item) => item.hex || '')
          .join('')
          .slice(mouseBefore.length)
          .includes(Buffer.from('\x1b[<0;').toString('hex')),
      'native mouse input was not routed to the painted terminal',
    )
    // Core 0.1.17 omits historical OSC 8 targets from first-paint serialization.
    // Trigger actual live program output to verify the adapter preserves supplied targets.
    await writeFile(control, 'draw')
    await until(
      async () =>
        !!(await client.content())?.some((pane) =>
          pane.links.some((link) => link.url === 'https://example.test/fixture'),
        ),
      'live OSC 8 output was not preserved',
    )
    const contentInput = (await records())
      .filter((item) => item.kind === 'input')
      .map((item) => item.hex)
      .join('')
    const content = await client.content()
    assert(
      content?.some((pane) => pane.lines.some((line) => line.includes('CORE_NATIVE_FIXTURE'))),
      'visible text is read from the current terminal',
    )
    assert(
      content?.some((pane) =>
        pane.links.some((link) => link.url === 'https://example.test/fixture'),
      ),
      'OSC 8 survives the core compositor',
    )
    await delay(80)
    assert.equal(
      (await records())
        .filter((item) => item.kind === 'input')
        .map((item) => item.hex)
        .join(''),
      contentInput,
      'visible read never scrolls or types into the native program',
    )
    await writeFile(control, 'working')
    await until(
      async () =>
        (await listResources(source)).spaces.find((item) => item.id === created.spaceId)!
          .windows[0]!.status === 'working',
      'OSC 7501 working was not projected',
    )
    await writeFile(control, 'idle')
    await until(
      async () =>
        (await listResources(source)).spaces.find((item) => item.id === created.spaceId)!
          .windows[0]!.status === 'done',
      'turn completion was not projected',
    )
    const afterDone = await layout.snapshot(),
      record = afterDone.terminals.find((item) => item.address === terminalId)!
    await layout.markSeen(terminalId, record.turn)
    assert.equal(
      (await listResources(source)).spaces.find((item) => item.id === created.spaceId)!.windows[0]!
        .status,
      'idle',
      'native shared seen label controls displayed read state',
    )
    for (const [state, expected] of [
      ['blocked', 'attention'],
      ['error', 'error'],
    ] as const) {
      await writeFile(control, state)
      await until(
        async () =>
          (await listResources(source)).spaces.find((item) => item.id === created.spaceId)!
            .windows[0]!.status === expected,
        `OSC 7501 ${state} was not projected`,
      )
    }
    await writeFile(control, 'idle')
    await client.paneAction(context(), { action: 'split-right' })
    await until(
      async () =>
        (await listResources(source)).spaces.find((item) => item.id === created.spaceId)!
          .windows[0]!.panes.length === 2 && frame?.panes.length === 2,
      'native split did not reach metadata and paint',
    )
    assert.equal(
      new Set(
        (await layout.snapshot()).terminals
          .filter((item) => item.state === 'live')
          .map((item) => item.address),
      ).size,
      2,
    )
    screen.resize(110, 32)
    client.resize(110, 32)
    await until(
      async () =>
        (await records())
          .filter((item) => item.kind === 'size')
          .some((item) => (item.cols || 0) >= 50 && item.rows === 32),
      'core pane grids did not follow resized split geometry',
    )
    const floating = await rpc.call<{ address: string }>('terminal.run', {
      argv: [],
      cwd: root,
      keep: true,
      no_parent: true,
      wait: false,
    })
    const floatingLayout = await layout.snapshot(),
      floatingTab = floatingLayout.document.spaces
        .find((space) => space.id === created.spaceId)!
        .tabs.find((tab) => tab.id === created.windowId)!
    floatingTab.root.floating = [
      { id: 'floating-fixture', edge: 'bottom', content: { terminal: floating.address } },
    ]
    await rpc.call('doc.set', {
      name: 'herdr-app',
      value: floatingLayout.document,
      version: floatingLayout.documentVersion,
    })
    await until(
      async () =>
        (await client.content())?.some(
          (pane) =>
            pane.id === 'floating-fixture' &&
            pane.lines.some((line) => line.includes('CORE_NATIVE_FIXTURE')),
        ) === true,
      'a native floating terminal was not attached and painted',
    )
    assert(frame?.layout)
    const floatingContext = client.paneContext({
      column: 55,
      row: 24,
      cols: 110,
      rows: 32,
      layout: frame.layout,
    })
    assert.equal(
      floatingContext?.paneId,
      'floating-fixture',
      'visible floating pane owns the covered split position',
    )
    const beforeFloatingClick = (await records()).length
    client.write('\x1b[<0;56;25M\x1b[<0;56;25m')
    await until(
      async () =>
        (await records())
          .slice(beforeFloatingClick)
          .some((record) => record.kind === 'input' && record.terminal === floating.address),
      'click over the covered native divider did not reach its floating terminal',
    )
    assert(
      (await records())
        .slice(beforeFloatingClick)
        .filter((record) => record.kind === 'input')
        .every((record) => record.terminal === floating.address),
      'floating click never reaches a covered terminal',
    )
    await client.paneAction(floatingContext!, { action: 'close' })
    await until(
      async () => !(await client.content())?.some((pane) => pane.id === 'floating-fixture'),
      'closing a floating pane did not restore the underlying layout',
    )
    const snapshot = await layout.snapshot()
    const originalPids = snapshot.terminals
      .filter((item) => item.state === 'live')
      .map((item) => item.pid)
    client.kill()
    await handle.cleanup()
    const cloned: Source = { ...source, id: 'core-native-clone' }
    const cloneHandle = await openTerminal(cloned, created.spaceId, created.windowId)
    handles.push(cloneHandle)
    const cloneClient = await cloneHandle.connect(2, 32)
    clients.push(cloneClient)
    const cloneScreen = new headless.Terminal({ cols: 110, rows: 32, allowProposedApi: true })
    t.after(() => cloneScreen.dispose())
    cloneClient.onData((data) => cloneScreen.write(data))
    await until(
      async () => (await cloneClient.content())?.length === 1,
      'the narrow initial view should expose one pane',
    )
    cloneClient.resize(110, 32)
    await until(
      async () =>
        (await cloneClient.content())?.filter((pane) =>
          pane.lines.some((line) => line.includes('CORE_NATIVE_FIXTURE')),
        ).length === 2,
      'expanding the initial narrow viewport must attach and paint both panes without another layout event',
    )
    await until(
      () =>
        Array.from(
          { length: cloneScreen.buffer.active.length },
          (_, i) => cloneScreen.buffer.active.getLine(i)?.translateToString(true) || '',
        )
          .join('\n')
          .includes('CORE_NATIVE_FIXTURE'),
      'a fresh source connection did not reattach the existing layout',
    )
    assert.deepEqual(
      (await layout.snapshot()).terminals
        .filter((item) => item.state === 'live')
        .map((item) => item.pid),
      originalPids,
      'reattach preserves native programs',
    )
    let cloneExit = false
    cloneClient.onExit(() => {
      cloneExit = true
    })
    const owned = (await layout.snapshot()).terminals.find((item) => item.address === terminalId)!
    assert.equal(typeof owned.pid, 'number')
    process.kill(Number(owned.pid), 'SIGTERM')
    await until(async () => {
      const recovered = (await layout.snapshot()).terminals.find(
        (item) => item.address === terminalId,
      )
      return !!recovered?.pid && recovered.pid !== owned.pid && recovered.state === 'live'
    }, 'kept terminal did not recover its private shell after owned program loss')
    const recoveredPid = (await layout.snapshot()).terminals.find(
      (item) => item.address === terminalId,
    )!.pid
    await until(
      () =>
        Array.from(
          { length: cloneScreen.buffer.active.length },
          (_, i) => cloneScreen.buffer.active.getLine(i)?.translateToString(true) || '',
        )
          .join('\n')
          .includes(`PID=${recoveredPid}`),
      'restarted terminal did not reattach its new program paint',
    )
    assert.equal(cloneExit, false, 'kept recovery does not close the Canvas window')
    cloneClient.kill()
    await cloneHandle.cleanup()
    await closeRuntimeConnections(cloned.id)
    await closeSpace(source, created.spaceId)
    assert(!(await listResources(source)).spaces.some((item) => item.id === created.spaceId))
    assert.equal(
      (await layout.snapshot()).terminals.filter((item) => item.state === 'live').length,
      0,
      'explicit close ends only the fixture terminals',
    )
  },
)
