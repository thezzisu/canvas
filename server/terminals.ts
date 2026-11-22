// The window channel: what one browser exchanges with one herdr window. A browser tab has one
// socket, and a channel on it for each window it shows (terminal-channels.ts).
//
// The server's herdr client is the only terminal client; the browser mirrors its screen and
// sends input. Binary messages are cell messages (shared/cell-wire.ts); text messages are JSON.
//
// Cells, server to browser:
// - The window counts the grids its client has shown; that count is the revision. A FRAME or
//   PATCH carries the revision it brings the browser to, and a PATCH names as `base` the
//   revision of the previous cell message on this channel. Revisions may skip: a browser is
//   brought to the latest grid, never through the ones in between.
// - A FRAME is sent when the browser has nothing to patch: on joining, on becoming visible
//   again, when a maximized view it did not own is released, when the grid changes size, and
//   when the stream's style or link table has outgrown its limit. Otherwise changed rows and
//   the cursor travel as a PATCH; an unchanged grid sends nothing.
// - The grid size is the FRAME's. After a size change no cells are sent until the client
//   shows a grid of the new size. There is no separate reset or resize message.
// - One cell message is in flight per channel. While it is, newer grids are not sent; when it
//   has gone out to the network the browser gets one message to the latest grid. So the socket
//   never queues more than one cell message per window, however fast a window redraws, and
//   that window's next message goes behind what the other windows queued meanwhile.
// - A browser that is hidden, or covered by another browser's maximized view, gets no cells
//   or clipboard. `presentation` tells it which.
// - A browser that cannot apply a cell message has lost the stream: it closes the channel and
//   opens another.
//
// Views:
// - A page's view of the window outlives its channels. A later channel of the view replaces
//   the one before, which closes: what still arrives on that one is dropped. Input control
//   goes to the new channel, and so does the maximized size if the view is still maximized.
// - `resume` is the first message of a channel that joined: how far the view's messages were
//   taken, or null when the window does not know the view. A browser sends again only what
//   came after that, and nothing if it is null: lost, never done twice.
//
// JSON, server to browser:
//   resume            { taken }
//   status            { status: 'connecting' } | { status: 'connected', readOnly } |
//                     { status: 'error', error } | { status: 'removed' | 'closed' }; the server
//                     closes the channel after the last three
//   presentation      { maximized, owned, token?, lease? }; after the FRAME when a view resumes
//   focus-resize      { active, owned, token?, reason? }, the maximized viewport lease
//   pane-focus        { paneId }
//   metadata          { window, at }, `at` when it was published on the server's clock
//   mouse-areas       { areas }, where the window's programs take the mouse (MouseArea[]);
//                     sent when it changes, and on joining when any program takes it
//   completion-frame  { generation, focusedPaneId, layout, panes }; follows the cell message
//                     that painted it
//   capture           { capture }
//   clipboard         { data }, base64 text copied by a pane or a selection
//   bell              the window rang; sent only to the browser controlling its input
//   pong              { id }
//
// JSON, browser to server:
//   input             { data }, bytes for a terminal whose modes are fixed:
//                     application cursor keys, bracketed paste, any-event mouse tracking with
//                     SGR cell coordinates, focus reports
//   focus             take input control
//   view-visible      { visible, focused? }
//   focus-resize-begin | -update { token, cols, rows }, focus-resize-end { token }
//   presentation-cancel { lease }, the maximization a peer saw, which no other has the number of
//   completion-fence  { generation }, completion-read { generation, paneId, bootId, sequence }
//   ping              { id }
//
// Uploads and downloads put their own JSON messages on this channel (uploads.ts, open-download.ts).
import { CompletionReads } from './completion-reads.ts'
import type { PaneAction, PaneContext, PanePoint } from '../shared/pane-context.ts'
import { sameCompletion, type CompletionToken } from '../shared/completion.ts'
import type { TerminalChannel } from './terminal-channels.ts'
import { sourceConnectionKey, type Source } from './state.ts'
import { openTerminal } from './runtimes.ts'
import { GeometryController, type Size } from './geometry.ts'
import { serverTime } from './server-time.ts'
import { warn } from './log.ts'
import { logIdentifier } from '../shared/log-line.ts'
import type { WindowTransport } from './transport.ts'
import { Events, type Subscribable } from './channels.ts'
import { NotificationIntake } from './notification-intake.ts'
import type { FrameData } from './herdr/wire.ts'
import { GridEncoder } from './cell-grid.ts'
import type { WindowMetadata, WindowProgress } from '../shared/window-metadata.ts'
import type { CanvasNotification } from '../shared/notification.ts'
import { bracketedPaste, type PasteSegment } from '../shared/paste.ts'
import type { CaptureDescriptor, CaptureState } from '../shared/capture.ts'
import { defaultTerminalCell } from '../shared/settings.ts'
import { defaultWindowSize, normalTerminalGrid } from '../shared/window-size.ts'
import { isTerminalHoverInput } from '../shared/terminal-mouse.ts'
export type TerminalTarget = {
  sourceId: string
  spaceId: string
  windowId: string
}
// Agents may read a pasted attachment path asynchronously and insert its
// placeholder later. Following text waits until the screen has stayed quiet.
export const PASTE_SETTLE_QUIET_MS = 500
export const PASTE_SETTLE_LIMIT_MS = 2_000
// One paste never holds keyboard input or its upload request much longer.
export const PASTE_TOTAL_LIMIT_MS = 10_000
const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback
function json(ws: TerminalChannel, data: object) {
  ws.send(data)
}
/** A page's view of the window, whichever channel carries it now. */
interface ViewRecord {
  channel: TerminalChannel
}
/** Views remembered beyond those connected; a forgotten one resumes as unknown. */
const MAX_KNOWN_VIEWS = 256
/** One browser on the window: what it reported, and what it has been sent. */
interface View {
  record: ViewRecord
  encoder: GridEncoder
  /** The browser paints this window; otherwise it is owed a FRAME when it next does. */
  shown: boolean
  /** The browser does not show the window at all. */
  hidden: boolean
  /** The window holds the browser's read focus. */
  focused: boolean
  /** A cell message is still on its way out; the next one waits for it. */
  sending: boolean
  /** Metadata is on its way out; `due` when newer came meanwhile, which follows it. */
  metadata?: { due: boolean }
  /** The completion frame, then the presentation, follow the next cell message. */
  frameDue: boolean
  presentationDue: boolean
  /** The completion frame it was last sent, which its reads refer to. */
  sentFrame?: WindowMetadata
  /** Its last completion fence, and the one still waiting for its frame. */
  readGeneration: number
  pendingFence?: number
}
/** What a live terminal is opened with. */
export interface LiveTerminalOptions {
  source: Source
  target: TerminalTarget
  handle: Awaited<ReturnType<typeof openTerminal>>
  proc: WindowTransport
  size: Size
  reads?: CompletionReads
  /** The window is closed and its connections released. */
  onClose(): void
  /** The window went away while a browser had it in front. */
  onFocusedRemove?(): void
  capture?(): CaptureDescriptor | null
  /** A browser started reading the window. */
  onReadFocus?(): void
}
/** How long a window no browser shows stays open, as its source's watch does. */
const IDLE_MS = 20_000

