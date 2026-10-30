import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { HerdrInputRouter } from './input.ts'
import { HerdrScreen, applySurfacePatch, validateSurface, type ScreenSelection } from './screen.ts'
import { FrameReader, encodeClientMessage, type ClientMessage, type ClientShellSnapshot, type PaneSurfaceFrame, type ServerMessage } from './wire.ts'
import { readWindowContent, type NativeContentPane } from './content.ts'

export interface HerdrClientTransport {
  onData(listener: (data: string) => void): { dispose(): void }
  onPaneFocus(listener: (paneId: string | undefined) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  content(): Promise<NativeContentPane[] | undefined>
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(): void
}

export interface HerdrClientOptions {
  socketPath: string; tabId: string; cols: number; rows: number; handshakeTimeoutMs?: number
  /** Absolute, revision-checked selection reads do not mutate endpoint view state. */
  readSelection?(params: Record<string, unknown>): Promise<unknown>
}
type Exit = { exitCode: number; signal?: number }
interface Request { boot: string; chunks: Buffer[]; size: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const MAX_BUFFER = 8 * 1024 * 1024
// Semantic surfaces always use cell-based SGR mouse reports. Native pane modes
// are handled by the input router and never alter this outer terminal encoding.
export const HERDR_MOUSE_ENCODING = '\x1b[?1016l\x1b[?1006h'
const INITIAL_MODES = '\x1b[?1049h\x1b[?7l\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1002h' + HERDR_MOUSE_ENCODING + '\x1b[?1004h'

function dimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 4096 || rows > 4096 || cols * rows > 1_000_000) throw new Error('Invalid herdr viewport size')
}
function parseSnapshot(data: string): ClientShellSnapshot {
  const value = JSON.parse(data) as ClientShellSnapshot
  if (!value || typeof value !== 'object' || typeof value.boot_id !== 'string' || !value.boot_id
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.tabs) || !Array.isArray(value.panes)
    || value.tabs.some(tab => !tab || typeof tab.tab_id !== 'string' || typeof tab.workspace_id !== 'string')
    || value.panes.some(pane => !pane || typeof pane.pane_id !== 'string' || typeof pane.tab_id !== 'string')) throw new Error('Invalid herdr shell snapshot')
  return value
}

class HerdrClient implements HerdrClientTransport {
  private readonly socket: Socket
  private readonly reader = new FrameReader()
  private readonly screen = new HerdrScreen()
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly paneFocusListeners = new Set<(paneId: string | undefined) => void>()
  private focusedPaneId?: string
  private readonly exitListeners = new Set<(event: Exit) => void>()
  private readonly requests = new Map<string, Request>()
  private requestLane: Promise<unknown> = Promise.resolve()
  private queuedRequests = 0
  private readonly input: HerdrInputRouter
  private snapshot?: ClientShellSnapshot
  private surface?: PaneSurfaceFrame
  private renderedContent?: { surface: PaneSurfaceFrame; snapshot: ClientShellSnapshot }
  private selection?: ScreenSelection
  private output: string[] = []
  private outputBytes = 0
  private paused = false
  private flushing = false
  private welcomed = false
  private focusRequested = false
  private focusReady = false
  private initialized = false
  private closed = false
  private exit?: Exit
  private writeQueue: Buffer[] = []
  private writeBytes = 0
  private writeBlocked = false
  private pendingInput: Buffer[] = []
  private pendingInputBytes = 0
  private inputFocusPending = false
  private inputFocusReady = false
  private methods = new Set<string>()
  private cols: number
  private rows: number
  private readonly deadline: ReturnType<typeof setTimeout>
  readonly connected: Promise<HerdrClientTransport>
  private resolve!: (client: HerdrClientTransport) => void
  private reject!: (error: Error) => void

