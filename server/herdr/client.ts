import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { HerdrInputRouter } from './input.ts'
import {
  applySurfacePatch,
  composedFrame,
  mouseAreas,
  paneAt,
  validateSurface,
  type ScreenSelection,
} from './screen.ts'
import {
  FrameReader,
  encodeClientMessage,
  type ClientMessage,
  type ClientShellSnapshot,
  type HostThemeUpdate,
  type PaneSurfaceFrame,
  type ServerMessage,
} from './wire.ts'
import { readWindowContent } from './content.ts'
import { windowMetadata } from './metadata.ts'
import type { PaneTitleSource } from './pane-titles.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { NativeNotification } from '../../shared/notification.ts'
import type { PaneAction, PaneContext, PanePoint } from '../../shared/pane-context.ts'
import { isTerminalHoverInput } from '../../shared/terminal-mouse.ts'
import { terminalTheme } from '../../shared/terminal-theme.ts'
import { Events, Latest } from '../channels.ts'
import {
  isClipboardPayload,
  nextPaint,
  validateViewport,
  type Screen,
  type TransportExit,
  type WindowTransport,
} from '../transport.ts'

export interface HerdrClientOptions {
  socketPath: string
  tabId: string
  cols: number
  rows: number
  handshakeTimeoutMs?: number
  /** Independent API reads leave the endpoint keyboard lane available. */
  readSelection?(params: Record<string, unknown>): Promise<unknown>
  readContent?(params: Record<string, unknown>): Promise<unknown>
  /** Pane titles from herdr's API; the endpoint snapshot carries none that are current. */
  titles?: PaneTitleSource
}
interface Request {
  boot: string
  chunks: Buffer[]
  size: number
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const MAX_BUFFER = 8 * 1024 * 1024
function parseSnapshot(data: string): ClientShellSnapshot {
  const value = JSON.parse(data) as ClientShellSnapshot
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.boot_id !== 'string' ||
    !value.boot_id ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.tabs) ||
    !Array.isArray(value.panes) ||
    value.tabs.some(
      (tab) => !tab || typeof tab.tab_id !== 'string' || typeof tab.workspace_id !== 'string',
    ) ||
    value.panes.some(
      (pane) => !pane || typeof pane.pane_id !== 'string' || typeof pane.tab_id !== 'string',
    )
  )
    throw new Error('Invalid herdr shell snapshot')
  return value
}

class HerdrClient implements WindowTransport {
  private readonly socket: Socket
  private readonly reader = new FrameReader()
  /** What the window holds; closing disposes it, which ends every subscription. */
  private readonly owned = new DisposableStack()
  readonly screen = this.owned.use(new Latest<Screen>())
  /** Metadata of the current screen, when it is safe to acknowledge. */
  readonly painted = this.owned.use(new Latest<WindowMetadata>())
  readonly metadata = this.owned.use(new Latest<WindowMetadata>((value) => JSON.stringify(value)))
  readonly paneFocus = this.owned.use(new Latest<string | undefined>((paneId) => paneId))
  readonly snapshots = this.owned.use(new Latest<void>())
  readonly copies = this.owned.use(new Events<string>())
  readonly bells = this.owned.use(new Events<string | undefined>())
  readonly notifications = this.owned.use(new Events<NativeNotification>())
  readonly exit = new Latest<TransportExit>()
  private completions?: { bootId: string; revision: number; values: Map<string, number> }
  private snapshotWindows?: WindowMetadata[]
  private completed = new Map<string, number>()
  private working = new Set<string>()
  private readonly requests = new Map<string, Request>()
  private requestLane: Promise<unknown> = Promise.resolve()
  private queuedRequests = 0
  private readonly input: HerdrInputRouter
  private snapshot?: ClientShellSnapshot
  private surface?: PaneSurfaceFrame
  private renderedMetadata?: WindowMetadata
  private renderedContent?: { surface: PaneSurfaceFrame; snapshot: ClientShellSnapshot }
  private layout = { signature: '', token: '' }
  private selection?: ScreenSelection
  private welcomed = false
  private focusRequested = false
  private focusReady = false
  private initialized = false
  private closed = false
  private writeQueue: Buffer[] = []
  private writeBytes = 0
  private writeBlocked = false
  private pendingInput: Buffer[] = []
  private pendingInputBytes = 0
  private inputFocusBarrier: Promise<void> = Promise.resolve()
  private inputFocusPending = false
  private inputFocusReady = false
  private methods = new Set<string>()
  private cols: number
  private rows: number
  private readonly deadline: ReturnType<typeof setTimeout>
  readonly connected: Promise<WindowTransport>
  private resolve!: (client: WindowTransport) => void
  private reject!: (error: Error) => void

