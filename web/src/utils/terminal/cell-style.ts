import {
  ATTR,
  DEFAULT_COLOUR,
  PALETTE_COLOUR,
  UNDERLINE_MASK,
  UNDERLINE_SHIFT,
  type CellStyle,
} from '../../../../shared/cell-wire'

/** Colours the grid itself does not carry. All are 0xRRGGBB. */
export interface CellTheme {
  /** The default colours, for a window that names none of its own. */
  foreground: number
  background: number
  cursor: number
  /** The character under a block cursor. */
  cursorAccent: number
  selectionBackground: number
  /** Selected text keeps its own colour without one. */
  selectionForeground?: number
  /** Replaces the first entries of the xterm 256-colour palette, normally the ANSI sixteen. */
  ansi?: readonly number[]
  /** Bold text in ANSI 0–7 takes the bright colour, as xterm.js draws it by default. */
  brightBold?: boolean
}

/** The xterm 256-colour palette. */
export const xtermPalette: readonly number[] = (() => {
  const colours = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ]
  const level = (step: number) => (step ? 55 + step * 40 : 0)
  for (let index = 0; index < 216; index++)
    colours.push(
      (level(Math.floor(index / 36)) << 16) |
        (level(Math.floor(index / 6) % 6) << 8) |
        level(index % 6),
    )
  for (let gray = 0; gray < 24; gray++) colours.push((8 + gray * 10) * 0x010101)
  return colours
})()

/** The theme's ANSI colours on xterm's palette. */
export function cellPalette(theme: CellTheme): readonly number[] {
  return theme.ansi?.length
    ? [...theme.ansi, ...xtermPalette.slice(theme.ansi.length)]
    : xtermPalette
}

export const cssColour = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

export const FOREGROUND = 'var(--tg-fg)'
export const BACKGROUND = 'var(--tg-bg)'
/** Bits of `CellPaint.face`: which of the four font faces a style uses. */
export const FACE_BOLD = 1
export const FACE_ITALIC = 2

/** One style as the painter draws it, worked out once per table entry. */
export interface CellPaint {
  /** The text colour. */
  ink: string
  /** The ink over the paper as one opaque colour, for glyphs drawn as backgrounds. */
  solid: string
  /** The background, or '' for the default one. */
  paper: string
  /** Attribute classes for the text's element. */
  className: string
  /** Inline colours for the text's element. */
  css: string
  face: number
  link: number
}

const UNDERLINES = ['', 'tg-u', 'tg-u tg-u2', 'tg-u tg-u3', 'tg-u tg-u4', 'tg-u tg-u5']

export function cellPaint(
  style: CellStyle,
  palette: readonly number[],
  theme: CellTheme,
): CellPaint {
  const { attrs } = style
  const bold = (attrs & ATTR.bold) !== 0
  const colour = (value: number, bright = false) => {
    if (value === DEFAULT_COLOUR) return ''
    if (value < PALETTE_COLOUR) return cssColour(value)
    const index = value & 255
    return cssColour(palette[bright && index < 8 ? index + 8 : index]!)
  }
  let fg = colour(style.fg, bold && theme.brightBold !== false)
  let bg = colour(style.bg)
  if (attrs & ATTR.inverse) [fg, bg] = [bg || BACKGROUND, fg || FOREGROUND]
  if (attrs & ATTR.selected) {
    bg = 'var(--tg-select)'
    if (theme.selectionForeground !== undefined) fg = 'var(--tg-select-fg)'
  }
  let solid = fg || FOREGROUND
  if (attrs & ATTR.dim) {
    solid = `color-mix(in srgb, ${solid} 50%, ${bg || BACKGROUND})`
    fg = `color-mix(in srgb, ${fg || FOREGROUND} 50%, transparent)`
  }
  if (attrs & ATTR.invisible) {
    fg = 'transparent'
    solid = bg || BACKGROUND
  }
  const underline = (attrs & UNDERLINE_MASK) >>> UNDERLINE_SHIFT
  const classes = [
    bold ? 'tg-b' : '',
    attrs & ATTR.italic ? 'tg-i' : '',
    UNDERLINES[underline] ?? 'tg-u',
    attrs & ATTR.strike ? 'tg-s' : '',
    attrs & ATTR.overline ? 'tg-o' : '',
    attrs & (ATTR.blink | ATTR.rapidBlink) ? 'tg-blink' : '',
  ]
  const line = underline ? colour(style.underline) : ''
  return {
    ink: fg || FOREGROUND,
    solid,
    paper: bg,
    className: classes.filter(Boolean).join(' '),
    css: (fg ? `color:${fg};` : '') + (line ? `text-decoration-color:${line};` : ''),
    face: (bold ? FACE_BOLD : 0) | (attrs & ATTR.italic ? FACE_ITALIC : 0),
    link: style.link,
  }
}
