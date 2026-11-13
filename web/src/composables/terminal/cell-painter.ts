import {
  runCells,
  type CellCursor,
  type CellFrame,
  type CellPatch,
  type CellRun,
  type CellStyle,
} from '../../utils/terminal/cell-grid'
import { isDrawnGlyph } from '../../utils/terminal/cell-glyphs'
import { detectLinks } from '../../utils/terminal/cell-links'
import {
  cellFromPoint,
  columnEdge,
  unitsToCss,
  type CellMetrics,
} from '../../utils/terminal/cell-metrics'
import {
  clusterAt,
  planRow,
  rowText,
  type RowPlan,
  type RowSegment,
} from '../../utils/terminal/cell-rows'
import {
  cellPaint,
  BACKGROUND,
  cellPalette,
  cssColour,
  FACE_BOLD,
  FACE_ITALIC,
  type CellPaint,
  type CellTheme,
} from '../../utils/terminal/cell-style'
import { layoutRatio, measureCellFont, type CellFont, type CellFontOptions } from './cell-font'

export interface CellPainterOptions {
  font: CellFontOptions
  theme: CellTheme
  /** The grid's accessible name. */
  label?: string
  /** After the DOM shows a revision. */
  onPaint?(revision: number): void
  /** When the cell size changes: a new font, or a new pixel ratio. */
  onMetrics?(metrics: CellMetrics): void
  /** A click on a hyperlink or a web address. The painter opens nothing itself. */
  onLink?(uri: string, event: MouseEvent): void
}

interface LinkPiece {
  row: number
  column: number
  cells: number
  ink: string
}
interface LinkHit {
  uri: string
  /** Identifies the link among everything on screen. */
  key: string
  pieces(): LinkPiece[]
}

const NO_RUNS: readonly CellRun[] = []
const NO_STYLE: CellStyle = { attrs: 0, fg: -1, bg: -1, underline: -1, link: 0 }

/** Layout pixels, per whole pixel of ratio, that a row runs on under the next. */
const UNDER = 4

/**
 * A row's background: bands from top to bottom, each one gradient with hard stops and each
 * running on under the next. Every pixel is exactly one colour, or on a band's edge two.
 */
function rowBackground({ fills, tiles }: RowPlan, font: CellFont): string {
  if (!tiles.length && !fills.some((fill) => fill.colour)) return ''
  const edge = (column: number) => columnEdge(column, font)
  const height = Math.round(font.height * font.ratio)
  const cuts = [0, ...tiles.flatMap((tile) => [tile.y0, tile.y1])].filter((y) => y < height)
  const tops = [...new Set(cuts)].sort((a, b) => a - b)
  const bands = tops.map((top, index) => {
    const bottom = tops[index + 1] ?? Infinity
    const inBand = tiles.filter((tile) => tile.y0 <= top && tile.y1 >= bottom)
    // [where it ends in layout units, colour], left to right.
    const spans: [number, string][] = []
    const span = (end: number, colour: string) => {
      const last = spans.at(-1)
      if (last?.[1] === colour) last[0] = end
      else if (!last || end > last[0]) spans.push([end, colour])
    }
    let next = 0
    fills.forEach((fill, at) => {
      const end = at + 1 < fills.length ? edge(fills[at + 1]!.column) : Infinity
      for (; next < inBand.length && edge(inBand[next]!.column) < end; next++) {
        const tile = inBand[next]!
        const start = edge(tile.column)
        span(start + tile.x0 * 64, fill.colour || BACKGROUND)
        span(Math.min(start + tile.x1 * 64, edge(tile.column + 1)), tile.colour)
      }
      span(end, fill.colour || BACKGROUND)
    })
    const stops = spans.map(([end, colour], at) =>
      at === spans.length - 1
        ? `${colour} 0`
        : `${colour} ${at ? '0 ' : ''}${+(end / font.units).toFixed(4)}px`,
    )
    const image = spans.length > 1 ? `to right,${stops.join(',')}` : `${spans[0]![1]} 0 0`
    return `linear-gradient(${image})${top ? ` 0 ${top / font.ratio}px no-repeat` : ''}`
  })
  // The first layer listed is painted last.
  return bands.reverse().join(',')
}

