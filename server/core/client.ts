import { randomUUID } from 'node:crypto'
import headless, { type IBufferCell } from '@xterm/headless'
import { terminalCellWidth, terminalUnicodeAddon } from '../../shared/terminal-unicode.ts'
import { sameCompletion, type CompletionToken } from '../../shared/completion.ts'
import type { PaneAction, PaneContext, PanePoint } from '../../shared/pane-context.ts'
import type { NativeNotification } from '../../shared/notification.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import { HerdrInputRouter } from '../herdr/input.ts'
import { HerdrScreen, type ScreenSelection } from '../herdr/screen.ts'
import { windowContent, type NativeContentPane } from '../herdr/content.ts'
import type { HerdrClientExit, HerdrClientTransport } from '../herdr/client.ts'
import type { CellData, ClientMessage, ClientShellSnapshot, FrameData, PaneSurfaceFrame, PaneSurfacePane, PaneSurfaceSplit } from '../herdr/wire.ts'
import { coreInput, type CoreInputModes } from './input.ts'
import { CoreLayout, coreWindowMetadata, panes, projectCoreSnapshot, projectTab, type CoreSnapshot, type CoreTab, type CoreTerminal } from './layout.ts'
import { CoreRpc, type CoreNotification, type CoreStream } from './rpc.ts'

const { Terminal } = headless
type Emulator = InstanceType<typeof Terminal>
type Subscription = { dispose(): void }
const INITIAL_MODES = '\x1b[?1049h\x1b[?7l\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1016l\x1b[?1006h\x1b[?1004h'
const MAX_OUTPUT = 8 * 1024 * 1024
const blank = (symbol = ' '): CellData => ({ symbol, fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })
/** OSC 8 permits Unicode and spaces; emit a valid URI without losing the target. */
export function coreHyperlink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) return
  try { const uri = new URL(value).href; return uri.length <= 24576 ? uri : undefined }
  catch { return }
}
function dimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 4096 || rows > 4096 || cols * rows > 1_000_000) throw new Error('Invalid core viewport size')
}
function color(cell: IBufferCell, background = false) {
  const value = background ? cell.getBgColor() : cell.getFgColor()
  return (background ? cell.isBgRGB() : cell.isFgRGB()) ? 0x2000000 | value
    : (background ? cell.isBgPalette() : cell.isFgPalette()) ? 0x1000000 | value : 0
}
function cellData(cell?: IBufferCell): CellData {
  if (!cell) return blank()
  return { symbol: cell.getChars() || ' ', fg: color(cell), bg: color(cell, true),
    modifier: (cell.isBold() ? 1 : 0) | (cell.isDim() ? 2 : 0) | (cell.isItalic() ? 4 : 0) | (cell.isUnderline() ? 8 : 0)
      | (cell.isBlink() ? 16 : 0) | (cell.isInverse() ? 64 : 0) | (cell.isInvisible() ? 128 : 0) | (cell.isStrikethrough() ? 256 : 0),
    skip: cell.getWidth() === 0, hyperlink: null }
}
/** Dividers keep their original resize axis, but only exposed cells accept hits. */
function visibleSplits(split: PaneSurfaceSplit, owners: Int32Array, cols: number): PaneSurfaceSplit[] {
  const rect = split.hit_rect, vertical = rect.width === 1, length = vertical ? rect.height : rect.width
  const result: PaneSurfaceSplit[] = []
  let start = -1
  for (let offset = 0; offset <= length; offset++) {
    const visible = offset < length && owners[(rect.y + (vertical ? offset : 0)) * cols + rect.x + (vertical ? 0 : offset)] === 0
    if (visible && start < 0) start = offset
    if (!visible && start >= 0) {
      result.push({ ...split, hit_rect: vertical ? { ...rect, y: rect.y + start, height: offset - start } : { ...rect, x: rect.x + start, width: offset - start } })
      start = -1
    }
  }
  return result
}
interface CorePane {
  id: string
  address: string
  emulator: Emulator
  modes: CoreInputModes
  stream?: CoreStream
  revision: number
  ready: boolean
  paintComplete: boolean
  firstPaint: Promise<void>
  painted(): void
  scroll: number
  cursorVisible: boolean
  cursorShape: number
  disposed: boolean
  subscriptions: Subscription[]
  kittyStack: number[]
  wanted: { cols: number; rows: number }
  parsedTurn: number
  parsedState?: string
  rootReport: boolean
}

export interface CoreClientOptions {
  rpc: CoreRpc
  layout: CoreLayout
  spaceId: string
  tabId: string
  cols: number
  rows: number
  handshakeTimeoutMs?: number
}

/** One Canvas window, composed from independent native core terminal streams. */
class CoreWindowClient implements HerdrClientTransport {
  private state?: CoreSnapshot
  private tab?: CoreTab
  private surface?: PaneSurfaceFrame
  private shell?: ClientShellSnapshot
  private metadata?: WindowMetadata
  private renderedMetadata?: WindowMetadata
  private renderedContent?: { surface: PaneSurfaceFrame; shell: ClientShellSnapshot; owners: Int32Array; layers: string[] }
  private layoutToken = { signature: '', token: '' }
  private readonly screen = new HerdrScreen()
  private readonly attached = new Map<string, CorePane>()
  private focused?: string
  private zoomed?: string
  private selection?: ScreenSelection
  private cols: number
  private rows: number
  private revision = 0
  /** Highest subscription sequence reflected in the native snapshot. */
  private eventSeq = 0
  private parseQueue: Promise<void> = Promise.resolve()
  private refreshQueue: Promise<void> = Promise.resolve()
  private readonly input: HerdrInputRouter
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly paneFocusListeners = new Set<(id: string | undefined) => void>()
  private readonly metadataListeners = new Set<(metadata: WindowMetadata) => void>()
  private readonly frameListeners = new Set<(metadata: WindowMetadata) => void>()
  private readonly snapshotListeners = new Set<() => void>()
  private readonly notificationListeners = new Set<(notification: NativeNotification) => void>()
  private readonly exitListeners = new Set<(exit: HerdrClientExit) => void>()
  private readonly subscriptions: Subscription[] = []
  private subscription?: { close(): void }
  private output: Array<{ data: string; frame?: WindowMetadata }> = []
  private outputBytes = 0
  private paused = false
  private flushing = false
  private renderScheduled = false
  private closed = false
  private initialized = false
  private exit?: HerdrClientExit