  constructor(private readonly options: HerdrClientOptions) {
    validateViewport(options.cols, options.rows, 'herdr')
    this.cols = options.cols
    this.rows = options.rows
    this.connected = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.input = this.owned.use(
      new HerdrInputRouter({
        tabId: options.tabId,
        send: (message) => this.send(message),
        request: (method, params) => this.request(method, params),
        getSurface: () => this.surface,
        getSnapshot: () => this.snapshot,
        onCopy: (text) => this.clipboard(Buffer.from(text).toString('base64')),
        onSelection: (selection) => {
          this.selection = selection
          this.render()
        },
      }),
    )
    if (options.titles)
      this.owned.use(
        options.titles.changes.subscribe((paneIds) => {
          if (this.snapshot?.panes.some((pane) => paneIds.has(pane.pane_id))) this.updateMetadata()
        }),
      )
    this.socket = createConnection(options.socketPath)
    this.deadline = setTimeout(
      () => this.fail(new Error('Herdr endpoint handshake or tab focus timed out')),
      options.handshakeTimeoutMs ?? 15_000,
    )
    this.deadline.unref()
    this.socket.once('connect', () => {
      try {
        this.send({
          EndpointControl: {
            kind: 'endpoint.hello.v1',
            data: JSON.stringify({
              generation: 1,
              cell_width_px: 0,
              cell_height_px: 0,
              surface_size: { cols: this.cols, rows: this.rows },
              pixel_mouse: false,
              direct_graphics: false,
              endpoint_keybindings: false,
              mouse_capture: true,
              surface_active: true,
              surface_reuse: false,
              surface_delta: false,
              surface_scroll: false,
              snapshot_codecs: ['shell.snapshot.v1'],
              surface_codecs: ['shell.surface.v1'],
              input_codecs: ['shell.input.semantic.v1'],
              blob_codecs: ['shell.blob.v1'],
            }),
          },
        })
        // Programs asking for their colours are told the ones Canvas paints with.
        for (const update of [
          { Appearance: 'Dark' },
          { DefaultColor: { kind: 'Foreground', color: terminalTheme.foreground } },
          { DefaultColor: { kind: 'Background', color: terminalTheme.background } },
          { PaletteColors: terminalTheme.ansi.map((color, index) => [index, color]) },
        ] as HostThemeUpdate[])
          this.send({ ClientShellHostTheme: update })
      } catch (error) {
        this.fail(error)
      }
    })
    this.socket.on('data', (bytes) => {
      try {
        for (const message of this.reader.feed(
          typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
        )) {
          if (!this.closed) this.receive(message)
        }
      } catch (error) {
        this.fail(error)
      }
    })
    this.socket.on('drain', () => {
      this.writeBlocked = false
      this.flushWrites()
    })
    this.socket.once('error', (error) => this.fail(error))
    this.socket.once('end', () => {
      try {
        this.reader.end()
      } catch (error) {
        this.fail(error)
      }
    })
    this.socket.once('close', () => this.finish({ exitCode: this.initialized ? 0 : 1 }))
  }

