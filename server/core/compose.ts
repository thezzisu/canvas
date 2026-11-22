// What a Core window shows: its panes' screens, dividers and scrollbars composed into one grid,
// and what can be read back from that grid.
import type { GhosttyTerminal } from '../ghostty/terminal.ts'
import { cellWidth } from '../ghostty/module.ts'
import type { NativeContentPane } from '../herdr/content.ts'
import { windowContent } from '../herdr/content.ts'
import { thumb } from '../herdr/input.ts'
import { SELECTED, type ScreenSelection } from '../herdr/screen.ts'
import type {
  CellData,
  ClientShellSnapshot,
  FrameData,
  PaneSurfaceFrame,
  PaneSurfacePane,
  PaneSurfaceSplit,
} from '../herdr/wire.ts'
import { CORE_CELL } from './input.ts'
import type { CoreTerminal, projectTab } from './layout.ts'

const cell = (symbol: string): CellData => ({
  symbol,
  fg: 0,
  bg: 0,
  modifier: 0,
  skip: false,
  hyperlink: null,
})
const BLANK = Object.freeze(cell(' '))
/**
 * A pane's scrollbar is herdr's: the pane keeps its last column for it, except in a narrow pane or
 * on the alternate screen, and it is drawn there while there is history to scroll.
 */
export const paneColumns = (width: number, alternate: boolean) =>
  width > 4 && !alternate ? width - 1 : width
const SCROLLBAR = {
  focused: { track: 0x2000000 | 0x6c7086, thumb: 0x2000000 | 0x7f849c, symbol: '▐' },
  unfocused: { track: 0x2000000 | 0x1e1e2e, thumb: 0x2000000 | 0x6c7086, symbol: '▕' },
}
/** OSC 8 permits Unicode and spaces; emit a valid URI without losing the target. */
export function coreHyperlink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/u.test(value))
    return
  try {
    const uri = new URL(value).href
    return uri.length <= 24576 ? uri : undefined
  } catch {
    return
  }
}
/** Dividers keep their original resize axis, but only exposed cells accept hits. */
function visibleSplits(
  split: PaneSurfaceSplit,
  owners: Int32Array,
  cols: number,
): PaneSurfaceSplit[] {
  const rect = split.hit_rect,
    vertical = rect.width === 1,
    length = vertical ? rect.height : rect.width
  const result: PaneSurfaceSplit[] = []
  let start = -1
  for (let offset = 0; offset <= length; offset++) {
    const visible =
      offset < length &&
      owners[(rect.y + (vertical ? offset : 0)) * cols + rect.x + (vertical ? 0 : offset)] === 0
    if (visible && start < 0) start = offset
    if (!visible && start >= 0) {
      result.push({
        ...split,
        hit_rect: vertical
          ? { ...rect, y: rect.y + start, height: offset - start }
          : { ...rect, x: rect.x + start, width: offset - start },
      })
      start = -1
    }
  }
  return result
}

export interface Composition {
  frame: FrameData
  /** Topmost first, as native input and context hit tests visit them. */
  panes: PaneSurfacePane[]
  splits: PaneSurfaceSplit[]
  /** For each cell, 1 + the index in `layers` of the pane that shows it; 0 for none. */
  owners: Int32Array
  /** Pane ids in paint order, bottom first. */
  layers: string[]
}
interface ComposedPane {
  engine: GhosttyTerminal
  revision: number
}

