import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveTerminalChannels, type TerminalChannel } from './terminal-channels.ts'
import { CellMirror } from '../shared/cell-wire.ts'
import { gridText, mirrorText } from './test-grid.ts'
import { terminalInputChunks } from '../web/src/utils/terminal/terminal-input-chunks.ts'
import { Store, sourceConnectionKey, type Canvas, type TerminalNode } from './state.ts'
import { CompletionReads } from './completion-reads.ts'
import { CaptureService } from './capture.ts'
import { LiveTerminal, PASTE_SETTLE_QUIET_MS, TerminalManager } from './terminals.ts'
import type { HerdrClientTransport } from './herdr/client.ts'
import type { FrameData } from './herdr/wire.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import { createSpace, createWindow, listResources, shellQuote, type Source } from './runtimes.ts'
import type { CanvasNotification } from '../shared/notification.ts'
import { herdrApiRequest } from './herdr/api.ts'

/** One cell message, as the browser's mirror stood after applying it. */
interface Cells {
  frame: boolean
  cols: number
  rows: number
  text: string
}
class Client extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  received: (string | Cells)[] = []
  mirror = new CellMirror()
  /** While set, cell messages stay in flight, as on a socket that cannot drain. */
  stalled?: (() => void)[]
  send(data: object | Uint8Array, sent?: () => void) {
    if (!(data instanceof Uint8Array)) this.received.push(JSON.stringify(data))
    else {
      const { frame } = this.mirror.apply(data)
      const { cols, rows } = this.mirror
      this.received.push({ frame, cols, rows, text: mirrorText(this.mirror).join('\n') })
    }
    if (sent) {
      if (this.stalled) this.stalled.push(sent)
      else queueMicrotask(sent)
    }
  }
  drain() {
    const sent = this.stalled ?? []
    this.stalled = undefined
    for (const done of sent) done()
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  command(data: unknown) {
    this.emit('message', JSON.parse(JSON.stringify(data)))
  }
  get socket() {
    return this as unknown as TerminalChannel
  }
}

const messages = (client: Client) =>
  client.received
    .filter((data): data is string => typeof data === 'string')
    .map((data) => JSON.parse(data))
const presentation = (client: Client) =>
  messages(client)
    .filter((item) => item.type === 'presentation')
    .at(-1)
const cells = (values: readonly (string | Cells)[]) =>
  values.filter((data): data is Cells => typeof data !== 'string')
const size = (client: Client) => ({ cols: client.mirror.cols, rows: client.mirror.rows })
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(label)
}

async function fixture(
  t: TestContext,
  probe = false,
  quietProbe = false,
  completionReads = false,
  captureLifecycle = false,
) {
  const binary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY
  if (!binary) {
    t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'cv-terminal-'))
  const config = join(root, 'config'),
    state = join(root, 'state'),
    bytes = join(root, 'input.bin')
  const prompt = 'CANVAS_TEST_SHELL>'
  let shell = process.env.CANVAS_TEST_SHELL || '/bin/sh'
  if (probe) {
    shell = join(root, 'receiver')
    writeFileSync(
      shell,
      `#!/usr/bin/python3\nimport os,tty\ntty.setraw(0)\nprint('\\x1b[?1003h${quietProbe ? '\\x1b[?2004h' : ''}READY',flush=True)\nwith open(${JSON.stringify(bytes)},'ab',buffering=0) as output:\n while True:\n  data=os.read(0,4096)\n  if not data: break\n  output.write(data)\n${quietProbe ? '' : "  print('HEX:'+data.hex(),flush=True)\n"}`,
      { mode: 0o700 },
    )
  }
  for (const flavor of ['herdr', 'herdr-dev']) {
    mkdirSync(join(config, flavor), { recursive: true })
    writeFileSync(
      join(config, flavor, 'config.toml'),
      `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\n`,
    )
  }
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    USER: process.env.USER || 'fixture',
    SHELL: shell,
    PS1: `${prompt} `,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
  }
  const session = 'terminal-test'
  const source: Source = {
    id: root,
    name: 'Fixture',
    transport: 'local',
    herdrSession: session,
    herdrSocket: join(config, 'herdr/sessions', session, 'herdr.sock'),
  }
  const server = spawn(binary, ['--session', session, 'server'], { env, stdio: 'ignore' })
  const store = completionReads || captureLifecycle ? new Store(join(root, 'canvas.db')) : undefined
  store?.put('source', source)
  const reads = completionReads && store ? new CompletionReads(store) : undefined
  const captures =
    captureLifecycle && store
      ? new CaptureService(store, {
          onChange: (sourceId, windowId) => {
            void manager.captureChanged(sourceId, windowId)
          },
        })
      : undefined
  let normalSize = { cols: 100, rows: 30 }
  const manager = new TerminalManager(
    reads,
    (source, windowId) => store?.removeWindowReferences(source, [windowId]),
    () => normalSize,
    (sourceId, windowId) => captures?.current(sourceId, windowId) ?? null,
    (source, windowId) => store?.markWindowRead(source, windowId),
  )
  const setNormalSize = (cols: number, rows: number) => {
    normalSize = { cols, rows }
    manager.refreshNormalSizes()
  }
  t.after(async () => {
    await captures?.close()
    await manager.closeAll()
    try {
      execFileSync(binary, ['--session', session, 'server', 'stop'], {
        env,
        stdio: 'ignore',
        timeout: 5000,
      })
    } catch {}
    server.kill()
    if (server.exitCode === null && server.signalCode === null)
      await new Promise<void>((resolve) => {
        server.once('exit', () => resolve())
        setTimeout(() => {
          server.kill('SIGKILL')
          resolve()
        }, 1500).unref()
      })
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })
  await waitFor(
    async () => (await listResources(source)).status === 'online',
    'isolated herdr server did not start',
  )
  await createSpace(source, 'Synthetic')
  const space = (await listResources(source)).spaces.find((item) => item.name === 'Synthetic')!
  const target = { sourceId: source.id, spaceId: space.id, windowId: space.windows[0]!.id }
  const text = async () => {
    const terminal = await manager.entries.get(`${source.id}/${target.windowId}`)
    return terminal?.grid ? gridText(terminal.grid).join('\n') : ''
  }
  const ready = () =>
    waitFor(
      async () => (await text()).includes(probe ? 'READY' : prompt),
      'native pane was not ready',
    )
  let sequence = 0
  const shellResult = async (client: Client, command: string) => {
    const path = join(root, `result-${sequence++}`)
    client.command({ type: 'input', data: `${command} > ${shellQuote(path)}\r` })
    await waitFor(
      () => existsSync(path) && readFileSync(path, 'utf8').length > 0,
      'shell result was not written',
    )
    return readFileSync(path, 'utf8').trim()
  }
  const assertSize = async (client: Client, cols: number, rows: number) => {
    await waitFor(
      () => size(client).cols === cols && size(client).rows === rows,
      'client viewport did not reach requested size',
    )
    assert.equal(
      await shellResult(client, 'stty size'),
      `${rows} ${cols - 1}`,
      'native pane does not fill its viewport except its scrollbar column',
    )
  }
  const reportAgent = (paneId: string, state: 'working' | 'idle' | 'blocked') =>
    execFileSync(
      binary,
      [
        '--session',
        session,
        'pane',
        'report-agent',
        paneId,
        '--source',
        'canvas-test',
        '--agent',
        'pi',
        '--state',
        state,
      ],
      { env, stdio: 'ignore', timeout: 5000 },
    )
  const notify = async (title: string) => {
    let result: Record<string, unknown>
    await waitFor(async () => {
      result = await herdrApiRequest(source.herdrSocket!, 'notification.show', {
        title,
        body: 'Synthetic body',
      })
      return result.reason !== 'rate_limited'
    }, 'native notification API remained rate-limited')
    return result!
  }
  return {
    root,
    bytes,
    manager,
    store,
    reads,
    captures,
    source,
    target,
    shellResult,
    assertSize,
    ready,
    text,
    reportAgent,
    notify,
    setNormalSize,
  }
}

test('a new size reaches browsers only as a frame of that size', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const client = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.ready()
  const { frame, cols, rows } = cells(client.received)[0]!
  assert.deepEqual({ frame, cols, rows }, { frame: true, cols: 100, rows: 30 })
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const mark = client.received.length
  f.setNormalSize(83, 27)
  await terminal.geometry.drain()
  assert.equal(terminal.grid, undefined, 'the grid of the previous size is never sent again')
  const late = new Client()
  await f.manager.connect(f.source, f.target, late.socket)
  assert.deepEqual(cells(late.received), [], 'a joining browser waits for the new size')
  await waitFor(() => size(client).cols === 83 && size(late).cols === 83, 'resized frame')
  const resized = cells(client.received.slice(mark))
  assert.deepEqual(
    resized.map(({ frame, cols, rows }) => ({ frame, cols, rows })),
    [{ frame: true, cols: 83, rows: 27 }],
  )
  assert.deepEqual(size(late), { cols: 83, rows: 27 })
  assert(
    !messages(client).some((message) => ['reset', 'resize'].includes(message.type)),
    'size and replacement travel in the frame alone',
  )
  client.close()
  late.close()
})