  private send(message: ClientMessage) {
    if (this.closed) throw new Error('Herdr endpoint connection is closed')
    const bytes = encodeClientMessage(message)
    if (this.writeBytes + this.socket.writableLength + bytes.length > MAX_BUFFER) {
      this.fail(new Error('Herdr input buffer exceeded its limit'))
      return
    }
    this.writeQueue.push(bytes)
    this.writeBytes += bytes.length
    this.flushWrites()
  }
  private flushWrites() {
    try {
      while (!this.closed && !this.writeBlocked && this.writeQueue.length) {
        const bytes = this.writeQueue.shift()!
        this.writeBytes -= bytes.length
        this.writeBlocked = !this.socket.write(bytes)
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    valid?: () => boolean,
  ): Promise<unknown> {
    if (method === 'pane.selection.read' && this.options.readSelection) {
      const boot = this.snapshot?.boot_id
      if (this.closed || !boot)
        return Promise.reject(new Error('Herdr endpoint connection is closed'))
      return this.options.readSelection(params).then((result) => {
        if (this.closed || this.snapshot?.boot_id !== boot)
          throw new Error('Herdr endpoint changed before selection completed')
        return result
      })
    }
    if (this.queuedRequests >= 64)
      return Promise.reject(new Error('Too many pending herdr requests'))
    this.queuedRequests++
    const boot = this.snapshot?.boot_id
    const result = this.requestLane
      .then(() => {
        if (boot !== this.snapshot?.boot_id)
          throw new Error('Herdr endpoint changed before request delivery')
        if (valid && !valid()) throw new Error('Pane changed; open its menu again')
        return this.sendRequest(method, params)
      })
      .finally(() => {
        this.queuedRequests--
      })
    this.requestLane = result.catch(() => {})
    return result
  }
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const snapshot = this.snapshot
    if (this.closed || !snapshot || !this.methods.has(method))
      return Promise.reject(new Error(`Herdr endpoint method is unavailable: ${method}`))
    if (this.requests.size >= 64)
      return Promise.reject(new Error('Too many pending herdr requests'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Herdr request timed out: ${method}`))
      }, 15_000)
      timer.unref()
      this.requests.set(id, { boot: snapshot.boot_id, chunks: [], size: 0, resolve, reject, timer })
      try {
        this.send({
          ClientShellEndpointRequest: {
            boot_id: snapshot.boot_id,
            request: JSON.stringify({ id, method, params }),
          },
        })
      } catch (error) {
        clearTimeout(timer)
        this.requests.delete(id)
        reject(error)
      }
    })
  }

  private receive(message: ServerMessage) {
    if (!this.welcomed) {
      if (message.type !== 'control' || message.kind !== 'endpoint.welcome.v1')
        throw new Error('Herdr endpoint welcome is missing')
      const welcome = JSON.parse(message.data)
      if (welcome.error)
        throw new Error(
          typeof welcome.error.message === 'string'
            ? welcome.error.message
            : 'Herdr handshake rejected',
        )
      if (
        welcome.generation !== 1 ||
        welcome.snapshot_codec !== 'shell.snapshot.v1' ||
        welcome.surface_codec !== 'shell.surface.v1' ||
        welcome.input_codec !== 'shell.input.semantic.v1' ||
        welcome.blob_codec !== 'shell.blob.v1' ||
        !Array.isArray(welcome.methods)
      )
        throw new Error('Herdr server has no compatible endpoint generation 1 codecs')
      this.methods = new Set(
        welcome.methods.filter((method: unknown): method is string => typeof method === 'string'),
      )
      if (!this.methods.has('tab.focus'))
        throw new Error('Herdr server cannot focus an independent tab client')
      this.welcomed = true
      return
    }
    if (message.type === 'control') {
      if (message.kind === 'endpoint.agent-completions.v1') {
        const value = JSON.parse(message.data)
        if (
          !value ||
          typeof value.boot_id !== 'string' ||
          !Number.isSafeInteger(value.revision) ||
          value.revision < 0 ||
          !value.completions ||
          typeof value.completions !== 'object' ||
          Array.isArray(value.completions)
        )
          throw new Error('Invalid herdr completion metadata')
        const values = new Map<string, number>()
        for (const [id, sequence] of Object.entries(value.completions)) {
          if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)
            throw new Error('Invalid herdr completion sequence')
          values.set(id, sequence)
        }
        if (
          !this.completions ||
          this.completions.bootId !== value.boot_id ||
          this.completions.revision < value.revision
        )
          this.completions = { bootId: value.boot_id, revision: value.revision, values }
        return
      }
      if (message.kind !== 'shell.snapshot.v1') return
      const snapshot = parseSnapshot(message.data)
      if (this.snapshot && snapshot.boot_id !== this.snapshot.boot_id)
        throw new Error('Herdr endpoint restarted; reconnect this window')
      if (this.snapshot && snapshot.revision < this.snapshot.revision) return
      this.snapshot = snapshot
      if (!snapshot.tabs.some((tab) => tab.tab_id === this.options.tabId)) {
        this.finish({ exitCode: 0, reason: 'removed' }, new Error('Herdr tab no longer exists'))
        return
      }
      const companion =
        this.completions?.bootId === snapshot.boot_id &&
        this.completions.revision === snapshot.revision
          ? this.completions.values
          : undefined
      const present = new Set<string>()
      for (const agent of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
        if (!agent || typeof agent.pane_id !== 'string') continue
        const id = agent.pane_id,
          sequence = agent.state_change_seq
        present.add(id)
        if (agent.agent_status === 'working') {
          this.working.add(id)
          this.completed.delete(id)
          continue
        }
        const worked = this.working.delete(id)
        if (
          (agent.agent_status === 'idle' || agent.agent_status === 'done') &&
          Number.isSafeInteger(sequence) &&
          sequence >= 0 &&
          (companion
            ? companion.get(id) === sequence
            : agent.agent_status === 'done' || worked || this.completed.get(id) === sequence)
        )
          this.completed.set(id, sequence)
        else this.completed.delete(id)
      }
      for (const id of this.completed.keys()) if (!present.has(id)) this.completed.delete(id)
      for (const id of this.working) if (!present.has(id)) this.working.delete(id)
      this.snapshotWindows = undefined
      this.snapshots.set()
      this.updateMetadata()
      if (
        !this.focusRequested &&
        (!this.focusReady || snapshot.focused_tab_id !== this.options.tabId)
      ) {
        this.focusRequested = true
        this.focusReady = false
        void this.request('tab.focus', { tab_id: this.options.tabId })
          .then(() => {
            if (this.closed) return
            this.focusRequested = false
            this.focusReady = true
            this.render()
          })
          .catch((error) => this.fail(error))
      }
      this.render()
    } else if (message.type === 'surface') {
      validateSurface(message.surface)
      if (
        this.surface &&
        message.surface.boot_id === this.surface.boot_id &&
        message.surface.surface_revision <= this.surface.surface_revision
      )
        return
      this.surface = message.surface
      this.render()
    } else if (message.type === 'patch') {
      if (!this.surface) throw new Error('Herdr patch arrived before its complete surface')
      if (message.patch.surface_revision <= this.surface.surface_revision) return
      this.surface = applySurfacePatch(this.surface, message.patch)
      this.render()
    } else if (message.type === 'response') {
      const request = this.requests.get(message.request_id)
      if (!request || request.boot !== message.boot_id) return
      request.size += message.data.length
      if (request.size > MAX_BUFFER) throw new Error('Herdr endpoint response exceeded its limit')
      request.chunks.push(message.data)
      if (!message.final_chunk) return
      this.requests.delete(message.request_id)
      clearTimeout(request.timer)
      try {
        const response = JSON.parse(Buffer.concat(request.chunks).toString('utf8'))
        if (response.id !== message.request_id)
          throw new Error('Herdr endpoint response ID mismatch')
        if (response.error)
          throw new Error(
            typeof response.error.message === 'string'
              ? response.error.message
              : 'Herdr endpoint request failed',
          )
        request.resolve(response.result)
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error('Invalid herdr response'))
      }
    } else if (message.type === 'clipboard') this.clipboard(message.data)
    // herdr names no pane for a bell and sends it only to the client last used.
    else if (message.type === 'bell') this.bells.emit(undefined)
    else if (message.type === 'notification') {
      if (this.initialized) this.notifications.emit(message.notification)
    } else if (message.type === 'shutdown') this.finish({ exitCode: 0 })
    else if (message.type === 'error') throw new Error(message.message)
  }

  private coherentSurface() {
    const snapshot = this.snapshot,
      surface = this.surface
    return this.focusReady &&
      snapshot?.focused_tab_id === this.options.tabId &&
      surface?.boot_id === snapshot.boot_id &&
      surface.projection_revision === snapshot.revision &&
      surface.frame.width === this.cols &&
      surface.frame.height === this.rows
      ? surface
      : undefined
  }
  // diag: a screen held back by the gate above for a second or more, and what held it.
  private stall?: { since: number; timer: ReturnType<typeof setTimeout>; logged: boolean }
  private stallReason() {
    const snapshot = this.snapshot,
      surface = this.surface
    return JSON.stringify({
      tab: this.options.tabId,
      focusReady: this.focusReady,
      focusRequested: this.focusRequested,
      focusedTab: snapshot?.focused_tab_id,
      boot: surface?.boot_id === snapshot?.boot_id,
      projection: surface?.projection_revision,
      snapshot: snapshot?.revision,
      surface: surface && `${surface.frame.width}x${surface.frame.height}`,
      asked: `${this.cols}x${this.rows}`,
    })
  }
  private render() {
    const surface = this.coherentSurface()
    if (!surface && !this.closed && this.initialized && !this.stall) {
      const stall: { since: number; timer: ReturnType<typeof setTimeout>; logged: boolean } =
        (this.stall = {
          since: Date.now(),
          logged: false,
          timer: setTimeout(() => {
            stall.logged = true
            console.log('diag herdr screen held 1s', this.stallReason())
          }, 1000),
        })
    } else if ((surface || this.closed) && this.stall) {
      clearTimeout(this.stall.timer)
      if (this.stall.logged)
        console.log(
          `diag herdr screen released after ${Date.now() - this.stall.since}ms`,
          this.options.tabId,
        )
      this.stall = undefined
    }
    if (!surface || this.closed) return
    this.paneFocus.set(surface.panes.find((pane) => pane.focused)?.pane_id)
    this.input.refresh()
    this.renderedContent = { surface, snapshot: this.snapshot! }
    const signature = JSON.stringify([
      surface.boot_id,
      this.options.tabId,
      surface.frame.width,
      surface.frame.height,
      surface.panes.map((pane) => [pane.pane_id, pane.inner_rect]),
      surface.popup?.terminal_id,
    ])
    if (signature !== this.layout.signature) this.layout = { signature, token: randomUUID() }
    if (!this.initialized) {
      this.initialized = true
      clearTimeout(this.deadline)
      this.resolve(this)
    }
    const metadata = this.metadata.current
    this.renderedMetadata = metadata
      ? { ...metadata, layout: this.layout.token, ...(surface.popup ? { panes: [] } : {}) }
      : undefined
    const painted =
      !this.pendingInputBytes && !this.inputFocusPending && this.input.focusSettled
        ? this.renderedMetadata
        : undefined
    if (!painted) this.painted.clear()
    this.screen.set({ grid: composedFrame(surface, this.selection), mouse: mouseAreas(surface) })
    if (painted) this.painted.set(painted)
    this.flushInput()
  }
  async content() {
    const rendered = this.renderedContent
    if (this.closed || !rendered) return
    const panes = await readWindowContent(
      rendered.surface,
      rendered.snapshot,
      this.options.tabId,
      (params) =>
        this.options.readContent
          ? this.options.readContent(params)
          : Promise.reject(new Error('Pane read unavailable')),
    )
    if (this.closed) return
    return panes
  }
  paneContext(point: PanePoint): PaneContext | undefined {
    const rendered = this.renderedContent
    if (
      this.closed ||
      !rendered ||
      point.layout !== this.layout.token ||
      rendered.surface.popup ||
      this.surface?.popup ||
      point.cols !== rendered.surface.frame.width ||
      point.rows !== rendered.surface.frame.height
    )
      return
    const hit = paneAt(rendered.surface, point.column, point.row)
    const pane =
      hit &&
      this.snapshot?.panes.find(
        (pane) => pane.pane_id === hit.pane_id && pane.tab_id === this.options.tabId,
      )
    if (!pane) return
    return {
      bootId: rendered.snapshot.boot_id,
      paneId: pane.pane_id,
      name: typeof pane.label === 'string' ? pane.label : '',
    }
  }
  paneAction(
    context: PaneContext,
    action: PaneAction,
    authorized: () => boolean = () => true,
  ): Promise<unknown> {
    const valid = () =>
      authorized() &&
      !this.closed &&
      !this.surface?.popup &&
      this.snapshot?.boot_id === context.bootId &&
      !!this.snapshot.panes.some(
        (pane) => pane.pane_id === context.paneId && pane.tab_id === this.options.tabId,
      )
    if (!valid()) return Promise.reject(new Error('Pane changed; open its menu again'))
    const pane_id = context.paneId
    if (action.action === 'rename')
      return this.request('pane.rename', { pane_id, label: action.name.trim() || null }, valid)
    if (action.action === 'split-right' || action.action === 'split-down')
      return this.request(
        'pane.split',
        {
          target_pane_id: pane_id,
          direction: action.action === 'split-right' ? 'right' : 'down',
          focus: true,
        },
        valid,
      )
    return this.request(
      action.action === 'zoom' ? 'pane.zoom' : 'pane.close',
      action.action === 'zoom' ? { pane_id, mode: 'toggle' } : { pane_id },
      valid,
    )
  }
  private clipboard(data: string) {
    if (this.initialized && isClipboardPayload(data)) this.copies.emit(data)
  }
  completionSnapshot() {
    const snapshot = this.snapshot
    if (this.closed || !snapshot) return
    this.snapshotWindows ??= snapshot.tabs.map((tab) =>
      windowMetadata(snapshot, tab.tab_id, this.completed),
    )
    return {
      windows: this.snapshotWindows,
      state: { bootId: snapshot.boot_id, revision: snapshot.revision },
    }
  }
  write(data: string | Buffer) {
    if (this.closed || !this.initialized || !data.length) return
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (this.pendingInputBytes + bytes.length > MAX_BUFFER) {
      this.fail(new Error('Herdr input buffer exceeded its limit'))
      return
    }
    // Passive motion/blur cannot focus a tab. Keep it behind any active input
    // already waiting for its focus barrier, without creating another barrier.
    const hover = isTerminalHoverInput(bytes.toString())
    if (
      !this.pendingInputBytes &&
      (hover || (bytes.length === 3 && bytes.toString() === '\x1b[O'))
    ) {
      if (!hover || this.coherentSurface()) this.input.write(bytes)
      return
    }
    this.pendingInput.push(bytes)
    this.pendingInputBytes += bytes.length
    if (this.inputFocusPending || this.inputFocusReady) {
      this.flushInput()
      return
    }
    // An independent native client/API can move the server-side view before its
    // next snapshot reaches us. Establish this tab on the ordered endpoint lane
    // before releasing the input burst; never send keys to a stale visible pane.
    this.inputFocusPending = true
    this.inputFocusBarrier = this.request('tab.focus', { tab_id: this.options.tabId })
      .then(() => {
        this.inputFocusPending = false
        this.inputFocusReady = true
        this.flushInput()
      })
      .catch((error) => this.fail(error))
  }
  private flushInput() {
    if (!this.inputFocusReady || !this.coherentSurface() || this.closed) return
    this.inputFocusReady = false
    const bytes = Buffer.concat(this.pendingInput, this.pendingInputBytes)
    this.pendingInput = []
    this.pendingInputBytes = 0
    this.input.write(bytes)
    // A focus-only input can settle without another native redraw. Publish the
    // coherent frame held behind it once the existing input lane has drained.
    void this.input
      .settled()
      .then(() => this.render())
      .catch((error) => this.fail(error))
  }
  async completionFence(): Promise<WindowMetadata | undefined> {
    await this.inputFocusBarrier
    await this.input.settled()
    if (this.closed) return
    const paint = nextPaint(
      this.painted,
      this.exit,
      (metadata) =>
        metadata === this.renderedMetadata &&
        this.input.focusSettled &&
        !this.pendingInputBytes &&
        !this.inputFocusPending &&
        !!this.coherentSurface(),
    )
    this.render()
    return paint
  }
  resize(cols: number, rows: number) {
    validateViewport(cols, rows, 'herdr')
    if (this.closed || (cols === this.cols && rows === this.rows)) return
    this.cols = cols
    this.rows = rows
    this.selection = undefined
    this.send({
      ClientShellResize: {
        cell_width_px: 0,
        cell_height_px: 0,
        surface_size: { cols, rows },
        pixel_mouse: false,
      },
    })
  }
  private updateMetadata() {
    if (this.closed || !this.snapshot) return
    this.metadata.set(
      windowMetadata(this.snapshot, this.options.tabId, this.completed, this.options.titles),
    )
  }
  kill() {
    if (this.closed) return
    try {
      this.socket.end(encodeClientMessage('Detach'))
    } catch {
      /* Socket may already have ended. */
    }
    this.finish({ exitCode: 0 })
  }
  private fail(reason: unknown) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (!this.initialized) this.reject(error)
    this.finish({ exitCode: 1 }, error)
  }
  private finish(exit: TransportExit, error = new Error('Herdr endpoint connection closed')) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.deadline)
    if (!this.initialized) this.reject(error)
    this.owned.dispose()
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.requests.clear()
    this.writeQueue = []
    this.writeBytes = 0
    this.pendingInput = []
    this.pendingInputBytes = 0
    this.socket.destroy()
    this.exit.set(exit)
  }
}

export async function createHerdrClient(options: HerdrClientOptions): Promise<WindowTransport> {
  if (!options.socketPath || !options.tabId) throw new Error('Herdr socket and tab are required')
  return new HerdrClient(options).connected
}
