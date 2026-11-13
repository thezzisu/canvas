/**
 * Cell geometry. The browser lays boxes out in 1/64ths of a layout pixel and paints them on whole
 * layout pixels; a layout pixel is a device pixel on a high-density screen and a CSS pixel under an
 * emulated ratio. Sizes that must add up are therefore counted in those units, never in CSS pixels.
 */

/** A cell in CSS pixels. */
export interface CellMetrics {
  width: number
  height: number
}

export interface CellGeometry extends CellMetrics {
  /** Letter-spacing that puts every glyph of the primary font on the cell grid. */
  spacing: number
  /** Layout units (1/64 layout pixel) per CSS pixel. */
  units: number
  /** A light box-drawing line, in layout pixels. */
  light: number
}

/**
 * The cell for a font whose glyphs advance by `advance` and whose face is `fontHeight` tall, in CSS
 * pixels, where `ratio` layout pixels make one CSS pixel.
 *
 * The height is a whole number of layout pixels, as xterm.js sizes its rows. Without ligatures the
 * width is rounded down to a layout unit and the difference becomes letter-spacing, so any number
 * of cells is an exact length, and never longer than the font's own: a grid sized from the advance
 * fits on every screen. Ligatures only form at zero letter-spacing: there the width stays the
 * font's own advance and boxes are placed on rounded edges instead.
 */
export function cellGeometry(font: {
  advance: number
  fontHeight: number
  size: number
  lineHeight: number
  ligatures: boolean
  ratio: number
}): CellGeometry {
  const { advance, ratio } = font
  const units = ratio * 64
  const width = font.ligatures ? advance : Math.floor(advance * units) / units
  return {
    width,
    height: Math.max(1, Math.floor(Math.ceil(font.fontHeight * ratio) * font.lineHeight)) / ratio,
    spacing: width - advance,
    units,
    light: Math.max(1, Math.round((font.size * ratio) / 12)),
  }
}

/** Where a column starts, in layout units: rounding each edge keeps the error from adding up. */
export const columnEdge = (column: number, geometry: Pick<CellGeometry, 'width' | 'units'>) =>
  Math.round(column * geometry.width * geometry.units)

/**
 * A length of whole layout units as CSS pixels. The fifth of a unit survives the browser's own
 * conversion whether it truncates or rounds, alone or added to another such length.
 */
export const unitsToCss = (count: number, units: number) => (count + 0.2) / units

/** The cell under a point, given the grid's box as drawn: exact under any scale. */
export function cellFromPoint(
  box: { left: number; top: number; width: number; height: number },
  grid: { cols: number; rows: number },
  x: number,
  y: number,
): { column: number; row: number } {
  const index = (offset: number, length: number, count: number) =>
    length > 0 ? Math.min(count - 1, Math.max(0, Math.floor((offset / length) * count))) : 0
  return {
    column: index(x - box.left, box.width, grid.cols),
    row: index(y - box.top, box.height, grid.rows),
  }
}