test('normal geometry starts from shared state and changes without browser focus or resize authority', async (t) => {
  const f = await fixture(t, true, true)
  if (!f) return
  f.setNormalSize(150, 40)
  const first = new Client(),
    peer = new Client()
  await f.manager.connect(f.source, f.target, first.socket)
  await f.ready()
  await f.manager.connect(f.source, f.target, peer.socket)
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  assert.deepEqual(size(first), { cols: 150, rows: 40 })
  assert.deepEqual(size(peer), { cols: 150, rows: 40 })
  assert.equal(
    messages(peer)
      .filter((message) => message.type === 'status')
      .at(-1)?.readOnly,
    true,
  )
  assert.equal(await f.manager.downloadRecipient(f.source.id, f.target.windowId), undefined)
  const writes: unknown[] = [],
    nativeResize = terminal.proc.resize.bind(terminal.proc)
  terminal.proc.resize = (cols, rows) => {
    writes.push({ cols, rows })
    nativeResize(cols, rows)
  }
  for (const viewer of [first, peer]) viewer.command({ type: 'resize', cols: 80, rows: 24 })
  f.manager.refreshNormalSizes()
  await terminal.geometry.drain()
  assert.deepEqual(
    writes,
    [],
    'browser viewport requests and unrelated shared changes cannot replace the normal size',
  )
  f.setNormalSize(120, 32)
  await terminal.geometry.drain()
  await waitFor(() => size(peer).cols === 120, 'shared edit reaches the passive browser')
  assert.deepEqual(writes, [{ cols: 120, rows: 32 }])
  assert.equal(terminal.controller, first.socket)
  assert.equal(await f.manager.downloadRecipient(f.source.id, f.target.windowId), undefined)
  const token = randomUUID()
  peer.command({ type: 'focus-resize-begin', token, cols: 90, rows: 25 })
  await waitFor(() => size(peer).cols === 90, 'temporary view owns its maximized size')
  first.command({ type: 'view-visible', visible: false })
  f.setNormalSize(160, 44)
  await terminal.geometry.drain()
  assert.equal(
    size(peer).cols,
    90,
    'normal shared edit updates only the restore baseline during maximization',
  )
  peer.command({ type: 'focus-resize-end', token })
  await waitFor(() => size(peer).cols === 160, 'restoration uses the latest shared normal size')
  const late = new Client()
  await f.manager.connect(f.source, f.target, late.socket)
  assert.deepEqual(size(late), { cols: 160, rows: 44 })
  assert.equal(
    existsSync(f.bytes) ? readFileSync(f.bytes).length : 0,
    0,
    'size changes never inject terminal input',
  )
})

test('an authenticated terminal liveness probe is answered for passive hidden views without taking input control', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const controller = new Client(),
    passive = new Client()
  await f.manager.connect(f.source, f.target, controller.socket)
  await f.ready()
  await f.manager.connect(f.source, f.target, passive.socket)
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  assert.equal(terminal.controller, controller.socket)
  passive.command({ type: 'view-visible', visible: false })
  passive.command({ type: 'ping', id: 'picker-return-1' })
  await waitFor(
    () =>
      messages(passive).some(
        (message) => message.type === 'pong' && message.id === 'picker-return-1',
      ),
    'same native terminal did not confirm liveness',
  )
  assert.deepEqual(messages(passive).slice(-1)[0], { type: 'pong', id: 'picker-return-1' })
  assert.equal(terminal.controller, controller.socket, 'liveness does not claim input control')
  assert.equal(
    await f.manager.downloadRecipient(f.source.id, f.target.windowId),
    undefined,
    'liveness does not claim the upload recipient',
  )
  assert.equal(
    existsSync(f.bytes) ? readFileSync(f.bytes).length : 0,
    0,
    'liveness does not write terminal input',
  )

  const invalid = passive.received.length
  for (const id of ['', 'has space', 'x'.repeat(65)]) passive.command({ type: 'ping', id })
  assert.equal(passive.received.length, invalid, 'invalid correlation ids are ignored')
  assert.equal(terminal.controller, controller.socket)
  controller.close()
  passive.close()
})

test('one existing native endpoint per source delivers live notifications across viewers, owner closure and reconnect', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const first = new Client(),
    duplicateView = new Client(),
    siblingView = new Client()
  const events: CanvasNotification[] = []
  const subscription = f.manager.onNotification((value) => events.push(value))
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, duplicateView.socket)
  const sibling = await createWindow(f.source, f.target.spaceId, 'Sibling')
  await f.manager.connect(f.source, { ...f.target, windowId: sibling.windowId }, siblingView.socket)
  assert.equal(
    f.manager.entries.size,
    2,
    'notifications must not create an additional native attachment',
  )
  assert.equal((await f.notify('First event')).shown, true)
  await waitFor(() => events.length === 1, 'native notification was not delivered')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(events.length, 1, 'source-wide native broadcast was duplicated per window/viewer')
  assert.deepEqual(
    { ...events[0], id: undefined },
    {
      id: undefined,
      sourceId: f.source.id,
      kind: 'custom',
      title: 'First event',
      body: 'Synthetic body',
    },
  )

  await (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!.close()
  assert.equal((await f.notify('Promoted endpoint')).shown, true)
  await waitFor(
    () => events.length === 2,
    'remaining endpoint did not take over notification intake',
  )
  assert.equal(events[1]!.title, 'Promoted endpoint')
  assert.notEqual(events[0]!.id, events[1]!.id)

  await f.manager.closeSource(f.source.id)
  assert.equal((await f.notify('Disconnected event')).shown, false)
  const reconnected = new Client()
  await f.manager.connect(f.source, f.target, reconnected.socket)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(events.length, 2, 'reconnect replayed a notification from before attachment')
  assert.equal((await f.notify('Reconnected event')).shown, true)
  await waitFor(() => events.length === 3, 'reconnected source did not deliver its next live event')
  assert.equal(events[2]!.title, 'Reconnected event')
  subscription.dispose()
  assert.equal((await f.notify('Disposed event')).shown, true)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(events.length, 3)
})