  constructor(private readonly options: CoreClientOptions) {
    dimensions(options.cols, options.rows)
    this.cols = options.cols; this.rows = options.rows
    this.input = new HerdrInputRouter({ tabId: options.tabId, getSurface: () => this.surface, getSnapshot: () => this.shell,
      send: message => this.send(message), request: (method, params) => this.request(method, params),
      onSelection: selection => { this.selection = selection; this.render() },
      onCopy: text => this.clipboard(Buffer.from(text).toString('base64')),
      onError: () => this.emit('\x07'),
    })
  }

  async initialize(): Promise<HerdrClientTransport> {
    this.subscriptions.push(this.options.rpc.onClose(() => this.finish({ exitCode: 1 })))
    // Subscribe before reading documents; doc changes are not part of the terminal snapshot.
    const subscription = await this.options.rpc.subscribe({}, event => this.event(event))
    this.subscription = subscription
    this.eventSeq = subscription.snapshot.seq
    await this.replace(await this.options.layout.snapshot(subscription.snapshot.terminals), true)
    subscription.start()
    const timeout = setTimeout(() => this.finish({ exitCode: 1 }), this.options.handshakeTimeoutMs ?? 15_000)
    timeout.unref()
    try {
      await Promise.race([
        Promise.all([...this.attached.values()].map(pane => pane.firstPaint)),
        new Promise<never>((_, reject) => this.subscriptions.push(this.onExit(() => reject(new Error('Core terminal first paint failed'))))),
      ])
      if (this.closed) throw new Error('Core window closed while attaching')
      this.initialized = true
      this.emit(INITIAL_MODES)
      this.render()
      return this
    } catch (error) { this.kill(); throw error }
    finally { clearTimeout(timeout) }
  }

  private enqueue(action: () => Promise<void> | void): Promise<void> {
    const next = this.parseQueue.then(async () => { if (!this.closed) await action() })
    this.parseQueue = next.catch(() => this.finish({ exitCode: 1 }))
    return next
  }

  private async replace(state: CoreSnapshot, nativeSnapshot = false): Promise<void> {
    if (this.closed) return
    if (this.state?.coreId === state.coreId && state !== this.state) {
      // Document requests/actions may resolve around newer native events. Only
      // sequenced snapshots may replace terminals; document versions own layout.
      const terminals = nativeSnapshot ? state.terminals : this.state.terminals
      state = projectCoreSnapshot({ ...(state.documentVersion < this.state.documentVersion ? this.state : state), terminals })
    }
    let tab: CoreTab
    try { tab = this.options.layout.findWindow(state, this.options.spaceId, this.options.tabId) }
    catch { this.finish({ exitCode: 0, reason: 'removed' }); return }
    this.state = state; this.tab = tab
    const projected = projectTab(tab, this.cols, this.rows, this.zoomed)
    const ids = new Set(projected.panes.filter(pane => pane.terminal).map(pane => pane.id))
    for (const [id, pane] of this.attached) if (!ids.has(id) || projected.panes.find(item => item.id === id)?.terminal !== pane.address) {
      this.disposePane(pane); this.attached.delete(id)
    }
    if (!projected.panes.some(pane => pane.id === this.focused)) this.focused = projected.panes.find(pane => pane.terminal)?.id || projected.panes[0]?.id
    await Promise.all(projected.panes.map(async projected => {
      if (!projected.terminal || this.attached.has(projected.id)) return
      const terminal = state.terminals.find(terminal => terminal.address === projected.terminal)
      const pane = this.makePane(projected.id, projected.terminal, projected.rect.width, projected.rect.height)
      this.attached.set(pane.id, pane)
      if (terminal?.state !== 'live' || terminal.reason && !terminal.pid) {
        await new Promise<void>(resolve => pane.emulator.write(terminal?.state === 'live' ? '[Waiting for terminal recovery]' : '[Terminal finished]', resolve))
        pane.ready = true; pane.painted(); return
      }
      try {
        const attached = await this.options.rpc.attach({ terminal: pane.address, cols: projected.rect.width, rows: projected.rect.height,
          history: 2000, resumed: true, display: { cell: [8, 16] } })
        if (pane.disposed || this.closed) { attached.stream.close(); return }
        pane.stream = attached.stream
        const nativeCols = Number(attached.terminal.cols), nativeRows = Number(attached.terminal.rows)
        dimensions(nativeCols, nativeRows)
        pane.emulator.resize(Math.max(2, nativeCols), nativeRows)
        pane.parsedTurn = Number.isSafeInteger(attached.terminal.turn) ? Number(attached.terminal.turn) : 0
        const initialStatus = attached.terminal.status as { state?: unknown } | null | undefined
        pane.parsedState = typeof initialStatus?.state === 'string' ? initialStatus.state : undefined
        // Install all handlers before enabling queued DATA delivery.
        pane.subscriptions.push(attached.stream.onResize(size => this.enqueue(() => {
          if (!pane.disposed) { pane.emulator.resize(size.cols, size.rows); pane.revision++; this.render() }
        })))
        pane.subscriptions.push(attached.stream.onClose(() => {
          pane.stream = undefined; pane.ready = true; pane.painted()
          if (!this.closed && !pane.disposed) void this.refresh()
        }))
        pane.subscriptions.push(attached.stream.onData(data => this.enqueue(async () => {
          if (pane.disposed) return
          await new Promise<void>(resolve => pane.emulator.write(data, resolve))
          pane.revision++; pane.scroll = Math.min(pane.scroll, pane.emulator.buffer.active.baseY)
          if (pane.paintComplete) { pane.ready = true; pane.painted() }
          this.render()
        })))
      } catch (error) {
        this.disposePane(pane); this.attached.delete(pane.id)
        throw error
      }
    }))
    this.resizeStreams()
    this.revision++
    this.updateMetadata()
    for (const listener of this.snapshotListeners) listener()
    this.render()
  }