/** Paints a projected tab: each pane at its place, later ones over earlier ones. */
export function composeWindow(
  projection: ReturnType<typeof projectTab>,
  attached: ReadonlyMap<string, ComposedPane>,
  terminals: readonly CoreTerminal[],
  focusedId: string | undefined,
  cols: number,
  rows: number,
): Composition {
  const frame: FrameData = {
    cells: new Array<CellData>(cols * rows).fill(BLANK),
    width: cols,
    height: rows,
    cursor: null,
    hyperlinks: [],
    graphics: Buffer.alloc(0),
  }
  const panes: PaneSurfacePane[] = [],
    owners = new Int32Array(frame.cells.length),
    layers = projection.panes.map((pane) => pane.id)
  const backgrounds = new Set<number | undefined>()
  for (const split of projection.splits) {
    const area = split.hit_rect
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++)
        frame.cells[y * cols + x] = cell(split.direction === 'Horizontal' ? '│' : '─')
  }
  for (const [index, projected] of projection.panes.entries()) {
    const rect = projected.rect,
      pane = attached.get(projected.id),
      terminal = terminals.find((terminal) => terminal.address === projected.terminal)
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) owners[y * cols + x] = index + 1
    if (!pane) {
      const message = projected.unsupported
        ? `[${projected.unsupported}]`
        : '[Terminal unavailable]'
      for (let y = rect.y; y < rect.y + rect.height; y++)
        for (let x = rect.x; x < rect.x + rect.width; x++) frame.cells[y * cols + x] = BLANK
      for (let x = 0; x < Math.min(rect.width, message.length); x++)
        frame.cells[rect.y * cols + rect.x + x] = cell(message[x]!)
      panes.push({
        pane_id: projected.id,
        content_revision: 0,
        rect,
        inner_rect: rect,
        scrollbar_rect: null,
        scroll: null,
        focused: false,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
      })
      continue
    }
    const engine = pane.engine,
      lines = engine.read(),
      cursor = engine.cursor(),
      alternate = engine.alternateScreen,
      focused = projected.id === focusedId
    // Where the program wrote nothing, the pane shows the background it set.
    const background = engine.background,
      empty = background === undefined ? BLANK : { ...BLANK, bg: 0x2000000 | background }
    backgrounds.add(background)
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) frame.cells[y * cols + x] = empty
    // A terminal that kept a wider grid than it was asked for shows it whole, without the bar.
    const inner = {
      ...rect,
      width: Math.min(rect.width, Math.max(paneColumns(rect.width, alternate), engine.cols)),
    }
    const scroll = alternate
      ? null
      : {
          offset_from_bottom: engine.scroll.max - engine.scroll.top,
          max_offset_from_bottom: engine.scroll.max,
          viewport_rows: engine.rows,
        }
    const track =
      scroll?.max_offset_from_bottom && inner.width < rect.width
        ? { ...rect, x: rect.x + inner.width, width: 1 }
        : null
    const linkIndexes = new Map<string, number>()
    for (let y = 0; y < inner.height; y++) {
      const line = lines[y]
      for (let x = 0; x < inner.width; x++) {
        let rendered = line?.cells[x] ?? empty
        const uri = coreHyperlink(line?.links?.get(x))
        if (uri) {
          let link = linkIndexes.get(uri)
          if (link === undefined) {
            link = frame.hyperlinks.push(uri) - 1
            linkIndexes.set(uri, link)
          }
          rendered = { ...rendered, hyperlink: link }
        }
        frame.cells[(rect.y + y) * cols + rect.x + x] = rendered
      }
    }
    const bar = thumb({ scrollbar_rect: track, scroll })
    if (track && bar) {
      const look = focused ? SCROLLBAR.focused : SCROLLBAR.unfocused
      for (let y = track.y; y < track.y + track.height; y++) {
        const held = y >= bar.top && y < bar.top + bar.length
        frame.cells[y * cols + track.x] = {
          ...cell(held ? look.symbol : '▕'),
          fg: held ? look.thumb : look.track,
          bg: empty.bg,
        }
      }
    }
    panes.push({
      pane_id: projected.id,
      content_revision: pane.revision,
      rect,
      inner_rect: inner,
      scrollbar_rect: track,
      scroll,
      focused,
      mouse_reporting: engine.mouseReporting,
      sgr_pixel_mouse: engine.mode(1016),
      alternate_screen_active: alternate,
      pixel_width: inner.width * CORE_CELL.width,
      pixel_height: inner.height * CORE_CELL.height,
    })
    // The engine has no cursor to show while its viewport is scrolled away from it.
    if (focused && cursor && cursor.x < inner.width && cursor.y < inner.height)
      frame.cursor = {
        x: rect.x + cursor.x,
        y: rect.y + cursor.y,
        visible: cursor.visible && terminal?.state === 'live',
        shape: cursor.shape,
      }
  }
  // A wide glyph is indivisible. Do not let a covered lead/continuation
  // make the renderer skip a different pane's first visible cell.
  for (let y = 0; y < rows; y++) {
    let continuation = 0,
      owner = 0
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x,
        cell = frame.cells[index]!
      if (cell.skip) {
        if (continuation && owners[index] === owner) continuation--
        else {
          frame.cells[index] = BLANK
          continuation = 0
        }
        continue
      }
      const width = cellWidth(cell.symbol)
      owner = owners[index]!
      continuation = Math.max(0, width - 1)
      if (x + width > cols || (width > 1 && owners[index + width - 1] !== owner)) {
        frame.cells[index] = BLANK
        continuation = 0
      }
    }
  }
  if (
    frame.cursor &&
    owners[frame.cursor.y * cols + frame.cursor.x] !== layers.indexOf(focusedId || '') + 1
  )
    frame.cursor = null
  // The margins around the grid take the background every pane agrees on.
  const [background] = backgrounds
  if (backgrounds.size === 1 && background !== undefined) frame.background = background
  panes.reverse()
  const splits = projection.splits.flatMap((split) => visibleSplits(split, owners, cols))
  return { frame, panes, splits, owners, layers }
}

