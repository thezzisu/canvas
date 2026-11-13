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
// JSON, server to browser:
//   status            { status: 'connecting' } | { status: 'connected', readOnly } |
//                     { status: 'error', error } | { status: 'removed' | 'closed' }; the server
//                     closes the channel after the last three
//   presentation      { maximized, owned, token?, lease? }; after the FRAME when a view resumes
//   focus-resize      { active, owned, token?, reason? }, the maximized viewport lease
//   pane-focus        { paneId }
//   metadata          { window }
//   completion-frame  { generation, focusedPaneId, layout, panes }; follows the cell message
//                     that painted it
//   capture           { capture }
//   clipboard         { data }, base64 text copied by a pane or a selection
//   pong              { id }
//
// JSON, browser to server:
//   input             { data }, bytes for a terminal whose modes are fixed:
//                     application cursor keys, bracketed paste, any-event mouse tracking with
//                     SGR cell coordinates, focus reports
//   focus             take input control
//   view-visible      { visible, focused? }
//   focus-resize-begin | -update { token, cols, rows }, focus-resize-end { token }
//   presentation-cancel { token, lease }
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
import type { HerdrClientTransport } from './herdr/client.ts'
import type { FrameData } from './herdr/wire.ts'
import { GridEncoder } from './cell-grid.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import { randomUUID } from 'node:crypto'
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
/** What one browser has been sent of the window's grid. */
interface View {
  encoder: GridEncoder
  /** The browser paints this window; otherwise it is owed a FRAME when it next does. */
  shown: boolean
  /** A cell message is still on its way out; the next one waits for it. */
  sending: boolean
  /** The completion frame, then the presentation, follow the next cell message. */
  frameDue: boolean
  presentationDue: boolean
}
export class LiveTerminal {
  clients = new Set<TerminalChannel>()
  private views = new Map<TerminalChannel, View>()
  /** The grid the herdr client shows; absent until it shows one of the current size. */
  grid?: FrameData
  /** A count of the grids the client has shown. */
  private revision = 0
  private hidden = new Set<TerminalChannel>()
  private focused = new Set<TerminalChannel>()
  private maximized?: { owner: TerminalChannel; token: string; lease: number; releasing?: boolean }
  private presentationRevision = 0
  private focusedPaneId?: string
  private metadata?: WindowMetadata
  private rawMetadata?: WindowMetadata
  private frame?: WindowMetadata
  private sentFrames = new WeakMap<TerminalChannel, WindowMetadata>()
  private readGenerations = new WeakMap<TerminalChannel, number>()
  private pendingFences = new WeakMap<TerminalChannel, number>()
  private readSubscription?: { dispose(): unknown }
  private outputWaiters = new Set<() => void>()
  // Keyboard input typed during a paced paste follows the complete paste.
  private pasting?: Promise<void>
  controller?: TerminalChannel
  private downloadController?: TerminalChannel
  idle?: ReturnType<typeof setTimeout>
  geometry: GeometryController<TerminalChannel>
  closing?: Promise<void>
  closed = false
  cols: number
  rows: number
  private normalSize: Size
  constructor(
    readonly key: string,
    readonly sourceId: string,
    readonly connectionKey: string,
    readonly spaceId: string,
    readonly windowId: string,
    readonly handle: Awaited<ReturnType<typeof openTerminal>>,
    cols: number,
    rows: number,
    readonly onClose: () => void,
    readonly proc: HerdrClientTransport,
    readonly source: Source,
    readonly reads?: CompletionReads,
    readonly onFocusedRemove?: () => void,
    readonly capture: () => CaptureDescriptor | null = () => null,
    readonly onReadFocus?: () => void,
  ) {
    this.cols = cols
    this.rows = rows
    this.normalSize = { cols, rows }
    this.geometry = new GeometryController(
      { cols, rows },
      (size) => this.adoptGeometry(size),
      (reason) => {
        for (const ws of this.clients)
          json(ws, {
            ...this.geometry.state(ws),
            ...(reason ? { reason } : {}),
          })
      },
      () => {
        void this.close()
      },
    )
    this.proc.onPaneFocus((paneId) => {
      if (this.closed || this.focusedPaneId === paneId) return
      this.focusedPaneId = paneId
      for (const ws of this.clients) json(ws, { type: 'pane-focus', paneId })
    })
    this.readSubscription = reads?.onRead((sourceId) => {
      if (sourceId === this.sourceId) this.publishMetadata()
    })
    this.proc.onMetadata((metadata) => {
      if (this.closed) return
      this.rawMetadata = metadata
      this.publishMetadata()
    })
    this.proc.onScreen((grid) => {
      if (this.closed) return
      for (const waiter of this.outputWaiters) waiter()
      this.grid = grid
      this.revision++
      for (const ws of this.clients) this.pump(ws)
    })
    this.proc.onFrame((frame) => {
      if (this.closed) return
      this.frame = frame
      for (const ws of this.clients)
        if (!this.pendingFences.has(ws) && this.canRender(ws)) {
          this.views.get(ws)!.frameDue = true
          this.pump(ws)
        }
    })
    this.proc.onClipboard((data) => {
      for (const ws of this.clients) if (this.canRender(ws)) json(ws, { type: 'clipboard', data })
    })
    this.proc.onExit((event) => void this.close(event.reason))
  }
  private publishMetadata() {
    if (this.closed || !this.rawMetadata) return
    this.metadata = this.reads?.project(this.source, this.rawMetadata) || this.rawMetadata
    for (const ws of this.clients) json(ws, { type: 'metadata', window: this.metadata })
  }
  private publishFrame(ws: TerminalChannel) {
    if (!this.frame || this.pendingFences.has(ws)) return
    const frame = this.reads?.project(this.source, this.frame) || this.frame
    this.sentFrames.set(ws, frame)
    json(ws, {
      type: 'completion-frame',
      generation: this.readGenerations.get(ws) || 0,
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
    const view = this.views.get(ws)
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
      this.publishFrame(ws)
    }
    if (view.presentationDue) {
      view.presentationDue = false
      this.presentation(ws)
    }
  }
  private canRender(ws: TerminalChannel) {
    return (
      !this.hidden.has(ws) &&
      !!this.views.get(ws)?.shown &&
      (!this.maximized || (!this.maximized.releasing && this.maximized.owner === ws))
    )
  }
  publishCapture() {
    if (this.closed) return
    const message: CaptureState = { type: 'capture', capture: this.capture() }
    for (const ws of this.clients) json(ws, message)
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
    if (this.closed || !this.clients.has(ws) || ws.readyState !== 1) return
    json(ws, { type: 'pane-focus', paneId: this.focusedPaneId })
    if (
      this.hidden.has(ws) ||
      (this.maximized && (this.maximized.releasing || this.maximized.owner !== ws))
    ) {
      this.pause(ws)
      this.presentation(ws)
      return
    }
    const view = this.views.get(ws)!
    view.shown = true
    this.sentFrames.delete(ws)
    view.frameDue = true
    view.presentationDue = true
    this.pump(ws)
  }
  /** Stops cell traffic to a browser and forgets what it was sent. */
  private pause(ws: TerminalChannel) {
    const view = this.views.get(ws)
    if (!view) return
    view.shown = false
    view.frameDue = false
    view.presentationDue = false
    view.encoder.reset()
  }
  private resume() {
    for (const ws of this.clients) if (!this.views.get(ws)!.shown) this.snapshot(ws)
  }
  private maximize(ws: TerminalChannel, token: string) {
    this.presentationRevision++
    this.maximized = { owner: ws, token, lease: this.presentationRevision }
    this.controller = ws
    this.downloadController = ws
    for (const client of this.clients) {
      if (client !== ws) {
        this.pause(client)
        this.presentation(client)
      } else if (this.views.get(client)!.shown) this.presentation(client)
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
    for (const client of this.clients) this.pause(client)
    await this.geometry.end(ws, current.token)
    if (this.maximized !== current) return
    this.maximized = undefined
    this.resume()
    this.status()
  }
  join(ws: TerminalChannel) {
    clearTimeout(this.idle)
    if (!this.closed && ws.readyState === 1) {
      this.clients.add(ws)
      this.views.set(ws, {
        encoder: new GridEncoder(),
        shown: false,
        sending: false,
        frameDue: false,
        presentationDue: false,
      })
      if (!this.controller) this.controller = ws
      if (this.metadata) json(ws, { type: 'metadata', window: this.metadata })
      json(ws, { type: 'capture', capture: this.capture() } satisfies CaptureState)
      this.snapshot(ws)
      this.status()
      json(ws, this.geometry.state(ws))
    }
    ws.on('message', (msg) => {
      if (this.closed || ws.readyState !== 1 || !this.clients.has(ws)) return
      try {
        if (msg.type === 'ping') {
          if (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(msg.id))
            json(ws, { type: 'pong', id: msg.id })
          return
        }
        if (msg.type === 'view-visible' && typeof msg.visible === 'boolean') {
          // A browser reports focused exactly while this window holds its read focus.
          if (msg.visible && msg.focused === true && !this.focused.has(ws)) {
            this.focused.add(ws)
            this.onReadFocus?.()
          } else if (!msg.visible || msg.focused === false) this.focused.delete(ws)
          if (msg.visible === !this.hidden.has(ws)) return
          if (msg.visible) {
            this.hidden.delete(ws)
            this.resume()
          } else {
            this.hidden.add(ws)
            this.pause(ws)
          }
          return
        }
        if (msg.type === 'completion-fence') {
          const generation = msg.generation
          if (
            typeof generation !== 'number' ||
            !Number.isSafeInteger(generation) ||
            generation <= (this.readGenerations.get(ws) || 0)
          )
            return
          this.readGenerations.set(ws, generation)
          this.pendingFences.set(ws, generation)
          this.sentFrames.delete(ws)
          void this.proc
            .completionFence()
            .then((frame) => {
              if (
                !frame ||
                this.closed ||
                !this.clients.has(ws) ||
                this.pendingFences.get(ws) !== generation
              )
                return
              this.pendingFences.delete(ws)
              this.frame = frame
              if (this.canRender(ws)) {
                this.views.get(ws)!.frameDue = true
                this.pump(ws)
              }
            })
            .catch(() => {})
          return
        }
        if (msg.type === 'completion-read') {
          const frame = this.sentFrames.get(ws)
          const pane = frame?.panes.find((pane) => pane.id === msg.paneId && pane.active)
          const completion = { bootId: msg.bootId, sequence: msg.sequence } as CompletionToken
          if (
            Number.isSafeInteger(msg.generation) &&
            msg.generation === (this.readGenerations.get(ws) || 0) &&
            !this.pendingFences.has(ws) &&
            this.canRender(ws) &&
            pane &&
            pane.id === this.focusedPaneId &&
            pane.completion &&
            sameCompletion(pane.completion, completion)
          ) {
            if (this.proc.acknowledgeCompletion)
              void this.proc.acknowledgeCompletion(pane.id, completion).catch(() => {})
            else this.reads?.acknowledge(this.source, frame!.id, pane.id, completion)
          }
          return
        }
        if (msg.type === 'focus') {
          if (this.maximized && this.maximized.owner !== ws) return
          this.controller = ws
          this.downloadController = ws
          this.status()
          return
        }
        const size = {
          // A wide character needs two columns; one row is valid.
          cols: clamp(msg.cols, 2, 500, this.cols),
          rows: clamp(msg.rows, 1, 200, this.rows),
        }
        if (
          msg.type === 'focus-resize-begin' &&
          typeof msg.token === 'string' &&
          msg.token.length <= 100
        ) {
          this.maximize(ws, msg.token)
          this.geometry.begin(ws, msg.token, size)
          return
        }
        if (msg.type === 'focus-resize-update' && typeof msg.token === 'string') {
          if (this.maximized?.owner !== ws || this.maximized.token !== msg.token) return
          this.geometry.update(ws, msg.token, size)
          return
        }
        if (msg.type === 'focus-resize-end' && typeof msg.token === 'string') {
          void this.releaseMaximized(ws, msg.token)
          return
        }
        if (
          msg.type === 'presentation-cancel' &&
          typeof msg.token === 'string' &&
          Number.isSafeInteger(msg.lease)
        ) {
          const current = this.maximized
          if (current && current.token === msg.token && current.lease === msg.lease)
            void this.releaseMaximized(current.owner, current.token)
          else this.presentation(ws)
          return
        }
        if (this.controller !== ws) return
        if (this.maximized && this.maximized.owner !== ws) return
        if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 64 * 1024) {
          // Outer window focus reports cannot change the native pane or pixels.
          if (msg.data !== '\x1b[I' && msg.data !== '\x1b[O' && !isTerminalHoverInput(msg.data))
            this.sentFrames.delete(ws)
          if (this.pasting)
            this.holdInput(
              this.pasting.then(() => {
                if (!this.closed) this.proc.write(msg.data as string)
              }),
            )
          else this.proc.write(msg.data)
        }
      } catch {
        /* Malformed messages cannot become terminal commands. */
      }
    })
    ws.once('close', () => {
      this.clients.delete(ws)
      this.views.delete(ws)
      this.hidden.delete(ws)
      this.focused.delete(ws)
      if (this.downloadController === ws) this.downloadController = undefined
      if (this.closed) return
      if (this.maximized?.owner === ws) void this.releaseMaximized(ws)
      else void this.geometry.end(ws)
      if (this.controller === ws) this.controller = this.clients.values().next().value
      this.status()
      if (!this.clients.size) {
        this.idle = setTimeout(() => void this.close(), 20_000)
        this.idle.unref()
      }
    })
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
    for (const ws of this.clients)
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
      [...this.focused].some(
        (ws) => ws.readyState === 1 && this.clients.has(ws) && this.canRender(ws),
      )
    this.closed = true
    for (const waiter of this.outputWaiters) waiter()
    this.readSubscription?.dispose()
    if (reason === 'removed')
      this.reads?.removeWindow(this.source, this.key.slice(this.sourceId.length + 1))
    if (focused) this.onFocusedRemove?.()
    clearTimeout(this.idle)
    // A native snapshot confirmed the tab is gone. Notify before asynchronous
    // viewport/tunnel cleanup so viewers never treat that cleanup as an outage.
    if (reason === 'removed')
      for (const ws of this.clients) {
        json(ws, { type: 'status', status: 'removed' })
        ws.close()
      }
    this.closing = (async () => {
      // Restore the viewport before detaching this client.
      await this.geometry.close()
      for (const ws of this.clients) {
        if (reason !== 'removed') json(ws, { type: 'status', status: 'closed' })
        ws.close()
      }
      this.clients.clear()
      this.views.clear()
      this.hidden.clear()
      this.focused.clear()
      this.maximized = undefined
      try {
        this.proc.kill()
      } catch {}
      await this.handle.cleanup().catch(() => {})
      this.onClose()
    })()
    return this.closing
  }
}
export class TerminalManager {
  entries = new Map<string, Promise<LiveTerminal>>()
  private readonly live = new Set<LiveTerminal>()
  private readonly notificationListeners = new Set<(notification: CanvasNotification) => void>()
  private stopped = false
  private closingSources = new Set<string>()
  private pendingCompletions = new Map<
    string,
    { source: Source; notification: CanvasNotification; timer: ReturnType<typeof setTimeout> }
  >()
  private deliveredCompletions = new Map<string, CompletionToken>()
  private completionBoots = new Map<string, string>()
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
  ) {}
  refreshNormalSizes() {
    if (this.stopped) return
    for (const terminal of this.live)
      terminal.setNormalSize(this.normalSize(terminal.sourceId, terminal.windowId))
  }
  onNotification(listener: (notification: CanvasNotification) => void) {
    this.notificationListeners.add(listener)
    return {
      dispose: () => {
        this.notificationListeners.delete(listener)
      },
    }
  }
  private observeCompletionSource(source: Source) {
    const owner = [...this.live].find(
      (terminal) =>
        !terminal.closed &&
        terminal.sourceId === source.id &&
        terminal.connectionKey === sourceConnectionKey(source),
    )
    const snapshot = owner?.proc.completionSnapshot()
    if (owner && snapshot) {
      this.reads?.observeSnapshot(source, snapshot.windows, snapshot.state, owner)
      if (this.completionBoots.get(source.id) !== snapshot.state.bootId) {
        this.completionBoots.set(source.id, snapshot.state.bootId)
        for (const window of snapshot.windows)
          for (const pane of window.panes) {
            const token = this.reads?.completion(source, pane.id)?.completion || pane.completion
            if (token) this.deliveredCompletions.set(`${source.id}/${pane.id}`, token)
          }
      }
      this.flushCompletions(source.id)
    } else if (!owner) {
      this.reads?.disconnected(source.id)
      this.completionBoots.delete(source.id)
    }
  }
  private publishNotification(notification: CanvasNotification) {
    for (const listener of this.notificationListeners) listener(notification)
  }
  private flushCompletions(sourceId: string) {
    if (!this.reads || this.stopped || this.closingSources.has(sourceId)) return
    for (const [key, pending] of this.pendingCompletions) {
      if (pending.source.id !== sourceId) continue
      const completion = this.reads.completion(pending.source, pending.notification.paneId!)
      if (!completion) continue
      if (sameCompletion(this.deliveredCompletions.get(key), completion.completion)) continue
      clearTimeout(pending.timer)
      this.pendingCompletions.delete(key)
      this.deliveredCompletions.set(key, completion.completion)
      if (this.deliveredCompletions.size > 1000)
        this.deliveredCompletions.delete(this.deliveredCompletions.keys().next().value!)
      this.publishNotification({
        ...pending.notification,
        windowId: completion.windowId,
        completion: completion.completion,
      })
    }
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
        let transport: HerdrClientTransport | undefined
        try {
          const { cols, rows } = this.normalSize(source.id, target.windowId)
          transport = await handle.connect(cols, rows)
          if (this.stopped || this.closingSources.has(source.id))
            throw new Error('Terminal service is closing')
          const terminal = new LiveTerminal(
            key,
            source.id,
            sourceConnectionKey(source),
            target.spaceId,
            target.windowId,
            handle,
            cols,
            rows,
            () => {
              this.entries.delete(key)
              this.live.delete(terminal)
              this.observeCompletionSource(source)
            },
            transport,
            source,
            this.reads,
            () => this.onFocusedWindowRemoved?.(source, target.windowId),
            () => this.capture(source.id, target.windowId),
            () => this.onWindowRead?.(source, target.windowId),
          )
          this.live.add(terminal)
          // A card/font edit may have committed while the native socket opened.
          terminal.setNormalSize(this.normalSize(source.id, target.windowId))
          transport.onSnapshot(() => {
            const owner = [...this.live].find(
              (candidate) =>
                !candidate.closed &&
                candidate.sourceId === source.id &&
                candidate.connectionKey === terminal.connectionKey,
            )
            if (owner === terminal) this.observeCompletionSource(source)
          })
          transport.onNotification((notification) => {
            if (this.stopped || this.closingSources.has(source.id) || terminal.closed) return
            // Herdr broadcasts to every native shell. One existing endpoint owns
            // this connection's live intake; closing it naturally promotes the next.
            const owner = [...this.live].find(
              (candidate) =>
                !candidate.closed &&
                candidate.sourceId === source.id &&
                candidate.connectionKey === terminal.connectionKey,
            )
            if (owner !== terminal) return
            const event: CanvasNotification = {
              ...notification,
              id: randomUUID(),
              sourceId: source.id,
            }
            if (notification.kind !== 'done' || !this.reads) {
              this.publishNotification(event)
              return
            }
            if (!notification.paneId) return
            const key = `${source.id}/${notification.paneId}`
            clearTimeout(this.pendingCompletions.get(key)?.timer)
            const timer = setTimeout(() => this.pendingCompletions.delete(key), 1000)
            timer.unref()
            this.pendingCompletions.set(key, { source, notification: event, timer })
            queueMicrotask(() => this.flushCompletions(source.id))
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
    if (!terminal.clients.size && !terminal.closed) {
      terminal.idle = setTimeout(() => void terminal.close(), 20_000)
      terminal.idle.unref()
    }
  }
  async downloadRecipient(
    sourceId: string,
    windowId: string,
  ): Promise<{ socket: TerminalChannel; isCurrent(): boolean } | undefined> {
    const pending = this.entries.get(`${sourceId}/${windowId}`)
    if (!pending) return
    const terminal = await pending.catch(() => undefined)
    const socket = terminal?.downloadRecipient()
    if (!terminal || !socket) return
    return { socket, isCurrent: () => terminal.downloadRecipient() === socket }
  }
  /** Captures follow the native window to all its viewers, including later ones. */
  async captureChanged(sourceId: string, windowId: string) {
    const terminal = await this.entries.get(`${sourceId}/${windowId}`)?.catch(() => undefined)
    if (terminal) {
      terminal.setNormalSize(this.normalSize(sourceId, windowId))
      terminal.publishCapture()
    }
  }
  async content(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entries.get(`${source.id}/${windowId}`)?.catch(() => undefined)
    return terminal &&
      !terminal.closed &&
      terminal.clients.size &&
      terminal.spaceId === spaceId &&
      terminal.connectionKey === sourceConnectionKey(source)
      ? terminal.proc.content()
      : undefined
  }
  private async paneClient(source: Source, spaceId: string, windowId: string) {
    const terminal = await this.entries.get(`${source.id}/${windowId}`)?.catch(() => undefined)
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
    const pending = this.entries.get(`${sourceId}/${windowId}`)
    const terminal = await pending?.catch(() => undefined)
    return terminal?.captureFilePaste(ws)
  }
  /** Keep new viewers out until the caller has retired bridges and committed the source. */
  async closeSource(sourceId: string, afterClose?: () => void | Promise<void>) {
    if (this.closingSources.has(sourceId)) throw new Error('Connection is already changing')
    this.closingSources.add(sourceId)
    this.completionBoots.delete(sourceId)
    for (const [key, pending] of this.pendingCompletions)
      if (pending.source.id === sourceId) {
        clearTimeout(pending.timer)
        this.pendingCompletions.delete(key)
      }
    for (const key of this.deliveredCompletions.keys())
      if (key.startsWith(`${sourceId}/`)) this.deliveredCompletions.delete(key)
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
    this.notificationListeners.clear()
    for (const pending of this.pendingCompletions.values()) clearTimeout(pending.timer)
    this.pendingCompletions.clear()
    this.deliveredCompletions.clear()
    this.completionBoots.clear()
    await Promise.all(
      [...this.entries.values()].map(async (p) => (await p.catch(() => undefined))?.close()),
    )
  }
}