test('native agent metadata reaches both viewers and late joiners without resource polling or a second attachment', async (t) => {
  const f = await fixture(t, false, false, true)
  if (!f) return
  const notifications: CanvasNotification[] = []
  f.manager.onNotification((value) => notifications.push(value))
  const first = new Client(),
    second = new Client(),
    late = new Client()
  const metadata = (client: Client) =>
    messages(client)
      .filter((message) => message.type === 'metadata')
      .at(-1)?.window
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, second.socket)
  await f.ready()
  await waitFor(
    () => !!metadata(first)?.panes.length && !!metadata(second),
    'initial native metadata was not replayed',
  )
  second.command({ type: 'focus' })
  second.command({ type: 'input', data: '\x1b[O' })
  const paneId = metadata(first).panes[0].id
  f.reportAgent(paneId, 'working')
  await waitFor(
    () => metadata(first)?.status === 'working' && metadata(second)?.status === 'working',
    'working metadata was not pushed',
  )
  f.reportAgent(paneId, 'idle')
  await waitFor(
    () => metadata(first)?.status === 'done' && metadata(second)?.status === 'done',
    'unseen completion was not pushed',
  )
  await waitFor(
    () => notifications.some((value) => value.kind === 'done'),
    'native completion notification was not pushed',
  )
  const done = notifications.find((value) => value.kind === 'done')!
  assert.deepEqual(
    [done.sourceId, done.spaceId, done.windowId, done.paneId],
    [f.source.id, f.target.spaceId, f.target.windowId, paneId],
  )
  second.command({ type: 'focus' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(
    metadata(first).status,
    'done',
    'controller ownership incorrectly acknowledged native work',
  )
  const started = performance.now()
  second.command({ type: 'input', data: '\x1b[I' })
  second.command({ type: 'completion-fence', generation: 1 })
  await waitFor(
    () =>
      messages(second).some(
        (message) =>
          message.type === 'completion-frame' &&
          message.generation === 1 &&
          message.panes.some((pane: { completion?: unknown }) => !!pane.completion),
      ),
    'completion frame before read',
  )
  second.command({
    type: 'completion-read',
    generation: 1,
    paneId,
    ...metadata(second).panes.find((pane: { id: string }) => pane.id === paneId).completion,
  })
  await waitFor(
    () => metadata(first)?.status === 'idle' && metadata(second)?.status === 'idle',
    'native focus acknowledgement was not pushed',
  )
  t.diagnostic(
    `Native done-to-idle metadata reached both viewers in ${Math.round(performance.now() - started)}ms without resource polling`,
  )
  await f.manager.connect(f.source, f.target, late.socket)
  assert.deepEqual(metadata(late), metadata(second))
  assert.equal(f.manager.entries.size, 1, 'metadata opened another native attachment')
  assert.equal(
    await f.shellResult(second, "printf '\\033]0;Live title\\007' >&2; printf ready"),
    'ready',
  )
  // Herdr 0.9.5 can coalesce a title-only change; an agent report explicitly
  // publishes its current snapshot, whose title must reach every viewer.
  f.reportAgent(paneId, 'working')
  await waitFor(
    () => metadata(first)?.panes[0].terminalTitle === 'Live title',
    'native title snapshot was not pushed',
  )
  assert.equal(metadata(second).panes[0].terminalTitle, 'Live title')
  f.reportAgent(paneId, 'blocked')
  await waitFor(
    () => notifications.some((value) => value.kind === 'attention'),
    'native attention notification was not pushed',
  )
  assert.equal(notifications.find((value) => value.kind === 'attention')!.paneId, paneId)
})

test('native shell EOF removes every viewer before maximized cleanup without a reconnect status', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const first = new Client(),
    maximized = new Client()
  const sibling = await createWindow(f.source, f.target.spaceId, 'Still running')
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, maximized.socket)
  await f.ready()
  maximized.command({ type: 'focus-resize-begin', token: randomUUID(), cols: 130, rows: 40 })
  await waitFor(() => size(maximized).cols === 130, 'maximized viewport did not settle')
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const close = terminal.geometry.close.bind(terminal.geometry)
  let release!: () => void
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  terminal.geometry.close = async () => {
    await cleanup
    await close()
  }
  try {
    maximized.command({ type: 'input', data: '\x04' })
    await waitFor(
      () => first.readyState === 3 && maximized.readyState === 3,
      'confirmed native EOF did not immediately retire both viewers',
    )
    for (const client of [first, maximized]) {
      assert.equal(messages(client).at(-1)?.status, 'removed')
      assert.equal(
        messages(client).some((message) => ['closed', 'error'].includes(message.status)),
        false,
      )
    }
    assert.equal(f.manager.entries.size, 1, 'test did not hold the asynchronous cleanup')
  } finally {
    release()
  }
  await waitFor(() => f.manager.entries.size === 0, 'native cleanup did not finish')
  const resources = await listResources(f.source)
  assert.equal(resources.status, 'online')
  const windows = resources.spaces.flatMap((space) => space.windows)
  assert.equal(
    windows.some((window) => window.id === f.target.windowId),
    false,
  )
  assert.equal(
    windows.some((window) => window.id === sibling.windowId),
    true,
    'EOF stopped another native window',
  )
})

test('clean transport detachment remains reconnectable while its native tab exists', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const first = new Client()
  await f.manager.connect(f.source, f.target, first.socket)
  await f.ready()
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  terminal.proc.kill()
  await waitFor(
    () => first.readyState === 3 && f.manager.entries.size === 0,
    'transport did not detach',
  )
  assert.equal(messages(first).at(-1)?.status, 'closed')
  assert.equal(
    messages(first).some((message) => message.status === 'removed'),
    false,
  )
  const second = new Client()
  await f.manager.connect(f.source, f.target, second.socket)
  await f.ready()
  assert.equal(
    messages(second)
      .filter((message) => message.type === 'status')
      .at(-1)?.status,
    'connected',
  )
  assert.equal(f.manager.entries.size, 1)
})

function addWindowReferences(store: Store, sourceId: string, spaceId: string, windowId: string) {
  const node: TerminalNode = {
    id: 'first',
    type: 'terminal',
    sourceId,
    spaceId,
    windowId,
    x: 0,
    y: 0,
    width: 900,
    height: 600,
  }
  store.put<Canvas>('canvas', { id: randomUUID(), name: 'First', nodes: [node] })
  store.put<Canvas>('canvas', {
    id: randomUUID(),
    name: 'Second',
    nodes: [{ ...node, id: 'second' }],
  })
  store.setWindowSize(sourceId, windowId, { width: 900, height: 600 })
}

test('a confirmed exit during logical Canvas focus removes every reference for EOF, exit and an external close', async (t) => {
  for (const method of ['eof', 'exit', 'external'])
    await t.test(method, async (t) => {
      const f = await fixture(t, false, false, true)
      if (!f) return
      addWindowReferences(f.store!, f.source.id, f.target.spaceId, f.target.windowId)
      const controller = new Client(),
        focusedPeer = new Client()
      await f.manager.connect(f.source, f.target, controller.socket)
      await f.manager.connect(f.source, f.target, focusedPeer.socket)
      await f.ready()
      focusedPeer.command({ type: 'view-visible', visible: true, focused: true })
      assert.equal(
        (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!.controller,
        controller.socket,
        'logical focus must not take input ownership',
      )
      assert(
        f.store!.snapshot().windowReads[`${f.source.id}/${f.target.windowId}`],
        'starting read focus records the window',
      )
      if (method === 'external')
        await herdrApiRequest(f.source.herdrSocket!, 'tab.close', { tab_id: f.target.windowId })
      else controller.command({ type: 'input', data: method === 'eof' ? '\x04' : 'exit\r' })
      await waitFor(
        () => controller.readyState === 3 && focusedPeer.readyState === 3,
        'native exit did not reach both clients',
      )
      assert(f.store!.list<Canvas>('canvas').every((canvas) => canvas.nodes.length === 0))
      assert.equal(
        f.store!.snapshot().windowSizes[`${f.source.id}/${f.target.windowId}`],
        undefined,
      )
      assert.equal(
        f.store!.snapshot().windowReads[`${f.source.id}/${f.target.windowId}`],
        undefined,
      )
    })
})

test('each start of a viewer read focus records the window once in the shared store', async (t) => {
  const f = await fixture(t, false, false, true)
  if (!f) return
  const key = `${f.source.id}/${f.target.windowId}`,
    client = new Client(),
    peer = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.manager.connect(f.source, f.target, peer.socket)
  await f.ready()
  client.command({ type: 'view-visible', visible: true })
  client.command({ type: 'view-visible', visible: true, focused: 'true' })
  assert.equal(
    f.store!.snapshot().windowReads[key],
    undefined,
    'visibility alone or a malformed report is not a read',
  )
  client.command({ type: 'view-visible', visible: true, focused: true })
  const first = f.store!.snapshot().windowReads[key]!
  assert(first)
  client.command({ type: 'view-visible', visible: true, focused: true })
  assert.equal(
    f.store!.snapshot().windowReads[key],
    first,
    'a repeated report does not restart read focus',
  )
  client.command({ type: 'view-visible', visible: true, focused: false })
  peer.command({ type: 'view-visible', visible: true, focused: true })
  assert(
    f.store!.snapshot().windowReads[key]! > first,
    'another viewer starting read focus advances the shared time',
  )
})

test('unfocused, hidden, covered and disconnected viewers preserve confirmed closed-window references', async (t) => {
  for (const mode of [
    'controller-only',
    'deselected',
    'hidden',
    'covered',
    'disconnected',
    'malformed',
  ])
    await t.test(mode, async (t) => {
      const f = await fixture(t, false, false, true)
      if (!f) return
      addWindowReferences(f.store!, f.source.id, f.target.spaceId, f.target.windowId)
      const controller = new Client(),
        peer = new Client()
      await f.manager.connect(f.source, f.target, controller.socket)
      await f.manager.connect(f.source, f.target, peer.socket)
      await f.ready()
      if (mode !== 'controller-only')
        peer.command({
          type: 'view-visible',
          visible: true,
          focused: mode === 'malformed' ? 'true' : true,
        })
      if (mode === 'deselected')
        peer.command({ type: 'view-visible', visible: true, focused: false })
      if (mode === 'hidden') peer.command({ type: 'view-visible', visible: false, focused: true })
      if (mode === 'covered') {
        controller.command({ type: 'focus-resize-begin', token: randomUUID(), cols: 130, rows: 40 })
        await waitFor(() => size(controller).cols === 130, 'maximized owner did not settle')
      }
      if (mode === 'disconnected') {
        peer.close()
        peer.command({ type: 'view-visible', visible: true, focused: true })
      }
      const before = f.store!.snapshot()
      controller.command({ type: 'input', data: 'exit\r' })
      await waitFor(() => controller.readyState === 3, 'native exit did not reach remaining viewer')
      assert.deepEqual(f.store!.snapshot().canvases, before.canvases)
      assert.deepEqual(f.store!.snapshot().windowSizes, before.windowSizes)
    })
})

test('focus never cleans references after endpoint replacement or an unconfirmed transport closure', async (t) => {
  for (const mode of ['replacement', 'transport'])
    await t.test(mode, async (t) => {
      const f = await fixture(t, false, false, true)
      if (!f) return
      addWindowReferences(f.store!, f.source.id, f.target.spaceId, f.target.windowId)
      const client = new Client()
      await f.manager.connect(f.source, f.target, client.socket)
      await f.ready()
      client.command({ type: 'view-visible', visible: true, focused: true })
      const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
      if (mode === 'replacement')
        f.store!.put('source', { ...f.source, herdrSocket: '/replacement/herdr.sock' })
      const before = f.store!.snapshot()
      if (mode === 'replacement')
        await herdrApiRequest(f.source.herdrSocket!, 'tab.close', { tab_id: f.target.windowId })
      else terminal.proc.kill()
      await waitFor(() => client.readyState === 3, 'transport did not finish')
      assert.deepEqual(f.store!.snapshot().canvases, before.canvases)
      assert.deepEqual(f.store!.snapshot().windowSizes, before.windowSizes)
      assert.equal(messages(client).at(-1)?.status, mode === 'replacement' ? 'removed' : 'closed')
    })
})

test('file downloads require explicit interaction and never follow passive controller fallback', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const { manager, source, target } = f
  const first = new Client(),
    second = new Client(),
    reconnected = new Client()
  const maxToken = randomUUID()
  await manager.connect(source, target, first.socket)
  await manager.connect(source, target, second.socket)
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined)
  second.command({ type: 'focus' })
  const secondRecipient = await manager.downloadRecipient(source.id, target.windowId)
  assert.equal(secondRecipient?.socket, second.socket)
  assert.equal(secondRecipient?.isCurrent(), true)
  first.command({ type: 'focus' })
  assert.equal(secondRecipient?.isCurrent(), false)
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, first.socket)
  first.close()
  assert.equal(
    await manager.downloadRecipient(source.id, target.windowId),
    undefined,
    'passive fallback inherited file delivery',
  )
  await manager.connect(source, target, reconnected.socket)
  assert.equal(
    await manager.downloadRecipient(source.id, target.windowId),
    undefined,
    'reconnection reclaimed file delivery',
  )
  second.command({ type: 'focus' })
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, second.socket)
  reconnected.command({ type: 'focus-resize-begin', token: maxToken, cols: 120, rows: 35 })
  const maximizedRecipient = await manager.downloadRecipient(source.id, target.windowId)
  assert.equal(maximizedRecipient?.socket, reconnected.socket)
  second.command({ type: 'focus' })
  assert.equal(maximizedRecipient?.isCurrent(), true, 'paused viewer stole the file recipient')
  reconnected.close()
  assert.equal(maximizedRecipient?.isCurrent(), false)
  assert.equal(await manager.downloadRecipient(source.id, target.windowId), undefined)
})