  private makePane(id: string, address: string, cols: number, rows: number): CorePane {
    const emulator = new Terminal({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: 2000, allowProposedApi: true })
    emulator.loadAddon(terminalUnicodeAddon())
    let painted!: () => void
    const firstPaint = new Promise<void>(resolve => { painted = resolve })
    const pane: CorePane = { id, address, emulator, revision: 0, ready: false, paintComplete: false, firstPaint, painted, scroll: 0,
      cursorVisible: true, cursorShape: 0, disposed: false, subscriptions: [], kittyStack: [],
      wanted: { cols, rows },
      parsedTurn: 0, rootReport: false,
      modes: { applicationCursor: false, bracketedPaste: false, mouse: 'none', sgrMouse: false, pixelMouse: false, utf8Mouse: false, urxvtMouse: false,
        kitty: 0, modifyOtherKeys: 0, win32: false } }
    const numbers = (params: (number | number[])[]) => params.map(value => typeof value === 'number' ? value : value[0] || 0)
    for (const final of ['h', 'l']) pane.subscriptions.push(emulator.parser.registerCsiHandler({ prefix: '?', final }, params => {
      const on = final === 'h'
      for (const mode of numbers(params)) {
        if (mode === 25) pane.cursorVisible = on
        if (mode === 1006) pane.modes.sgrMouse = on
        if (mode === 1016) pane.modes.pixelMouse = on
        if (mode === 1005) pane.modes.utf8Mouse = on
        if (mode === 1015) pane.modes.urxvtMouse = on
        if (mode === 9001) { pane.modes.win32 = on; pane.paintComplete = true }
      }
      return false
    }))
    pane.subscriptions.push(emulator.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
      pane.cursorShape = numbers(params)[0] || 0; return false
    }))
    pane.subscriptions.push(emulator.parser.registerCsiHandler({ prefix: '>', final: 'u' }, params => {
      pane.kittyStack.push(pane.modes.kitty); if (pane.kittyStack.length > 32) pane.kittyStack.shift()
      pane.modes.kitty = numbers(params)[0] || 0; return true
    }))
    pane.subscriptions.push(emulator.parser.registerCsiHandler({ prefix: '<', final: 'u' }, params => {
      let count = Math.max(1, Math.min(32, numbers(params)[0] || 1))
      while (count--) pane.modes.kitty = pane.kittyStack.pop() ?? 0
      return true
    }))
    pane.subscriptions.push(emulator.parser.registerCsiHandler({ prefix: '=', final: 'u' }, params => {
      const [flags = 0, operation = 1] = numbers(params)
      pane.modes.kitty = operation === 2 ? pane.modes.kitty | flags : operation === 3 ? pane.modes.kitty & ~flags : flags
      return true
    }))
    pane.subscriptions.push(emulator.parser.registerCsiHandler({ prefix: '>', final: 'm' }, params => {
      const [mode, value] = numbers(params); if (mode === 4) pane.modes.modifyOtherKeys = value || 0
      return false
    }))
    pane.subscriptions.push(emulator.parser.registerOscHandler(52, data => {
      const at = data.indexOf(';'), value = data.slice(at + 1)
      if (at >= 0 && value !== '?') this.clipboard(value)
      return true
    }))
    pane.subscriptions.push(emulator.parser.registerOscHandler(7501, data => {
      const fields = new Map(data.split(':').flatMap(field => {
        const at = field.indexOf('='); return at < 0 ? [] : [[field.slice(0, at), field.slice(at + 1)] as [string, string]]
      }))
      const word = fields.get('state')
      if (fields.get('id') || !['idle', 'working', 'done', 'blocked', 'error', 'clear'].includes(word || '')) return true
      // The attach reply seeds its turn. Its first report is a replay of that
      // snapshot, not another transition; subsequent reports are live bytes.
      if (pane.rootReport && pane.parsedState === 'working' && word !== 'working') pane.parsedTurn++
      pane.rootReport = true; pane.parsedState = word === 'clear' ? undefined : word
      return true
    }))
    // The core already answers program queries; a viewer must never echo headless replies.
    pane.subscriptions.push(emulator.onBell(() => this.emit('\x07')))
    return pane
  }

  private async event(event: CoreNotification): Promise<void> {
    if (this.closed) return
    const seq = Number(event.params.seq)
    if (!Number.isSafeInteger(seq) || seq <= this.eventSeq) return
    this.eventSeq = seq
    if (event.method === 'heartbeat') return
    if (event.method === 'missed') {
      // Core supplies the terminal records at this waterline; do not pair the
      // sequence with a separately sampled terminal.list response.
      const snapshot = event.params.terminals
      if (!Array.isArray(snapshot) || !snapshot.every(value => value && typeof value === 'object' && !Array.isArray(value))) {
        throw new Error('Invalid core recovery snapshot')
      }
      await this.refresh(() => this.options.layout.snapshot(snapshot as Record<string, unknown>[]), true)
      return
    }
    const { type, terminal: address, data } = event.params
    if (type === 'doc') { await this.refresh(); return }
    if (typeof address !== 'string' || !this.state || data !== null && typeof data !== 'object') return
    if (['created', 'removed', 'restarted', 'lost', 'finished'].includes(String(type))) {
      const update = data as Record<string, unknown>, terminals = this.state.terminals.slice()
      if (!update || Array.isArray(update)) throw new Error('Invalid core terminal event')
      const index = terminals.findIndex(terminal => terminal.address === address)
      if (type === 'created' || type === 'restarted') {
        if (update.address !== address) throw new Error('Invalid core terminal event')
        if (index < 0) terminals.push(update as CoreTerminal)
        else terminals[index] = update as CoreTerminal
        for (const [id, pane] of this.attached) if (pane.address === address && (type === 'restarted' || !pane.stream)) {
          this.disposePane(pane); this.attached.delete(id)
        }
      } else if (index >= 0) {
        if (type === 'removed') terminals.splice(index, 1)
        else terminals[index] = { ...terminals[index]!, ...update, state: type === 'lost' ? 'live' : 'finished',
          ...(type === 'lost' ? { pid: null } : {}), foreground: null }
      }
      await this.refresh(() => this.options.layout.snapshot(terminals), true)
      return
    }
    await this.enqueue(() => {
      const terminal = this.state?.terminals.find(terminal => terminal.address === address)
      if (!terminal) return
      const before = terminal.status?.state, priorTurn = terminal.turn
      const update = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      if (type === 'status') { terminal.status = update.status as CoreTerminal['status']; terminal.records = update.records; terminal.reported = update.reported }
      else if (type === 'turn' && Number.isSafeInteger(update.turn)) terminal.turn = Number(update.turn)
      else if (type === 'labels' && update.labels && typeof update.labels === 'object') terminal.labels = update.labels as Record<string, string>
      else if (type === 'title' && typeof update.title === 'string') terminal.title = update.title
      else if (type === 'keep' && typeof update.keep === 'boolean') terminal.keep = update.keep
      else if (type === 'foreground') terminal.foreground = data as CoreTerminal['foreground']
      else if (type === 'size' && Number.isInteger(update.cols) && Number.isInteger(update.rows)) {
        terminal.cols = Number(update.cols); terminal.rows = Number(update.rows)
        for (const pane of this.attached.values()) if (pane.address === address && (pane.emulator.cols !== terminal.cols || pane.emulator.rows !== terminal.rows)) {
          pane.emulator.resize(terminal.cols, terminal.rows); pane.revision++
        }
      }
      this.revision++; this.updateMetadata(); this.render()
      for (const listener of this.snapshotListeners) listener()
      if (this.initialized && type === 'status' && before !== terminal.status?.state && ['blocked', 'error'].includes(terminal.status?.state || '')) this.notify(terminal, 'attention')
      if (this.initialized && type === 'turn' && terminal.turn > priorTurn && !['working', 'blocked', 'error'].includes(terminal.status?.state || '')) this.notify(terminal, 'done')
    })
  }

  private notify(terminal: CoreTerminal, kind: 'attention' | 'done') {
    const target = this.state?.spaces.flatMap(space => space.tabs.flatMap(tab => {
      const pane = panes(tab).find(pane => pane.terminal === terminal.address)
      return pane ? [{ space, tab, pane }] : []
    }))[0]
    if (!target) return
    const notification: NativeNotification = { kind, title: terminal.status?.title || terminal.name || terminal.title || terminal.address,
      ...(terminal.status?.msg ? { body: terminal.status.msg } : {}), ...(terminal.status?.app ? { agent: terminal.status.app } : {}),
      spaceId: target.space.id, windowId: target.tab.id, paneId: target.pane.id }
    for (const listener of this.notificationListeners) listener(notification)
  }

  private refresh(snapshot?: () => CoreSnapshot | Promise<CoreSnapshot>, nativeSnapshot = false): Promise<void> {
    const next = this.refreshQueue.then(async () => { if (!this.closed) await this.replace(snapshot ? await snapshot() : await this.options.layout.snapshot(this.state?.terminals), nativeSnapshot) })
    this.refreshQueue = next.catch(() => this.finish({ exitCode: 1 }))
    return this.refreshQueue
  }

  private updateMetadata() {
    if (!this.state) return
    this.metadata = coreWindowMetadata(this.state, this.options.tabId, this.focused)
    if (this.metadata) for (const listener of this.metadataListeners) listener(this.metadata)
  }

  private render() {
    if (this.closed || this.renderScheduled || !this.initialized) return
    this.renderScheduled = true
    queueMicrotask(() => {
      this.renderScheduled = false
      if (this.closed || this.paused || !this.state || !this.tab || [...this.attached.values()].some(pane => !pane.ready)) return
      const projection = projectTab(this.tab, this.cols, this.rows, this.zoomed)
      if (projection.panes.some(pane => pane.terminal && !this.attached.has(pane.id))) return
      const frame: FrameData = { cells: Array.from({ length: this.cols * this.rows }, () => blank()), width: this.cols, height: this.rows, cursor: null, hyperlinks: [], graphics: Buffer.alloc(0) }
      const surfacePanes: PaneSurfacePane[] = [], owners = new Int32Array(frame.cells.length), layers = projection.panes.map(pane => pane.id)
      for (const split of projection.splits) {
        const area = split.hit_rect
        for (let y = area.y; y < area.y + area.height; y++) for (let x = area.x; x < area.x + area.width; x++) frame.cells[y * this.cols + x] = blank(split.direction === 'Horizontal' ? '│' : '─')
      }
      for (const [index, projected] of projection.panes.entries()) {
        const rect = projected.rect, pane = this.attached.get(projected.id), terminal = this.state.terminals.find(terminal => terminal.address === projected.terminal)
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) owners[y * this.cols + x] = index + 1
        if (!pane) {
          const message = projected.unsupported ? `[${projected.unsupported}]` : '[Terminal unavailable]'
          for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) frame.cells[y * this.cols + x] = blank()
          for (let x = 0; x < Math.min(rect.width, message.length); x++) frame.cells[rect.y * this.cols + rect.x + x] = blank(message[x])
          surfacePanes.push({ pane_id: projected.id, content_revision: 0, rect, inner_rect: rect, scrollbar_rect: null, scroll: null,
            focused: false, mouse_reporting: false, sgr_pixel_mouse: false, alternate_screen_active: false, pixel_width: 0, pixel_height: 0 })
          continue
        }
        const emulator = pane.emulator, buffer = emulator.buffer.active
        const offset = Math.max(0, buffer.baseY - pane.scroll)
        const linkIndexes = new Map<string, number>()
        for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
          const cell = x < emulator.cols && y < emulator.rows ? buffer.getLine(offset + y)?.getCell(x) : undefined
          const rendered = cellData(cell)
          const uri = cell && this.hyperlink(emulator, cell)
          if (uri) {
            let index = linkIndexes.get(uri)
            if (index === undefined) { index = frame.hyperlinks.push(uri) - 1; linkIndexes.set(uri, index) }
            rendered.hyperlink = index
          }
          frame.cells[(rect.y + y) * this.cols + rect.x + x] = rendered
        }
        pane.modes.applicationCursor = emulator.modes.applicationCursorKeysMode
        pane.modes.bracketedPaste = emulator.modes.bracketedPasteMode
        pane.modes.mouse = emulator.modes.mouseTrackingMode
        const alternate = buffer.type === 'alternate'
        const focused = projected.id === this.focused
        surfacePanes.push({ pane_id: projected.id, content_revision: pane.revision, rect, inner_rect: rect, scrollbar_rect: null,
          scroll: alternate ? null : { offset_from_bottom: pane.scroll, max_offset_from_bottom: buffer.baseY, viewport_rows: emulator.rows },
          focused, mouse_reporting: emulator.modes.mouseTrackingMode !== 'none', sgr_pixel_mouse: pane.modes.pixelMouse,
          alternate_screen_active: alternate, pixel_width: rect.width * 8, pixel_height: rect.height * 16 })
        if (focused && pane.scroll === 0 && buffer.cursorX < rect.width && buffer.cursorY < rect.height) frame.cursor = {
          x: rect.x + buffer.cursorX, y: rect.y + buffer.cursorY, visible: pane.cursorVisible && terminal?.state === 'live', shape: pane.cursorShape }
      }
      // A wide glyph is indivisible. Do not let a covered lead/continuation
      // make the renderer skip a different pane's first visible cell.
      for (let y = 0; y < this.rows; y++) {
        let continuation = 0, owner = 0
        for (let x = 0; x < this.cols; x++) {
          const index = y * this.cols + x, cell = frame.cells[index]!
          if (cell.skip) {
            if (continuation && owners[index] === owner) continuation--
            else { frame.cells[index] = blank(); continuation = 0 }
            continue
          }
          const width = terminalCellWidth(cell.symbol)
          owner = owners[index]!
          continuation = Math.max(0, width - 1)
          if (x + width > this.cols || width > 1 && owners[index + width - 1] !== owner) {
            frame.cells[index] = blank(); continuation = 0
          }
        }
      }
      const visible = new Set(owners)
      if (frame.cursor && owners[frame.cursor.y * this.cols + frame.cursor.x] !== layers.indexOf(this.focused || '') + 1) frame.cursor = null
      surfacePanes.reverse() // Native input/context hit tests visit the topmost pane first.
      const splits = projection.splits.flatMap(split => visibleSplits(split, owners, this.cols))
      const signature = JSON.stringify([this.state.coreId, this.options.tabId, this.cols, this.rows, surfacePanes.map(pane => [pane.pane_id, pane.inner_rect])])
      if (signature !== this.layoutToken.signature) this.layoutToken = { signature, token: randomUUID() }
      const shell: ClientShellSnapshot = { boot_id: this.state.coreId, revision: ++this.revision, focused_workspace_id: this.options.spaceId,
        focused_tab_id: this.options.tabId, focused_pane_id: this.focused || null,
        tabs: [{ tab_id: this.options.tabId, workspace_id: this.options.spaceId, focused: true }],
        panes: surfacePanes.map(pane => ({ pane_id: pane.pane_id, tab_id: this.options.tabId, workspace_id: this.options.spaceId, focused: pane.focused,
          right_click_passthrough: false, label: this.metadata?.panes.find(item => item.id === pane.pane_id)?.name || '',
          foreground_cwd: this.state!.terminals.find(terminal => terminal.address === this.attached.get(pane.pane_id)?.address)?.foreground?.cwd,
          cwd: this.state!.terminals.find(terminal => terminal.address === this.attached.get(pane.pane_id)?.address)?.cwd })) }
      const surface: PaneSurfaceFrame = { boot_id: this.state.coreId, projection_revision: shell.revision, surface_revision: shell.revision,
        frame, panes: surfacePanes, splits, popup: null }
      this.shell = shell; this.surface = surface; this.input.refresh()
      this.renderedContent = { surface, shell, owners, layers }
      this.renderedMetadata = this.metadata ? { ...this.metadata, layout: this.layoutToken.token, panes: this.metadata.panes.map(metadata => {
        const pane = this.attached.get(metadata.id), owner = layers.indexOf(metadata.id) + 1
        if (!metadata.completion || pane && owner > 0 && visible.has(owner) && this.completionPainted(pane, metadata.completion)) return metadata
        const { completion: _completion, ...pending } = metadata
        return pending
      }) } : undefined
      let display = surface
      const selection = this.selection, selected = selection && surfacePanes.find(pane => pane.pane_id === selection.pane_id)
      if (selection && selected) {
        const rect = selected.inner_rect, owner = layers.indexOf(selected.pane_id) + 1, cells = frame.cells.slice()
        const at = (point: { row: number; col: number }) => Math.max(0, Math.min(rect.height - 1, point.row)) * rect.width + Math.max(0, Math.min(rect.width - 1, point.col))
        const start = Math.min(at(selection.anchor), at(selection.cursor)), end = Math.max(at(selection.anchor), at(selection.cursor))
        for (let offset = start; offset <= end; offset++) {
          const index = (rect.y + Math.floor(offset / rect.width)) * this.cols + rect.x + offset % rect.width
          if (owners[index] === owner) cells[index] = { ...cells[index]!, modifier: cells[index]!.modifier ^ 64 }
        }
        display = { ...surface, frame: { ...frame, cells } }
      }
      this.emit(this.screen.render(display), this.renderedMetadata)
    })
  }

  private hyperlink(emulator: Emulator, cell: IBufferCell): string | undefined {
    // xterm's public cell API omits OSC 8 metadata. This narrow optional accessor
    // is isolated here; unsupported internals simply omit the link, never text.
    const id = (cell as IBufferCell & { extended?: { urlId?: number } }).extended?.urlId
    const terminal = emulator as Emulator & { _core?: { _oscLinkService?: { getLinkData(id: number): { uri?: unknown } | undefined } } }
    const uri = id ? terminal._core?._oscLinkService?.getLinkData(id)?.uri : undefined
    return coreHyperlink(uri)
  }

  private send(message: ClientMessage) {
    if (this.closed || typeof message === 'string') return
    if ('ClientShellPaneInput' in message) {
      const input = message.ClientShellPaneInput, pane = this.attached.get(input.pane_id)
      if (!pane?.stream) return
      pane.scroll = 0
      pane.modes.applicationCursor = pane.emulator.modes.applicationCursorKeysMode
      pane.modes.bracketedPaste = pane.emulator.modes.bracketedPasteMode
      pane.modes.mouse = pane.emulator.modes.mouseTrackingMode
      for (let event of input.events) {
        if ('Mouse' in event && pane.modes.pixelMouse && 'Cell' in event.Mouse.position) {
          const { column, row } = event.Mouse.position.Cell
          event = { Mouse: { ...event.Mouse, position: { Pixels: { column, row, x: column * 8 + 4, y: row * 16 + 8 } } } }
        }
        const bytes = coreInput(event, pane.modes); if (bytes.length) pane.stream.write(bytes)
      }
    } else if ('ClientShellFocus' in message) this.attached.get(this.focused || '')?.stream?.focus(message.ClientShellFocus.focused)
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Core window is closed')
    const paneId = String(params.pane_id || ''), pane = this.attached.get(paneId)
    if (method === 'pane.focus') {
      if (!pane) throw new Error('Pane no longer exists')
      this.attached.get(this.focused || '')?.stream?.focus(false)
      this.focused = paneId; pane.stream?.focus(true); this.revision++; this.updateMetadata()
      for (const listener of this.paneFocusListeners) listener(paneId)
      this.render(); return {}
    }
    if (method === 'pane.scroll') {
      if (!pane || !Number.isSafeInteger(params.offset_from_bottom)) throw new Error('Invalid pane scroll')
      pane.scroll = Math.max(0, Math.min(pane.emulator.buffer.active.baseY, Number(params.offset_from_bottom))); this.render(); return {}
    }
    if (method === 'pane.selection.read') {
      if (!pane || params.content_revision !== pane.revision) throw new Error('Pane output changed during selection')
      return { pane_id: paneId, text: this.selectionText(pane, params.anchor, params.cursor) }
    }
    if (method === 'layout.set_split_ratio') {
      const state = await this.options.layout.setSplitRatio(this.options.spaceId, this.options.tabId, params.path as boolean[], Number(params.ratio), () => !this.closed)
      await this.replace(state); this.resizeStreams(); return {}
    }
    throw new Error(`Unsupported core view operation: ${method}`)
  }

  private selectionText(pane: CorePane, anchor: unknown, cursor: unknown): string {
    const point = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('row' in value) || !('col' in value) || !Number.isSafeInteger(value.row) || !Number.isSafeInteger(value.col)) throw new Error('Invalid selection coordinates')
      return { row: Math.max(0, Math.min(pane.emulator.buffer.active.length - 1, Number(value.row))), col: Math.max(0, Math.min(pane.emulator.cols - 1, Number(value.col))) }
    }
    let start = point(anchor), end = point(cursor)
    if (start.row > end.row || start.row === end.row && start.col > end.col) [start, end] = [end, start]
    if ((end.row - start.row + 1) * pane.emulator.cols > 1_000_000) throw new Error('Selection is too large')
    const rendered = this.renderedContent, rect = rendered?.surface.panes.find(item => item.pane_id === pane.id)?.inner_rect
    const top = Math.max(0, pane.emulator.buffer.active.baseY - pane.scroll), owner = (rendered?.layers.indexOf(pane.id) ?? -1) + 1
    let text = ''
    for (let row = start.row; row <= end.row; row++) {
      const line = pane.emulator.buffer.active.getLine(row)
      let part = ''
      for (let col = row === start.row ? start.col : 0; col <= (row === end.row ? end.col : pane.emulator.cols - 1); col++) {
        const cell = line?.getCell(col)
        if (cell?.getWidth() === 0) continue
        let covered = false
        if (rendered && rect && row >= top && row < top + rect.height) for (let offset = 0; offset < (cell?.getWidth() || 1); offset++) {
          if (col + offset >= rect.width || rendered.owners[(rect.y + row - top) * rendered.surface.frame.width + rect.x + col + offset] !== owner) { covered = true; break }
        }
        part += covered || cell?.isInvisible() ? ' '.repeat(cell?.getWidth() || 1) : cell?.getChars() || ' '
      }
      if (row > start.row && !line?.isWrapped) text += '\n'
      text += part.trimEnd()
    }
    return text
  }

  async content(): Promise<NativeContentPane[] | undefined> {
    await this.parseQueue
    const rendered = this.renderedContent
    if (this.closed || !rendered || !this.state) return
    const { surface, shell, owners, layers } = rendered
    return surface.panes.toReversed().flatMap(pane => {
      const owner = layers.indexOf(pane.pane_id) + 1, rect = pane.inner_rect
      const native = this.attached.get(pane.pane_id)
      if (!native || !owners.includes(owner)) return []
      const cells = Array.from({ length: rect.width * rect.height }, (_, index) => {
        const at = (rect.y + Math.floor(index / rect.width)) * surface.frame.width + rect.x + index % rect.width
        return owners[at] === owner ? surface.frame.cells[at]! : blank()
      })
      const local = { x: 0, y: 0, width: rect.width, height: rect.height }
      const top = Math.max(0, native.emulator.buffer.active.baseY - native.scroll)
      const visible = Array.from({ length: rect.height }, (_, row) => {
        for (let col = 0; col < rect.width; col++) if (owners[(rect.y + row) * surface.frame.width + rect.x + col] !== owner) return false
        return true
      })
      return windowContent({ ...surface, frame: { ...surface.frame, width: rect.width, height: rect.height, cells, cursor: null },
        panes: [{ ...pane, rect: local, inner_rect: local }], splits: [] }, shell, this.options.tabId,
        (_id, row) => native.emulator.cols === rect.width && visible[row - 1] && visible[row]
          && !!native.emulator.buffer.active.getLine(top + row)?.isWrapped)
    })
  }
  paneContext(point: PanePoint): PaneContext | undefined {
    if (this.closed || !this.surface || point.layout !== this.layoutToken.token || point.cols !== this.cols || point.rows !== this.rows) return
    const pane = this.surface.panes.find(pane => point.column >= pane.inner_rect.x && point.column < pane.inner_rect.x + pane.inner_rect.width && point.row >= pane.inner_rect.y && point.row < pane.inner_rect.y + pane.inner_rect.height)
    return pane ? { bootId: this.state!.coreId, paneId: pane.pane_id, name: this.metadata?.panes.find(item => item.id === pane.pane_id)?.name || '' } : undefined
  }
  async paneAction(context: PaneContext, action: PaneAction, authorized: () => boolean = () => true): Promise<unknown> {
    const valid = () => authorized() && !this.closed && this.state?.coreId === context.bootId && !!this.tab && panes(this.tab).some(pane => pane.id === context.paneId)
    if (!valid()) throw new Error('Pane changed; open its menu again')
    if (action.action === 'zoom') {
      await this.replace(await this.options.layout.snapshot(this.state?.terminals))
      if (!valid()) throw new Error('Pane changed; open its menu again')
      this.zoomed = this.zoomed === context.paneId ? undefined : context.paneId
      await this.replace(this.state!); this.resizeStreams(); return {}
    }
    const state = await this.options.layout.paneAction(this.options.spaceId, this.options.tabId, context.paneId, action, valid)
    if (!this.closed) {
      if (action.action.startsWith('split-')) {
        const previous = new Set(this.tab ? panes(this.tab).map(pane => pane.id) : [])
        const updated = state.spaces.flatMap(space => space.tabs).find(tab => tab.id === this.options.tabId)
        this.focused = updated && panes(updated).find(pane => !previous.has(pane.id))?.id
      }
      await this.replace(state); this.resizeStreams()
    }
    return {}
  }
  async acknowledgeCompletion(paneId: string, completion: CompletionToken): Promise<void> {
    if (this.closed || completion.bootId !== this.state?.coreId || !this.tab) return
    const address = panes(this.tab).find(pane => pane.id === paneId)?.terminal
    const terminal = this.state.terminals.find(terminal => terminal.address === address)
    const pane = this.attached.get(paneId)
    if (!address || terminal?.turn !== completion.sequence || !pane || !this.completionPainted(pane, completion)
      || !sameCompletion(this.renderedMetadata?.panes.find(value => value.id === paneId)?.completion, completion)) return
    await this.options.layout.markSeen(address, completion.sequence)
    await this.refresh()
  }
  private completionPainted(pane: CorePane, completion: CompletionToken): boolean {
    return pane.ready && pane.parsedTurn === completion.sequence && !['working', 'blocked', 'error'].includes(pane.parsedState || '')
  }
  completionSnapshot() {
    if (this.closed || !this.state) return
    return { windows: this.state.spaces.flatMap(space => space.tabs.map(tab => coreWindowMetadata(this.state!, tab.id, tab.id === this.options.tabId ? this.focused : undefined)!)),
      state: { bootId: this.state.coreId, revision: this.revision } }
  }
  async completionFence(): Promise<WindowMetadata | undefined> {
    await this.input.settled(); await this.parseQueue
    if (this.closed) return
    // Core events and terminal bytes are independent channels. This fences the
    // bytes already received and parsed, not unseen future remote output.
    return new Promise(resolve => {
      const frame = this.onFrame(metadata => { frame.dispose(); exit.dispose(); resolve(metadata) })
      const exit = this.onExit(() => { frame.dispose(); exit.dispose(); resolve(undefined) })
      this.render()
    })
  }
  write(data: string | Buffer) { if (!this.closed && this.initialized) this.input.write(data) }
  private resizeStreams() {
    if (!this.tab) return
    for (const projected of projectTab(this.tab, this.cols, this.rows, this.zoomed).panes) {
      const pane = this.attached.get(projected.id)
      if (!pane || pane.disposed || pane.wanted.cols === projected.rect.width && pane.wanted.rows === projected.rect.height) continue
      pane.wanted = { cols: projected.rect.width, rows: projected.rect.height }
      pane.emulator.resize(Math.max(2, projected.rect.width), Math.max(1, projected.rect.height)); pane.revision++; pane.stream?.resize(projected.rect.width, projected.rect.height)
    }
    this.render()
  }
  resize(cols: number, rows: number) {
    dimensions(cols, rows)
    if (this.closed || this.cols === cols && this.rows === rows) return
    this.cols = cols; this.rows = rows; this.selection = undefined
    // A wider projection may expose panes omitted from the previous viewport.
    // Reconcile their streams using current local state, without another RPC.
    if (this.state) void this.refresh(() => this.state!)
  }
  pause() { this.paused = true }
  resume() { if (!this.closed) { this.paused = false; this.render(); this.scheduleFlush() } }
  kill() { this.finish({ exitCode: 0 }) }
  private disposePane(pane: CorePane) {
    if (pane.disposed) return
    pane.disposed = true; pane.painted(); pane.stream?.close()
    for (const subscription of pane.subscriptions) subscription.dispose()
    pane.emulator.dispose()
  }
  private finish(exit: HerdrClientExit) {
    if (this.closed) return
    this.closed = true; this.exit = exit; this.input.dispose(); this.subscription?.close()
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const pane of this.attached.values()) this.disposePane(pane)
    this.attached.clear(); this.output = []; this.outputBytes = 0
    for (const listener of this.exitListeners) listener(exit)
  }
  private clipboard(data: string) {
    if (!this.initialized || data.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return
    this.emit(`\x1b]52;c;${data}\x07`)
  }
  private emit(data: string, frame?: WindowMetadata) {
    if (this.closed || !data && !frame) return
    this.output.push({ data, frame }); this.outputBytes += Buffer.byteLength(data)
    if (this.outputBytes > MAX_OUTPUT) { this.finish({ exitCode: 1 }); return }
    this.scheduleFlush()
  }
  private scheduleFlush() {
    if (this.flushing || this.paused || this.closed || !this.dataListeners.size) return
    this.flushing = true
    queueMicrotask(() => {
      this.flushing = false
      while (!this.closed && !this.paused && this.dataListeners.size && this.output.length) {
        const value = this.output.shift()!; this.outputBytes -= Buffer.byteLength(value.data)
        if (value.data) for (const listener of this.dataListeners) listener(value.data)
        if (value.frame) for (const listener of this.frameListeners) listener(value.frame)
      }
    })
  }
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); this.scheduleFlush(); return { dispose: () => { this.dataListeners.delete(listener) } } }
  onPaneFocus(listener: (id: string | undefined) => void) {
    this.paneFocusListeners.add(listener); queueMicrotask(() => { if (!this.closed && this.paneFocusListeners.has(listener)) listener(this.focused) })
    return { dispose: () => { this.paneFocusListeners.delete(listener) } }
  }
  onMetadata(listener: (metadata: WindowMetadata) => void) {
    this.metadataListeners.add(listener); const metadata = this.metadata
    queueMicrotask(() => { if (!this.closed && metadata && this.metadataListeners.has(listener)) listener(metadata) })
    return { dispose: () => { this.metadataListeners.delete(listener) } }
  }
  onFrame(listener: (metadata: WindowMetadata) => void) { this.frameListeners.add(listener); return { dispose: () => { this.frameListeners.delete(listener) } } }
  onSnapshot(listener: () => void) {
    this.snapshotListeners.add(listener); queueMicrotask(() => { if (!this.closed && this.state && this.snapshotListeners.has(listener)) listener() })
    return { dispose: () => { this.snapshotListeners.delete(listener) } }
  }
  onNotification(listener: (notification: NativeNotification) => void) { this.notificationListeners.add(listener); return { dispose: () => { this.notificationListeners.delete(listener) } } }
  onExit(listener: (exit: HerdrClientExit) => void) {
    this.exitListeners.add(listener); const exit = this.exit
    if (exit) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(exit) })
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }
}

export async function createCoreClient(options: CoreClientOptions): Promise<HerdrClientTransport> {
  const client = new CoreWindowClient(options)
  try { return await client.initialize() }
  catch (error) { client.kill(); throw error }
}
