import { cellWidth } from '../ghostty/module.ts'
import { popupInnerRect, type ScreenSelection } from './screen.ts'
import { CONTROL, SHIFT, VtInputParser, type Mouse, type ParsedInput } from './vt-parser.ts'
import { MAX_TERMINAL_PASTE_BYTES as MAX_PENDING } from '../../shared/paste.ts'
import type {
  ClientMessage,
  ClientMouseButton,
  ClientPaneInputEvent,
  ClientShellSnapshot,
  PaneSurfaceFrame,
  PaneSurfacePane,
  PaneSurfaceSplit,
  SurfaceRect,
} from './wire.ts'

type Point = { row: number; col: number }

interface RouterOptions {
  tabId: string
  send(message: ClientMessage): void
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  getSurface(): PaneSurfaceFrame | undefined
  getSnapshot(): ClientShellSnapshot | undefined
  onError?(error: Error): void
  onCopy?(text: string): void
  onSelection?(selection: ScreenSelection | undefined): void
  escapeDelay?: number
}
function contains(rect: SurfaceRect, mouse: Mouse) {
  return (
    mouse.column >= rect.x &&
    mouse.row >= rect.y &&
    mouse.column < rect.x + rect.width &&
    mouse.row < rect.y + rect.height
  )
}
function local(rect: SurfaceRect, mouse: Mouse): Point {
  return {
    col: Math.max(0, Math.min(rect.width - 1, mouse.column - rect.x)),
    row: Math.max(0, Math.min(rect.height - 1, mouse.row - rect.y)),
  }
}
function popupInputRect(surface: PaneSurfaceFrame) {
  const area = popupInnerRect(surface),
    frame = surface.popup?.frame
  return area && frame
    ? {
        ...area,
        width: Math.min(area.width, frame.width),
        height: Math.min(area.height, frame.height),
      }
    : undefined
}
function same(a: Point, b: Point) {
  return a.col === b.col && a.row === b.row
}
function before(a: Point, b: Point) {
  return a.row < b.row || (a.row === b.row && a.col < b.col)
}
function top(pane: PaneSurfacePane) {
  return pane.scroll
    ? Math.max(0, pane.scroll.max_offset_from_bottom - pane.scroll.offset_from_bottom)
    : 0
}
/** The scrollbar's thumb in its track, as herdr sizes and places it. */
export function thumb(pane: Pick<PaneSurfacePane, 'scrollbar_rect' | 'scroll'>) {
  const track = pane.scrollbar_rect,
    metrics = pane.scroll
  if (!track || !metrics || !metrics.max_offset_from_bottom || !track.height) return
  const length = Math.max(
    1,
    Math.min(
      track.height,
      Math.round(
        (metrics.viewport_rows * track.height) /
          (metrics.max_offset_from_bottom + metrics.viewport_rows),
      ),
    ),
  )
  return {
    top:
      track.y +
      Math.round(
        ((metrics.max_offset_from_bottom - metrics.offset_from_bottom) * (track.height - length)) /
          metrics.max_offset_from_bottom,
      ),
    length,
  }
}
function scrollOffset(pane: PaneSurfacePane, row: number, grab?: number) {
  const track = pane.scrollbar_rect,
    metrics = pane.scroll,
    bar = thumb(pane)
  if (!track || !metrics || !bar) return 0
  const maxTop = track.height - bar.length
  const desired = Math.max(
    0,
    Math.min(
      maxTop,
      Math.max(0, Math.min(track.height - 1, row - track.y)) - (grab ?? Math.floor(bar.length / 2)),
    ),
  )
  return maxTop
    ? Math.max(
        0,
        metrics.max_offset_from_bottom -
          Math.round((desired * metrics.max_offset_from_bottom) / maxTop),
      )
    : 0
}