test('one native window has one maximized view, pauses peers and restores complete snapshots and viewport', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const { manager, source, target } = f
  const first = new Client(),
    second = new Client(),
    late = new Client(),
    independent = new Client()
  const firstToken = randomUUID(),
    secondToken = randomUUID(),
    otherToken = randomUUID()
  const exitToken = randomUUID(),
    cancelToken = randomUUID(),
    latestToken = randomUUID()
  await manager.connect(source, target, first.socket)
  await manager.connect(source, target, second.socket)
  await f.ready()
  const pid = await f.shellResult(first, "printf '%s\\n' $$")
  first.command({ type: 'focus-resize-begin', token: firstToken, cols: 130, rows: 40 })
  assert.deepEqual(presentation(second), {
    type: 'presentation',
    maximized: true,
    owned: false,
    token: firstToken,
    lease: presentation(second).lease,
  })
  assert(Number.isSafeInteger(presentation(second).lease))
  await f.assertSize(first, 130, 40)
  const secondMark = second.received.length
  second.command({ type: 'focus' })
  second.command({ type: 'input', data: "printf 'BLOCKED_%s\\n' VIEW\r" })
  second.command({ type: 'resize', cols: 70, rows: 20 })
  first.command({ type: 'input', data: "printf 'CURRENT_%s\\n' SCREEN\r" })
  await waitFor(
    async () => (await f.text()).includes('CURRENT_SCREEN'),
    'owner input did not reach terminal',
  )
  assert.ok(!(await f.text()).includes('BLOCKED_VIEW'))
  assert.equal(size(first).cols, 130)
  assert.deepEqual(
    cells(second.received.slice(secondMark)),
    [],
    'paused viewer received output or size',
  )
  await manager.connect(source, target, late.socket)
  assert.equal(manager.entries.size, 1)
  assert.deepEqual(cells(late.received), [])
  assert.equal(presentation(late).maximized, true)
  await createWindow(source, target.spaceId, 'Independent')
  const other = (await listResources(source)).spaces
    .find((item) => item.id === target.spaceId)!
    .windows.find((item) => item.name === 'Independent')!
  await manager.connect(source, { ...target, windowId: other.id }, independent.socket)
  independent.command({ type: 'focus-resize-begin', token: otherToken, cols: 100, rows: 32 })
  await waitFor(
    () => presentation(independent)?.owned === true,
    'independent native window did not maximize',
  )
  assert.equal(presentation(first).owned, true)
  assert.equal(manager.entries.size, 2)

  const takeoverMark = second.received.length
  second.command({ type: 'focus-resize-begin', token: secondToken, cols: 144, rows: 44 })
  assert.equal(presentation(first).owned, false)
  await waitFor(() => presentation(second)?.owned === true, 'second view could not take over')
  const takeover = second.received.slice(takeoverMark)
  const replayIndex = takeover.findIndex(
    (data) => typeof data !== 'string' && data.frame && data.text.includes('CURRENT_SCREEN'),
  )
  const shownIndex = takeover.findIndex(
    (data) =>
      typeof data === 'string' &&
      JSON.parse(data).type === 'presentation' &&
      JSON.parse(data).owned,
  )
  assert.ok(replayIndex >= 0 && shownIndex > replayIndex, 'takeover preceded its complete frame')
  await f.assertSize(second, 144, 44)
  first.command({ type: 'focus-resize-end', token: firstToken })
  first.command({ type: 'focus-resize-update', token: firstToken, cols: 80, rows: 24 })
  await f.assertSize(second, 144, 44)

  const resumeMark = late.received.length
  second.command({ type: 'focus-resize-end', token: secondToken })
  await waitFor(() => presentation(late)?.maximized === false, 'paused viewer did not resume')
  const resumed = late.received.slice(resumeMark)
  const resume = resumed.slice(resumed.findIndex((data) => typeof data !== 'string'))
  const restored = resume[0] as Cells
  assert.deepEqual(
    { frame: restored.frame, cols: restored.cols, rows: restored.rows },
    { frame: true, cols: 100, rows: 30 },
    'a resumed view starts from a frame of the restored size',
  )
  assert.ok(restored.text.includes('CURRENT_SCREEN'))
  assert.deepEqual(
    JSON.parse(
      resume.find(
        (data) => typeof data === 'string' && JSON.parse(data).type === 'presentation',
      ) as string,
    ),
    { type: 'presentation', maximized: false, owned: false },
  )
  await f.assertSize(second, 100, 30)

  second.command({ type: 'focus-resize-begin', token: exitToken, cols: 150, rows: 45 })
  await f.assertSize(second, 150, 45)
  second.close()
  await waitFor(
    () => presentation(first)?.maximized === false,
    'disconnect did not restore and resume viewers',
  )
  first.command({ type: 'focus' })
  await f.assertSize(first, 100, 30)
  first.command({ type: 'focus-resize-begin', token: cancelToken, cols: 160, rows: 48 })
  first.command({ type: 'focus-resize-end', token: cancelToken })
  late.command({ type: 'focus-resize-begin', token: latestToken, cols: 140, rows: 42 })
  await waitFor(() => presentation(late)?.owned === true, 'rapid takeover lost the latest owner')
  await f.assertSize(late, 140, 42)
  assert.equal(presentation(first).owned, false)
  late.command({ type: 'focus-resize-end', token: latestToken })
  await waitFor(() => presentation(first)?.maximized === false, 'rapid takeover did not release')
  await f.assertSize(late, 100, 30)
  assert.equal(await f.shellResult(late, "printf '%s\\n' $$"), pid, 'native shell was replaced')
  assert.equal(presentation(independent).owned, true, 'ownership leaked across native windows')
})

