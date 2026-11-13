import type { CellData } from '../herdr/wire.ts'
import { ghostty, type GhosttyModule, type Pointer } from './module.ts'

/** The modifier bits of a key or mouse event, as libghostty-vt numbers them. */
export const MODS = { shift: 1, ctrl: 2, alt: 4, super: 8 } as const

export interface GhosttyEvents {
  /** A program set the clipboard (OSC 52 or OSC 5522) to this text. */
  clipboard?(text: Uint8Array): void
  /** A program status report (OSC 7501) for the record `id`; the root record has no id. */
  status?(id: string, state: string): void
}
/** One row of the viewport. A row that did not change keeps its cells from one read to the next. */
export interface ScreenRow {
  /** One per column; `hyperlink` is always null here, the targets are in `links`. */
  cells: readonly CellData[]
  /** OSC 8 targets by column. */
  links?: ReadonlyMap<number, string>
  /** The row continues the one above it. */
  wrapped: boolean
}
export interface ScreenCursor {
  x: number
  y: number
  visible: boolean
  /** As DECSCUSR numbers it: 1–2 block, 3–4 underline, 5–6 bar; the odd ones blink. */
  shape: number
}
/** One cell of a line read by its position in the whole screen. */
export interface LineCell {
  text: string
  /** 0 for the second column of a wide cell. */
  width: number
  invisible: boolean
}
export interface KeyInput {
  /** A GhosttyKey name, such as `ENTER` or `A`. */
  key: string
  action: 'PRESS' | 'REPEAT' | 'RELEASE'
  mods: number
  /** The modifiers the layout used up to produce `text`. */
  consumed: number
  text: string
  /** The key's character without Shift, or 0. */
  unshifted: number
}
export interface MouseInput {
  action: 'PRESS' | 'RELEASE' | 'MOTION'
  /** A GhosttyMouseButton name; `UNKNOWN` for none. */
  button: string
  mods: number
  /** A button is held during this motion. */
  dragging: boolean
  /** The position in pixels, in a window of `cell` sized cells. */
  x: number
  y: number
  cell: { width: number; height: number }
}

const BLANK: CellData = Object.freeze({
  symbol: ' ',
  fg: 0,
  bg: 0,
  modifier: 0,
  skip: false,
  hyperlink: null,
})
const STATUS_STATES = ['idle', 'working', 'done', 'blocked', 'error', 'clear']
const MAX_CLUSTER = 32
const MAX_LINK = 8192
/** A program may set at most this much clipboard text at once. */
const MAX_CLIPBOARD = 1024 * 1024
/** The representations of one clipboard write that are looked at for its text. */
const MAX_CLIPBOARD_KINDS = 16
/** No key or mouse report is longer. */
const MAX_REPORT = 4096