/** Inclusive display columns, matching native word selection for URLs and paths. */
export function wordBounds(text: string, column: number): [number, number] | undefined {
  let nextColumn = 0
  const cells = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    ({ segment }) => {
      const width = cellWidth(segment),
        start = width ? nextColumn : Math.max(0, nextColumn - 1)
      nextColumn += width
      return { ch: segment, start, end: Math.max(0, nextColumn - 1) }
    },
  )
  const index = cells.findIndex((cell) => cell.start <= column && column <= cell.end)
  if (index < 0) return
  const chars = cells.map((cell) => cell.ch)
  const finish = (start: number, end: number): [number, number] | undefined =>
    start <= index && end >= index ? [cells[start]!.start, cells[end]!.end] : undefined
  for (let start = 0; start < chars.length; start++) {
    if (
      !chars
        .slice(start, start + 8)
        .join('')
        .startsWith('https://') &&
      !chars
        .slice(start, start + 7)
        .join('')
        .startsWith('http://')
    )
      continue
    let end = start
    while (end + 1 < chars.length && !/\s/u.test(chars[end + 1]!)) end++
    if (index < start || index > end) {
      start = end
      continue
    }
    while (end >= start) {
      const ch = chars[end]!,
        open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[ch]
      const balance = open
        ? chars
            .slice(start, end)
            .reduce((n, value) => n + (value === open ? 1 : value === ch ? -1 : 0), 0)
        : 0
      if (!'"\'`.,;:!?'.includes(ch) && (!open || balance > 0)) break
      end--
    }
    const bounds = finish(start, end)
    if (bounds) return bounds
  }
  for (const quote of ['"', "'", '`']) {
    let start: number | undefined
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== quote) continue
      let slashes = 0
      for (let j = i - 1; j >= 0 && chars[j] === '\\'; j--) slashes++
      if (slashes % 2) continue
      if (start === undefined) start = i
      else {
        if (index > start && index < i && chars.slice(start + 1, i).includes('/'))
          return finish(start + 1, i - 1)
        start = undefined
      }
    }
  }
  const separator = (ch: string) => /\s/u.test(ch) || '|()[]{},;!（）\uff1a、。，'.includes(ch)
  if (separator(chars[index]!)) return
  let start = index,
    end = index
  while (start > 0 && !separator(chars[start - 1]!)) start--
  while (end + 1 < chars.length && !separator(chars[end + 1]!)) end++
  const trailing = (ch: string) => ')]}>"\'`.,;:!?'.includes(ch)
  while (start <= end && '([{<"\'`'.includes(chars[start]!)) start++
  if (start < end && chars[end] === '$' && trailing(chars[end - 1]!)) end--
  while (end >= start && trailing(chars[end]!)) end--
  return finish(start, end)
}

interface PendingFocus {
  pane: string
  snapshot: number
  boot: string
  failed?: boolean
}
interface InputTarget {
  kind: 'pane' | 'popup'
  id: string
  boot: string
  focus?: PendingFocus
}
interface SelectionState extends ScreenSelection {
  pane: PaneSurfacePane
  boot: string
  generation: number
  base: number
  pointer?: Mouse
  scrollOffsets: Set<number>
  word?: { anchor: Point; bounds: [number, number] }
}
/** What a held mouse button is doing; one at a time. */
type Drag =
  /** A program that takes the mouse is sent the drag. */
  | {
      kind: 'mouse'
      target: InputTarget
      rect: SurfaceRect
      button: ClientMouseButton
      last: Mouse
    }
  | {
      kind: 'split'
      split: PaneSurfaceSplit
      offset: number
      topology: string
      boot: string
      last?: number
    }
  | { kind: 'scrollbar'; pane: string; boot: string; grab: number }
  | { kind: 'select'; selection: SelectionState }

