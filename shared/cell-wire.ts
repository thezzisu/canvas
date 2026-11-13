// The cell wire: a window's screen as one binary FRAME, then PATCHes of changed rows.
// The server encodes what its herdr client shows; a browser decodes into a CellMirror and paints.
//
// Integers are unsigned LEB128 ("v") unless a width is given.
//
//   message  u8 kind (1 FRAME, 2 PATCH) · v revision
//            FRAME: v cols · v rows · u8 defaults (1 foreground, 2 background) · [rgb] · [rgb]
//            PATCH: v base
//            cursor · links · styles · v rowCount · row*
//   cursor   u8 flags (1 visible, 2 blink, shape << 2: 0 block, 1 underline, 2 bar) · v x · v y
//   links    v count · (v length · utf8)*
//   styles   v count · style*
//   style    u16 attrs, little-endian · colour fg · colour bg · colour underline
//            v link (0 none, else link index + 1)
//   colour   u8 tag: 0 default · 1 palette + u8 index · 2 rgb + 3 bytes
//   row      v y · v length · run*
//   run      v (style << 3 | kind) · v count · payload
//            kind 0  count ASCII bytes (0x20–0x7e), one cell each
//                 1  count narrow cells:  v length · utf8, one code point per cell
//                 2  count wide cells:    v length · utf8, one code point per two columns
//                 3  count narrow cells:  (v length · utf8)*, one cluster per cell
//                 4  count wide cells:    (v length · utf8)*, one cluster per two columns
//                 5  count blank cells, no payload
//
// Rules:
// - A FRAME replaces everything: size, defaults, cursor, both tables and every row. It carries
//   all rows, in order. Absent defaults leave the foreground or background to the page's theme.
// - A PATCH applies only to the revision named by `base`, and then becomes `revision`. Its rows
//   replace whole rows, in ascending order; the other rows stay.
// - Links and styles are append-only tables. A message carries the entries its rows need that
//   earlier messages since the last FRAME did not; indices count from that FRAME.
// - Neither table holds more than 65536 entries; an encoder starts over with a FRAME first.
// - The runs of a row cover every column exactly once. The second column of a wide cell has no
//   cell of its own.
// - A decoder rejects anything else and keeps what it had.

const FRAME = 1
const PATCH = 2
const MAX_SIDE = 4096
const MAX_CELLS = 1_000_000
/** Entries either table may hold between two FRAMEs. */
export const MAX_TABLE = 65_536

/** Style attribute bits; `(attrs & UNDERLINE_MASK) >> UNDERLINE_SHIFT` is the underline style. */
export const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  inverse: 8,
  invisible: 16,
  strike: 32,
  overline: 64,
  blink: 128,
  rapidBlink: 2048,
  selected: 4096,
} as const
/** Underline styles: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
export const UNDERLINE_SHIFT = 8
export const UNDERLINE_MASK = 7 << UNDERLINE_SHIFT
const ATTR_MASK = 0x1fff

/** A colour is DEFAULT_COLOUR, 0xRRGGBB, or PALETTE_COLOUR | index. */
export const DEFAULT_COLOUR = -1
export const PALETTE_COLOUR = 0x1000000

const CURSOR_SHAPES = ['block', 'underline', 'bar'] as const
export interface CellCursor {
  x: number
  y: number
  visible: boolean
  blink: boolean
  shape: (typeof CURSOR_SHAPES)[number]
}
export interface CellStyle {
  attrs: number
  fg: number
  bg: number
  underline: number
  /** 0 for none, else an index + 1 into the link table. */
  link: number
}
export interface CellRun {
  /** First column, and the number of columns covered. */
  column: number
  columns: number
  /** Index into the style table. */
  style: number
  /** Each glyph takes two columns. */
  wide: boolean
  /** A string holds one ASCII character per cell; an array holds one glyph per cell. */
  text: string | string[]
}
interface CellUpdate {
  revision: number
  cursor: CellCursor
  /** Table entries not yet sent since the last FRAME. */
  links: readonly string[]
  styles: readonly CellStyle[]
  lines: readonly { y: number; runs: Uint8Array }[]
}
export interface CellFrame extends CellUpdate {
  cols: number
  rows: number
  foreground?: number
  background?: number
}
export interface CellPatch extends CellUpdate {
  base: number
}

