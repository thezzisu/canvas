import { randomUUID } from 'node:crypto'
import { sameCompletion, type CompletionToken } from '../../shared/completion.ts'
import type { PaneAction, PaneContext, PanePoint } from '../../shared/pane-context.ts'
import type { NativeNotification } from '../../shared/notification.ts'
import type { WindowProgress } from '../../shared/window-metadata.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import { GhosttyTerminal } from '../ghostty/terminal.ts'
import { HerdrInputRouter } from '../herdr/input.ts'
import { mouseAreas, paneAt, type ScreenSelection } from '../herdr/screen.ts'
import { type NativeContentPane } from '../herdr/content.ts'
import { Events, Latest } from '../channels.ts'
import {
  isClipboardPayload,
  nextPaint,
  validateViewport,
  type Screen,
  type TransportExit,
  type WindowTransport,
} from '../transport.ts'
import type { ClientMessage, ClientShellSnapshot, PaneSurfaceFrame } from '../herdr/wire.ts'
import { CORE_CELL, coreInput, Win32InputMode } from './input.ts'
import {
  composeWindow,
  composedContent,
  markSelection,
  paneColumns,
  selectionText,
  type Composition,
} from './compose.ts'
import {
  CoreLayout,
  coreWindowMetadata,
  panes,
  projectCoreSnapshot,
  projectTab,
  type CoreSnapshot,
  type CoreTab,
  type CoreTerminal,
} from './layout.ts'
import { CoreRpc, CoreRpcError, type CoreNotification, type CoreStream } from './rpc.ts'
import { cssColour, terminalTheme } from '../../shared/terminal-theme.ts'

/** Lines of history a pane keeps, and asks the core for when it attaches. */
const HISTORY = 2000
interface CorePane {
  id: string
  address: string
  /** The pane's screen: it parses the program's output and encodes its input. */
  engine: GhosttyTerminal
  win32: Win32InputMode
  stream?: CoreStream
  revision: number
  ready: boolean
  paintComplete: boolean
  firstPaint: Promise<void>
  painted(): void
  disposed: boolean
  /** Its stream, the stream's subscriptions and its engine, released together. */
  resources: DisposableStack
  /** The pane's place in the window, and the grid last asked of its terminal for it. */
  place: { width: number; height: number }
  wanted: { cols: number; rows: number }
  parsedTurn: number
  parsedState?: string
  rootReport: boolean
  /** The working directory the program last reported (OSC 7). */
  reportedCwd?: string
  /** The program's last progress report (OSC 9;4), until it removes it. */
  progress?: WindowProgress
}

export interface CoreClientOptions {
  rpc: CoreRpc
  layout: CoreLayout
  spaceId: string
  tabId: string
  cols: number
  rows: number
  handshakeTimeoutMs?: number
  /** How long a synchronized update (DEC 2026) may hold the window's paint. */
  syncTimeoutMs?: number
}

/** One Canvas window, composed from independent native core terminal streams. */
class CoreWindowClient implements WindowTransport {
  private state?: CoreSnapshot
  private tab?: CoreTab
  private surface?: PaneSurfaceFrame
  private shell?: ClientShellSnapshot
  private renderedMetadata?: WindowMetadata
  private renderedContent?: {
    surface: PaneSurfaceFrame
    shell: ClientShellSnapshot
    composition: Composition
  }
  private layoutToken = { signature: '', token: '' }
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
  /** What the window holds; closing disposes it, which ends every subscription. */
  private readonly owned = new DisposableStack()
  readonly screen = this.owned.use(new Latest<Screen>())
  /** Metadata of the current screen. */
  readonly painted = this.owned.use(new Latest<WindowMetadata>())
  // Every Core event reaches every window; most leave this one as it was.
  readonly metadata = this.owned.use(new Latest<WindowMetadata>((value) => JSON.stringify(value)))
  readonly paneFocus = this.owned.use(new Latest<string | undefined>((paneId) => paneId))
  readonly snapshots = this.owned.use(new Latest<void>())
  readonly copies = this.owned.use(new Events<string>())
  readonly bells = this.owned.use(new Events<string>())
  readonly notifications = this.owned.use(new Events<NativeNotification>())
  readonly exit = new Latest<TransportExit>()
  private metadataScheduled = false
  private renderScheduled = false
  /** Painting waits while a program updates its screen in one go (DEC 2026), up to a limit. */
  private sync: { timer?: ReturnType<typeof setTimeout>; expired: boolean } = { expired: false }
  private closed = false
  private initialized = false