/** Per connection/tab ownership; async endpoint replies cannot retarget queued input. */
export class HerdrInputRouter implements Disposable {
  private readonly parser: VtInputParser
  private queue = Promise.resolve()
  private reads = new Set<Promise<void>>()
  private disposed = false
  private focus?: PendingFocus
  private batch?: { target: InputTarget; events: ClientPaneInputEvent[]; bytes: number }
  private latest = new Map<string, { params: Record<string, unknown>; valid: () => boolean }>()
  private drag?: Drag
  private selection?: SelectionState
  private selectionRevision = 0
  private selectionScrollTimer?: ReturnType<typeof setTimeout>
  private lastClick?: { pane: string; point: Point; at: number }
  private scrollTargets = new Map<string, { offset: number; revision: number }>()
  constructor(private readonly options: RouterOptions) {
    this.parser = new VtInputParser(
      (input) => this.route(input),
      (error) => options.onError?.(error),
      options.escapeDelay,
    )
  }
  write(data: string | Buffer) {
    this.parser.write(data)
  }
  async drain() {
    this.parser.flushEscape()
    let pending
    do {
      pending = this.queue
      await pending
      await Promise.all(this.reads)
    } while (pending !== this.queue || this.reads.size)
  }
  private enqueue(action: () => void | Promise<void>, barrier = true) {
    this.batch = undefined
    if (barrier) this.latest.clear()
    this.queue = this.queue
      .then(async () => {
        if (!this.disposed) await action()
      })
      .catch((reason) => {
        if (!this.disposed)
          this.options.onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      })
  }
  private endpointLatest(
    key: string,
    method: string,
    params: Record<string, unknown>,
    valid: () => boolean,
  ) {
    const existing = this.latest.get(key)
    if (existing) {
      existing.params = params
      existing.valid = valid
      return
    }
    const pending = { params, valid }
    this.enqueue(async () => {
      if (this.latest.get(key) === pending) this.latest.delete(key)
      if (pending.valid()) await this.options.request(method, pending.params)
    }, false)
    this.latest.set(key, pending)
  }
  private context() {
    const snapshot = this.options.getSnapshot(),
      surface = this.options.getSurface()
    if (
      !snapshot ||
      !surface ||
      snapshot.boot_id !== surface.boot_id ||
      snapshot.focused_tab_id !== this.options.tabId
    )
      return
    const ids = new Set(
      snapshot.panes
        .filter((pane) => pane.tab_id === this.options.tabId)
        .map((pane) => pane.pane_id),
    )
    const panes = surface.panes.filter(
      (pane) => ids.has(pane.pane_id) && pane.inner_rect.width > 0 && pane.inner_rect.height > 0,
    )
    return { snapshot, surface, panes }
  }
  private valid(target: InputTarget) {
    const context = this.context()
    return (
      !!context &&
      context.snapshot.boot_id === target.boot &&
      !target.focus?.failed &&
      (target.kind === 'popup'
        ? context.surface.popup?.terminal_id === target.id && !!popupInputRect(context.surface)
        : !context.surface.popup && context.panes.some((pane) => pane.pane_id === target.id))
    )
  }
  private paneTarget(pane: PaneSurfacePane): InputTarget {
    return {
      kind: 'pane',
      id: pane.pane_id,
      boot: this.options.getSnapshot()!.boot_id,
      focus: this.focus?.pane === pane.pane_id ? this.focus : undefined,
    }
  }
  private target(): InputTarget | undefined {
    const context = this.context()
    if (!context) return
    if (context.surface.popup)
      return {
        kind: 'popup',
        id: context.surface.popup.terminal_id,
        boot: context.snapshot.boot_id,
      }
    const id = this.focus?.pane ?? context.snapshot.focused_pane_id
    const pane = context.panes.find((pane) => pane.pane_id === id)
    return pane && this.paneTarget(pane)
  }
  /** Where a target's cells are, in a surface where it is valid. */
  private rect(target: InputTarget, surface: PaneSurfaceFrame) {
    return target.kind === 'popup'
      ? popupInputRect(surface)!
      : surface.panes.find((pane) => pane.pane_id === target.id)!.inner_rect
  }
  private send(target: InputTarget, event: ClientPaneInputEvent) {
    const bytes =
      'Paste' in event
        ? Buffer.byteLength(event.Paste)
        : 'TextCommit' in event
          ? Buffer.byteLength(event.TextCommit)
          : 64
    const previous = this.batch
    if (
      previous &&
      previous.target.id === target.id &&
      previous.target.kind === target.kind &&
      previous.target.boot === target.boot &&
      previous.target.focus === target.focus &&
      previous.events.length < 128 &&
      previous.bytes + bytes <= MAX_PENDING
    ) {
      previous.events.push(event)
      previous.bytes += bytes
      return
    }
    const batch = { target, events: [event], bytes }
    this.enqueue(() => {
      if (this.batch === batch) this.batch = undefined
      if (!this.valid(target)) return
      const rect = this.rect(target, this.options.getSurface()!)
      const events = batch.events.map((event) => {
        if (!('Mouse' in event) || !('Cell' in event.Mouse.position)) return event
        const { column, row } = event.Mouse.position.Cell
        return {
          Mouse: {
            ...event.Mouse,
            position: {
              Cell: {
                column: Math.min(rect.width - 1, column),
                row: Math.min(rect.height - 1, row),
              },
            },
          },
        }
      })
      this.options.send(
        target.kind === 'pane'
          ? { ClientShellPaneInput: { pane_id: target.id, events } }
          : { ClientShellPopupInput: { terminal_id: target.id, events } },
      )
    })
    this.batch = batch
  }
  private focusPane(pane: PaneSurfacePane) {
    const context = this.context()
    if (!context || (this.focus?.pane || context.snapshot.focused_pane_id) === pane.pane_id) return
    const focus: PendingFocus = (this.focus = {
      pane: pane.pane_id,
      snapshot: context.snapshot.revision,
      boot: context.snapshot.boot_id,
    })
    const target: InputTarget = { kind: 'pane', id: pane.pane_id, boot: focus.boot, focus }
    const failed = () => {
      focus.failed = true
      if (this.focus === focus) this.focus = undefined
    }
    this.enqueue(async () => {
      if (!this.valid(target)) return failed()
      try {
        await this.options.request('pane.focus', { pane_id: pane.pane_id })
      } catch (reason) {
        failed()
        throw reason
      }
    })
  }
  private clearSelection() {
    this.stopSelectionScroll()
    if (this.drag?.kind === 'select') this.drag = undefined
    const selected = !!this.selection
    this.selection = undefined
    this.selectionRevision++
    if (selected) this.options.onSelection?.(undefined)
  }
  async settled() {
    let pending
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
  }
  get focusSettled(): boolean {
    return !this.focus
  }
  /** Called after snapshot/surface changes, before rendering the next frame. */
  refresh() {
    if (this.disposed) return
    const context = this.context(),
      snapshot = this.options.getSnapshot()
    if (this.focus && snapshot) {
      if (
        snapshot.boot_id !== this.focus.boot ||
        snapshot.focused_tab_id !== this.options.tabId ||
        !snapshot.panes.some(
          (pane) => pane.pane_id === this.focus!.pane && pane.tab_id === this.options.tabId,
        )
      ) {
        this.focus.failed = true
        this.focus = undefined
      } else if (
        snapshot.revision > this.focus.snapshot &&
        snapshot.focused_pane_id === this.focus.pane
      )
        this.focus = undefined
    }
    // Snapshot and surface arrive separately. Preserve gestures through a short
    // projection gap; later input still requires a valid matching surface.
    if (!context && snapshot?.focused_tab_id === this.options.tabId && !this.options.getSurface())
      return
    if (this.drag && !this.followDrag(this.drag, context)) this.drag = undefined
    if (this.selection) {
      if (!this.selectionValid(this.selection)) this.clearSelection()
      else {
        const selection = this.selection,
          pane = context!.panes.find((pane) => pane.pane_id === selection.pane_id)!
        if (top(pane) !== top(selection.pane)) {
          selection.pane = pane
          if (selection.pointer) this.moveSelection(selection, pane, selection.pointer)
          else this.highlight(selection)
        }
      }
    }
    for (const [id, target] of this.scrollTargets) {
      const pane = context?.panes.find((pane) => pane.pane_id === id)
      if (
        !pane ||
        pane.content_revision > target.revision ||
        pane.scroll?.offset_from_bottom === target.offset
      )
        this.scrollTargets.delete(id)
    }
  }
  /** Keeps a drag on what it holds as the surface changes, or says that it cannot. */
  private followDrag(drag: Drag, context: ReturnType<HerdrInputRouter['context']>) {
    if (drag.kind === 'mouse') {
      if (!this.valid(drag.target)) return false
      drag.rect = this.rect(drag.target, context!.surface)
      return true
    }
    if (drag.kind === 'select') return true
    if (!context || context.surface.popup || context.snapshot.boot_id !== drag.boot) return false
    if (drag.kind === 'scrollbar') return context.panes.some((pane) => pane.pane_id === drag.pane)
    if (this.topology(context) !== drag.topology) return false
    drag.split = context.surface.splits.find(
      (split) =>
        split.direction === drag.split.direction &&
        JSON.stringify(split.path) === JSON.stringify(drag.split.path),
    )!
    return true
  }
  /** Lets go of whatever the mouse held; a program holding the button is told it went up. */
  private endDrag() {
    const drag = this.drag
    this.drag = undefined
    if (drag?.kind !== 'mouse' || !this.valid(drag.target)) return
    const event = this.mouseEvent(drag.rect, drag.last, { Up: drag.button })
    if (event) this.send(drag.target, event)
  }
  private route(input: ParsedInput) {
    if (this.disposed) return
    this.refresh()
    if ('focus' in input) {
      if (!input.focus) {
        this.endDrag()
        this.clearSelection()
        this.lastClick = undefined
      }
      this.enqueue(() => this.options.send({ ClientShellFocus: { focused: input.focus } }))
      return
    }
    if ('mouse' in input) {
      this.routeMouse(input.mouse)
      return
    }
    const target = this.target()
    if (!target) return
    if ('Key' in input.event && this.selection && this.drag?.kind !== 'select') {
      const { code, modifiers } = input.event.Key
      if (
        (modifiers === (CONTROL | SHIFT) &&
          typeof code === 'object' &&
          'Char' in code &&
          code.Char.toLowerCase() === 'c') ||
        (modifiers === CONTROL && code === 'Insert')
      ) {
        this.copySelection(this.selection)
        return
      }
    }
    this.clearSelection()
    this.lastClick = undefined
    this.scrollTargets.delete(target.id)
    this.send(target, input.event)
  }
  private mouseEvent(
    rect: SurfaceRect,
    event: Mouse,
    kind = event.kind,
  ): ClientPaneInputEvent | undefined {
    if (kind === 'Release') return
    const point = local(rect, event)
    return {
      Mouse: {
        kind,
        position: { Cell: { column: point.col, row: point.row } },
        geometry: null,
        modifiers: event.modifiers,
        lines: 3,
      },
    }
  }
  private topology(context: NonNullable<ReturnType<HerdrInputRouter['context']>>) {
    return JSON.stringify([
      context.panes.map((pane) => pane.pane_id),
      context.surface.splits.map((split) => [split.direction, split.path]),
    ])
  }
  private scroll(pane: PaneSurfacePane, offset: number, selection?: SelectionState) {
    const target = this.paneTarget(pane)
    this.scrollTargets.set(pane.pane_id, { offset, revision: pane.content_revision })
    this.endpointLatest(
      'scroll:' + pane.pane_id,
      'pane.scroll',
      { pane_id: pane.pane_id, offset_from_bottom: offset },
      () =>
        this.valid(target) &&
        (!selection || (this.selection === selection && this.selectionValid(selection))),
    )
  }
  private selectionValid(selection: SelectionState) {
    const context = this.context(),
      pane = context?.panes.find((pane) => pane.pane_id === selection.pane_id)
    return (
      !!pane &&
      !context!.surface.popup &&
      context!.snapshot.boot_id === selection.boot &&
      selection.generation === this.selectionRevision &&
      pane.content_revision === selection.pane.content_revision &&
      pane.alternate_screen_active === selection.pane.alternate_screen_active &&
      (top(pane) === top(selection.pane) ||
        selection.scrollOffsets.has(pane.scroll?.offset_from_bottom ?? -1)) &&
      JSON.stringify(pane.inner_rect) === JSON.stringify(selection.pane.inner_rect)
    )
  }
  private highlight(selection: SelectionState) {
    const pane = this.context()?.panes.find((pane) => pane.pane_id === selection.pane_id)
    if (!pane) return
    const shift = selection.base - top(pane),
      inner = pane.inner_rect
    const point = (value: Point): Point => {
      const row = value.row + shift
      return row < 0
        ? { row: 0, col: 0 }
        : row >= inner.height
          ? { row: inner.height - 1, col: inner.width - 1 }
          : { row, col: value.col }
    }
    this.options.onSelection?.({
      pane_id: selection.pane_id,
      anchor: point(selection.anchor),
      cursor: point(selection.cursor),
    })
  }
  private stopSelectionScroll() {
    clearTimeout(this.selectionScrollTimer)
    this.selectionScrollTimer = undefined
  }
  private moveSelection(selection: SelectionState, pane: PaneSurfacePane, event: Mouse) {
    selection.pointer = event
    const point = local(pane.inner_rect, event),
      target = this.scrollTargets.get(pane.pane_id)
    const viewportTop =
      target && selection.scrollOffsets.has(target.offset) && pane.scroll
        ? pane.scroll.max_offset_from_bottom - target.offset
        : top(pane)
    const row = point.row + viewportTop - selection.base
    if (selection.word) {
      const bounds =
        viewportTop === top(pane)
          ? (this.bounds(pane, point) ?? [point.col, point.col])
          : [0, pane.inner_rect.width - 1]
      const anchor = { row: selection.word.anchor.row, col: selection.word.bounds[0] },
        cursor = { row, col: bounds[0]! }
      selection.anchor = before(cursor, anchor) ? cursor : anchor
      const anchorEnd = { row: selection.word.anchor.row, col: selection.word.bounds[1] },
        cursorEnd = { row, col: bounds[1]! }
      selection.cursor = before(cursorEnd, anchorEnd) ? anchorEnd : cursorEnd
    } else selection.cursor = { row, col: point.col }
    if (!same(selection.anchor, selection.cursor) || selection.word) this.highlight(selection)
  }
  private selectionScroll(selection: SelectionState) {
    this.stopSelectionScroll()
    if (
      this.disposed ||
      this.selection !== selection ||
      this.drag?.kind !== 'select' ||
      !this.selectionValid(selection) ||
      !selection.pointer
    )
      return
    const pane = this.context()!.panes.find((pane) => pane.pane_id === selection.pane_id)!,
      metrics = pane.scroll,
      inner = pane.inner_rect,
      pointer = selection.pointer
    if (!metrics || pane.alternate_screen_active) return
    const distance =
      pointer.row < inner.y
        ? inner.y - pointer.row
        : pointer.row >= inner.y + inner.height
          ? inner.y + inner.height - pointer.row - 1
          : 0
    if (!distance) return
    const previous = this.scrollTargets.get(pane.pane_id)?.offset ?? metrics.offset_from_bottom
    const offset = Math.max(
      0,
      Math.min(
        metrics.max_offset_from_bottom,
        previous + Math.sign(distance) * Math.min(15, Math.abs(distance) * 3),
      ),
    )
    if (offset === previous) return
    selection.scrollOffsets.add(offset)
    this.scroll(pane, offset, selection)
    this.moveSelection(selection, pane, pointer)
    this.selectionScrollTimer = setTimeout(() => this.selectionScroll(selection), 30)
    this.selectionScrollTimer.unref()
  }
  private copySelection(selection: SelectionState) {
    const base = selection.base
    this.enqueue(() => {
      if (!this.selectionValid(selection)) return
      // Selection reads must not hold subsequent typing behind a remote round trip.
      const read = this.options
        .request('pane.selection.read', {
          pane_id: selection.pane_id,
          anchor: { row: selection.anchor.row + base, col: selection.anchor.col },
          cursor: { row: selection.cursor.row + base, col: selection.cursor.col },
          content_revision: selection.pane.content_revision,
        })
        .then((result) => {
          if (this.disposed || !this.selectionValid(selection)) return
          if (
            result &&
            typeof result === 'object' &&
            'text' in result &&
            typeof result.text === 'string' &&
            (!('pane_id' in result) || result.pane_id === selection.pane_id)
          )
            this.options.onCopy?.(result.text)
        })
        .catch((reason) => {
          if (!this.disposed && this.selectionValid(selection))
            this.options.onError?.(reason instanceof Error ? reason : new Error(String(reason)))
        })
        .finally(() => this.reads.delete(read))
      this.reads.add(read)
    })
  }
  private bounds(pane: PaneSurfacePane, point: Point): [number, number] | undefined {
    const frame = this.options.getSurface()!.frame,
      inner = pane.inner_rect
    let text = ''
    for (let x = 0; x < inner.width;) {
      const cell = frame.cells[(inner.y + point.row) * frame.width + inner.x + x]
      const symbol = cell?.symbol || ' '
      text += symbol
      x += Math.max(1, cellWidth(symbol))
    }
    return wordBounds(text, point.col)
  }
  /** A held button moved or went up. */
  private moveDrag(
    drag: Drag,
    event: Mouse,
    context: NonNullable<ReturnType<HerdrInputRouter['context']>>,
    up: boolean,
  ) {
    if (up) this.drag = undefined
    if (drag.kind === 'mouse') {
      if (!this.valid(drag.target)) {
        this.drag = undefined
        return
      }
      drag.rect = this.rect(drag.target, context.surface)
      drag.last = event
      const message = this.mouseEvent(
        drag.rect,
        event,
        up ? { Up: drag.button } : { Drag: drag.button },
      )
      if (message) this.send(drag.target, message)
    } else if (drag.kind === 'scrollbar') {
      const pane = context.panes.find((pane) => pane.pane_id === drag.pane)
      if (pane && context.snapshot.boot_id === drag.boot)
        this.scroll(pane, scrollOffset(pane, event.row, drag.grab))
    } else if (drag.kind === 'split') {
      if (drag.boot !== context.snapshot.boot_id || drag.topology !== this.topology(context)) return
      const split = drag.split,
        horizontal = split.direction === 'Horizontal'
      const pointer = horizontal ? event.column : event.row,
        origin = horizontal ? split.area.x : split.area.y,
        length = horizontal ? split.area.width : split.area.height
      const ratio = Math.max(
        0.1,
        Math.min(0.9, (pointer + drag.offset - origin) / Math.max(1, length)),
      )
      if (ratio === drag.last) return
      drag.last = ratio
      this.endpointLatest(
        'split:' + JSON.stringify(split.path),
        'layout.set_split_ratio',
        { tab_id: this.options.tabId, path: split.path, ratio },
        () => {
          const current = this.context()
          return (
            !!current &&
            !current.surface.popup &&
            current.snapshot.boot_id === drag.boot &&
            this.topology(current) === drag.topology
          )
        },
      )
    } else {
      const { selection } = drag,
        pane = context.panes.find((pane) => pane.pane_id === selection.pane_id)!
      const point = local(pane.inner_rect, event)
      this.moveSelection(selection, pane, event)
      if (!up) {
        this.selectionScroll(selection)
        if (this.lastClick && !same(this.lastClick.point, point)) this.lastClick = undefined
        return
      }
      this.stopSelectionScroll()
      if (same(selection.anchor, selection.cursor) && !selection.word) this.clearSelection()
      else this.copySelection(selection)
    }
  }
  private routeMouse(event: Mouse) {
    const context = this.context()
    if (!context) return
    const kind = event.kind
    const up = kind === 'Release' || (typeof kind === 'object' && 'Up' in kind)
    const drag = typeof kind === 'object' && 'Drag' in kind
    const down = typeof kind === 'object' && 'Down' in kind
    if (down) this.endDrag()
    const held = this.drag
    if (held && (up || drag)) {
      const button = held.kind === 'mouse' ? held.button : 'Left',
        pressed = typeof kind !== 'object' ? undefined : 'Up' in kind ? kind.Up : kind.Drag
      if (pressed === undefined || pressed === button) this.moveDrag(held, event, context, up)
      return
    }
    if (context.surface.popup) {
      const popup = context.surface.popup,
        rect = popupInputRect(context.surface)!
      if (
        !rect ||
        !contains(rect, event) ||
        (!popup.mouse_reporting && !(typeof kind === 'string' && kind.startsWith('Scroll')))
      )
        return
      if (up || drag) return
      const target: InputTarget = {
          kind: 'popup',
          id: popup.terminal_id,
          boot: context.snapshot.boot_id,
        },
        message = this.mouseEvent(rect, event)
      if (message) this.send(target, message)
      if (down) this.drag = { kind: 'mouse', target, rect, button: kind.Down, last: event }
      return
    }
    if (down) this.clearSelection()
    if (down && kind.Down === 'Left') {
      const barPane = context.panes.find(
        (pane) => pane.scrollbar_rect && contains(pane.scrollbar_rect, event) && thumb(pane),
      )
      if (barPane) {
        this.lastClick = undefined
        this.focusPane(barPane)
        const bar = thumb(barPane)!
        if (event.row >= bar.top && event.row < bar.top + bar.length)
          this.drag = {
            kind: 'scrollbar',
            pane: barPane.pane_id,
            boot: context.snapshot.boot_id,
            grab: event.row - bar.top,
          }
        else this.scroll(barPane, scrollOffset(barPane, event.row))
        return
      }
      const split = context.surface.splits.find((split) => contains(split.hit_rect, event))
      if (split) {
        this.lastClick = undefined
        this.drag = {
          kind: 'split',
          split,
          offset: split.pos - (split.direction === 'Horizontal' ? event.column : event.row),
          topology: this.topology(context),
          boot: context.snapshot.boot_id,
        }
        return
      }
    }
    const pane = context.panes.find((pane) => contains(pane.rect, event))
    if (!pane) return
    if (down) this.focusPane(pane)
    if (!contains(pane.inner_rect, event)) return
    if (typeof kind === 'string' && kind.startsWith('Scroll')) {
      this.focusPane(pane)
      this.clearSelection()
      this.lastClick = undefined
      if (
        !pane.mouse_reporting &&
        !pane.alternate_screen_active &&
        pane.scroll &&
        (kind === 'ScrollUp' || kind === 'ScrollDown')
      ) {
        const old = this.scrollTargets.get(pane.pane_id)
        const offset = Math.max(
          0,
          Math.min(
            pane.scroll.max_offset_from_bottom,
            (old && old.revision >= pane.content_revision
              ? old.offset
              : pane.scroll.offset_from_bottom) + (kind === 'ScrollUp' ? 3 : -3),
          ),
        )
        this.scroll(pane, offset)
      } else {
        const message = this.mouseEvent(pane.inner_rect, event)
        if (message) this.send(this.paneTarget(pane), message)
      }
      return
    }
    if (pane.mouse_reporting) {
      if (up || drag) return
      const target = this.paneTarget(pane),
        message = this.mouseEvent(pane.inner_rect, event)
      if (message) this.send(target, message)
      if (down)
        this.drag = { kind: 'mouse', target, rect: pane.inner_rect, button: kind.Down, last: event }
    } else if (down && kind.Down === 'Left') {
      const point = local(pane.inner_rect, event),
        at = Date.now(),
        previous = this.lastClick
      const double =
        !event.modifiers &&
        previous?.pane === pane.pane_id &&
        at - previous.at <= 350 &&
        Math.abs(previous.point.row - point.row) <= 1 &&
        Math.abs(previous.point.col - point.col) <= 1
      this.lastClick = !event.modifiers && !double ? { pane: pane.pane_id, point, at } : undefined
      const bounds = double ? this.bounds(pane, point) : undefined
      this.selection = {
        pane_id: pane.pane_id,
        pane,
        anchor: bounds ? { row: point.row, col: bounds[0] } : point,
        cursor: bounds ? { row: point.row, col: bounds[1] } : point,
        boot: context.snapshot.boot_id,
        generation: this.selectionRevision,
        base: top(pane),
        scrollOffsets: new Set(),
        word: bounds ? { anchor: point, bounds } : undefined,
      }
      this.drag = { kind: 'select', selection: this.selection }
      if (bounds) this.highlight(this.selection)
    }
  }
  [Symbol.dispose]() {
    this.disposed = true
    this.parser[Symbol.dispose]()
    this.drag = undefined
    this.clearSelection()
    this.scrollTargets.clear()
    this.latest.clear()
    this.batch = undefined
  }
}