export class CellWireError extends Error {
  constructor(message: string) {
    super(`Invalid cell message: ${message}`)
    this.name = 'CellWireError'
  }
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class Writer {
  private bytes = new Uint8Array(1024)
  private length = 0
  private room(extra: number) {
    if (this.length + extra <= this.bytes.length) return
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra))
    grown.set(this.bytes.subarray(0, this.length))
    this.bytes = grown
  }
  u8(value: number) {
    this.room(1)
    this.bytes[this.length++] = value
  }
  v(value: number) {
    this.room(8)
    while (value > 127) {
      this.bytes[this.length++] = (value % 128) | 128
      value = Math.floor(value / 128)
    }
    this.bytes[this.length++] = value
  }
  rgb(value: number) {
    this.room(3)
    this.bytes[this.length++] = (value >>> 16) & 255
    this.bytes[this.length++] = (value >>> 8) & 255
    this.bytes[this.length++] = value & 255
  }
  raw(bytes: Uint8Array) {
    this.room(bytes.length)
    this.bytes.set(bytes, this.length)
    this.length += bytes.length
  }
  /** UTF-8 with a length prefix. */
  text(value: string) {
    const bytes = utf8Encoder.encode(value)
    this.v(bytes.length)
    this.raw(bytes)
  }
  colour(value: number) {
    if (value === DEFAULT_COLOUR) this.u8(0)
    else if (value >= PALETTE_COLOUR) {
      this.u8(1)
      this.u8(value & 255)
    } else {
      this.u8(2)
      this.rgb(value)
    }
  }
  take() {
    const out = this.bytes.slice(0, this.length)
    this.length = 0
    return out
  }
}

/** The append-only link and style tables of one stream; `clear` goes with a FRAME. */
export class CellTables {
  readonly links: string[] = []
  readonly styles: CellStyle[] = []
  private readonly linkIds = new Map<string, number>()
  private readonly styleIds = new Map<string, number>()

  /** The index of a style, added on first use. `link` is a URI, or empty for none. */
  style(attrs: number, fg: number, bg: number, underline: number, link: string): number {
    let linkId = 0
    if (link) {
      linkId = this.linkIds.get(link) ?? 0
      if (!linkId) {
        this.links.push(link)
        this.linkIds.set(link, (linkId = this.links.length))
      }
    }
    const key = `${attrs},${fg},${bg},${underline},${linkId}`
    let id = this.styleIds.get(key)
    if (id === undefined) {
      id = this.styles.length
      this.styles.push({ attrs, fg, bg, underline, link: linkId })
      this.styleIds.set(key, id)
    }
    return id
  }
  clear() {
    this.links.length = 0
    this.styles.length = 0
    this.linkIds.clear()
    this.styleIds.clear()
  }
}

const isAscii = (text: string) =>
  text.length === 1 && text.charCodeAt(0) >= 0x20 && text.charCodeAt(0) <= 0x7e
const isCodePoint = (text: string) =>
  text.length === 1 || (text.length === 2 && text.codePointAt(0)! > 0xffff)

/** Encodes one row from its cells, left to right; the second column of a wide cell is not a cell. */
export class RowEncoder {
  private readonly writer = new Writer()
  private style = 0
  private wide = false
  private clusters = false
  private ascii = true
  private glyphs: string[] = []

  /** An empty `text` is a blank. */
  cell(style: number, text: string, wide: boolean) {
    // A lone surrogate would pair with its neighbour in a joined run.
    const glyph = text.toWellFormed() || ' ',
      clusters = !isCodePoint(glyph)
    if (
      this.glyphs.length &&
      (style !== this.style || wide !== this.wide || clusters !== this.clusters)
    )
      this.flush()
    this.style = style
    this.wide = wide
    this.clusters = clusters
    this.ascii &&= isAscii(glyph)
    this.glyphs.push(glyph)
  }
  private run(kind: number, count: number) {
    this.writer.v(this.style * 8 + kind)
    this.writer.v(count)
  }
  private flush() {
    const glyphs = this.glyphs,
      w = this.writer
    if (this.clusters) {
      this.run(this.wide ? 4 : 3, glyphs.length)
      for (const glyph of glyphs) w.text(glyph)
    } else if (this.wide || !this.ascii) {
      this.run(this.wide ? 2 : 1, glyphs.length)
      w.text(glyphs.join(''))
    } else {
      // Trailing blanks need no payload.
      let used = glyphs.length
      while (used && glyphs[used - 1] === ' ') used--
      if (used) {
        this.run(0, used)
        for (let index = 0; index < used; index++) w.u8(glyphs[index]!.charCodeAt(0))
      }
      if (used < glyphs.length) this.run(5, glyphs.length - used)
    }
    this.glyphs = []
    this.ascii = true
  }
  finish(): Uint8Array {
    if (this.glyphs.length) this.flush()
    return this.writer.take()
  }
}