test('a paused peer cancels the observed maximization without input, focus takeover or losing the shared restore size', async (t) => {
  const f = await fixture(t, true)
  if (!f) return
  const { manager, source, target } = f
  const owner = new Client(),
    peer = new Client()
  await manager.connect(source, target, owner.socket)
  await manager.connect(source, target, peer.socket)
  await f.ready()
  const token = randomUUID()
  owner.command({ type: 'focus-resize-begin', token, cols: 130, rows: 40 })
  await waitFor(() => size(owner).cols === 130, 'owner did not maximize')
  const observed = presentation(peer)
  assert(observed.maximized && !observed.owned && Number.isSafeInteger(observed.lease))
  f.setNormalSize(112, 34)
  const terminal = await manager.entries.get(`${source.id}/${target.windowId}`)!
  await terminal.geometry.drain()
  assert.equal(size(owner).cols, 130, 'persistent card geometry replaced the active maximized size')
  const before = existsSync(f.bytes) ? readFileSync(f.bytes) : Buffer.alloc(0)
  peer.command({ type: 'presentation-cancel', token, lease: observed.lease })
  peer.command({ type: 'presentation-cancel', token, lease: observed.lease })
  await waitFor(
    () => presentation(owner)?.maximized === false && presentation(peer)?.maximized === false,
    'peer cancel did not resume both views',
  )
  assert.equal(size(peer).cols, 112)
  assert.equal(size(peer).rows, 34)
  assert.equal(terminal.controller, owner.socket, 'cancel stole terminal focus')
  assert.equal((await manager.downloadRecipient(source.id, target.windowId))?.socket, owner.socket)
  assert.deepEqual(
    existsSync(f.bytes) ? readFileSync(f.bytes) : Buffer.alloc(0),
    before,
    'cancel sent terminal input',
  )
  peer.command({ type: 'presentation-cancel', token, lease: observed.lease })
  assert.equal(presentation(peer).maximized, false, 'repeated cancel reintroduced a lease')
})

test('visibility resumes and late viewers stay paused until maximized restoration finishes', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const owner = new Client(),
    peer = new Client(),
    late = new Client()
  await f.manager.connect(f.source, f.target, owner.socket)
  await f.manager.connect(f.source, f.target, peer.socket)
  await f.ready()
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const token = randomUUID()
  owner.command({ type: 'focus-resize-begin', token, cols: 130, rows: 40 })
  await terminal.geometry.drain()
  assert.equal(presentation(owner).owned, true)

  const end = terminal.geometry.end.bind(terminal.geometry)
  let restored!: () => void, release!: () => void
  const restoring = new Promise<void>((resolve) => {
    restored = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  terminal.geometry.end = async (ws, lease) => {
    await end(ws, lease)
    restored()
    await held
  }
  const ownerMark = owner.received.length,
    peerMark = peer.received.length
  try {
    owner.command({ type: 'focus-resize-end', token })
    await restoring
    assert.deepEqual(terminal.geometry.current, { cols: 100, rows: 30 })
    owner.command({ type: 'view-visible', visible: false })
    owner.command({ type: 'view-visible', visible: true })
    await f.manager.connect(f.source, f.target, late.socket)
    for (const [client, mark] of [
      [owner, ownerMark],
      [peer, peerMark],
      [late, 0],
    ] as const) {
      assert.deepEqual(
        cells(client.received.slice(mark)).filter((value) => value.cols !== 130),
        [],
        'restoring view received a premature frame',
      )
      assert.equal(presentation(client).maximized, true)
    }
  } finally {
    release()
    terminal.geometry.end = end
  }
  await waitFor(
    () => [owner, peer, late].every((client) => presentation(client)?.maximized === false),
    'restored viewers retained a stale maximized presentation',
  )
  for (const [client, mark] of [
    [owner, ownerMark],
    [peer, peerMark],
    [late, 0],
  ] as const) {
    const received = client.received.slice(mark)
    const restored = received.findIndex(
      (value) => typeof value !== 'string' && value.frame && value.cols === 100,
    )
    assert(restored >= 0)
    assert.equal((received[restored] as Cells).rows, 30)
    assert.deepEqual(
      JSON.parse(
        received
          .slice(restored + 1)
          .find(
            (data) => typeof data === 'string' && JSON.parse(data).type === 'presentation',
          ) as string,
      ),
      { type: 'presentation', maximized: false, owned: false },
    )
  }
  assert.equal(f.manager.entries.size, 1, 'restoration replaced the native attachment')
})

test('a narrow maximized viewport reaches the native pane exactly and restores its original grid', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const owner = new Client(),
    peer = new Client()
  await f.manager.connect(f.source, f.target, owner.socket)
  await f.manager.connect(f.source, f.target, peer.socket)
  await f.ready()
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const token = randomUUID()
  owner.command({ type: 'focus-resize-begin', token, cols: 14, rows: 3 })
  await terminal.geometry.drain()
  assert.deepEqual(terminal.geometry.current, { cols: 14, rows: 3 })
  await f.assertSize(owner, 14, 3)
  assert.equal(presentation(peer).owned, false)
  owner.command({ type: 'focus-resize-update', token, cols: '20', rows: null })
  await terminal.geometry.drain()
  assert.deepEqual(
    terminal.geometry.current,
    { cols: 14, rows: 3 },
    'non-numeric dimensions changed the grid',
  )
  owner.command({ type: 'focus-resize-end', token })
  await waitFor(
    () => presentation(owner)?.maximized === false && presentation(peer)?.maximized === false,
    'narrow maximization did not restore both viewers',
  )
  await f.assertSize(owner, 100, 30)
  assert.deepEqual(size(peer), { cols: 100, rows: 30 })
  assert.equal(f.manager.entries.size, 1)
})

test('stale peer cancellation cannot end a replacement lease or a takeover queued during restoration', async (t) => {
  const f = await fixture(t, true)
  if (!f) return
  const { manager, source, target } = f
  const owner = new Client(),
    peer = new Client()
  await manager.connect(source, target, owner.socket)
  await manager.connect(source, target, peer.socket)
  await f.ready()
  const token = randomUUID()
  owner.command({ type: 'focus-resize-begin', token, cols: 130, rows: 40 })
  await waitFor(() => size(owner).cols === 130, 'initial maximization failed')
  const stale = presentation(peer)
  owner.command({ type: 'focus-resize-begin', token, cols: 140, rows: 44 })
  const replacement = presentation(peer)
  assert.notEqual(
    replacement.lease,
    stale.lease,
    'server lease identity must not depend on client token uniqueness',
  )
  peer.command({ type: 'presentation-cancel', token, lease: stale.lease })
  await waitFor(() => size(owner).cols === 140, 'stale cancellation changed replacement geometry')
  assert.equal(presentation(peer).lease, replacement.lease)
  peer.command({ type: 'presentation-cancel', token, lease: replacement.lease })
  const nextToken = randomUUID()
  owner.command({ type: 'focus-resize-begin', token: nextToken, cols: 150, rows: 46 })
  const terminal = await manager.entries.get(`${source.id}/${target.windowId}`)!
  await terminal.geometry.drain()
  await waitFor(
    () => presentation(owner)?.owned === true && presentation(owner)?.token === nextToken,
    'queued restore dismissed the new owner',
  )
  await waitFor(() => size(owner).cols === 150, 'the new owner was not shown its own size')
  peer.command({ type: 'presentation-cancel', token, lease: replacement.lease })
  assert.equal(presentation(peer).token, nextToken)
  assert.equal(presentation(peer).maximized, true)
  const current = presentation(peer)
  peer.command({ type: 'presentation-cancel', token: nextToken, lease: current.lease })
  await waitFor(
    () => presentation(peer)?.maximized === false,
    'latest observed lease could not be cancelled',
  )
  assert.equal(size(peer).cols, 100)
  assert.equal(size(peer).rows, 30)
})

test('shared native terminals give late viewers the current screen, retain last resize and close without stopping herdr', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const { manager, source, target } = f
  const first = new Client(),
    second = new Client()
  await manager.connect(source, target, first.socket)
  await f.ready()
  first.command({ type: 'input', data: "printf 'SHARED_%s\\n' SCREEN\r" })
  await waitFor(
    async () => (await f.text()).includes('SHARED_SCREEN'),
    'first viewer received no output',
  )
  await manager.connect(source, target, second.socket)
  assert.equal(manager.entries.size, 1)
  assert.deepEqual(
    cells(second.received).map((value) => value.frame),
    [true],
    'a late viewer starts from one frame',
  )
  assert.ok(
    mirrorText(second.mirror).join('\n').includes('SHARED_SCREEN'),
    'late viewer received no screen',
  )
  assert.deepEqual(mirrorText(second.mirror), mirrorText(first.mirror))
  assert.deepEqual(second.mirror.cursor, first.mirror.cursor)
  assert.ok(messages(second).some((item) => item.readOnly === true))
  second.command({ type: 'focus' })
  assert.ok(messages(first).some((item) => item.readOnly === true))
  first.readyState = 2
  first.command({ type: 'focus' })
  first.command({ type: 'input', data: "printf 'BLOCKED_%s\\n' INPUT\r" })
  second.command({ type: 'input', data: "printf 'ALLOWED_%s\\n' INPUT\r" })
  await waitFor(
    async () => (await f.text()).includes('ALLOWED_INPUT'),
    'controller input did not arrive',
  )
  assert.ok(!(await f.text()).includes('BLOCKED_INPUT'))
  for (let cols = 110; cols <= 132; cols++) f.setNormalSize(cols, 42)
  await f.assertSize(second, 132, 42)
  second.command({ type: 'input', data: 'seq 1 40000\r' })
  await manager.closeAll()
  await assert.rejects(manager.connect(source, target, new Client().socket), /service is closing/)
  assert.equal(manager.entries.size, 0)
  assert.equal(
    (await listResources(source)).spaces.find((item) => item.id === target.spaceId)?.windows[0]?.id,
    target.windowId,
  )
})