/** The grid with the Canvas selection marked on the cells its pane shows. */
export function markSelection(composition: Composition, selection: ScreenSelection): FrameData {
  const { frame, owners, layers } = composition,
    selected = composition.panes.find((pane) => pane.pane_id === selection.pane_id)
  if (!selected) return frame
  const rect = selected.inner_rect,
    owner = layers.indexOf(selected.pane_id) + 1,
    cells = frame.cells.slice()
  const at = (point: { row: number; col: number }) =>
    Math.max(0, Math.min(rect.height - 1, point.row)) * rect.width +
    Math.max(0, Math.min(rect.width - 1, point.col))
  const start = Math.min(at(selection.anchor), at(selection.cursor)),
    end = Math.max(at(selection.anchor), at(selection.cursor))
  for (let offset = start; offset <= end; offset++) {
    const index =
      (rect.y + Math.floor(offset / rect.width)) * frame.width + rect.x + (offset % rect.width)
    if (owners[index] === owner)
      cells[index] = { ...cells[index]!, modifier: cells[index]!.modifier | SELECTED }
  }
  return { ...frame, cells }
}

/**
 * The text between two points of a pane's history, with soft wraps joined. Cells another pane
 * covers in the composition read as spaces, so nothing is copied through an overlay.
 */
export function selectionText(
  engine: GhosttyTerminal,
  paneId: string,
  anchor: unknown,
  cursor: unknown,
  composition: Composition | undefined,
): string {
  const cols = engine.cols,
    scroll = engine.scroll
  const point = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('row' in value) ||
      !('col' in value) ||
      !Number.isSafeInteger(value.row) ||
      !Number.isSafeInteger(value.col)
    )
      throw new Error('Invalid selection coordinates')
    return {
      row: Math.max(0, Math.min(scroll.max + engine.rows - 1, Number(value.row))),
      col: Math.max(0, Math.min(cols - 1, Number(value.col))),
    }
  }
  let start = point(anchor),
    end = point(cursor)
  if (start.row > end.row || (start.row === end.row && start.col > end.col))
    [start, end] = [end, start]
  if ((end.row - start.row + 1) * cols > 1_000_000) throw new Error('Selection is too large')
  const rect = composition?.panes.find((item) => item.pane_id === paneId)?.inner_rect
  const top = scroll.top,
    owner = (composition?.layers.indexOf(paneId) ?? -1) + 1
  const lines: string[] = []
  for (let row = start.row; row <= end.row; row++) {
    const line = engine.line(row)
    let part = ''
    for (
      let col = row === start.row ? start.col : 0;
      col <= (row === end.row ? end.col : cols - 1);
      col++
    ) {
      const cell = line?.cells[col],
        width = cell?.width ?? 1
      if (width === 0) continue
      let covered = false
      if (composition && rect && row >= top && row < top + rect.height)
        for (let offset = 0; offset < width; offset++) {
          if (
            col + offset >= rect.width ||
            composition.owners[
              (rect.y + row - top) * composition.frame.width + rect.x + col + offset
            ] !== owner
          ) {
            covered = true
            break
          }
        }
      part += covered || cell?.invisible ? ' '.repeat(width) : (cell?.text ?? ' ')
    }
    if (row === start.row || !line?.wrapped) lines.push(part)
    else lines[lines.length - 1] += part
  }
  return lines.map((line) => line.replace(/ +$/u, '')).join('\n')
}

/** What each visible pane shows, as text with its links, top pane first. */
export function composedContent(
  composition: Composition,
  surface: PaneSurfaceFrame,
  shell: ClientShellSnapshot,
  tabId: string,
  engineOf: (paneId: string) => GhosttyTerminal | undefined,
): NativeContentPane[] {
  const { owners, layers } = composition
  return surface.panes.toReversed().flatMap((pane) => {
    const owner = layers.indexOf(pane.pane_id) + 1,
      rect = pane.inner_rect
    const engine = engineOf(pane.pane_id)
    if (!engine || !owners.includes(owner)) return []
    const cells = Array.from({ length: rect.width * rect.height }, (_, index) => {
      const at =
        (rect.y + Math.floor(index / rect.width)) * surface.frame.width +
        rect.x +
        (index % rect.width)
      return owners[at] === owner ? surface.frame.cells[at]! : BLANK
    })
    const local = { x: 0, y: 0, width: rect.width, height: rect.height }
    const rows = engine.read()
    const visible = Array.from({ length: rect.height }, (_, row) => {
      for (let col = 0; col < rect.width; col++)
        if (owners[(rect.y + row) * surface.frame.width + rect.x + col] !== owner) return false
      return true
    })
    return windowContent(
      {
        ...surface,
        frame: { ...surface.frame, width: rect.width, height: rect.height, cells, cursor: null },
        panes: [{ ...pane, rect: local, inner_rect: local }],
        splits: [],
      },
      shell,
      tabId,
      (_id, row) =>
        engine.cols === rect.width && visible[row - 1] && visible[row] && !!rows[row]?.wrapped,
    )
  })
}