interface Layout {
  cell: Record<'tag' | 'content' | 'style' | 'wide' | 'link', { lsb: number; width: number }>
  flags: Record<string, { lsb: number; width: number }>
  style: { fg: number; bg: number; flags: number }
  tag: { codepoint: number; grapheme: number; palette: number }
  wide: { wide: number; tail: number }
  colour: { palette: number; rgb: number }
}
/** What every terminal shares: iterators, encoders, callbacks and the decoded layouts. */
interface Kit {
  g: GhosttyModule
  layout: Layout
  iterator: Pointer
  cells: Pointer
  keyEncoder: Pointer
  keyEvent: Pointer
  mouseEncoder: Pointer
  mouseEvent: Pointer
  codepoints: Pointer
  callbacks: { status: number; clipboard: number }
  terminals: Map<Pointer, GhosttyTerminal>
}
let shared: Kit | undefined
function kit(): Kit {
  if (shared) return shared
  const g = ghostty(),
    x = g.x,
    terminals = new Map<Pointer, GhosttyTerminal>()
  const flag = (name: string) => g.bits('GhosttyStyleFlags', name)
  const created: Kit = {
    g,
    terminals,
    layout: {
      cell: {
        tag: g.bits('GhosttyCell', 'content_tag'),
        content: g.bits('GhosttyCell', 'content'),
        style: g.bits('GhosttyCell', 'style_id'),
        wide: g.bits('GhosttyCell', 'wide'),
        link: g.bits('GhosttyCell', 'hyperlink'),
      },
      flags: Object.fromEntries(
        [
          'bold',
          'italic',
          'faint',
          'blink',
          'inverse',
          'invisible',
          'strikethrough',
          'underline',
        ].map((name) => [name, flag(name)]),
      ),
      style: {
        fg: g.offset('GhosttyStyle', 'fg_color'),
        bg: g.offset('GhosttyStyle', 'bg_color'),
        flags: g.offset('GhosttyStyle', 'flags'),
      },
      tag: {
        codepoint: g.value('GhosttyCellContentTag', 'CODEPOINT'),
        grapheme: g.value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
        palette: g.value('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
      },
      wide: {
        wide: g.value('GhosttyCellWide', 'WIDE'),
        tail: g.value('GhosttyCellWide', 'SPACER_TAIL'),
      },
      colour: {
        palette: g.value('GhosttyStyleColorTag', 'PALETTE'),
        rgb: g.value('GhosttyStyleColorTag', 'RGB'),
      },
    },
    iterator: g.handle((slot) => x.ghostty_render_state_row_iterator_new!(0, slot)),
    cells: g.handle((slot) => x.ghostty_render_state_row_cells_new!(0, slot)),
    keyEncoder: g.handle((slot) => x.ghostty_key_encoder_new!(0, slot)),
    keyEvent: g.handle((slot) => x.ghostty_key_event_new!(0, slot)),
    mouseEncoder: g.handle((slot) => x.ghostty_mouse_encoder_new!(0, slot)),
    mouseEvent: g.handle((slot) => x.ghostty_mouse_event_new!(0, slot)),
    codepoints: g.alloc(MAX_CLUSTER * 4),
    callbacks: {
      status: g.callback(3, (terminal, _userdata, report) => {
        const state = STATUS_STATES[g.view.getUint32(report, true)]
        if (state)
          terminals
            .get(terminal)
            ?.events.status?.(
              g.string(report + g.offset('GhosttyTerminalProgramStatus', 'id')),
              state,
            )
      }),
      clipboard: g.callback(3, (terminal, _userdata, write) => {
        const view = g.view,
          field = (name: string) => write + g.offset('GhosttyClipboardWrite', name)
        const contents = view.getUint32(field('contents'), true),
          count = view.getUint32(field('contents_len'), true),
          size = g.size('GhosttyClipboardContent')
        let text: Uint8Array | undefined
        for (let index = 0; index < Math.min(count, MAX_CLIPBOARD_KINDS) && !text; index++) {
          const content = contents + index * size
          if (g.string(content + g.offset('GhosttyClipboardContent', 'mime')) === 'text/plain')
            text = g.stringBytes(content + g.offset('GhosttyClipboardContent', 'data'))
        }
        // The request is answered before the callback returns; the reply is the library's own
        // function, reached through the table.
        const reply = g.sized(g.out, 'GhosttyClipboardWriteReply')
        g.view.setUint32(
          reply + g.offset('GhosttyClipboardWriteReply', 'result'),
          g.value('GhosttyClipboardWriteResult', text ? 'SUCCESS' : 'UNSUPPORTED'),
          true,
        )
        ;(g.table.get(view.getUint32(field('reply'), true)) as (a: number, b: number) => void)(
          write,
          reply,
        )
        if (text) terminals.get(terminal)?.events.clipboard?.(text)
      }),
    },
  }
  return (shared = created)
}

/** A bit field of a packed 64-bit value given as two halves. */
const field = (lo: number, hi: number, { lsb, width }: { lsb: number; width: number }) =>
  (lsb >= 32
    ? hi >>> (lsb - 32)
    : lsb + width <= 32
      ? lo >>> lsb
      : (lo >>> lsb) | (hi << (32 - lsb))) &
  ((1 << width) - 1)

/** One headless terminal: it parses a program's output and answers what is on its screen. */
export class GhosttyTerminal {
  private readonly k = kit()
  private handle: Pointer
  private readonly renderState: Pointer
  private screen: ScreenRow[] = []
  /** Styles decoded while reading one row, by the row's style id. */
  private readonly styles = new Map<number, { fg: number; bg: number; modifier: number }>()

  constructor(
    cols: number,
    rows: number,
    scrollback: number,
    readonly events: GhosttyEvents = {},
  ) {
    const { g, callbacks, terminals } = this.k,
      x = g.x
    this.handle = g.handle((slot) => x.ghostty_terminal_new!(0, slot, cols, rows))
    this.renderState = g.handle((slot) => x.ghostty_render_state_new!(0, slot))
    terminals.set(this.handle, this)
    // Lines bound the history; the byte limit is lifted so that they are the bound that applies.
    this.setSize('SCROLLBACK_MAX_BYTES', 0xffffffff)
    this.setSize('SCROLLBACK_MAX_LINES', scrollback)
    this.setSize('CLIPBOARD_WRITE_MAX_BYTES', MAX_CLIPBOARD)
    // Without grapheme clustering an emoji sequence takes a cell pair per code point.
    g.view.setUint16(g.out, 2027, true)
    g.view.setUint8(g.out + g.offset('GhosttyTerminalModeConfig', 'value'), 1)
    this.set('MODE_DEFAULT', g.out)
    g.view.setUint8(g.out, 1)
    this.set('DEFAULT_CURSOR_BLINK', g.out)
    // No reply callback is installed: the core answers the program's queries itself.
    this.set('PROGRAM_STATUS', callbacks.status)
    this.set('CLIPBOARD_WRITE', callbacks.clipboard)
  }
  /** Returns the terminal's memory to the module. Nothing else may be called afterwards. */
  free() {
    if (!this.handle) return
    const { g, terminals } = this.k
    terminals.delete(this.handle)
    g.x.ghostty_render_state_free!(this.renderState)
    g.x.ghostty_terminal_free!(this.handle)
    this.handle = 0
    this.screen = []
  }

  private set(option: string, value: Pointer) {
    const { g } = this.k
    g.check(g.x.ghostty_terminal_set!(this.handle, g.value('GhosttyTerminalOption', option), value))
  }
  private setSize(option: string, value: number) {
    const { g } = this.k
    g.view.setUint32(g.out, value, true)
    this.set(option, g.out)
  }
  /** Reads one value into scratch and returns where it is. */
  private get(data: string, out = this.k.g.out): Pointer {
    const { g } = this.k
    g.check(g.x.ghostty_terminal_get!(this.handle, g.value('GhosttyTerminalData', data), out))
    return out
  }

  write(data: Uint8Array | string) {
    const { g } = this.k,
      length = g.put(data)
    g.x.ghostty_terminal_vt_write!(this.handle, g.ioPointer, length)
  }
  resize(cols: number, rows: number) {
    const { g } = this.k
    g.check(g.x.ghostty_terminal_resize!(this.handle, cols, rows, 0, 0))
  }
  get cols() {
    return this.k.g.view.getUint16(this.get('COLS'), true)
  }
  get rows() {
    return this.k.g.view.getUint16(this.get('ROWS'), true)
  }
  get alternateScreen() {
    const { g } = this.k
    return (
      g.view.getUint32(this.get('ACTIVE_SCREEN'), true) ===
      g.value('GhosttyTerminalScreen', 'ALTERNATE')
    )
  }
  /** The program asked for mouse events. */
  get mouseReporting() {
    return this.k.g.view.getUint8(this.get('MOUSE_TRACKING')) !== 0
  }
  /** The kitty keyboard protocol flags the program asked for; 0 for none. */
  get kittyKeyboard() {
    return this.k.g.view.getUint8(this.get('KITTY_KEYBOARD_FLAGS'))
  }
  /** Whether a DEC private mode is set. */
  mode(number: number) {
    const { g } = this.k
    g.view.setUint16(g.out, number, true)
    return g.view.getUint8(this.get('MODE') + g.offset('GhosttyTerminalModeConfig', 'value')) !== 0
  }

  /** Where the viewport is: `top` rows of the screen are above it, out of `max` it can reach. */
  get scroll(): { top: number; max: number } {
    const { g } = this.k,
      at = this.get('SCROLLBAR'),
      view = g.view
    const number = (name: string) =>
      Number(view.getBigUint64(at + g.offset('GhosttyTerminalScrollbar', name), true))
    return { top: number('offset'), max: Math.max(0, number('total') - number('len')) }
  }
  /** Moves the viewport so that `top` rows are above it; past the end is the bottom. */
  scrollTo(top: number) {
    const { g } = this.k,
      at = g.out,
      bottom = top >= this.scroll.max
    g.bytes.fill(0, at, at + g.size('GhosttyTerminalScrollViewport'))
    g.view.setUint32(
      at,
      g.value('GhosttyTerminalScrollViewportTag', bottom ? 'BOTTOM' : 'ROW'),
      true,
    )
    g.view.setBigUint64(
      at + g.offset('GhosttyTerminalScrollViewport', 'value'),
      BigInt(Math.max(0, top)),
      true,
    )
    g.check(g.x.ghostty_terminal_scroll_viewport!(this.handle, at))
  }

  /** The viewport's rows. Call `cursor()` after it for the cursor of the same moment. */
  read(): readonly ScreenRow[] {
    const { g, iterator, cells } = this.k,
      x = g.x
    g.check(x.ghostty_render_state_update!(this.renderState, this.handle))
    const DATA = (name: string) => g.value('GhosttyRenderStateData', name),
      ROW = (name: string) => g.value('GhosttyRenderStateRowData', name)
    const rows = this.rows
    if (this.screen.length !== rows) {
      // Every row is read again: the cache no longer matches the viewport.
      this.screen = []
      g.view.setUint32(g.out, g.value('GhosttyRenderStateDirty', 'FULL'), true)
      g.check(
        x.ghostty_render_state_set!(
          this.renderState,
          g.value('GhosttyRenderStateOption', 'DIRTY'),
          g.out,
        ),
      )
    }
    g.view.setUint32(g.out, iterator, true)
    g.check(x.ghostty_render_state_get!(this.renderState, DATA('ROW_ITERATOR'), g.out))
    while (x.ghostty_render_state_row_iterator_next_dirty!(iterator, g.out)) {
      const y = g.view.getUint16(g.out, true)
      g.check(x.ghostty_render_state_row_get!(iterator, ROW('CELLS_RAW'), g.out))
      const base = g.view.getUint32(g.out, true),
        count = g.view.getUint32(g.out + 4, true)
      g.view.setUint32(g.out, cells, true)
      g.check(x.ghostty_render_state_row_get!(iterator, ROW('CELLS'), g.out))
      g.check(x.ghostty_render_state_row_get!(iterator, ROW('RAW'), g.out))
      const raw = g.view.getBigUint64(g.out, true)
      this.screen[y] = this.row(y, base, count, this.wrapped(raw))
    }
    g.check(x.ghostty_render_state_clean!(this.renderState))
    return this.screen
  }
  private wrapped(row: bigint): boolean {
    const { g } = this.k
    g.check(
      (g.x.ghostty_row_get as unknown as (row: bigint, data: number, out: number) => number)(
        row,
        g.value('GhosttyRowData', 'WRAP_CONTINUATION'),
        g.out,
      ),
    )
    return g.view.getUint8(g.out) !== 0
  }
  private row(y: number, base: Pointer, count: number, wrapped: boolean): ScreenRow {
    const { g, layout, cells: selector } = this.k,
      x = g.x
    const STYLE = g.value('GhosttyRenderStateRowCellsData', 'STYLE'),
      GRAPHEMES = g.value('GhosttyRenderStateRowCellsData', 'GRAPHEMES_BUF')
    const cells: CellData[] = []
    let links: Map<number, string> | undefined
    let view = g.view
    this.styles.clear()
    for (let column = 0; column < count; column++) {
      const lo = view.getUint32(base + column * 8, true),
        hi = view.getUint32(base + column * 8 + 4, true)
      // A cell nothing was written to, in the default style.
      if (lo === 0 && hi === 0) {
        cells.push(BLANK)
        continue
      }
      const tag = field(lo, hi, layout.cell.tag),
        content = field(lo, hi, layout.cell.content),
        id = field(lo, hi, layout.cell.style),
        wide = field(lo, hi, layout.cell.wide)
      let style = id ? this.styles.get(id) : undefined
      if (id && !style) {
        x.ghostty_render_state_row_cells_select!(selector, column)
        g.check(x.ghostty_render_state_row_cells_get!(selector, STYLE, g.out))
        style = this.style(g.out)
        this.styles.set(id, style)
      }
      let symbol = ' ',
        bg = style?.bg ?? 0
      if (tag === layout.tag.codepoint) {
        if (content) symbol = String.fromCodePoint(content)
      } else if (tag === layout.tag.grapheme) {
        x.ghostty_render_state_row_cells_select!(selector, column)
        const buffer = g.out
        view.setUint32(buffer, this.k.codepoints, true)
        view.setUint32(buffer + g.offset('GhosttyCodepointBuffer', 'cap'), MAX_CLUSTER, true)
        g.check(
          x.ghostty_render_state_row_cells_get!(selector, GRAPHEMES, buffer),
          g.value('GhosttyResult', 'OUT_OF_SPACE'),
        )
        view = g.view
        const length = Math.min(
          MAX_CLUSTER,
          view.getUint32(buffer + g.offset('GhosttyCodepointBuffer', 'len'), true),
        )
        symbol = ''
        for (let index = 0; index < length; index++)
          symbol += String.fromCodePoint(view.getUint32(this.k.codepoints + index * 4, true))
      } else if (tag === layout.tag.palette) bg = 0x1000000 | content
      // A background-only cell holds its colour as r, g, b from the low byte up.
      else bg = 0x2000000 | ((content & 255) << 16) | (content & 0xff00) | (content >>> 16)
      if (field(lo, hi, layout.cell.link)) {
        const uri = this.link(column, y)
        if (uri) (links ??= new Map()).set(column, uri)
        view = g.view
      }
      cells.push({
        symbol,
        fg: style?.fg ?? 0,
        bg,
        modifier: style?.modifier ?? 0,
        skip: wide === layout.wide.tail,
        hyperlink: null,
      })
    }
    return { cells, wrapped, ...(links ? { links } : {}) }
  }
  /** A GhosttyStyle as herdr's cell colours and modifier bits. */
  private style(at: Pointer) {
    const { g, layout } = this.k,
      view = g.view
    const colour = (offset: number) => {
      const tag = view.getUint8(at + offset)
      if (tag === layout.colour.rgb)
        return (
          0x2000000 |
          (view.getUint8(at + offset + 1) << 16) |
          (view.getUint8(at + offset + 2) << 8) |
          view.getUint8(at + offset + 3)
        )
      return tag === layout.colour.palette ? 0x1000000 | view.getUint8(at + offset + 1) : 0
    }
    const raw = view.getUint16(at + layout.style.flags, true),
      bit = (name: string) => (raw >>> layout.flags[name]!.lsb) & 1,
      underline = (raw >>> layout.flags.underline!.lsb) & 7
    return {
      fg: colour(layout.style.fg),
      bg: colour(layout.style.bg),
      modifier:
        bit('bold') |
        (bit('faint') << 1) |
        (bit('italic') << 2) |
        (underline ? 8 | (underline << 12) : 0) |
        (bit('blink') << 4) |
        (bit('inverse') << 6) |
        (bit('invisible') << 7) |
        (bit('strikethrough') << 8),
    }
  }
  /** A reference to a cell in scratch, or 0 when the screen has no such cell. */
  private ref(tag: 'VIEWPORT' | 'SCREEN', x: number, y: number): Pointer {
    const { g } = this.k,
      point = g.out2,
      ref = g.out2 + 32,
      coordinate = point + g.offset('GhosttyPoint', 'value')
    g.view.setUint32(point, g.value('GhosttyPointTag', tag), true)
    g.view.setUint16(coordinate + g.offset('GhosttyPointCoordinate', 'x'), x, true)
    g.view.setUint32(coordinate + g.offset('GhosttyPointCoordinate', 'y'), y, true)
    return g.x.ghostty_terminal_grid_ref!(this.handle, point, ref) === 0 ? ref : 0
  }
  /** The OSC 8 target of a viewport cell; none when it is longer than a link may be. */
  private link(column: number, row: number): string {
    const { g } = this.k,
      ref = this.ref('VIEWPORT', column, row)
    if (!ref) return ''
    const uri = g.encode(0, MAX_LINK, (buffer, capacity, written) =>
      g.x.ghostty_grid_ref_hyperlink_uri!(ref, buffer, capacity, written),
    )
    return uri ? Buffer.from(uri).toString('utf8') : ''
  }

  /** The cursor in the viewport read last, or nothing while it is scrolled out of view. */
  cursor(): ScreenCursor | undefined {
    const { g } = this.k,
      at = g.sized(g.out, 'GhosttyRenderStateCursor'),
      offset = (name: string) => at + g.offset('GhosttyRenderStateCursor', name)
    g.check(
      g.x.ghostty_render_state_get!(
        this.renderState,
        g.value('GhosttyRenderStateData', 'CURSOR'),
        at,
      ),
    )
    const view = g.view
    if (!view.getUint8(offset('viewport_has_value'))) return
    const style = view.getUint32(offset('visual_style'), true),
      steady = view.getUint8(offset('blinking')) ? 0 : 1
    return {
      x: view.getUint16(offset('viewport_x'), true),
      y: view.getUint16(offset('viewport_y'), true),
      visible: view.getUint8(offset('visible')) !== 0,
      shape:
        (style === g.value('GhosttyCursorStyle', 'BAR')
          ? 5
          : style === g.value('GhosttyCursorStyle', 'UNDERLINE')
            ? 3
            : 1) + steady,
    }
  }

  /** A row by its position in the whole screen, history included; nothing past its end. */
  line(y: number): { cells: LineCell[]; wrapped: boolean } | undefined {
    const { g, layout } = this.k,
      x = g.x,
      cols = this.cols
    const cells: LineCell[] = []
    let wrapped = false
    for (let column = 0; column < cols; column++) {
      const ref = this.ref('SCREEN', column, y)
      if (!ref) return
      if (column === 0) {
        g.check(x.ghostty_grid_ref_row!(ref, g.out))
        wrapped = this.wrapped(g.view.getBigUint64(g.out, true))
      }
      g.check(x.ghostty_grid_ref_cell!(ref, g.out))
      const lo = g.view.getUint32(g.out, true),
        hi = g.view.getUint32(g.out + 4, true)
      const tag = field(lo, hi, layout.cell.tag),
        content = field(lo, hi, layout.cell.content),
        wide = field(lo, hi, layout.cell.wide)
      let text = ' '
      if (tag === layout.tag.grapheme) {
        g.check(
          x.ghostty_grid_ref_graphemes!(ref, this.k.codepoints, MAX_CLUSTER, g.out),
          g.value('GhosttyResult', 'OUT_OF_SPACE'),
        )
        const length = Math.min(MAX_CLUSTER, g.view.getUint32(g.out, true))
        text = ''
        for (let index = 0; index < length; index++)
          text += String.fromCodePoint(g.view.getUint32(this.k.codepoints + index * 4, true))
      } else if (tag === layout.tag.codepoint && content) text = String.fromCodePoint(content)
      let invisible = false
      if (field(lo, hi, layout.cell.style)) {
        g.check(x.ghostty_grid_ref_style!(ref, g.out))
        invisible = (this.style(g.out).modifier & 128) !== 0
      }
      cells.push({
        text,
        width: wide === layout.wide.tail ? 0 : wide === layout.wide.wide ? 2 : 1,
        invisible,
      })
    }
    return { cells, wrapped }
  }

  /** The bytes a key sends in the program's keyboard modes; none when it sends nothing. */
  encodeKey(input: KeyInput): Uint8Array {
    const { g, keyEncoder, keyEvent } = this.k,
      x = g.x
    g.check(x.ghostty_key_encoder_set_from_terminal!(keyEncoder, this.handle))
    x.ghostty_key_event_set_action!(keyEvent, g.value('GhosttyKeyAction', input.action))
    x.ghostty_key_event_set_key!(keyEvent, g.value('GhosttyKey', input.key))
    x.ghostty_key_event_set_mods!(keyEvent, input.mods)
    x.ghostty_key_event_set_consumed_mods!(keyEvent, input.consumed)
    x.ghostty_key_event_set_unshifted_codepoint!(keyEvent, input.unshifted)
    // The event borrows its text, which stays at the front of the buffer the result follows.
    const length = g.put(input.text)
    const report = g.encode(length, MAX_REPORT, (buffer, capacity, written) => {
      g.view.setUint32(g.out, g.ioPointer, true)
      g.view.setUint32(g.out + 4, length, true)
      x.ghostty_key_event_set_utf8!(keyEvent, g.out)
      return x.ghostty_key_encoder_encode!(keyEncoder, keyEvent, buffer, capacity, written)
    })
    return report ?? new Uint8Array()
  }
  /** The bytes a mouse event sends; none unless the program asked for such events. */
  encodeMouse(input: MouseInput): Uint8Array {
    const { g, mouseEncoder, mouseEvent } = this.k,
      x = g.x,
      OPTION = (name: string) => g.value('GhosttyMouseEncoderOption', name)
    g.check(x.ghostty_mouse_encoder_set_from_terminal!(mouseEncoder, this.handle))
    // The getters use the scratch the size is then built in.
    const width = this.cols * input.cell.width,
      height = this.rows * input.cell.height
    const size = g.sized(g.out, 'GhosttyMouseEncoderSize'),
      set = (name: string, value: number) =>
        g.view.setUint32(size + g.offset('GhosttyMouseEncoderSize', name), value, true)
    set('screen_width', width)
    set('screen_height', height)
    set('cell_width', input.cell.width)
    set('cell_height', input.cell.height)
    g.check(x.ghostty_mouse_encoder_set!(mouseEncoder, OPTION('SIZE'), size))
    g.view.setUint8(g.out, input.dragging ? 1 : 0)
    g.check(x.ghostty_mouse_encoder_set!(mouseEncoder, OPTION('ANY_BUTTON_PRESSED'), g.out))
    x.ghostty_mouse_event_set_action!(mouseEvent, g.value('GhosttyMouseAction', input.action))
    if (input.button === 'UNKNOWN') x.ghostty_mouse_event_clear_button!(mouseEvent)
    else x.ghostty_mouse_event_set_button!(mouseEvent, g.value('GhosttyMouseButton', input.button))
    x.ghostty_mouse_event_set_mods!(mouseEvent, input.mods)
    g.view.setFloat32(g.out, input.x, true)
    g.view.setFloat32(g.out + 4, input.y, true)
    g.check(x.ghostty_mouse_event_set_position!(mouseEvent, g.out))
    const report = g.encode(0, MAX_REPORT, (buffer, capacity, written) =>
      x.ghostty_mouse_encoder_encode!(mouseEncoder, mouseEvent, buffer, capacity, written),
    )
    return report ?? new Uint8Array()
  }
}