export class LiveTerminal {
  /** Every browser channel on the window. */
  readonly clients = new Map<TerminalChannel, View>()
  /** The grid the herdr client shows; absent until it shows one of the current size. */
  grid?: FrameData
  /** A count of the grids the client has shown. */
  private revision = 0
  private readonly known = new Map<string, ViewRecord>()
  private maximized?: {
    owner: TerminalChannel
    view: ViewRecord
    token: string
    lease: number
    releasing?: boolean
    /** It passed to a new channel of its view, whose first request renames it. */
    handedOver?: boolean
  }
  private presentationRevision = 0
  private focusedPaneId?: string
  private metadata?: WindowMetadata
  private metadataAt = 0
  private bellQueued = false
  private rawMetadata?: WindowMetadata
  private frame?: WindowMetadata
  /** Where the window's programs take the mouse, as last sent. */
  private mouseAreas = '[]'
  /** The window's subscriptions, disposed when it closes. */
  private readonly owned = new DisposableStack()
  private outputWaiters = new Set<() => void>()
  // Keyboard input typed during a paced paste follows the complete paste.
  private pasting?: Promise<void>
  controller?: TerminalChannel
  private downloadController?: TerminalChannel
  private idle?: ReturnType<typeof setTimeout>
  /** A view keeps its size over its channels, so the owner is the view. */
  geometry: GeometryController<ViewRecord>
  closing?: Promise<void>
  closed = false
  cols: number
  rows: number
  private normalSize: Size
  readonly source: Source
  readonly sourceId: string
  readonly connectionKey: string
  readonly spaceId: string
  readonly windowId: string
  readonly proc: WindowTransport
  private readonly reads?: CompletionReads
  constructor(private readonly options: LiveTerminalOptions) {
    const { source, target, proc, reads } = options,
      { cols, rows } = options.size
    this.source = source
    this.sourceId = source.id
    this.connectionKey = sourceConnectionKey(source)
    this.spaceId = target.spaceId
    this.windowId = target.windowId
    this.proc = proc
    this.reads = reads
    this.cols = cols
    this.rows = rows
    this.normalSize = { cols, rows }
    this.geometry = new GeometryController(
      { cols, rows },
      (size) => this.adoptGeometry(size),
      (reason) => {
        for (const ws of this.clients.keys())
          json(ws, {
            ...this.geometry.state(this.clients.get(ws)!.record),
            ...(reason ? { reason } : {}),
          })
      },
      () => {
        void this.close()
      },
    )
    // Closing disposes these, so none of them runs for a closed window.
    const { owned } = this
    owned.use(
      proc.paneFocus.subscribe((paneId) => {
        if (this.focusedPaneId === paneId) return
        this.focusedPaneId = paneId
        for (const ws of this.clients.keys()) json(ws, { type: 'pane-focus', paneId })
      }),
    )
    if (reads)
      owned.use(
        reads.changes.subscribe((sourceId) => {
          if (sourceId === this.sourceId) this.publishMetadata()
        }),
      )
    owned.use(
      proc.metadata.subscribe((metadata) => {
        this.rawMetadata = metadata
        this.publishMetadata()
      }),
    )
    owned.use(
      proc.screen.subscribe(({ grid, mouse }) => {
        const areas = JSON.stringify(mouse)
        if (areas !== this.mouseAreas) {
          this.mouseAreas = areas
          for (const ws of this.clients.keys()) this.sendMouseAreas(ws)
        }
        for (const waiter of this.outputWaiters) waiter()
        this.grid = grid
        this.revision++
        for (const ws of this.clients.keys()) this.pump(ws)
      }),
    )
    owned.use(
      proc.painted.subscribe((frame) => {
        this.frame = frame
        for (const [ws, view] of this.clients)
          if (view.pendingFence === undefined && this.canRender(ws)) {
            view.frameDue = true
            this.pump(ws)
          }
      }),
    )
    owned.use(
      proc.copies.subscribe((data) => {
        for (const ws of this.clients.keys())
          if (this.canRender(ws)) json(ws, { type: 'clipboard', data })
      }),
    )
    // An agent that reports its state says when it needs you; its bell would say it again. herdr
    // names no pane, so there any agent in the window counts. Bells written together ring once, in
    // one place: the browser at the keyboard, as herdr rings only its foreground client.
    owned.use(
      proc.bells.subscribe((paneId) => {
        if (this.bellQueued || this.agentReports(paneId)) return
        this.bellQueued = true
        queueMicrotask(() => {
          this.bellQueued = false
          const ws = this.controller
          if (!this.closed && ws && this.clients.has(ws) && this.canRender(ws))
            json(ws, { type: 'bell' })
        })
      }),
    )
    owned.use(proc.exit.subscribe((event) => void this.close(event.reason)))
  }
  /** The progress the window's programs report, as its terminal last published it. */
  get progress() {
    return this.rawMetadata?.progress
  }
  /** Whether an agent reports its state in the pane, or in any pane when none is named. */
  agentReports(paneId?: string) {
    return !!this.metadata?.panes.some(
      (pane) => (paneId === undefined || pane.id === paneId) && pane.status !== 'unknown',
    )
  }
  private publishMetadata() {
    if (this.closed || !this.rawMetadata) return
    this.metadata = this.reads?.project(this.source, this.rawMetadata) || this.rawMetadata
    this.metadataAt = serverTime()
    for (const ws of this.clients.keys()) this.sendMetadata(ws)
  }
  /**
   * Like cells, a browser has at most one metadata message in flight; the current metadata
   * follows it, so a slow socket skips the states in between.
   */
  private sendMetadata(ws: TerminalChannel) {
    const view = this.clients.get(ws)
    if (!this.metadata || !view) return
    if (view.metadata) {
      view.metadata.due = true
      return
    }
    const sending = (view.metadata = { due: false })
    ws.send({ type: 'metadata', window: this.metadata, at: this.metadataAt }, () => {
      view.metadata = undefined
      if (sending.due && !this.closed) this.sendMetadata(ws)
    })
  }
  private sendMouseAreas(ws: TerminalChannel) {
    json(ws, { type: 'mouse-areas', areas: JSON.parse(this.mouseAreas) })
  }
  private publishFrame(ws: TerminalChannel, view: View) {
    if (!this.frame || view.pendingFence !== undefined) return
    const frame = (view.sentFrame = this.reads?.project(this.source, this.frame) || this.frame)
    json(ws, {
      type: 'completion-frame',
      generation: view.readGeneration,
      focusedPaneId: frame.panes.find((pane) => pane.active)?.id,
      layout: frame.layout,
      panes: frame.panes.map((pane) => ({
        id: pane.id,
        ...(pane.completion ? { completion: pane.completion } : {}),
      })),
    })
  }
  /**
   * Brings a browser up to the current grid unless a cell message is still going out to it;
   * that message's completion runs this again, so a slow socket skips the grids in between.
   */
  private pump(ws: TerminalChannel) {
    const view = this.clients.get(ws)
    if (!view || view.sending || !this.grid || ws.readyState !== 1 || !this.canRender(ws)) return
    const message = view.encoder.encode(this.grid, this.revision)
    if (message) {
      view.sending = true
      ws.send(message, () => {
        view.sending = false
        if (!this.closed) this.pump(ws)
      })
    }
    if (view.frameDue) {
      view.frameDue = false
      this.publishFrame(ws, view)
    }
    if (view.presentationDue) {
      view.presentationDue = false
      this.presentation(ws)
    }
  }
  private canRender(ws: TerminalChannel) {
    const view = this.clients.get(ws)
    return (
      !!view &&
      !view.hidden &&
      view.shown &&
      (!this.maximized || (!this.maximized.releasing && this.maximized.owner === ws))
    )
  }
  private get capture() {
    return this.options.capture?.() ?? null
  }
  publishCapture() {
    if (this.closed) return
    const message: CaptureState = { type: 'capture', capture: this.capture }
    for (const ws of this.clients.keys()) json(ws, message)
  }
  downloadRecipient(): TerminalChannel | undefined {
    const ws = this.downloadController
    return ws &&
      ws === this.controller &&
      ws.readyState === 1 &&
      this.clients.has(ws) &&
      (!this.maximized || this.maximized.owner === ws)
      ? ws
      : undefined
  }
  captureFilePaste(
    ws: TerminalChannel,
  ): ((segments: readonly PasteSegment[]) => Promise<void>) | undefined {
    if (
      this.closed ||
      this.controller !== ws ||
      !this.clients.has(ws) ||
      ws.readyState !== 1 ||
      (this.maximized && this.maximized.owner !== ws)
    )
      return
    // A file drop authorizes this window at its start. Canvas navigation and
    // native pane selection do not redirect its eventual paste.
    return (segments) => {
      const paste = this.writePaste(segments)
      this.holdInput(paste)
      return paste
    }
  }
  private holdInput(operation: Promise<unknown>) {
    const held = (this.pasting = operation.then(
      () => {},
      () => {},
    ))
    void held.finally(() => {
      if (this.pasting === held) this.pasting = undefined
    })
  }
  private async writePaste(segments: readonly PasteSegment[]) {
    const deadline = Date.now() + PASTE_TOTAL_LIMIT_MS
    for (const [index, segment] of segments.entries()) {
      if (this.closed) throw new Error('windowClosed')
      const pace =
        segment.file && index < segments.length - 1
          ? Math.min(PASTE_SETTLE_LIMIT_MS, deadline - Date.now())
          : 0
      const settled = pace > 0 ? this.outputSettled(pace) : undefined
      // The surface the input router reads always has bracketed paste on.
      this.proc.write(bracketedPaste(segment.text))
      await settled
    }
  }
  /** Resolves after output follows by a quiet interval, or after the bounded limit. */
  private outputSettled(limitMs: number) {
    return new Promise<void>((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        clearTimeout(quiet)
        clearTimeout(limit)
        this.outputWaiters.delete(output)
        resolve()
      }
      const output = () => {
        clearTimeout(quiet)
        if (this.closed) done()
        else quiet = setTimeout(done, PASTE_SETTLE_QUIET_MS)
      }
      const limit = setTimeout(done, limitMs)
      this.outputWaiters.add(output)
    })
  }
  private presentation(ws: TerminalChannel) {
    json(ws, {
      type: 'presentation',
      maximized: !!this.maximized,
      owned: this.maximized?.owner === ws,
      ...(this.maximized ? { token: this.maximized.token, lease: this.maximized.lease } : {}),
    })
  }
  private snapshot(ws: TerminalChannel) {
    const view = this.clients.get(ws)
    if (this.closed || !view || ws.readyState !== 1) return
    json(ws, { type: 'pane-focus', paneId: this.focusedPaneId })
    if (
      view.hidden ||
      (this.maximized && (this.maximized.releasing || this.maximized.owner !== ws))
    ) {
      this.pause(ws)
      this.presentation(ws)
      return
    }
    view.shown = true
    view.sentFrame = undefined
    view.frameDue = true
    view.presentationDue = true
    this.pump(ws)
  }
  /** Stops cell traffic to a browser and forgets what it was sent. */
  private pause(ws: TerminalChannel) {
    const view = this.clients.get(ws)
    if (!view) return
    view.shown = false
    view.frameDue = false
    view.presentationDue = false
    view.encoder.reset()
  }
  private resume() {
    for (const ws of this.clients.keys()) if (!this.clients.get(ws)!.shown) this.snapshot(ws)
  }
  private maximize(ws: TerminalChannel, token: string) {
    this.presentationRevision++
    this.maximized = {
      owner: ws,
      view: this.clients.get(ws)!.record,
      token,
      lease: this.presentationRevision,
    }
    this.controller = ws
    this.downloadController = ws
    for (const client of this.clients.keys()) {
      if (client !== ws) {
        this.pause(client)
        this.presentation(client)
      } else if (this.clients.get(client)!.shown) this.presentation(client)
    }
    this.status()
    this.resume()
  }
  private async releaseMaximized(ws: TerminalChannel, token?: string) {
    const current = this.maximized
    if (
      !current ||
      current.releasing ||
      current.owner !== ws ||
      (token !== undefined && token !== current.token)
    )
      return
    current.releasing = true
    this.presentationRevision++
    // Keep every view paused until viewport restoration completes.
    // A new owner can take over while it is queued; snapshots
    // re-check the current owner and never release a newer request.
    for (const client of this.clients.keys()) this.pause(client)
    await this.geometry.end(current.view, current.token)
    if (this.maximized !== current) return
    this.maximized = undefined
    this.resume()
    this.status()
  }
  /** The view's channel before this one ends, and what it held passes to this one. */
  private supersede(previous: TerminalChannel, ws: TerminalChannel) {
    if (!this.clients.has(previous)) return
    // The browser gave this channel up while the server still held it open.
    warn('CANVAS_STALL', 'stall', {
      ...previous.names,
      view: logIdentifier(previous.view),
      silent: previous.takenAt ? Date.now() - previous.takenAt : undefined,
    })
    if (this.controller === previous) this.controller = ws
    if (this.downloadController === previous) this.downloadController = ws
    if (this.maximized?.owner === previous && ws.maximized) {
      this.maximized.owner = ws
      this.maximized.handedOver = true
    }
    previous.close('superseded')
  }
  private remember(view: string, record: ViewRecord) {
    this.known.delete(view)
    this.known.set(view, record)
    if (this.known.size <= MAX_KNOWN_VIEWS) return
    for (const [id, old] of this.known)
      if (!this.clients.has(old.channel) && old !== record) {
        this.known.delete(id)
        return
      }
  }
  join(ws: TerminalChannel) {
    if (this.closed || ws.readyState !== 1) return
    const known = this.known.get(ws.view),
      previous = known?.channel
    // An open can be held up on a stuck socket and arrive after the channel that replaced it.
    if (previous && previous.attempt >= ws.attempt) {
      ws.close()
      return
    }
    const record = known ?? { channel: ws }
    record.channel = ws
    this.remember(ws.view, record)
    // Nothing more is taken on the old channel once it is read how far that one got.
    if (previous) {
      ws.taken = Math.max(ws.taken, previous.taken)
      this.supersede(previous, ws)
    }
    clearTimeout(this.idle)
    json(ws, { type: 'resume', taken: previous?.taken ?? null })
    const view: View = {
      record,
      encoder: new GridEncoder(),
      shown: false,
      hidden: false,
      focused: false,
      sending: false,
      frameDue: false,
      presentationDue: false,
      readGeneration: 0,
    }
    this.clients.set(ws, view)
    if (!this.controller) this.controller = ws
    this.sendMetadata(ws)
    if (this.mouseAreas !== '[]') this.sendMouseAreas(ws)
    json(ws, { type: 'capture', capture: this.capture } satisfies CaptureState)
    this.snapshot(ws)
    this.status()
    json(ws, this.geometry.state(record))
    ws.on('message', (message) => {
      if (this.closed || ws.readyState !== 1 || !this.clients.has(ws)) return
      try {
        this.receive(ws, view, message)
      } catch {
        /* Malformed messages cannot become terminal commands. */
      }
    })
    ws.once('close', () => {
      this.clients.delete(ws)
      if (this.downloadController === ws) this.downloadController = undefined
      if (this.closed) return
      if (this.maximized?.owner === ws) void this.releaseMaximized(ws)
      // A superseded channel's view goes on, with its size.
      else if (record.channel === ws) void this.geometry.end(record)
      if (this.controller === ws) this.controller = this.clients.keys().next().value
      this.status()
      this.closeWhenUnwatched()
    })
  }
  /** A message from a browser on the window. */
  private receive(ws: TerminalChannel, view: View, msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'ping':
        if (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(msg.id))
          json(ws, { type: 'pong', id: msg.id })
        return
      case 'view-visible':
        if (typeof msg.visible === 'boolean') this.viewVisible(ws, view, msg.visible, msg.focused)
        return
      case 'completion-fence':
        if (typeof msg.generation === 'number' && Number.isSafeInteger(msg.generation))
          this.completionFence(ws, view, msg.generation)
        return
      case 'completion-read':
        this.completionRead(ws, view, msg)
        return
      case 'focus':
        if (this.maximized && this.maximized.owner !== ws) return
        this.controller = ws
        this.downloadController = ws
        this.status()
        return
      case 'focus-resize-begin':
        if (typeof msg.token === 'string' && msg.token.length <= 100)
          this.focusResizeBegin(ws, view, msg.token, this.requestedSize(msg))
        return
      case 'focus-resize-update':
        if (this.maximized?.owner === ws && this.maximized.token === msg.token)
          this.geometry.update(view.record, msg.token, this.requestedSize(msg))
        return
      case 'focus-resize-end':
        if (typeof msg.token === 'string') void this.releaseMaximized(ws, msg.token)
        return
      case 'presentation-cancel': {
        if (!Number.isSafeInteger(msg.lease)) return
        const current = this.maximized
        if (current && current.lease === msg.lease)
          void this.releaseMaximized(current.owner, current.token)
        else this.presentation(ws)
        return
      }
      case 'input':
        if (typeof msg.data === 'string' && msg.data.length <= 64 * 1024)
          this.input(ws, view, msg.data)
        return
    }
  }
  /** The grid a browser asks for, within what a terminal can be. */
  private requestedSize(msg: Record<string, unknown>): Size {
    return {
      // A wide character needs two columns; one row is valid.
      cols: clamp(msg.cols, 2, 500, this.cols),
      rows: clamp(msg.rows, 1, 200, this.rows),
    }
  }
  private viewVisible(ws: TerminalChannel, view: View, visible: boolean, focused: unknown) {
    // A browser reports focused exactly while this window holds its read focus.
    if (visible && focused === true && !view.focused) {
      view.focused = true
      this.options.onReadFocus?.()
    } else if (!visible || focused === false) view.focused = false
    if (visible === !view.hidden) return
    view.hidden = !visible
    if (visible) this.resume()
    else this.pause(ws)
  }
  /** The browser asks for a completion frame newer than everything it was sent. */
  private completionFence(ws: TerminalChannel, view: View, generation: number) {
    if (generation <= view.readGeneration) return
    view.readGeneration = view.pendingFence = generation
    view.sentFrame = undefined
    void this.proc
      .completionFence()
      .then((frame) => {
        if (!frame || this.closed || !this.clients.has(ws) || view.pendingFence !== generation)
          return
        view.pendingFence = undefined
        this.frame = frame
        if (this.canRender(ws)) {
          view.frameDue = true
          this.pump(ws)
        }
      })
      .catch(() => {})
  }
  /** The browser showed a completion in the focused pane, in the frame it was last sent. */
  private completionRead(ws: TerminalChannel, view: View, msg: Record<string, unknown>) {
    const frame = view.sentFrame
    const pane = frame?.panes.find((pane) => pane.id === msg.paneId && pane.active)
    const completion = { bootId: msg.bootId, sequence: msg.sequence } as CompletionToken
    if (
      !frame ||
      !pane?.completion ||
      msg.generation !== view.readGeneration ||
      view.pendingFence !== undefined ||
      !this.canRender(ws) ||
      pane.id !== this.focusedPaneId ||
      !sameCompletion(pane.completion, completion)
    )
      return
    if (this.proc.acknowledgeCompletion)
      void this.proc.acknowledgeCompletion(pane.id, completion).catch(() => {})
    else this.reads?.acknowledge(this.source, frame.id, pane.id, completion)
  }
  private focusResizeBegin(ws: TerminalChannel, view: View, token: string, size: Size) {
    const handed = this.maximized
    if (handed?.handedOver && handed.owner === ws && !handed.releasing) {
      // The lease passed to this channel: the browser names it anew, and nothing else changes.
      handed.handedOver = false
      handed.token = token
      if (view.shown) this.presentation(ws)
    } else this.maximize(ws, token)
    this.geometry.begin(view.record, token, size)
  }
  /** Keys, pastes and pointer input, only from the browser that controls the window. */
  private input(ws: TerminalChannel, view: View, data: string) {
    if (this.controller !== ws || (this.maximized && this.maximized.owner !== ws)) return
    // Outer window focus reports cannot change the native pane or pixels.
    if (data !== '\x1b[I' && data !== '\x1b[O' && !isTerminalHoverInput(data))
      view.sentFrame = undefined
    if (this.pasting)
      this.holdInput(
        this.pasting.then(() => {
          if (!this.closed) this.proc.write(data)
        }),
      )
    else this.proc.write(data)
  }
  /** A window no browser shows closes after a while, unless one comes back. */
  closeWhenUnwatched() {
    if (this.clients.size || this.closed) return
    clearTimeout(this.idle)
    this.idle = setTimeout(() => void this.close(), IDLE_MS)
    this.idle.unref()
  }
  adoptGeometry(size: Size) {
    if (this.cols === size.cols && this.rows === size.rows) return
    this.proc.resize(size.cols, size.rows)
    this.cols = size.cols
    this.rows = size.rows
    // Browsers wait for the grid of the new size; the old one is never sent again.
    this.grid = undefined
  }
  setNormalSize(size: Size) {
    if (this.closed || (this.normalSize.cols === size.cols && this.normalSize.rows === size.rows))
      return
    this.normalSize = size
    // A shared card/font edit changes the restore size while maximized; it never
    // takes input ownership or replaces an active temporary viewport.
    this.geometry.persistent(size)
  }
  status() {
    for (const ws of this.clients.keys())
      json(ws, {
        type: 'status',
        status: 'connected',
        readOnly: this.controller !== ws || (!!this.maximized && this.maximized.owner !== ws),
      })
  }
  close(reason?: 'removed'): Promise<void> {
    if (this.closing) return this.closing
    const focused =
      reason === 'removed' &&
      [...this.clients].some(
        ([ws, view]) => view.focused && ws.readyState === 1 && this.canRender(ws),
      )
    this.closed = true
    for (const waiter of this.outputWaiters) waiter()
    this.owned.dispose()
    if (reason === 'removed') this.reads?.removeWindow(this.source, this.windowId)
    if (focused) this.options.onFocusedRemove?.()
    clearTimeout(this.idle)
    // A native snapshot confirmed the tab is gone. Notify before asynchronous
    // viewport/tunnel cleanup so viewers never treat that cleanup as an outage.
    if (reason === 'removed')
      for (const ws of this.clients.keys()) {
        json(ws, { type: 'status', status: 'removed', at: serverTime() })
        ws.close()
      }
    this.closing = (async () => {
      // Restore the viewport before detaching this client.
      await this.geometry.close()
      for (const ws of this.clients.keys()) {
        if (reason !== 'removed') json(ws, { type: 'status', status: 'closed' })
        ws.close()
      }
      this.clients.clear()
      this.maximized = undefined
      try {
        this.proc.kill()
      } catch {}
      await this.options.handle.cleanup().catch(() => {})
      this.options.onClose()
    })()
    return this.closing
  }
}
export class TerminalManager {
  entries = new Map<string, Promise<LiveTerminal>>()
  private readonly live = new Set<LiveTerminal>()
  private stopped = false
  private closingSources = new Set<string>()
  private readonly intake: NotificationIntake
  /** Sources whose open windows changed what Canvas adds to their listing. */
  readonly listingChanges = new Events<string>()
  constructor(
    private readonly reads?: CompletionReads,
    private readonly onFocusedWindowRemoved?: (source: Source, windowId: string) => void,
    private readonly normalSize: (sourceId: string, windowId: string) => Size = () =>
      normalTerminalGrid(defaultWindowSize, defaultTerminalCell()),
    private readonly capture: (
      sourceId: string,
      windowId: string,
    ) => CaptureDescriptor | null = () => null,
    private readonly onWindowRead?: (source: Source, windowId: string) => void,
  ) {
    this.intake = new NotificationIntake(
      reads,
      (source) => this.owner(source),
      (sourceId) => !this.stopped && !this.closingSources.has(sourceId),
    )
  }
  /** Native and program notifications to show, each once. */
  get notifications(): Subscribable<CanvasNotification> {
    return this.intake.notifications
  }
  /** The progress of the source's open windows, by window. */
  progress(sourceId: string): Map<string, WindowProgress> {
    const result = new Map<string, WindowProgress>()
    for (const terminal of this.live)
      if (!terminal.closed && terminal.sourceId === sourceId && terminal.progress)
        result.set(terminal.windowId, terminal.progress)
    return result
  }
  /** The source's open window that takes in its notices and completion state. */
  private owner(source: Source) {
    const connection = sourceConnectionKey(source)
    return [...this.live].find(
      (terminal) =>
        !terminal.closed &&
        terminal.sourceId === source.id &&
        terminal.connectionKey === connection,
    )
  }
  refreshNormalSizes() {
    if (this.stopped) return
    for (const terminal of this.live)
      terminal.setNormalSize(this.normalSize(terminal.sourceId, terminal.windowId))
  }
  async connect(source: Source, target: TerminalTarget, ws: TerminalChannel) {
    if (this.stopped || this.closingSources.has(source.id))
      throw new Error('Terminal service is closing')
    const key = `${source.id}/${target.windowId}`
    if (!this.entries.has(key)) {
      if (this.entries.size >= 100)
        throw new Error('At most 100 active terminal windows are supported')
      const creating = (async () => {
        const handle = await openTerminal(source, target.spaceId, target.windowId)
        let transport: WindowTransport | undefined
        try {
          const { cols, rows } = this.normalSize(source.id, target.windowId)
          transport = await handle.connect(cols, rows)
          if (this.stopped || this.closingSources.has(source.id))
            throw new Error('Terminal service is closing')
          const terminal = new LiveTerminal({
            source,
            target,
            handle,
            proc: transport,
            size: { cols, rows },
            reads: this.reads,
            onClose: () => {
              this.entries.delete(key)
              this.live.delete(terminal)
              this.intake.observe(source)
              this.listingChanges.emit(source.id)
            },
            onFocusedRemove: () => this.onFocusedWindowRemoved?.(source, target.windowId),
            capture: () => this.capture(source.id, target.windowId),
            onReadFocus: () => this.onWindowRead?.(source, target.windowId),
          })
          this.live.add(terminal)
          // A card/font edit may have committed while the native socket opened.
          terminal.setNormalSize(this.normalSize(source.id, target.windowId))
          transport.snapshots.subscribe(() => {
            if (this.owner(source) === terminal) this.intake.observe(source)
          })
          transport.notifications.subscribe((notification) =>
            this.intake.receive(source, terminal, notification),
          )
          let progress = JSON.stringify(terminal.progress)
          transport.metadata.subscribe(() => {
            const next = JSON.stringify(terminal.progress)
            if (next === progress) return
            progress = next
            this.listingChanges.emit(source.id)
          })
          return terminal
        } catch (error) {
          transport?.kill()
          await handle.cleanup()
          throw error
        }
      })()
      this.entries.set(key, creating)
      creating.catch(() => this.entries.delete(key))
    }
    const terminal = await this.entries.get(key)!
    if (this.stopped || this.closingSources.has(source.id))
      throw new Error('Terminal service is closing')
    if (terminal.closed) throw new Error('Terminal is detaching; reconnect in a moment')
    if (terminal.connectionKey !== sourceConnectionKey(source))
      throw new Error('Terminal connection changed')
    terminal.join(ws)
    // A channel that could not join leaves the window as unwatched as before.
    terminal.closeWhenUnwatched()
  }
  /** The window's live terminal, once it has opened; undefined if it is not open or failed. */
  private async entry(sourceId: string, windowId: string) {
    return this.entries.get(`${sourceId}/${windowId}`)?.catch(() => undefined)
  }
  async downloadRecipient(
    sourceId: string,
    windowId: string,
  ): Promise<{ socket: TerminalChannel; isCurrent(): boolean } | undefined> {
    const terminal = await this.entry(sourceId, windowId)
    const socket = terminal?.downloadRecipient()
    if (!terminal || !socket) return
    return { socket, isCurrent: () => terminal.downloadRecipient() === socket }
  }
  /** Captures follow the native window to all its viewers, including later ones. */
  async captureChanged(sourceId: string, windowId: string) {
    const terminal = await this.entry(sourceId, windowId)
    if (terminal) {
      terminal.setNormalSize(this.normalSize(sourceId, windowId))
      terminal.publishCapture()
    }
  }
  async content(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entry(source.id, windowId)
    return terminal &&
      !terminal.closed &&
      terminal.clients.size &&
      terminal.spaceId === spaceId &&
      terminal.connectionKey === sourceConnectionKey(source)
      ? terminal.proc.content()
      : undefined
  }
  private async paneClient(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entry(source.id, windowId)
    if (
      !terminal ||
      terminal.closed ||
      !terminal.clients.size ||
      terminal.spaceId !== spaceId ||
      terminal.connectionKey !== sourceConnectionKey(source)
    )
      throw new Error('Open this window first')
    return terminal.proc
  }
  async paneContext(source: Source, spaceId: string, windowId: string, point: PanePoint) {
    return (await this.paneClient(source, spaceId, windowId)).paneContext(point)
  }
  async paneAction(
    source: Source,
    spaceId: string,
    windowId: string,
    context: PaneContext,
    action: PaneAction,
    authorized: () => boolean,
  ) {
    return (await this.paneClient(source, spaceId, windowId)).paneAction(
      context,
      action,
      authorized,
    )
  }
  async captureFilePaste(sourceId: string, windowId: string, ws: TerminalChannel) {
    return (await this.entry(sourceId, windowId))?.captureFilePaste(ws)
  }
  /** Keep new viewers out until the caller has retired bridges and committed the source. */
  async closeSource(sourceId: string, afterClose?: () => void | Promise<void>) {
    if (this.closingSources.has(sourceId)) throw new Error('Connection is already changing')
    this.closingSources.add(sourceId)
    this.intake.forget(sourceId)
    try {
      await Promise.all(
        [...this.entries.values()].map(async (p) => {
          const t = await p.catch(() => undefined)
          if (t?.sourceId === sourceId) await t.close()
        }),
      )
      await afterClose?.()
    } finally {
      this.closingSources.delete(sourceId)
    }
  }
  async closeAll() {
    this.stopped = true
    this.intake[Symbol.dispose]()
    await Promise.all(
      [...this.entries.values()].map(async (p) => (await p.catch(() => undefined))?.close()),
    )
  }
}