// Every painter with changes paints in one animation frame.
const waiting = new Set<CellPainter>()
let frameRequest = 0
function schedule(painter: CellPainter) {
  waiting.add(painter)
  frameRequest ||= requestAnimationFrame(() => {
    frameRequest = 0
    for (const each of [...waiting]) each.flush()
  })
}

// A new device pixel ratio (another screen, browser zoom) changes every painter's cell.
const painters = new Set<CellPainter>()
let stopWatchingRatio: (() => void) | undefined
function watchRatio() {
  const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  const changed = () => {
    for (const painter of painters) painter.refreshMetrics()
    watchRatio()
  }
  query.addEventListener('change', changed, { once: true })
  stopWatchingRatio = () => query.removeEventListener('change', changed)
}

/**
 * Paints a grid of cells as DOM rows. It runs no terminal emulation and owns no selection: it
 * shows the frames and patches it is given, and reports cells and links back.
 *
 * A paint rebuilds only the rows that changed and reads nothing from layout. Sizes come from one
 * measurement per font, shared by every painter.
 */
export class CellPainter {
  readonly element: HTMLDivElement
  private readonly linkLayer: HTMLDivElement
  private readonly cursorElement: HTMLDivElement
  private preeditElement: HTMLDivElement | undefined
  private readonly options: CellPainterOptions
  private fontOptions: CellFontOptions
  private theme: CellTheme
  private font: CellFont | undefined
  /** The cell must be measured again before the next paint. */
  private stale = true
  private sized = false
  private focused = false
  private disposed = false

  private revision = -1
  private cols = 0
  private rows = 0
  private lines: (readonly CellRun[])[] = []
  private styles: CellStyle[] = []
  private links: string[] = []
  private paints: (CellPaint | undefined)[] = []
  private framePalette: readonly number[] | null | undefined
  private palette: readonly number[]
  private cursor: CellCursor | undefined
  private rowElements: HTMLDivElement[] = []
  private dirty: boolean[] = []

  private cursorAt = ''
  private cursorPhase = 'a'
  private preedit = ''
  private pointer: { column: number; row: number } | undefined
  private hoverKey = ''

  constructor(host: HTMLElement, options: CellPainterOptions) {
    this.options = options
    this.fontOptions = options.font
    this.theme = options.theme
    this.palette = cellPalette(options.theme)
    const element = document.createElement('div')
    element.className = 'terminal-grid'
    // Readable in order by assistive technology, and never announced as it repaints.
    element.setAttribute('role', 'group')
    element.setAttribute('aria-live', 'off')
    if (options.label) element.setAttribute('aria-label', options.label)
    this.linkLayer = document.createElement('div')
    this.linkLayer.className = 'tg-links'
    this.cursorElement = document.createElement('div')
    this.cursorElement.className = 'tg-cursor'
    this.cursorElement.hidden = true
    for (const overlay of [this.linkLayer, this.cursorElement])
      overlay.setAttribute('aria-hidden', 'true')
    element.append(this.linkLayer, this.cursorElement)
    element.addEventListener('mousemove', this.pointerMoved)
    element.addEventListener('mouseleave', this.pointerLeft)
    element.addEventListener('click', this.clicked)
    this.element = element
    this.applyTheme()
    host.append(element)
    if (!painters.size) watchRatio()
    painters.add(this)
  }

  /** The cell in CSS pixels, measured once per font. */
  get metrics(): CellMetrics {
    const font = this.measure()
    return { width: font.width, height: font.height }
  }

  /** Replaces everything shown. */
  frame(frame: CellFrame) {
    this.cols = frame.cols
    this.rows = frame.rows
    this.lines = Array.from({ length: frame.rows }, (_, y) => frame.lines[y] ?? NO_RUNS)
    this.styles = [...frame.styles]
    this.links = [...frame.links]
    this.paints = []
    this.framePalette = frame.palette
    this.palette = cellPalette(this.theme, frame.palette)
    this.cursor = frame.cursor
    this.revision = frame.revision
    const style = this.element.style
    style.setProperty('--tg-fg', cssColour(frame.foreground))
    style.setProperty('--tg-bg', cssColour(frame.background))
    while (this.rowElements.length > frame.rows) this.rowElements.pop()!.remove()
    while (this.rowElements.length < frame.rows) {
      const row = document.createElement('div')
      row.className = 'tg-row'
      this.linkLayer.before(row)
      this.rowElements.push(row)
    }
    this.dirty = new Array<boolean>(frame.rows).fill(true)
    this.sized = false
    schedule(this)
  }