  constructor(private readonly options: HerdrClientOptions) {
    dimensions(options.cols, options.rows)
    this.cols = options.cols; this.rows = options.rows
    this.connected = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    this.input = new HerdrInputRouter({
      tabId: options.tabId,
      send: message => this.send(message), request: (method, params) => this.request(method, params),
      getSurface: () => this.surface, getSnapshot: () => this.snapshot,
      onCopy: text => this.clipboard(Buffer.from(text).toString('base64')),
      onSelection: selection => { this.selection = selection; this.render() },
      onError: () => { this.emit('\x07'); this.screen.reset(); this.render() },
    })
    this.socket = createConnection(options.socketPath)
    this.deadline = setTimeout(() => this.fail(new Error('Herdr endpoint handshake or tab focus timed out')), options.handshakeTimeoutMs ?? 15_000)
    this.deadline.unref()
    this.socket.once('connect', () => {
      try {
        this.send({ EndpointControl: { kind: 'endpoint.hello.v1', data: JSON.stringify({
          generation: 1, cell_width_px: 0, cell_height_px: 0, surface_size: { cols: this.cols, rows: this.rows },
          pixel_mouse: false, direct_graphics: false, endpoint_keybindings: false, mouse_capture: true,
          surface_active: true, surface_reuse: false, surface_delta: false, surface_scroll: false,
          snapshot_codecs: ['shell.snapshot.v1'], surface_codecs: ['shell.surface.v1'],
          input_codecs: ['shell.input.semantic.v1'], blob_codecs: ['shell.blob.v1'],
        }) } })
      } catch (error) { this.fail(error) }
    })
    this.socket.on('data', bytes => {
      try { for (const message of this.reader.feed(typeof bytes === 'string' ? Buffer.from(bytes) : bytes)) { if (!this.closed) this.receive(message) } }
      catch (error) { this.fail(error) }
    })
    this.socket.on('drain', () => { this.writeBlocked = false; this.flushWrites() })
    this.socket.once('error', error => this.fail(error))
    this.socket.once('end', () => { try { this.reader.end() } catch (error) { this.fail(error) } })
    this.socket.once('close', () => this.finish({ exitCode: this.initialized ? 0 : 1 }))
  }