test('binary mouse coordinates and UTF-8 input pass through the native herdr client', async (t) => {
  const f = await fixture(t, true)
  if (!f) return
  const { manager, source, target } = f,
    client = new Client()
  await manager.connect(source, target, client.socket)
  await f.ready()
  f.setNormalSize(220, 60)
  await waitFor(() => size(client).cols === 220, 'wide viewport was not applied')
  client.command({
    type: 'input',
    encoding: 'binary',
    data: '\x1b[M' + String.fromCharCode(67, 200, 70),
  })
  await waitFor(
    () => existsSync(f.bytes) && readFileSync(f.bytes).length >= 6,
    'legacy mouse bytes did not arrive',
  )
  const mouseBytes = readFileSync(f.bytes)
  assert.equal(
    mouseBytes.toString('hex'),
    '1b5b4d43c846',
    'borderless native pane mouse coordinates must arrive without UTF-8 expansion',
  )
  client.command({ type: 'input', data: '中文' })
  await waitFor(
    () => readFileSync(f.bytes).length >= mouseBytes.length + Buffer.byteLength('中文'),
    'UTF-8 text did not arrive',
  )
  assert.deepEqual(readFileSync(f.bytes).subarray(mouseBytes.length), Buffer.from('中文'))
})

test('explicit native right and middle input preserve Unicode paste bytes without duplicate insertion', async (t) => {
  const f = await fixture(t, true, true)
  if (!f) return
  const client = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.ready()
  const right = Buffer.from('\x1b[M"%#\x1b[M#%#')
  client.command({ type: 'input', data: '\x1b[<2;5;3M\x1b[<2;5;3m' })
  const body = '合成剪贴板 😀 literal \\u4e3a\tsecond line\rnext'
  const pasted = `\x1b[200~${body}\x1b[201~`
  client.command({ type: 'input', data: pasted })
  await waitFor(
    () =>
      existsSync(f.bytes) &&
      readFileSync(f.bytes).length >= right.length + Buffer.byteLength(pasted),
    'Unicode paste did not reach the isolated receiver',
  )
  assert.deepEqual(
    readFileSync(f.bytes),
    Buffer.concat([right, Buffer.from(pasted)]),
    'explicit right-click has one press/release, and paste neither escapes nor unescapes Unicode',
  )
  client.command({ type: 'input', data: '\x1b[<1;5;3M\x1b[<1;5;3m' })
  const middle = Buffer.from('\x1b[M!%#\x1b[M#%#')
  await waitFor(
    () => readFileSync(f.bytes).length >= right.length + Buffer.byteLength(pasted) + middle.length,
    'native middle button did not reach the receiver',
  )
  assert.deepEqual(
    readFileSync(f.bytes),
    Buffer.concat([right, Buffer.from(pasted), middle]),
    'middle input is one native press/release without a duplicate paste',
  )
})

test('capture snapshots survive native-client disposal and clear missed end events on reconnect', async (t) => {
  const f = await fixture(t, true, true, false, true)
  if (!f) return
  f.store!.addSession('creator')
  f.store!.addSession('peer')
  const messages = (client: Client) =>
    client.received
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item))
      .filter((item) => item.type === 'capture')
  const first = new Client(),
    second = new Client(),
    late = new Client()
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, second.socket)
  await f.ready()
  assert.deepEqual(
    messages(first),
    [{ type: 'capture', capture: null }],
    'every connection starts with an explicit current state',
  )
  const lease = f.captures!.prepareCapture(f.source, {
    publicBase: 'https://canvas.test/',
    windowId: f.target.windowId,
    paneId: 'pane',
    port: 12345,
    session: 'creator',
    title: 'App',
    onStop: () => lease.close(),
  })
  await lease.ready('http://127.0.0.1:12345/app?q=1#draft')
  const capture = { type: 'capture', capture: f.captures!.current(f.source.id, f.target.windowId) }
  await waitFor(
    () => messages(first).length === 2 && messages(second).length === 2,
    'existing viewers receive the capture',
  )
  assert.deepEqual(messages(first).at(-1), capture)
  await f.manager.connect(f.source, f.target, late.socket)
  await waitFor(() => messages(late).length === 1, 'a late viewer receives the current capture')
  assert.deepEqual(messages(late)[0], capture)
  const native = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  first.close()
  second.close()
  late.close()
  await native.close()
  assert.equal(f.manager.entries.size, 0, 'the temporary native renderer has been disposed')
  assert.equal(
    f.captures!.current(f.source.id, f.target.windowId)?.id,
    lease.id,
    'capture lifetime is independent of viewers',
  )
  const resumed = new Client()
  await f.manager.connect(f.source, f.target, resumed.socket)
  assert.deepEqual(
    messages(resumed),
    [capture],
    'a replacement native renderer replays the running capture',
  )
  resumed.close()
  assert(
    f.captures!.stop(lease.id, 'peer'),
    'another authenticated session can stop the shared app',
  )
  const after = new Client()
  await f.manager.connect(f.source, f.target, after.socket)
  assert.deepEqual(
    messages(after).at(-1),
    { type: 'capture', capture: null },
    'a viewer that missed closure receives authoritative absence',
  )
})

test('keyboard input typed during a paced attachment paste follows the complete paste', async (t) => {
  const f = await fixture(t, true)
  if (!f) return
  const client = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.ready()
  client.command({ type: 'focus' })
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const paste = (await f.manager.captureFilePaste(f.source.id, f.target.windowId, client.socket))!
  const started = performance.now()
  const pasting = paste([
    { text: 'A ', file: false },
    { text: "'/inbox/one.png'", file: true },
    { text: ' B', file: false },
  ])
  await waitFor(
    () => existsSync(f.bytes) && readFileSync(f.bytes).includes("one.png'"),
    'first attachment was not written',
  )
  client.command({ type: 'input', data: 'typed\r' })
  await pasting
  await waitFor(
    () => readFileSync(f.bytes).toString().endsWith('typed\r'),
    'held input was dropped',
  )
  assert.equal(
    readFileSync(f.bytes).toString(),
    "A '/inbox/one.png' Btyped\r",
    'typing and Enter never split the paste',
  )
  assert(
    performance.now() - started >= PASTE_SETTLE_QUIET_MS,
    'text after an attachment waits for settled output',
  )
  assert.equal(terminal.closed, false)
})

test('a 200000-code-unit note reaches the native pane intact in bounded chunks and one paste bracket pair', async (t) => {
  const f = await fixture(t, true, true)
  if (!f) return
  const client = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.ready()
  const body = '中文😀\0\t\n\r"\\'.repeat(20_000)
  assert.equal(body.length, 200_000)
  const input = `\x1b[200~${body}\x1b[201~`,
    expected = Buffer.from(input)
  for (const data of terminalInputChunks(input)) {
    assert(Buffer.byteLength(JSON.stringify({ type: 'input', data })) < 128 * 1024)
    client.command({ type: 'input', data })
  }
  await waitFor(
    () => existsSync(f.bytes) && readFileSync(f.bytes).length >= expected.length,
    'long note bytes were dropped',
  )
  assert.deepEqual(
    readFileSync(f.bytes),
    expected,
    'native paste was truncated, Unicode was split, or Enter/brackets were duplicated',
  )
})

test('a viewport failure closes every viewer and drains restoration before reconnect', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const { manager, source, target } = f
  const first = new Client(),
    second = new Client()
  const resizeToken = randomUUID()
  await manager.connect(source, target, first.socket)
  await manager.connect(source, target, second.socket)
  await f.ready()
  first.command({ type: 'focus-resize-begin', token: resizeToken, cols: 130, rows: 40 })
  await f.assertSize(first, 130, 40)
  const terminal = (await manager.entries.get(`${source.id}/${target.windowId}`))!
  terminal.proc.resize = () => {
    throw new Error('fixture resize failure')
  }
  first.command({ type: 'focus-resize-update', token: resizeToken, cols: 140, rows: 45 })
  await waitFor(
    () => first.readyState === 3 && second.readyState === 3 && manager.entries.size === 0,
    'resize failure left the owner, paused peer or restoration queue hanging',
  )
  assert.equal(messages(first).at(-1)?.status, 'closed')
  const reconnected = new Client()
  await manager.connect(source, target, reconnected.socket)
  assert.equal(manager.entries.size, 1)
  await f.assertSize(reconnected, 100, 30)
})