  /** Applies changed rows. False when the patch is for another revision: ask for a frame. */
  patch(patch: CellPatch): boolean {
    if (this.revision < 0 || patch.base !== this.revision) return false
    this.styles.push(...patch.styles)
    this.links.push(...patch.links)
    const scroll = Math.min(patch.scroll, this.rows)
    if (scroll > 0) {
      // The rows that left the top become the new rows at the bottom.
      const moved = this.rowElements.splice(0, scroll)
      this.linkLayer.before(...moved)
      this.rowElements.push(...moved)
      this.lines = [
        ...this.lines.slice(scroll),
        ...new Array<readonly CellRun[]>(scroll).fill(NO_RUNS),
      ]
      this.dirty = [...this.dirty.slice(scroll), ...new Array<boolean>(scroll).fill(true)]
    }
    for (const { y, runs } of patch.rows) {
      if (y >= this.rows) continue
      this.lines[y] = runs
      this.dirty[y] = true
    }
    this.cursor = patch.cursor
    this.revision = patch.revision
    schedule(this)
    return true
  }

  setFont(font: CellFontOptions) {
    this.fontOptions = font
    this.refreshMetrics()
  }

  /** Measures the cell again before the next paint: the pixel ratio or a CSS zoom changed. */
  refreshMetrics() {
    this.stale = true
    if (this.revision >= 0) schedule(this)
    else if (this.font) this.measure()
  }

  setTheme(theme: CellTheme) {
    this.theme = theme
    this.palette = cellPalette(theme, this.framePalette)
    this.paints = []
    this.applyTheme()
    this.dirty.fill(true)
    if (this.revision >= 0) schedule(this)
  }

  /** Whether this grid has the keyboard: without it the cursor is an outline and does not blink. */
  setFocus(focused: boolean) {
    if (this.focused === focused) return
    this.focused = focused
    this.paintCursor()
  }

  /** Text an input method is composing, shown at the cursor; '' ends it. */
  setPreedit(text: string) {
    this.preedit = text
    this.paintCursor()
  }

  /** The cell under a viewport point, clamped to the grid; exact whatever scales the page. */
  cellAt(clientX: number, clientY: number): { column: number; row: number } {
    return cellFromPoint(
      this.element.getBoundingClientRect(),
      { cols: this.cols, rows: this.rows },
      clientX,
      clientY,
    )
  }

  /** The cursor's cell in the grid's own unscaled CSS pixels, to place an input method. */
  cursorBox(): { left: number; top: number; width: number; height: number } | undefined {
    const { cursor, font } = this
    if (!cursor || !font) return
    const cell = clusterAt(this.lines[cursor.y] ?? NO_RUNS, cursor.x)
    const column = cell?.column ?? cursor.x
    return {
      left: columnEdge(column, font) / font.units,
      top: cursor.y * font.height,
      width: (cell?.cells ?? 1) * font.width,
      height: font.height,
    }
  }

  /** Paints now what would otherwise wait for the next animation frame. */
  flush() {
    waiting.delete(this)
    if (this.disposed || this.revision < 0) return
    const font = this.measure()
    if (!this.sized) {
      const style = this.element.style
      style.width = `${unitsToCss(columnEdge(this.cols, font), font.units)}px`
      style.height = `${this.rows * font.height}px`
      this.sized = true
    }
    for (let y = 0; y < this.rows; y++) {
      if (!this.dirty[y]) continue
      this.dirty[y] = false
      this.paintRow(y, font)
    }
    this.paintCursor()
    this.showHover(true)
    this.options.onPaint?.(this.revision)
  }

  dispose() {
    this.disposed = true
    waiting.delete(this)
    painters.delete(this)
    if (!painters.size) stopWatchingRatio?.()
    this.element.removeEventListener('mousemove', this.pointerMoved)
    this.element.removeEventListener('mouseleave', this.pointerLeft)
    this.element.removeEventListener('click', this.clicked)
    this.element.remove()
  }

  private applyTheme() {
    const style = this.element.style
    const { theme } = this
    style.setProperty('--tg-cursor', cssColour(theme.cursor))
    style.setProperty('--tg-cursor-accent', cssColour(theme.cursorAccent))
    style.setProperty('--tg-select', cssColour(theme.selectionBackground))
    if (theme.selectionForeground === undefined) style.removeProperty('--tg-select-fg')
    else style.setProperty('--tg-select-fg', cssColour(theme.selectionForeground))
  }