  private send(message: ClientMessage) {
    if (this.closed) throw new Error('Herdr endpoint connection is closed')
    const bytes = encodeClientMessage(message)
    if (this.writeBytes + this.socket.writableLength + bytes.length > MAX_BUFFER) { this.fail(new Error('Herdr input buffer exceeded its limit')); return }
    this.writeQueue.push(bytes); this.writeBytes += bytes.length
    this.flushWrites()
  }
  private flushWrites() {
    try {
      while (!this.closed && !this.writeBlocked && this.writeQueue.length) {
        const bytes = this.writeQueue.shift()!
        this.writeBytes -= bytes.length
        this.writeBlocked = !this.socket.write(bytes)
      }
    } catch (error) { this.fail(error) }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'pane.selection.read' && this.options.readSelection) {
      const boot = this.snapshot?.boot_id
      if (this.closed || !boot) return Promise.reject(new Error('Herdr endpoint connection is closed'))
      return this.options.readSelection(params).then(result => {
        if (this.closed || this.snapshot?.boot_id !== boot) throw new Error('Herdr endpoint changed before selection completed')
        return result
      })
    }
    if (this.queuedRequests >= 64) return Promise.reject(new Error('Too many pending herdr requests'))
    this.queuedRequests++
    const boot = this.snapshot?.boot_id
    const result = this.requestLane.then(() => {
      if (boot !== this.snapshot?.boot_id) throw new Error('Herdr endpoint changed before request delivery')
      return this.sendRequest(method, params)
    }).finally(() => { this.queuedRequests-- })
    this.requestLane = result.catch(() => {})
    return result
  }
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const snapshot = this.snapshot
    if (this.closed || !snapshot || !this.methods.has(method)) return Promise.reject(new Error(`Herdr endpoint method is unavailable: ${method}`))
    if (this.requests.size >= 64) return Promise.reject(new Error('Too many pending herdr requests'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Herdr request timed out: ${method}`)) }, 15_000)
      timer.unref()
      this.requests.set(id, { boot: snapshot.boot_id, chunks: [], size: 0, resolve, reject, timer })
      try { this.send({ ClientShellEndpointRequest: { boot_id: snapshot.boot_id, request: JSON.stringify({ id, method, params }) } }) }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error) }
    })
  }

  private receive(message: ServerMessage) {
    if (!this.welcomed) {
      if (message.type !== 'control' || message.kind !== 'endpoint.welcome.v1') throw new Error('Herdr endpoint welcome is missing')
      const welcome = JSON.parse(message.data)
      if (welcome.error) throw new Error(typeof welcome.error.message === 'string' ? welcome.error.message : 'Herdr handshake rejected')
      if (welcome.generation !== 1 || welcome.snapshot_codec !== 'shell.snapshot.v1' || welcome.surface_codec !== 'shell.surface.v1'
        || welcome.input_codec !== 'shell.input.semantic.v1' || welcome.blob_codec !== 'shell.blob.v1' || !Array.isArray(welcome.methods))
        throw new Error('Herdr server has no compatible endpoint generation 1 codecs')
      this.methods = new Set(welcome.methods.filter((method: unknown): method is string => typeof method === 'string'))
      if (!this.methods.has('tab.focus')) throw new Error('Herdr server cannot focus an independent tab client')
      this.welcomed = true
      return
    }
    if (message.type === 'control') {
      if (message.kind !== 'shell.snapshot.v1') return
      const snapshot = parseSnapshot(message.data)
      if (this.snapshot && snapshot.boot_id !== this.snapshot.boot_id) throw new Error('Herdr endpoint restarted; reconnect this window')
      if (this.snapshot && snapshot.revision < this.snapshot.revision) return
      this.snapshot = snapshot
      if (!snapshot.tabs.some(tab => tab.tab_id === this.options.tabId)) throw new Error('Herdr tab no longer exists')
      if (!this.focusRequested && (!this.focusReady || snapshot.focused_tab_id !== this.options.tabId)) {
        this.focusRequested = true
        this.focusReady = false
        void this.request('tab.focus', { tab_id: this.options.tabId }).then(() => {
          if (this.closed) return
          this.focusRequested = false
          this.focusReady = true
          this.render()
        }).catch(error => this.fail(error))
      }
      this.render()
    } else if (message.type === 'surface') {
      validateSurface(message.surface)
      if (this.surface && message.surface.boot_id === this.surface.boot_id && message.surface.surface_revision <= this.surface.surface_revision) return
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
      this.requests.delete(message.request_id); clearTimeout(request.timer)
      try {
        const response = JSON.parse(Buffer.concat(request.chunks).toString('utf8'))
        if (response.id !== message.request_id) throw new Error('Herdr endpoint response ID mismatch')
        if (response.error) throw new Error(typeof response.error.message === 'string' ? response.error.message : 'Herdr endpoint request failed')
        request.resolve(response.result)
      } catch (error) { request.reject(error instanceof Error ? error : new Error('Invalid herdr response')) }
    } else if (message.type === 'clipboard') this.clipboard(message.data)
    else if (message.type === 'bell') this.emit('\x07'.repeat(Math.min(message.count, 16)))
    else if (message.type === 'shutdown') this.finish({ exitCode: 0 })
    else if (message.type === 'error') throw new Error(message.message)
  }

  private coherentSurface() {
    const snapshot = this.snapshot, surface = this.surface
    return this.focusReady && snapshot?.focused_tab_id === this.options.tabId && surface?.boot_id === snapshot.boot_id
      && surface.projection_revision === snapshot.revision && surface.frame.width === this.cols && surface.frame.height === this.rows ? surface : undefined
  }
  private render() {
    const surface = this.coherentSurface()
    if (!surface || this.closed) return
    const paneId = surface.panes.find(pane => pane.focused)?.pane_id
    if (paneId !== this.focusedPaneId) {
      this.focusedPaneId = paneId
      for (const listener of this.paneFocusListeners) listener(paneId)
    }
    this.input.refresh()
    const rendered = this.screen.render(surface, this.selection)
    this.renderedContent = { surface, snapshot: this.snapshot! }
    if (!this.initialized) {
      this.initialized = true
      clearTimeout(this.deadline)
      this.emit(INITIAL_MODES)
      this.resolve(this)
    }
    this.emit(rendered)
    this.flushInput()
  }
  async content() {
    const rendered = this.renderedContent
    if (this.closed || !rendered) return
    const panes = await readWindowContent(rendered.surface, rendered.snapshot, this.options.tabId,
      params => this.request('pane.selection.read', params))
    if (this.closed || this.snapshot?.boot_id !== rendered.snapshot.boot_id) throw new Error('Window changed; scan again')
    return panes
  }
  private clipboard(data: string) {
    if (!this.initialized || data.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return
    this.emit(`\x1b]52;c;${data}\x07`)
  }
  private emit(data: string) {
    if (!data || this.closed) return
    this.output.push(data); this.outputBytes += Buffer.byteLength(data)
    if (this.outputBytes > MAX_BUFFER) { this.fail(new Error('Herdr display buffer exceeded its limit')); return }
    this.scheduleFlush()
  }
  private scheduleFlush() {
    if (this.flushing || this.paused || !this.dataListeners.size || this.closed) return
    this.flushing = true
    queueMicrotask(() => {
      this.flushing = false
      while (!this.closed && !this.paused && this.dataListeners.size && this.output.length) {
        const data = this.output.shift()!
        this.outputBytes -= Buffer.byteLength(data)
        for (const listener of this.dataListeners) listener(data)
      }
    })
  }
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); this.scheduleFlush(); return { dispose: () => { this.dataListeners.delete(listener) } } }
  onPaneFocus(listener: (paneId: string | undefined) => void) {
    this.paneFocusListeners.add(listener)
    queueMicrotask(() => { if (!this.closed && this.paneFocusListeners.has(listener)) listener(this.focusedPaneId) })
    return { dispose: () => { this.paneFocusListeners.delete(listener) } }
  }
  onExit(listener: (event: Exit) => void) {
    this.exitListeners.add(listener)
    if (this.exit) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(this.exit!) })
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }
  write(data: string | Buffer) {
    if (this.closed || !this.initialized || !data.length) return
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (this.pendingInputBytes + bytes.length > MAX_BUFFER) { this.fail(new Error('Herdr input buffer exceeded its limit')); return }
    // A passive browser blur must not focus this tab or mark completed work as
    // seen. Keep it behind any user input already waiting for its focus barrier.
    if (!this.pendingInputBytes && bytes.length === 3 && bytes.toString() === '\x1b[O') {
      this.input.write(bytes)
      return
    }
    this.pendingInput.push(bytes); this.pendingInputBytes += bytes.length
    if (this.inputFocusPending || this.inputFocusReady) { this.flushInput(); return }
    // An independent native client/API can move the server-side view before its
    // next snapshot reaches us. Establish this tab on the ordered endpoint lane
    // before releasing the input burst; never send keys to a stale visible pane.
    this.inputFocusPending = true
    void this.request('tab.focus', { tab_id: this.options.tabId }).then(() => {
      this.inputFocusPending = false; this.inputFocusReady = true
      this.flushInput()
    }).catch(error => this.fail(error))
  }
  private flushInput() {
    if (!this.inputFocusReady || !this.coherentSurface() || this.closed) return
    this.inputFocusReady = false
    const bytes = Buffer.concat(this.pendingInput, this.pendingInputBytes)
    this.pendingInput = []; this.pendingInputBytes = 0
    this.input.write(bytes)
  }
  resize(cols: number, rows: number) {
    dimensions(cols, rows)
    if (this.closed || cols === this.cols && rows === this.rows) return
    this.cols = cols; this.rows = rows; this.selection = undefined
    this.send({ ClientShellResize: { cell_width_px: 0, cell_height_px: 0, surface_size: { cols, rows }, pixel_mouse: false } })
  }
  pause() { this.paused = true; this.socket.pause() }
  resume() { if (this.closed) return; this.paused = false; this.socket.resume(); this.scheduleFlush() }
  kill() {
    if (this.closed) return
    try { this.socket.end(encodeClientMessage('Detach')) } catch { /* Socket may already have ended. */ }
    this.finish({ exitCode: 0 })
  }
  private fail(reason: unknown) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (!this.initialized) this.reject(error)
    this.finish({ exitCode: 1 }, error)
  }
  private finish(exit: Exit, error = new Error('Herdr endpoint connection closed')) {
    if (this.closed) return
    this.closed = true; this.exit = exit
    clearTimeout(this.deadline)
    if (!this.initialized) this.reject(error)
    this.input.dispose()
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error) }
    this.requests.clear(); this.output = []; this.outputBytes = 0; this.writeQueue = []; this.writeBytes = 0
    this.pendingInput = []; this.pendingInputBytes = 0
    this.socket.destroy()
    for (const listener of this.exitListeners) listener(exit)
  }
}

export async function createHerdrClient(options: HerdrClientOptions): Promise<HerdrClientTransport> {
  if (!options.socketPath || !options.tabId) throw new Error('Herdr socket and tab are required')
  return new HerdrClient(options).connected
}
