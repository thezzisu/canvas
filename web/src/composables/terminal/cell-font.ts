import { createGlyphs, type Glyphs } from '../../utils/terminal/cell-glyphs'
import { cellGeometry, type CellGeometry } from '../../utils/terminal/cell-metrics'
import type { RowFont } from '../../utils/terminal/cell-rows'
import { FACE_BOLD, FACE_ITALIC } from '../../utils/terminal/cell-style'

export interface CellFontOptions {
  /** A CSS font-family list. Its fonts must have loaded. */
  family: string
  /** In CSS pixels. */
  size: number
  /** A multiple of the font's own height. */
  lineHeight: number
  ligatures: boolean
}

/** Everything measured for one font at one layout ratio; painters share it. */
export interface CellFont extends CellGeometry, RowFont {
  options: CellFontOptions
  /** Layout pixels per CSS pixel. */
  ratio: number
  glyphs: Glyphs
}

const fonts = new Map<string, CellFont>()
// Characters of different shapes: a face in which they advance alike is monospace.
const SAMPLE = 'iW@. '

/**
 * Layout pixels per CSS pixel where `parent` is: the device pixel ratio times any CSS zoom, or 1
 * under an emulated ratio. The browser widens a hairline border to one layout pixel and reports it
 * in CSS pixels.
 */
export function layoutRatio(parent: HTMLElement): number {
  const probe = document.createElement('i')
  probe.style.cssText = 'position:absolute;visibility:hidden;border-top:0.01px solid'
  parent.append(probe)
  const hairline = parseFloat(getComputedStyle(probe).borderTopWidth)
  probe.remove()
  return hairline > 0 ? Math.round(1000 / hairline) / 1000 : window.devicePixelRatio || 1
}

/**
 * Measures a font once. The cell width is layout's own advance, read from a probe beside a box of
 * known width so that any scale on the page cancels out. Other glyphs are measured on a canvas,
 * which costs no layout, and scaled by how the two disagree about the primary font.
 */
export function measureCellFont(options: CellFontOptions, ratio: number): CellFont {
  const key = JSON.stringify([options, ratio])
  const known = fonts.get(key)
  if (known) return known
  const context = new OffscreenCanvas(1, 1).getContext('2d')!
  const measure = (text: string, face: number) => {
    context.font = `${face & FACE_ITALIC ? 'italic ' : ''}${face & FACE_BOLD ? 'bold ' : ''}${options.size}px ${options.family}`
    return context.measureText(text)
  }
  const box = measure('W', 0)

  const probe = document.createElement('div')
  probe.style.cssText =
    `position:absolute;visibility:hidden;white-space:pre;font:${options.size}px ${options.family};` +
    'font-kerning:none;font-variant-ligatures:none;letter-spacing:0'
  const ruler = probe.appendChild(document.createElement('div'))
  const text = probe.appendChild(document.createElement('span'))
  ruler.style.width = '1000px'
  text.textContent = 'W'.repeat(200)
  document.body.append(probe)
  const laidOut = (text.getBoundingClientRect().width / ruler.getBoundingClientRect().width) * 5
  probe.remove()

  // Layout counts in 64ths of a pixel, so 200 glyphs give the advance to the thousandth, and
  // every screen then names the same number for the same font.
  const advance = Math.round((laidOut > 0 ? laidOut : box.width) * 1000) / 1000
  const scale = box.width > 0 ? advance / box.width : 1
  const geometry = cellGeometry({
    advance,
    fontHeight: box.fontBoundingBoxAscent + box.fontBoundingBoxDescent,
    size: options.size,
    lineHeight: options.lineHeight,
    ligatures: options.ligatures,
    ratio,
  })
  const advances = new Map<string, number>()
  const font: CellFont = {
    ...geometry,
    options,
    ratio,
    exact: [0, 1, 2, 3].map(
      (face) => Math.abs(measure(SAMPLE, face).width - SAMPLE.length * box.width) < 0.01,
    ),
    glyphs: createGlyphs({
      width: geometry.width * ratio,
      height: Math.round(geometry.height * ratio),
      light: geometry.light,
      ratio,
    }),
    advance(cluster, face) {
      const id = face + cluster
      let width = advances.get(id)
      if (width === undefined) advances.set(id, (width = measure(cluster, face).width * scale))
      return width
    },
  }
  fonts.set(key, font)
  return font
}