  private measure(): CellFont {
    if (this.font && !this.stale) return this.font
    // Detached, the ratio is a guess: measure again once the grid is in the page.
    const connected = this.element.isConnected
    const ratio = connected ? layoutRatio(this.element) : window.devicePixelRatio || 1
    const font = measureCellFont(this.fontOptions, ratio)
    this.stale = !connected
    if (font === this.font) return font
    this.font = font
    const style = this.element.style
    const { options } = font
    style.fontFamily = options.family
    style.fontSize = `${options.size}px`
    style.fontVariantLigatures = options.ligatures ? 'normal' : 'none'
    style.fontFeatureSettings = options.ligatures
      ? '"calt" 1, "liga" 1'
      : '"calt" 0, "liga" 0, "dlig" 0'
    style.letterSpacing = `${font.spacing}px`
    style.setProperty('--tg-h', `${unitsToCss(Math.round(font.height * font.units), font.units)}px`)
    style.setProperty(
      '--tg-under',
      `${unitsToCss(UNDER * Math.ceil(font.ratio) * 64, font.units)}px`,
    )
    style.setProperty('--tg-line', `${font.light / font.ratio}px`)
    this.sized = false
    this.dirty.fill(true)
    this.options.onMetrics?.({ width: font.width, height: font.height })
    return font
  }

  private readonly paintOf = (index: number): CellPaint =>
    (this.paints[index] ??= cellPaint(this.styles[index] ?? NO_STYLE, this.palette, this.theme))

  private paintRow(y: number, font: CellFont) {
    const plan = planRow(this.lines[y]!, this.paintOf, font, font.glyphs)
    const row = this.rowElements[y]!
    const background = rowBackground(plan, font)
    if (row.style.background !== background) row.style.background = background
    row.replaceChildren(...plan.segments.map((segment) => this.segmentElement(segment, font)))
  }

  private segmentElement(segment: RowSegment, font: CellFont): HTMLElement {
    const element = document.createElement('span')
    const width =
      columnEdge(segment.column + segment.cells, font) - columnEdge(segment.column, font)
    element.className =
      'tg-seg' + (segment.hidden ? ' tg-hidden' : '') + (segment.blink ? ' tg-blink' : '')
    const start = columnEdge(segment.column, font)
    const drawn = segment.drawn.length
      ? font.glyphs.paint(
          segment.drawn.map(({ code, column, cells }) => ({
            code,
            x: (columnEdge(column, font) - start) / 64,
            end: (columnEdge(column + cells, font) - start) / 64,
          })),
          segment.ink,
          segment.paper,
        )
      : ''
    element.style.cssText =
      `width:${unitsToCss(width, font.units)}px;` + (drawn ? `background:${drawn};` : '')
    for (const node of segment.nodes) {
      if (!node.className && !node.css && !node.box) {
        element.append(node.text)
        continue
      }
      const span = document.createElement('span')
      span.textContent = node.text
      if (node.box) {
        span.className = node.className ? `tg-box ${node.className}` : 'tg-box'
        span.style.cssText = `${node.css}width:${node.box * font.width}px;`
      } else {
        if (node.className) span.className = node.className
        if (node.css) span.style.cssText = node.css
      }
      element.append(span)
    }
    return element
  }