test('hidden viewers stop binary traffic and resume an exact current screen without native reconnect', async (t) => {
  const f = await fixture(t)
  if (!f) return
  const first = new Client(),
    second = new Client()
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, second.socket)
  await f.ready()
  const terminal = (await f.manager.entries.get(`${f.source.id}/${f.target.windowId}`))!
  const native = terminal.proc
  first.command({ type: 'focus' })
  const recipient = await f.manager.downloadRecipient(f.source.id, f.target.windowId)
  second.command({ type: 'view-visible', visible: false })
  const mark = second.received.length
  first.command({
    type: 'input',
    data: "printf '\\033[2J\\033[H'; printf 'HIDDEN_%s\\n' OUTPUT; seq 1 70\r",
  })
  await waitFor(
    async () => (await f.text()).includes('70'),
    'background output was not incorporated',
  )
  f.setNormalSize(123, 37)
  await f.assertSize(first, 123, 37)
  assert.deepEqual(cells(second.received.slice(mark)), [])
  assert.equal(recipient?.isCurrent(), true, 'hiding another view changed the CLI recipient')
  const beforeResume = second.received.length
  for (let i = 0; i < 4; i++) {
    second.command({ type: 'view-visible', visible: true })
    second.command({ type: 'view-visible', visible: false })
  }
  second.command({ type: 'view-visible', visible: true })
  await waitFor(() => second.mirror.revision === first.mirror.revision, 'resumed view')
  assert.equal(terminal.proc, native)
  assert.equal(f.manager.entries.size, 1)
  const frames = cells(second.received.slice(beforeResume))
  assert(frames.length > 0 && frames.length <= 5, 'each resume owes at most one frame')
  assert(
    frames.every((value) => value.frame),
    'a view that was hidden resumes from a frame, never a patch',
  )
  assert.deepEqual(size(second), { cols: 123, rows: 37 })
  assert.deepEqual(mirrorText(second.mirror), gridText(terminal.grid!))
  assert.deepEqual(mirrorText(second.mirror), mirrorText(first.mirror))
  assert.deepEqual(second.mirror.cursor, first.mirror.cursor)
  const token = randomUUID()
  first.command({ type: 'focus-resize-begin', token, cols: 130, rows: 40 })
  second.command({ type: 'view-visible', visible: false })
  first.command({ type: 'focus-resize-end', token })
  await terminal.geometry.drain()
  assert.equal(presentation(second).maximized, false, 'hidden peers missed lease state')
})

test('shared completion reads follow native frame fences and persist without controlling terminal input', async (t) => {
  const f = await fixture(t, false, false, true)
  if (!f) return
  const first = new Client(),
    peer = new Client()
  await f.manager.connect(f.source, f.target, first.socket)
  await f.manager.connect(f.source, f.target, peer.socket)
  await f.ready()
  const resource = await listResources(f.source),
    paneId = resource.spaces.find((space) => space.id === f.target.spaceId)!.windows[0]!.panes[0]!
      .id
  f.reportAgent(paneId, 'working')
  await waitFor(
    () =>
      messages(first).some(
        (message) =>
          message.type === 'metadata' &&
          message.window.panes.some(
            (pane: { id: string; status: string }) =>
              pane.id === paneId && pane.status === 'working',
          ),
      ),
    'working state arrives',
  )
  f.reportAgent(paneId, 'idle')
  await waitFor(
    () =>
      messages(peer).some(
        (message) =>
          message.type === 'completion-frame' &&
          message.panes.some(
            (pane: { id: string; completion?: unknown }) => pane.id === paneId && pane.completion,
          ),
      ),
    'native completion fence arrives',
  )
  const frame = messages(peer)
    .filter((message) => message.type === 'completion-frame')
    .at(-1)
  const token = frame.panes.find((pane: { id: string }) => pane.id === paneId).completion
  assert(token)
  assert.equal(
    messages(peer)
      .filter((message) => message.type === 'status')
      .at(-1).readOnly,
    true,
  )
  peer.command({
    type: 'completion-read',
    generation: 0,
    paneId,
    ...token,
    sequence: token.sequence + 1,
  })
  assert.deepEqual(
    f.store!.get<{ read: unknown }>('completion-read', f.source.id)!.read,
    {},
    'a fabricated future sequence is rejected',
  )
  peer.command({ type: 'view-visible', visible: false })
  peer.command({ type: 'completion-read', generation: 0, paneId, ...token })
  assert.deepEqual(
    f.store!.get<{ read: unknown }>('completion-read', f.source.id)!.read,
    {},
    'hidden views cannot acknowledge',
  )
  peer.command({ type: 'view-visible', visible: true })
  await waitFor(
    () => messages(peer).filter((message) => message.type === 'completion-frame').length > 1,
    'resumed view receives a new frame fence',
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  peer.command({ type: 'completion-read', generation: 0, paneId, ...token })
  await waitFor(
    () =>
      messages(first)
        .filter((message) => message.type === 'metadata')
        .at(-1)
        ?.window.panes.find((pane: { id: string }) => pane.id === paneId)?.status === 'idle',
    'other viewer observes shared acknowledgement',
  )
  const record = f.store!.get<{ read: Record<string, number> }>('completion-read', f.source.id)!
  assert.equal(record.read[paneId], token.sequence)
  assert.equal(
    messages(peer)
      .filter((message) => message.type === 'status')
      .at(-1).readOnly,
    true,
    'viewing does not take input control',
  )
})

test('passive hover and browser focus reports leave the already-painted completion frame available for acknowledgement', async (t) => {
  for (const [name, input] of [
    ['hover', '\x1b[<35;3;3M\x1b[<63;4;3M'],
    ['focus', '\x1b[O'],
  ] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t, false, false, true)
      if (!f) return
      const client = new Client()
      await f.manager.connect(f.source, f.target, client.socket)
      await f.ready()
      const resource = await listResources(f.source),
        paneId = resource.spaces.find((space) => space.id === f.target.spaceId)!.windows[0]!
          .panes[0]!.id
      f.reportAgent(paneId, 'working')
      await waitFor(
        () =>
          messages(client).some(
            (message) =>
              message.type === 'metadata' &&
              message.window.panes.some(
                (pane: { id: string; status: string }) =>
                  pane.id === paneId && pane.status === 'working',
              ),
          ),
        'working state arrives',
      )
      f.reportAgent(paneId, 'idle')
      await waitFor(
        () =>
          messages(client).some(
            (message) =>
              message.type === 'completion-frame' &&
              message.panes.some(
                (pane: { id: string; completion?: unknown }) =>
                  pane.id === paneId && pane.completion,
              ),
          ),
        'native completion frame arrives',
      )
      const frame = messages(client)
        .filter((message) => message.type === 'completion-frame')
        .at(-1)
      const token = frame.panes.find((pane: { id: string }) => pane.id === paneId).completion
      client.command({ type: 'input', data: input })
      assert.deepEqual(
        f.store!.get<{ read: unknown }>('completion-read', f.source.id)!.read,
        {},
        `${name} itself does not mark work read`,
      )
      client.command({ type: 'completion-read', generation: frame.generation, paneId, ...token })
      await waitFor(
        () =>
          f.store!.get<{ read: Record<string, number> }>('completion-read', f.source.id)?.read[
            paneId
          ] === token.sequence,
        `${name} did not invalidate the painted read evidence`,
      )
    })
})

test('initial completed panes remain unread without replaying notifications, then a new completion notifies once', async (t) => {
  const f = await fixture(t, false, false, true)
  if (!f) return
  const resource = await listResources(f.source),
    paneId = resource.spaces.find((space) => space.id === f.target.spaceId)!.windows[0]!.panes[0]!
      .id
  f.reportAgent(paneId, 'working')
  f.reportAgent(paneId, 'idle')
  const events: CanvasNotification[] = []
  f.manager.onNotification((event) => events.push(event))
  const client = new Client()
  await f.manager.connect(f.source, f.target, client.socket)
  await f.ready()
  const current = () =>
    messages(client)
      .filter((message) => message.type === 'metadata')
      .at(-1)
      ?.window.panes.find((pane: { id: string }) => pane.id === paneId)
  await waitFor(() => !!current()?.completion, 'initial completion is represented')
  assert.equal(current().status, 'done')
  assert.equal(events.filter((event) => event.kind === 'done').length, 0)
  const initial = current().completion.sequence
  f.reportAgent(paneId, 'working')
  await waitFor(() => current()?.status === 'working', 'new task starts')
  f.reportAgent(paneId, 'idle')
  await waitFor(
    () =>
      events.some(
        (event) => event.kind === 'done' && event.completion && event.completion.sequence > initial,
      ),
    'new completion has its own notification evidence',
  )
  assert.equal(events.filter((event) => event.kind === 'done').length, 1)
})