  constructor(private readonly options: CoreClientOptions) {
    validateViewport(options.cols, options.rows, 'core')
    this.cols = options.cols
    this.rows = options.rows
    this.input = this.owned.use(
      new HerdrInputRouter({
        tabId: options.tabId,
        getSurface: () => this.surface,
        getSnapshot: () => this.shell,
        send: (message) => this.send(message),
        request: (method, params) => this.request(method, params),
        onSelection: (selection) => {
          this.selection = selection
          this.render()
        },
        onCopy: (text) => this.clipboard(Buffer.from(text).toString('base64')),
      }),
    )
  }

  async initialize(): Promise<WindowTransport> {
    this.owned.use(this.options.rpc.onClose(() => this.finish({ exitCode: 1 })))
    // Subscribe before reading documents; doc changes are not part of the terminal snapshot.
    const subscription = await this.options.rpc.subscribe({}, (event) => this.event(event))
    this.owned.defer(() => subscription.close())
    this.owned.defer(() => clearTimeout(this.sync.timer))
    this.eventSeq = subscription.snapshot.seq
    await this.replace(await this.options.layout.snapshot(subscription.snapshot.terminals), true)
    subscription.start()
    const timeout = setTimeout(
      () => this.finish({ exitCode: 1 }),
      this.options.handshakeTimeoutMs ?? 15_000,
    )
    timeout.unref()
    using subscriptions = new DisposableStack()
    try {
      await Promise.race([
        Promise.all([...this.attached.values()].map((pane) => pane.firstPaint)),
        new Promise<never>((_, reject) =>
          subscriptions.use(
            this.exit.subscribe(() => reject(new Error('Core terminal first paint failed'))),
          ),
        ),
      ])
      if (this.closed) throw new Error('Core window closed while attaching')
      this.initialized = true
      this.render()
      return this
    } catch (error) {
      this.kill()
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private enqueue(action: () => Promise<void> | void): Promise<void> {
    const next = this.parseQueue.then(async () => {
      if (!this.closed) await action()
    })
    this.parseQueue = next.catch(() => this.finish({ exitCode: 1 }))
    return next
  }

  private async replace(state: CoreSnapshot, nativeSnapshot = false): Promise<void> {
    if (this.closed) return
    if (!nativeSnapshot && this.state?.coreId === state.coreId && state !== this.state)
      state = { ...state, terminals: this.state.terminals }
    const ended: Array<{ id: string; terminal: string }> = []
    const tabs =
      state === this.state
        ? []
        : state.spaces.flatMap((space) => space.tabs).filter((tab) => !tab.synthetic)
    for (const tab of tabs) {
      for (const pane of panes(tab)) {
        if (!pane.terminal) continue
        const terminal = state.terminals.find((item) => item.address === pane.terminal)
        if (
          terminal?.state === 'finished' &&
          ['exited', 'killed'].includes(String(terminal.reason))
        )
          ended.push({ id: pane.id, terminal: pane.terminal })
        else if (!terminal) {
          // Missing from a snapshot is not an exit: layout and native facts
          // have separate waterlines. Ask only whether the record is closed.
          try {
            const result = await this.options.rpc.call('terminal.get', { terminal: pane.terminal })
            const record =
              result.terminal && typeof result.terminal === 'object'
                ? (result.terminal as Record<string, unknown>)
                : result
            if (['exited', 'killed'].includes(String(record.reason)))
              ended.push({ id: pane.id, terminal: pane.terminal })
          } catch (error) {
            if (error instanceof CoreRpcError && error.kind === 'not_found')
              ended.push({ id: pane.id, terminal: pane.terminal })
          }
        }
      }
    }
    if (ended.length) {
      await this.options.layout.reconcileClosedPanes(ended, () => !this.closed)
      state = await this.options.layout.snapshot(state.terminals)
    }
    if (this.closed) return
    // Queries above may finish after a newer document action. Merge at commit,
    // not before awaiting them; only sequenced snapshots replace native facts.
    if (this.state?.coreId === state.coreId && state !== this.state) {
      const terminals = nativeSnapshot ? state.terminals : this.state.terminals
      state = projectCoreSnapshot({
        ...(state.documentVersion < this.state.documentVersion ? this.state : state),
        terminals,
      })
    }
    let tab: CoreTab
    try {
      tab = this.options.layout.findWindow(state, this.options.spaceId, this.options.tabId)
    } catch {
      this.finish({ exitCode: 0, reason: 'removed' })
      return
    }
    this.state = state
    this.tab = tab
    const projected = projectTab(tab, this.cols, this.rows, this.zoomed)
    const ids = new Set(projected.panes.filter((pane) => pane.terminal).map((pane) => pane.id))
    for (const [id, pane] of this.attached)
      if (
        !ids.has(id) ||
        projected.panes.find((item) => item.id === id)?.terminal !== pane.address
      ) {
        this.disposePane(pane)
        this.attached.delete(id)
      }
    if (!projected.panes.some((pane) => pane.id === this.focused))
      this.focused = projected.panes.find((pane) => pane.terminal)?.id || projected.panes[0]?.id
    await Promise.all(
      projected.panes.map(async (projected) => {
        if (!projected.terminal) return
        const terminal = state.terminals.find((terminal) => terminal.address === projected.terminal)
        const available = terminal?.state === 'live' && !(terminal.reason && !terminal.pid)
        const previous = this.attached.get(projected.id)
        if (previous) {
          // Fresh native facts recover ended streams and initial waiting panes in
          // the same way, even when the restarted event was missed.
          if (!nativeSnapshot || previous.stream || !previous.ready || !available) return
          this.disposePane(previous)
          this.attached.delete(previous.id)
        }
        const pane = this.makePane(
          projected.id,
          projected.terminal,
          projected.rect.width,
          projected.rect.height,
        )
        this.attached.set(pane.id, pane)
        if (!available) {
          pane.engine.write(
            terminal?.state === 'live' ? '[Waiting for terminal recovery]' : '[Terminal finished]',
          )
          pane.ready = true
          pane.painted()
          return
        }
        try {
          const attached = await this.options.rpc.attach({
            terminal: pane.address,
            cols: pane.wanted.cols,
            rows: pane.wanted.rows,
            history: HISTORY,
            resumed: true,
            // Programs asking for their colours are told the ones Canvas paints with.
            display: {
              fg: cssColour(terminalTheme.foreground),
              bg: cssColour(terminalTheme.background),
              cursor: cssColour(terminalTheme.cursor),
              cell: [CORE_CELL.width, CORE_CELL.height],
            },
          })
          if (pane.disposed || this.closed) {
            attached.stream.close()
            return
          }
          pane.stream = attached.stream
          pane.resources.defer(() => attached.stream.close())
          const nativeCols = Number(attached.terminal.cols),
            nativeRows = Number(attached.terminal.rows)
          validateViewport(nativeCols, nativeRows, 'core')
          pane.engine.resize(nativeCols, nativeRows)
          pane.parsedTurn = Number.isSafeInteger(attached.terminal.turn)
            ? Number(attached.terminal.turn)
            : 0
          const initialStatus = attached.terminal.status as { state?: unknown } | null | undefined
          pane.parsedState =
            typeof initialStatus?.state === 'string' ? initialStatus.state : undefined
          // Install all handlers before enabling queued DATA delivery.
          pane.resources.use(
            attached.stream.onResize((size) =>
              this.enqueue(() => {
                if (!pane.disposed) {
                  pane.engine.resize(size.cols, size.rows)
                  pane.revision++
                  this.render()
                }
              }),
            ),
          )
          pane.resources.use(
            attached.stream.onClose((reason) => {
              pane.stream = undefined
              pane.ready = true
              pane.painted()
              if (!this.closed && !pane.disposed)
                void this.refresh(async () => {
                  if (
                    !pane.disposed &&
                    ['exited', 'killed', 'finished'].includes(String(reason?.reason))
                  ) {
                    await this.options.layout.reconcileClosedPanes(
                      [{ id: pane.id, terminal: pane.address }],
                      () => !this.closed,
                    )
                  }
                  return this.options.layout.snapshot(this.state?.terminals)
                })
            }),
          )
          pane.resources.use(
            attached.stream.onData((data) =>
              this.enqueue(() => {
                if (pane.disposed) return
                // The core ends its first paint by saying whether the program wants win32 keys.
                if (pane.win32.scan(data)) pane.paintComplete = true
                const alternate = pane.engine.alternateScreen
                pane.engine.write(data)
                pane.revision++
                // The scrollbar's column is the program's on the alternate screen.
                if (pane.engine.alternateScreen !== alternate) this.resizeStreams(pane)
                if (pane.paintComplete) {
                  pane.ready = true
                  pane.painted()
                }
                this.render()
              }),
            ),
          )
        } catch (error) {
          this.disposePane(pane)
          this.attached.delete(pane.id)
          throw error
        }
      }),
    )
    this.resizeStreams()
    this.revision++
    this.updateMetadata()
    this.snapshots.set()
    this.render()
  }

  /** A pane for a place `width` columns wide; its program starts beside the scrollbar. */
  private makePane(id: string, address: string, width: number, rows: number): CorePane {
    const cols = paneColumns(width, false)
    let painted!: () => void
    const firstPaint = new Promise<void>((resolve) => {
      painted = resolve
    })
    // No reply reaches the program from here: the core answers its queries itself.
    const engine = new GhosttyTerminal(Math.max(1, cols), Math.max(1, rows), HISTORY, {
      clipboard: (text) => this.clipboard(Buffer.from(text).toString('base64')),
      pwd: (path) => {
        pane.reportedCwd = path
      },
      bell: () => this.bells.emit(pane.id),
      notification: (title, body) => this.programNotification(pane, title, body),
      progress: (progress) => {
        if (progress?.state === pane.progress?.state && progress?.value === pane.progress?.value)
          return
        pane.progress = progress
        this.scheduleMetadata()
      },
      status: (record, state) => {
        if (record) return
        // The attach reply seeds its turn. Its first report is a replay of that
        // snapshot, not another transition; subsequent reports are live bytes.
        if (pane.rootReport && pane.parsedState === 'working' && state !== 'working')
          pane.parsedTurn++
        pane.rootReport = true
        pane.parsedState = state === 'clear' ? undefined : state
      },
    })
    const pane: CorePane = {
      id,
      address,
      engine,
      win32: new Win32InputMode(),
      revision: 0,
      ready: false,
      paintComplete: false,
      firstPaint,
      painted,
      disposed: false,
      resources: new DisposableStack(),
      place: { width, height: rows },
      wanted: { cols, rows },
      parsedTurn: 0,
      rootReport: false,
    }
    pane.resources.defer(() => engine.free())
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
      if (
        !Array.isArray(snapshot) ||
        !snapshot.every((value) => value && typeof value === 'object' && !Array.isArray(value))
      ) {
        throw new Error('Invalid core recovery snapshot')
      }
      await this.refresh(
        () => this.options.layout.snapshot(snapshot as Record<string, unknown>[]),
        true,
      )
      return
    }
    const { type, terminal: address, data } = event.params
    if (type === 'doc') {
      await this.refresh()
      return
    }
    if (typeof address !== 'string' || !this.state || (data !== null && typeof data !== 'object'))
      return
    if (['created', 'removed', 'restarted', 'lost', 'finished'].includes(String(type))) {
      const update = data as Record<string, unknown>,
        terminals = this.state.terminals.slice()
      if (!update || Array.isArray(update)) throw new Error('Invalid core terminal event')
      const index = terminals.findIndex((terminal) => terminal.address === address)
      if (type === 'created' || type === 'restarted') {
        if (update.address !== address) throw new Error('Invalid core terminal event')
        if (index < 0) terminals.push(update as CoreTerminal)
        else terminals[index] = update as CoreTerminal
        for (const [id, pane] of this.attached)
          if (pane.address === address && type === 'restarted') {
            this.disposePane(pane)
            this.attached.delete(id)
          }
      } else if (index >= 0) {
        if (type === 'removed') terminals.splice(index, 1)
        else
          terminals[index] = {
            ...terminals[index]!,
            ...update,
            state: type === 'lost' ? 'live' : 'finished',
            ...(type === 'lost' ? { pid: null } : {}),
            foreground: null,
          }
      }
      await this.refresh(() => this.options.layout.snapshot(terminals), true)
      return
    }
    await this.enqueue(() => {
      const terminal = this.state?.terminals.find((terminal) => terminal.address === address)
      if (!terminal) return
      const before = terminal.status?.state,
        priorTurn = terminal.turn
      const update = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      if (type === 'status') {
        terminal.status = update.status as CoreTerminal['status']
        terminal.records = update.records
        terminal.reported = update.reported
      } else if (type === 'turn' && Number.isSafeInteger(update.turn))
        terminal.turn = Number(update.turn)
      else if (type === 'labels' && update.labels && typeof update.labels === 'object')
        terminal.labels = update.labels as Record<string, string>
      else if (type === 'title' && typeof update.title === 'string') terminal.title = update.title
      else if (type === 'keep' && typeof update.keep === 'boolean') terminal.keep = update.keep
      else if (type === 'foreground') terminal.foreground = data as CoreTerminal['foreground']
      else if (type === 'size' && Number.isInteger(update.cols) && Number.isInteger(update.rows)) {
        terminal.cols = Number(update.cols)
        terminal.rows = Number(update.rows)
        for (const pane of this.attached.values())
          if (
            pane.address === address &&
            (pane.engine.cols !== terminal.cols || pane.engine.rows !== terminal.rows)
          ) {
            pane.engine.resize(terminal.cols, terminal.rows)
            pane.revision++
          }
      }
      this.revision++
      this.updateMetadata()
      this.render()
      this.snapshots.set()
      if (
        this.initialized &&
        type === 'status' &&
        before !== terminal.status?.state &&
        ['blocked', 'error'].includes(terminal.status?.state || '')
      )
        this.notify(terminal, 'attention')
      if (
        this.initialized &&
        type === 'turn' &&
        terminal.turn > priorTurn &&
        !['working', 'blocked', 'error'].includes(terminal.status?.state || '')
      )
        this.notify(terminal, 'done')
    })
  }

  private notify(terminal: CoreTerminal, kind: 'attention' | 'done') {
    const target = this.state?.spaces.flatMap((space) =>
      space.tabs.flatMap((tab) => {
        const pane = panes(tab).find((pane) => pane.terminal === terminal.address)
        return pane ? [{ space, tab, pane }] : []
      }),
    )[0]
    if (!target) return
    const notification: NativeNotification = {
      kind,
      title: terminal.status?.title || terminal.name || terminal.title || terminal.address,
      ...(terminal.status?.msg ? { body: terminal.status.msg } : {}),
      ...(terminal.status?.app ? { agent: terminal.status.app } : {}),
      spaceId: target.space.id,
      windowId: target.tab.id,
      paneId: target.pane.id,
    }
    this.notifications.emit(notification)
  }

  private refresh(
    snapshot?: () => CoreSnapshot | Promise<CoreSnapshot>,
    nativeSnapshot = false,
  ): Promise<void> {
    const next = this.refreshQueue.then(async () => {
      if (!this.closed)
        await this.replace(
          snapshot ? await snapshot() : await this.options.layout.snapshot(this.state?.terminals),
          nativeSnapshot,
        )
    })
    this.refreshQueue = next.catch(() => this.finish({ exitCode: 1 }))
    return this.refreshQueue
  }

  private updateMetadata() {
    if (!this.state) return
    const metadata = coreWindowMetadata(this.state, this.options.tabId, this.focused)
    const progress = windowProgress([...this.attached.values()].map((pane) => pane.progress))
    if (metadata) this.metadata.set(progress ? { ...metadata, progress } : metadata)
    else this.metadata.clear()
  }
  /** Reports in one write update the metadata once. */
  private scheduleMetadata() {
    if (this.metadataScheduled) return
    this.metadataScheduled = true
    queueMicrotask(() => {
      this.metadataScheduled = false
      if (!this.closed) this.updateMetadata()
    })
  }
  private programNotification(pane: CorePane, title: string, body: string) {
    if (this.closed || !this.initialized) return
    const text = [plain(title), plain(body)].filter(Boolean).join(' — ').slice(0, 500)
    if (!text) return
    const notification: NativeNotification = {
      kind: 'custom',
      origin: 'program',
      title: (this.metadata.current?.name || pane.address).slice(0, 120),
      body: text,
      spaceId: this.options.spaceId,
      windowId: this.options.tabId,
      paneId: pane.id,
    }
    this.notifications.emit(notification)
  }

  private render() {
    if (this.closed || this.renderScheduled || !this.initialized) return
    this.renderScheduled = true
    queueMicrotask(() => {
      this.renderScheduled = false
      if (
        this.closed ||
        !this.state ||
        !this.tab ||
        [...this.attached.values()].some((pane) => !pane.ready)
      )
        return
      if (this.holdForSync()) return
      // Every way the focused pane changes (layout, split, focus request) ends in a paint.
      this.paneFocus.set(this.focused)
      const projection = projectTab(this.tab, this.cols, this.rows, this.zoomed)
      if (projection.panes.some((pane) => pane.terminal && !this.attached.has(pane.id))) return
      const composition = composeWindow(
        projection,
        this.attached,
        this.state.terminals,
        this.focused,
        this.cols,
        this.rows,
      )
      const { frame, panes: surfacePanes, splits, owners, layers } = composition
      const visible = new Set(owners)
      const signature = JSON.stringify([
        this.state.coreId,
        this.options.tabId,
        this.cols,
        this.rows,
        surfacePanes.map((pane) => [pane.pane_id, pane.inner_rect]),
      ])
      if (signature !== this.layoutToken.signature)
        this.layoutToken = { signature, token: randomUUID() }
      const shell: ClientShellSnapshot = {
        boot_id: this.state.coreId,
        revision: ++this.revision,
        focused_workspace_id: this.options.spaceId,
        focused_tab_id: this.options.tabId,
        focused_pane_id: this.focused || null,
        tabs: [{ tab_id: this.options.tabId, workspace_id: this.options.spaceId, focused: true }],
        panes: surfacePanes.map((pane) => ({
          pane_id: pane.pane_id,
          tab_id: this.options.tabId,
          workspace_id: this.options.spaceId,
          focused: pane.focused,
          right_click_passthrough: false,
          label: this.metadata.current?.panes.find((item) => item.id === pane.pane_id)?.name || '',
          ...cwds(
            this.attached.get(pane.pane_id),
            this.state!.terminals.find(
              (terminal) => terminal.address === this.attached.get(pane.pane_id)?.address,
            ),
          ),
        })),
      }
      const surface: PaneSurfaceFrame = {
        boot_id: this.state.coreId,
        projection_revision: shell.revision,
        surface_revision: shell.revision,
        frame,
        panes: surfacePanes,
        splits,
        popup: null,
      }
      this.shell = shell
      this.surface = surface
      this.input.refresh()
      this.renderedContent = { surface, shell, composition }
      const current = this.metadata.current
      this.renderedMetadata = current
        ? {
            ...current,
            layout: this.layoutToken.token,
            panes: current.panes.map((metadata) => {
              const pane = this.attached.get(metadata.id),
                owner = layers.indexOf(metadata.id) + 1
              if (
                !metadata.completion ||
                (pane &&
                  owner > 0 &&
                  visible.has(owner) &&
                  this.completionPainted(pane, metadata.completion))
              )
                return metadata
              const { completion: _completion, ...pending } = metadata
              return pending
            }),
          }
        : undefined
      const painted = this.renderedMetadata
      if (!painted) this.painted.clear()
      this.screen.set({
        grid: this.selection ? markSelection(composition, this.selection) : frame,
        mouse: mouseAreas(
          surface,
          new Map([...this.attached].map(([id, pane]) => [id, pane.engine.pointer])),
        ),
      })
      if (painted) this.painted.set(painted)
    })
  }

  /**
   * Whether a pane's program is in the middle of a synchronized update. Its engine already holds
   * the half-drawn screen, so the whole window waits for the update's end, or, for a program that
   * never ends it, for the time limit.
   */
  private holdForSync() {
    const syncing = [...this.attached.values()].some((pane) => pane.engine.mode(2026))
    if (!syncing) {
      clearTimeout(this.sync.timer)
      this.sync = { expired: false }
      return false
    }
    if (this.sync.expired) return false
    if (!this.sync.timer) {
      this.sync.timer = setTimeout(() => {
        this.sync = { expired: true }
        this.render()
      }, this.options.syncTimeoutMs ?? 1000)
      this.sync.timer.unref()
    }
    return true
  }

  private send(message: ClientMessage) {
    if (this.closed || typeof message === 'string') return
    if ('ClientShellPaneInput' in message) {
      const input = message.ClientShellPaneInput,
        pane = this.attached.get(input.pane_id)
      if (!pane?.stream) return
      // What reaches the program, other than hovering, returns the pane to its latest output.
      // A wheel step a program without mouse reporting never hears of does not.
      let used = false
      for (const event of input.events) {
        const bytes = coreInput(event, pane.engine, pane.win32.on)
        if (!bytes.length) continue
        pane.stream.write(Buffer.from(bytes))
        used ||= !('Mouse' in event) || event.Mouse.kind !== 'Moved'
      }
      const scroll = pane.engine.scroll
      if (used && scroll.top < scroll.max) {
        pane.engine.scrollTo(scroll.max)
        this.render()
      }
    } else if ('ClientShellFocus' in message)
      this.attached.get(this.focused || '')?.stream?.focus(message.ClientShellFocus.focused)
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Core window is closed')
    const paneId = String(params.pane_id || ''),
      pane = this.attached.get(paneId)
    if (method === 'pane.focus') {
      if (!pane) throw new Error('Pane no longer exists')
      this.attached.get(this.focused || '')?.stream?.focus(false)
      this.focused = paneId
      pane.stream?.focus(true)
      this.revision++
      this.updateMetadata()
      this.paneFocus.set(paneId)
      this.render()
      return {}
    }
    if (method === 'pane.scroll') {
      if (!pane || !Number.isSafeInteger(params.offset_from_bottom))
        throw new Error('Invalid pane scroll')
      pane.engine.scrollTo(pane.engine.scroll.max - Number(params.offset_from_bottom))
      this.render()
      return {}
    }
    if (method === 'pane.selection.read') {
      if (!pane || params.content_revision !== pane.revision)
        throw new Error('Pane output changed during selection')
      return {
        pane_id: paneId,
        text: selectionText(
          pane.engine,
          pane.id,
          params.anchor,
          params.cursor,
          this.renderedContent?.composition,
        ),
      }
    }
    if (method === 'layout.set_split_ratio') {
      const state = await this.options.layout.setSplitRatio(
        this.options.spaceId,
        this.options.tabId,
        params.path as boolean[],
        Number(params.ratio),
        () => !this.closed,
      )
      await this.replace(state)
      this.resizeStreams()
      return {}
    }
    throw new Error(`Unsupported core view operation: ${method}`)
  }

  async content(): Promise<NativeContentPane[] | undefined> {
    await this.parseQueue
    const rendered = this.renderedContent
    if (this.closed || !rendered || !this.state) return
    return composedContent(
      rendered.composition,
      rendered.surface,
      rendered.shell,
      this.options.tabId,
      (paneId) => this.attached.get(paneId)?.engine,
    )
  }
  paneContext(point: PanePoint): PaneContext | undefined {
    if (
      this.closed ||
      !this.surface ||
      point.layout !== this.layoutToken.token ||
      point.cols !== this.cols ||
      point.rows !== this.rows
    )
      return
    const pane = paneAt(this.surface, point.column, point.row)
    return pane
      ? {
          bootId: this.state!.coreId,
          paneId: pane.pane_id,
          name: this.metadata.current?.panes.find((item) => item.id === pane.pane_id)?.name || '',
        }
      : undefined
  }
  async paneAction(
    context: PaneContext,
    action: PaneAction,
    authorized: () => boolean = () => true,
  ): Promise<unknown> {
    const valid = () =>
      authorized() &&
      !this.closed &&
      this.state?.coreId === context.bootId &&
      !!this.tab &&
      panes(this.tab).some((pane) => pane.id === context.paneId)
    if (!valid()) throw new Error('Pane changed; open its menu again')
    if (action.action === 'zoom') {
      await this.replace(await this.options.layout.snapshot(this.state?.terminals))
      if (!valid()) throw new Error('Pane changed; open its menu again')
      this.zoomed = this.zoomed === context.paneId ? undefined : context.paneId
      await this.replace(this.state!)
      this.resizeStreams()
      return {}
    }
    const state = await this.options.layout.paneAction(
      this.options.spaceId,
      this.options.tabId,
      context.paneId,
      action,
      valid,
    )
    if (!this.closed) {
      if (action.action.startsWith('split-')) {
        const previous = new Set(this.tab ? panes(this.tab).map((pane) => pane.id) : [])
        const updated = state.spaces
          .flatMap((space) => space.tabs)
          .find((tab) => tab.id === this.options.tabId)
        this.focused = updated && panes(updated).find((pane) => !previous.has(pane.id))?.id
      }
      await this.replace(state)
      this.resizeStreams()
    }
    return {}
  }
  async acknowledgeCompletion(paneId: string, completion: CompletionToken): Promise<void> {
    if (this.closed || completion.bootId !== this.state?.coreId || !this.tab) return
    const address = panes(this.tab).find((pane) => pane.id === paneId)?.terminal
    const terminal = this.state.terminals.find((terminal) => terminal.address === address)
    const pane = this.attached.get(paneId)
    if (
      !address ||
      terminal?.turn !== completion.sequence ||
      !pane ||
      !this.completionPainted(pane, completion) ||
      !sameCompletion(
        this.renderedMetadata?.panes.find((value) => value.id === paneId)?.completion,
        completion,
      )
    )
      return
    await this.options.layout.markSeen(address, completion.sequence)
    await this.refresh()
  }
  private completionPainted(pane: CorePane, completion: CompletionToken): boolean {
    return (
      pane.ready &&
      pane.parsedTurn === completion.sequence &&
      !['working', 'blocked', 'error'].includes(pane.parsedState || '')
    )
  }
  completionSnapshot() {
    if (this.closed || !this.state) return
    return {
      windows: this.state.spaces.flatMap((space) =>
        space.tabs.map((tab) =>
          coreWindowMetadata(
            this.state!,
            tab.id,
            tab.id === this.options.tabId ? this.focused : undefined,
          )!,
        ),
      ),
      state: { bootId: this.state.coreId, revision: this.revision },
    }
  }
  async completionFence(): Promise<WindowMetadata | undefined> {
    await this.input.settled()
    await this.parseQueue
    if (this.closed) return
    // Core events and terminal bytes are independent channels. This fences the
    // bytes already received and parsed, not unseen future remote output.
    const paint = nextPaint(this.painted, this.exit)
    this.render()
    return paint
  }
  write(data: string | Buffer) {
    if (!this.closed && this.initialized) this.input.write(data)
  }
  /**
   * Sizes each pane's terminal for its place in the window. A pane whose place is unchanged is
   * left alone, so another viewer's grid is taken over only when this window is resized. With
   * `screen`, that pane's program changed screens: it gets or gives back the scrollbar's column
   * while its grid is still the one this view asked for.
   */
  private resizeStreams(screen?: CorePane) {
    if (!this.tab) return
    for (const projected of projectTab(this.tab, this.cols, this.rows, this.zoomed).panes) {
      const pane = this.attached.get(projected.id)
      if (!pane || pane.disposed) continue
      const { width, height } = projected.rect,
        moved = pane.place.width !== width || pane.place.height !== height,
        owned = pane.engine.cols === pane.wanted.cols && pane.engine.rows === pane.wanted.rows
      if (!moved && !(pane === screen && owned)) continue
      pane.place = { width, height }
      const cols = paneColumns(width, pane.engine.alternateScreen)
      pane.wanted = { cols, rows: height }
      pane.engine.resize(Math.max(1, cols), Math.max(1, height))
      pane.revision++
      pane.stream?.resize(cols, height)
    }
    this.render()
  }
  resize(cols: number, rows: number) {
    validateViewport(cols, rows, 'core')
    if (this.closed || (this.cols === cols && this.rows === rows)) return
    this.cols = cols
    this.rows = rows
    this.selection = undefined
    // A wider projection may expose panes omitted from the previous viewport.
    // Reconcile their streams using current local state, without another RPC.
    if (this.state) void this.refresh(() => this.state!)
  }
  kill() {
    this.finish({ exitCode: 0 })
  }
  private disposePane(pane: CorePane) {
    if (pane.disposed) return
    pane.disposed = true
    pane.painted()
    pane.resources.dispose()
  }
  private finish(exit: TransportExit) {
    if (this.closed) return
    this.closed = true
    this.owned.dispose()
    for (const pane of this.attached.values()) this.disposePane(pane)
    this.attached.clear()
    this.exit.set(exit)
  }
  private clipboard(data: string) {
    if (this.initialized && isClipboardPayload(data)) this.copies.emit(data)
  }
}

export async function createCoreClient(options: CoreClientOptions): Promise<WindowTransport> {
  const client = new CoreWindowClient(options)
  try {
    return await client.initialize()
  } catch (error) {
    client.kill()
    throw error
  }
}

/** Text a program asked to show, without control or direction-override characters. */
const plain = (text: string) =>
  text
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

/** The window's progress: an error first, then the furthest percentage, then any without one. */
export function windowProgress(
  reports: readonly (WindowProgress | undefined)[],
): WindowProgress | undefined {
  const rank = { error: 3, normal: 2, indeterminate: 1, paused: 0 } as const
  return reports.reduce<WindowProgress | undefined>((best, report) => {
    if (!report) return best
    if (!best || rank[report.state] > rank[best.state]) return report
    return rank[report.state] === rank[best.state] && (report.value ?? -1) > (best.value ?? -1)
      ? report
      : best
  }, undefined)
}

/** As herdr: the foreground program's directory, then the one it reported, then where it started. */
const cwds = (
  pane: CorePane | undefined,
  terminal: { foreground?: { cwd?: string } | null; cwd?: string } | undefined,
) => ({
  foreground_cwd: terminal?.foreground?.cwd,
  cwd: pane?.reportedCwd ?? terminal?.cwd,
})