  private paintCursor() {
    const { cursor, font, cursorElement: element } = this
    const box = cursor?.visible && cursor.x < this.cols && cursor.y < this.rows && this.cursorBox()
    element.hidden = !box
    if (this.preeditElement) this.preeditElement.hidden = !box || !this.preedit
    if (!box || !cursor || !font) return
    const place = `translate(${box.left}px,${box.top}px)`
    const shape = this.focused ? cursor.shape : 'outline'
    const cell = shape === 'block' ? clusterAt(this.lines[cursor.y]!, cursor.x) : undefined
    const code = cell?.cluster.codePointAt(0) ?? 0
    const drawn =
      !!cell && cell.cells === 1 && cell.cluster.length === 1 && isDrawnGlyph(code)
        ? font.glyphs.paint(
            [{ code, x: 0, end: font.width * font.ratio }],
            'var(--tg-cursor-accent)',
            'var(--tg-cursor)',
          )
        : ''
    const face = cell ? this.paintOf(cell.style).face : 0
    element.className =
      'tg-cursor' + (face & FACE_BOLD ? ' tg-b' : '') + (face & FACE_ITALIC ? ' tg-i' : '')
    element.dataset.shape = shape
    element.style.cssText =
      `width:${box.width}px;transform:${place};` + (drawn ? `background-image:${drawn};` : '')
    const text = cell && !drawn ? cell.cluster : ''
    if (element.textContent !== text) element.textContent = text
    // A cursor that moved shows at once: the blink starts over.
    const at = `${cursor.x},${cursor.y}`
    if (at !== this.cursorAt) {
      this.cursorAt = at
      this.cursorPhase = this.cursorPhase === 'a' ? 'b' : 'a'
    }
    if (this.focused && cursor.blink) element.dataset.blink = this.cursorPhase
    else delete element.dataset.blink

    if (!this.preedit && !this.preeditElement) return
    if (!this.preeditElement) {
      this.preeditElement = document.createElement('div')
      this.preeditElement.className = 'tg-preedit'
      this.preeditElement.setAttribute('aria-hidden', 'true')
      element.after(this.preeditElement)
    }
    this.preeditElement.hidden = !this.preedit
    this.preeditElement.textContent = this.preedit
    this.preeditElement.style.transform = place
  }

  /** The hyperlink or web address at a cell. */
  private linkAt(column: number, row: number): LinkHit | undefined {
    const runs = this.lines[row]
    const cell = runs && clusterAt(runs, column)
    if (!runs || !cell) return
    const link = this.paintOf(cell.style).link
    const span = (y: number, from: number, to: number) => {
      const pieces: LinkPiece[] = []
      let start = 0
      for (const run of this.lines[y]!) {
        const end = start + runCells(run)
        const paint = this.paintOf(run.style)
        const left = Math.max(start, from)
        const right = Math.min(end, to)
        if (left < right && (!link || paint.link === link)) {
          const last = pieces.at(-1)
          if (last && last.column + last.cells === left && last.ink === paint.ink)
            last.cells += right - left
          else pieces.push({ row: y, column: left, cells: right - left, ink: paint.ink })
        }
        start = end
      }
      return pieces
    }
    if (link) {
      const uri = this.links[link - 1]
      if (!uri) return
      // A hyperlink may wrap and change style: every cell that carries it is the link.
      const pieces = () => this.lines.flatMap((_, y) => span(y, 0, this.cols))
      return { uri, key: `link ${link}`, pieces }
    }
    const { text, columns } = rowText(runs)
    for (const found of detectLinks(text)) {
      const from = columns[found.start]!
      const to = columns[found.end]!
      if (column >= from && column < to)
        return {
          uri: found.uri,
          key: `text ${row} ${from} ${to} ${found.uri}`,
          pieces: () => span(row, from, to),
        }
    }
  }

  /** Underlines the link under the pointer, on every row it covers. */
  private showHover(repainted = false) {
    const { pointer, font } = this
    const link = pointer && this.linkAt(pointer.column, pointer.row)
    const key = link?.key ?? ''
    // The same link is redrawn only when the rows under it may have changed.
    if (key === this.hoverKey && !(repainted && key)) return
    this.hoverKey = key
    this.element.classList.toggle('tg-link', !!link)
    this.linkLayer.replaceChildren(
      ...(link && font ? link.pieces() : []).map((piece) => {
        const element = document.createElement('div')
        const left = columnEdge(piece.column, font!)
        const width = columnEdge(piece.column + piece.cells, font!) - left
        element.style.cssText = `left:${left / font!.units}px;top:${piece.row * font!.height}px;width:${width / font!.units}px;color:${piece.ink};`
        return element
      }),
    )
  }

  private readonly pointerMoved = (event: MouseEvent) => {
    const cell = this.cellAt(event.clientX, event.clientY)
    if (cell.column === this.pointer?.column && cell.row === this.pointer.row) return
    this.pointer = cell
    this.showHover()
  }

  private readonly pointerLeft = () => {
    this.pointer = undefined
    this.showHover()
  }

  private readonly clicked = (event: MouseEvent) => {
    if (!this.options.onLink) return
    const cell = this.cellAt(event.clientX, event.clientY)
    const link = this.linkAt(cell.column, cell.row)
    if (link) this.options.onLink(link.uri, event)
  }
}