function writeUpdate(w: Writer, update: CellUpdate) {
  const cursor = update.cursor
  w.u8(
    (cursor.visible ? 1 : 0) | (cursor.blink ? 2 : 0) | (CURSOR_SHAPES.indexOf(cursor.shape) << 2),
  )
  w.v(cursor.x)
  w.v(cursor.y)
  w.v(update.links.length)
  for (const link of update.links) w.text(link)
  w.v(update.styles.length)
  for (const style of update.styles) {
    w.u8(style.attrs & 255)
    w.u8(style.attrs >>> 8)
    w.colour(style.fg)
    w.colour(style.bg)
    w.colour(style.underline)
    w.v(style.link)
  }
  w.v(update.lines.length)
  for (const line of update.lines) {
    w.v(line.y)
    w.v(line.runs.length)
    w.raw(line.runs)
  }
  return w.take()
}
export function encodeFrame(frame: CellFrame): Uint8Array {
  const w = new Writer()
  w.u8(FRAME)
  w.v(frame.revision)
  w.v(frame.cols)
  w.v(frame.rows)
  w.u8((frame.foreground === undefined ? 0 : 1) | (frame.background === undefined ? 0 : 2))
  if (frame.foreground !== undefined) w.rgb(frame.foreground)
  if (frame.background !== undefined) w.rgb(frame.background)
  return writeUpdate(w, frame)
}
export function encodePatch(patch: CellPatch): Uint8Array {
  const w = new Writer()
  w.u8(PATCH)
  w.v(patch.revision)
  w.v(patch.base)
  return writeUpdate(w, patch)
}

class Reader {
  private at = 0
  constructor(private readonly bytes: Uint8Array) {}
  get left() {
    return this.bytes.length - this.at
  }
  private need(count: number, what: string) {
    if (count > this.left) throw new CellWireError(`truncated ${what}`)
  }
  u8(what: string) {
    this.need(1, what)
    return this.bytes[this.at++]!
  }
  v(what: string) {
    let value = 0,
      scale = 1
    for (let index = 0; index < 8; index++) {
      const byte = this.u8(what)
      value += (byte & 127) * scale
      if (byte < 128 && value <= Number.MAX_SAFE_INTEGER) return value
      scale *= 128
    }
    throw new CellWireError(`${what} is too large`)
  }
  /** A count of entries that each take at least `size` bytes. */
  count(what: string, size: number) {
    const count = this.v(what)
    if (count * size > this.left) throw new CellWireError(`truncated ${what}`)
    return count
  }
  rgb(what: string) {
    this.need(3, what)
    return (this.bytes[this.at++]! << 16) | (this.bytes[this.at++]! << 8) | this.bytes[this.at++]!
  }
  take(length: number, what: string) {
    this.need(length, what)
    return this.bytes.subarray(this.at, (this.at += length))
  }
  text(what: string) {
    const bytes = this.take(this.v(what), what)
    try {
      return utf8Decoder.decode(bytes)
    } catch {
      throw new CellWireError(`${what} is not UTF-8`)
    }
  }
  colour(what: string) {
    const tag = this.u8(what)
    if (tag === 0) return DEFAULT_COLOUR
    if (tag === 1) return PALETTE_COLOUR | this.u8(what)
    if (tag === 2) return this.rgb(what)
    throw new CellWireError(`unknown ${what} tag ${tag}`)
  }
}

function readRuns(r: Reader, cols: number, styles: number): CellRun[] {
  const runs: CellRun[] = []
  let column = 0
  while (r.left) {
    const head = r.v('run'),
      kind = head % 8,
      style = Math.floor(head / 8),
      count = r.v('run length'),
      wide = kind === 2 || kind === 4,
      columns = wide ? count * 2 : count
    if (kind > 5) throw new CellWireError(`unknown run kind ${kind}`)
    if (style >= styles) throw new CellWireError(`unknown style ${style}`)
    if (!count || column + columns > cols) throw new CellWireError('run outside its row')
    let text: string | string[]
    if (kind === 0) {
      const bytes = r.take(count, 'run text')
      if (bytes.some((byte) => byte < 0x20 || byte > 0x7e))
        throw new CellWireError('run text is not printable ASCII')
      text = String.fromCharCode(...bytes)
    } else if (kind === 5) text = ' '.repeat(count)
    else if (kind <= 2) {
      text = Array.from(r.text('run text'))
      if (text.length !== count) throw new CellWireError('run text does not match its length')
    } else {
      text = []
      for (let index = 0; index < count; index++) {
        const cluster = r.text('run text')
        if (!cluster) throw new CellWireError('empty cell')
        text.push(cluster)
      }
    }
    runs.push({ column, columns, style, wide, text })
    column += columns
  }
  if (column !== cols) throw new CellWireError('row does not cover every column')
  return runs
}