/** A herdr client stand-in that shows whatever grid a test gives it. */
function fakeWindow(cols = 8, rows = 2) {
  type Listener<T> = (value: T) => void
  const screens = new Set<Listener<FrameData>>(),
    frames = new Set<Listener<WindowMetadata>>(),
    clipboards = new Set<Listener<string>>()
  const on =
    <T>(listeners: Set<T>) =>
    (listener: T) => {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    }
  const none = () => ({ dispose() {} })
  const sizes: { cols: number; rows: number }[] = []
  const proc: HerdrClientTransport = {
    onScreen: on(screens),
    onFrame: on(frames),
    onBell: none,
    onClipboard: on(clipboards),
    onPaneFocus: none,
    onSnapshot: none,
    onMetadata: none,
    onNotification: none,
    onExit: none,
    completionSnapshot: () => undefined,
    completionFence: async () => undefined,
    content: async () => undefined,
    paneContext: () => undefined,
    paneAction: async () => undefined,
    write() {},
    resize: (cols, rows) => void sizes.push({ cols, rows }),
    kill() {},
  }
  const source: Source = { id: 'fake', name: 'Fake', transport: 'local' }
  const terminal = new LiveTerminal(
    'fake/window',
    source.id,
    sourceConnectionKey(source),
    'space',
    'window',
    { cleanup: async () => {} } as never,
    cols,
    rows,
    () => {},
    proc,
    source,
  )
  const grid = (text: string, width = cols, height = rows): FrameData => ({
    width,
    height,
    cells: Array.from({ length: width * height }, (_, index) => ({
      symbol: text[index] ?? ' ',
      fg: 0,
      bg: 0,
      modifier: 0,
      skip: false,
      hyperlink: null,
    })),
    hyperlinks: [],
    cursor: null,
    graphics: Buffer.alloc(0),
  })
  const metadata = (layout: string): WindowMetadata => ({
    id: 'window',
    name: 'Window',
    status: 'idle',
    layout,
    panes: [],
  })
  return {
    terminal,
    sizes,
    show(text: string, width?: number, height?: number) {
      const value = grid(text, width, height)
      for (const listener of screens) listener(value)
    },
    paint: (layout: string) => {
      for (const listener of frames) listener(metadata(layout))
    },
    copy: (data: string) => {
      for (const listener of clipboards) listener(data)
    },
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const kinds = (client: Client, from = 0) =>
  client.received
    .slice(from)
    .map((data) =>
      typeof data === 'string' ? JSON.parse(data).type : data.frame ? 'FRAME' : 'PATCH',
    )

test('a browser starts from a frame, then takes patches at the revisions the window reaches', async () => {
  const f = fakeWindow(),
    client = new Client()
  f.show('one')
  f.terminal.join(client.socket)
  assert.deepEqual(kinds(client), [
    'capture',
    'pane-focus',
    'FRAME',
    'presentation',
    'status',
    'focus-resize',
  ])
  assert.deepEqual([client.mirror.revision, mirrorText(client.mirror)[0]], [1, 'one'])
  await tick()
  f.show('one')
  await tick()
  assert.equal(client.mirror.revision, 1, 'an unchanged grid sends nothing')
  f.show('two')
  await tick()
  assert.deepEqual(kinds(client, 6), ['PATCH'])
  assert.deepEqual([client.mirror.revision, mirrorText(client.mirror)[0]], [3, 'two'])
  await f.terminal.close()
})

test('a socket that cannot drain is owed only the latest grid', async () => {
  const f = fakeWindow(),
    fast = new Client(),
    slow = new Client()
  f.show('zero')
  f.terminal.join(fast.socket)
  f.terminal.join(slow.socket)
  await tick()
  slow.stalled = []
  const mark = slow.received.length
  f.show('one')
  for (const text of ['two', 'three', 'four']) {
    await tick()
    f.show(text)
    f.paint(text)
  }
  await tick()
  assert.deepEqual(kinds(slow, mark), ['PATCH'], 'nothing queues behind the message in flight')
  assert.equal(mirrorText(slow.mirror)[0], 'one')
  assert.equal(cells(fast.received).length, 5)
  slow.drain()
  await tick()
  assert.deepEqual(
    kinds(slow, mark),
    ['PATCH', 'PATCH', 'completion-frame'],
    'one patch brings it to the latest grid, then that grid may be acknowledged',
  )
  assert.equal(JSON.parse(slow.received.at(-1) as string).layout, 'four')
  assert.deepEqual(
    [slow.mirror.revision, mirrorText(slow.mirror)[0]],
    [fast.mirror.revision, 'four'],
  )
  await f.terminal.close()
})

test('a window that redraws without pause keeps one message on the shared socket and waits behind the others', async () => {
  // The browser's one socket, which here lets nothing out until told to.
  const socket = new (class extends EventEmitter {
    readyState = 1
    queue: { channel: number; sent?: () => void }[] = []
    send(data: string | Uint8Array, sent?: () => void) {
      if (typeof data !== 'string') this.queue.push({ channel: data[0]!, sent })
    }
    /** The oldest queued cell message leaves for the network. */
    flush() {
      this.queue.shift()!.sent?.()
    }
  })()
  const busy = fakeWindow(),
    quiet = fakeWindow(),
    windows = [busy, quiet]
  busy.show('zero')
  quiet.show('zero')
  serveTerminalChannels(socket as never, (channel) => windows[channel.id]!.terminal.join(channel))
  for (const channel of [0, 1])
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'open', channel, sourceId: 's', spaceId: 's', windowId: 'w' }),
      ),
      false,
    )
  const queued = () => socket.queue.map(({ channel }) => channel)
  assert.deepEqual(queued(), [0, 1], 'each window sent its frame')
  socket.flush()
  socket.flush()
  for (let i = 0; i < 500; i++) busy.show(`busy ${i}`)
  quiet.show('typed')
  for (let i = 500; i < 1000; i++) busy.show(`busy ${i}`)
  assert.deepEqual(queued(), [0, 1], 'a thousand grids queue one message')
  socket.flush()
  assert.deepEqual(queued(), [1, 0], 'its next message goes behind the other window')
  socket.flush()
  socket.flush()
  busy.show('last')
  socket.flush()
  assert.deepEqual(queued(), [])
  await Promise.all(windows.map(({ terminal }) => terminal.close()))
})

test('hidden and covered browsers get no cells and resume from a frame', async () => {
  const f = fakeWindow(),
    owner = new Client(),
    peer = new Client()
  f.show('first')
  f.terminal.join(owner.socket)
  f.terminal.join(peer.socket)
  peer.command({ type: 'view-visible', visible: false })
  await tick()
  let mark = peer.received.length
  f.show('second')
  f.copy('Y29weQ==')
  await tick()
  assert.deepEqual(kinds(peer, mark), [], 'a hidden browser gets no cells or clipboard')
  assert.deepEqual(kinds(owner).slice(-2), ['PATCH', 'clipboard'])
  assert.deepEqual(JSON.parse(owner.received.at(-1) as string), {
    type: 'clipboard',
    data: 'Y29weQ==',
  })
  f.paint('layout')
  peer.command({ type: 'view-visible', visible: true })
  assert.deepEqual(kinds(peer, mark), ['pane-focus', 'FRAME', 'completion-frame', 'presentation'])
  assert.equal(mirrorText(peer.mirror)[0], 'second')

  mark = peer.received.length
  owner.command({ type: 'focus-resize-begin', token: 'lease', cols: 8, rows: 2 })
  f.show('third')
  await tick()
  assert.deepEqual(cells(peer.received.slice(mark)), [], 'a covered browser gets no cells')
  assert.equal(mirrorText(owner.mirror)[0], 'third')
  owner.command({ type: 'focus-resize-end', token: 'lease' })
  await f.terminal.geometry.drain()
  await tick()
  assert.deepEqual(
    kinds(peer, mark).filter((kind) => ['FRAME', 'PATCH', 'presentation'].includes(kind)),
    ['presentation', 'presentation', 'FRAME', 'presentation'],
    'a released view shows the current grid before it is presented again',
  )
  assert.equal(mirrorText(peer.mirror)[0], 'third')
  await f.terminal.close()
})

test('a new size drops the old grid and every browser waits for a frame of the new one', async () => {
  const f = fakeWindow(),
    client = new Client(),
    late = new Client()
  f.show('old')
  f.terminal.join(client.socket)
  await tick()
  f.terminal.setNormalSize({ cols: 10, rows: 3 })
  await f.terminal.geometry.drain()
  assert.deepEqual(f.sizes, [{ cols: 10, rows: 3 }])
  f.terminal.join(late.socket)
  assert.deepEqual(cells(late.received), [])
  assert.deepEqual(kinds(late), ['capture', 'pane-focus', 'status', 'focus-resize'])
  f.show('new', 10, 3)
  await tick()
  for (const viewer of [client, late]) {
    assert.deepEqual(cells(viewer.received).at(-1), {
      frame: true,
      cols: 10,
      rows: 3,
      text: 'new\n\n',
    })
    assert(!kinds(viewer).some((kind) => kind === 'resize' || kind === 'reset'))
  }
  assert.deepEqual(kinds(late).slice(-2), ['FRAME', 'presentation'])
  await f.terminal.close()
})