/** A browser's copy of one window's screen. */
export class CellMirror {
  /** -1 until the first FRAME. */
  revision = -1
  cols = 0
  rows = 0
  /** Undefined leaves the colour to the page's theme. */
  foreground?: number
  background?: number
  cursor: CellCursor = { x: 0, y: 0, visible: false, blink: false, shape: 'block' }
  links: string[] = []
  styles: CellStyle[] = []
  /** One list of runs per row. */
  lines: CellRun[][] = []

  /**
   * Applies one message and names the rows it replaced. A message that is malformed, or a PATCH
   * for another revision, throws CellWireError and changes nothing.
   */
  apply(bytes: Uint8Array): { frame: boolean; rows: number[] } {
    const r = new Reader(bytes)
    const kind = r.u8('kind')
    if (kind !== FRAME && kind !== PATCH) throw new CellWireError(`unknown kind ${kind}`)
    const frame = kind === FRAME,
      revision = r.v('revision')
    let cols = this.cols,
      rows = this.rows,
      foreground = this.foreground,
      background = this.background
    if (frame) {
      cols = r.v('cols')
      rows = r.v('rows')
      if (!cols || !rows || cols > MAX_SIDE || rows > MAX_SIDE || cols * rows > MAX_CELLS)
        throw new CellWireError(`grid size ${cols}x${rows}`)
      const defaults = r.u8('defaults')
      if (defaults > 3) throw new CellWireError('unknown defaults')
      foreground = defaults & 1 ? r.rgb('foreground') : undefined
      background = defaults & 2 ? r.rgb('background') : undefined
    } else {
      const base = r.v('base')
      if (base !== this.revision || revision <= base)
        throw new CellWireError(`patch ${base}→${revision} does not follow ${this.revision}`)
    }

    const flags = r.u8('cursor'),
      shape = CURSOR_SHAPES[flags >>> 2]
    const cursor = {
      x: r.v('cursor'),
      y: r.v('cursor'),
      visible: (flags & 1) !== 0,
      blink: (flags & 2) !== 0,
      shape: shape!,
    }
    if (!shape || cursor.x >= cols || cursor.y >= rows)
      throw new CellWireError('cursor outside the grid')

    const links: string[] = [],
      styles: CellStyle[] = [],
      knownLinks = frame ? 0 : this.links.length,
      knownStyles = frame ? 0 : this.styles.length
    for (let count = r.count('links', 1); count; count--) links.push(r.text('link'))
    for (let count = r.count('styles', 6); count; count--) {
      const attrs = r.u8('style') | (r.u8('style') << 8)
      const style = {
        attrs,
        fg: r.colour('colour'),
        bg: r.colour('colour'),
        underline: r.colour('colour'),
        link: r.v('style link'),
      }
      if (attrs & ~ATTR_MASK || (attrs & UNDERLINE_MASK) >> UNDERLINE_SHIFT > 5)
        throw new CellWireError('unknown style attributes')
      if (style.link > knownLinks + links.length)
        throw new CellWireError(`unknown link ${style.link - 1}`)
      styles.push(style)
    }

    if (knownLinks + links.length > MAX_TABLE || knownStyles + styles.length > MAX_TABLE)
      throw new CellWireError('table too large')
    const count = r.count('rows', 2)
    if (frame ? count !== rows : count > rows) throw new CellWireError('wrong number of rows')
    const changed: number[] = [],
      lines: CellRun[][] = []
    for (let index = 0; index < count; index++) {
      const y = r.v('row')
      if (y >= rows || (frame ? y !== index : index > 0 && y <= changed[index - 1]!))
        throw new CellWireError('rows out of order')
      const runs = new Reader(r.take(r.v('row length'), 'row'))
      changed.push(y)
      lines.push(readRuns(runs, cols, knownStyles + styles.length))
    }
    if (r.left) throw new CellWireError('trailing bytes')

    if (frame) {
      this.links = links
      this.styles = styles
      this.lines = lines
    } else {
      for (const link of links) this.links.push(link)
      for (const style of styles) this.styles.push(style)
      changed.forEach((y, index) => (this.lines[y] = lines[index]!))
    }
    Object.assign(this, { revision, cols, rows, foreground, background, cursor })
    return { frame, rows: changed }
  }
}
