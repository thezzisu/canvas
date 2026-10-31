import type { ContentFontSettings } from '../../shared/settings.ts'

export interface ContentFontFace {
  file: string
  weight: string
  style: 'normal' | 'italic'
}
export interface ContentFontCatalogEntry {
  family: string
  cssFamily: string
  /** Native half-width advance divided by units per em, not average glyph width. */
  latinAdvance: number
  faces: readonly ContentFontFace[]
}

function staticFaces(directory: string): ContentFontFace[] {
  return [
    { file: `${directory}/regular.woff2`, weight: '400', style: 'normal' },
    { file: `${directory}/bold.woff2`, weight: '700', style: 'normal' },
    { file: `${directory}/italic.woff2`, weight: '400', style: 'italic' },
    { file: `${directory}/bold-italic.woff2`, weight: '700', style: 'italic' },
  ]
}

/** One catalog supplies the font picker, asset declarations and terminal metrics. */
export const FONT_CATALOG: readonly ContentFontCatalogEntry[] = [
  {
    family: 'Maple Mono NF CN', cssFamily: 'Canvas Maple Mono NF CN',
    latinAdvance: 600 / 1000, faces: staticFaces('maple'),
  },
  {
    family: 'Maple Mono Normal NF CN', cssFamily: 'Canvas Maple Mono Normal NF CN',
    latinAdvance: 600 / 1000, faces: staticFaces('maple-normal'),
  },
  {
    family: 'Cascadia Code PL', cssFamily: 'Canvas Cascadia Code PL', latinAdvance: 1200 / 2048,
    faces: [
      { file: 'cascadia/regular.woff2', weight: '200 700', style: 'normal' },
      { file: 'cascadia/italic.woff2', weight: '200 700', style: 'italic' },
    ],
  },
]
const catalog = new Map(FONT_CATALOG.map(font => [font.family.toLowerCase(), font]))
const genericFamilies = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'])

export function quoteFamily(name: string): string {
  return genericFamilies.has(name.toLowerCase()) ? name.toLowerCase()
    : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f\x7f]/g, character => `\\${character.charCodeAt(0).toString(16)} `)}"`
}

export interface ResolvedFont { family: string; bundled?: ContentFontCatalogEntry; sizeAdjust?: string }

function resolveFont(bundled: ContentFontCatalogEntry, primaryAdvance?: number): ResolvedFont {
  const scale = primaryAdvance ? primaryAdvance / bundled.latinAdvance : 1
  return {
    family: bundled.cssFamily + (scale !== 1 ? ` @${scale.toFixed(8)}` : ''), bundled,
    ...(scale !== 1 ? { sizeAdjust: `${scale * 100}%` } : {}),
  }
}

export function fontChain(settings: ContentFontSettings): ResolvedFont[] {
  const seen = new Set<string>()
  const primaryAdvance = catalog.get(settings.stack[0]?.family.trim().toLowerCase() || '')?.latinAdvance
  return settings.stack.flatMap(entry => {
    const name = entry.family.trim()
    const bundled = catalog.get(name.toLowerCase())
    // Unknown local fonts retain native metrics; their advance is not guessed.
    const font = bundled ? resolveFont(bundled, primaryAdvance) : { family: name }
    const identity = font.family.toLowerCase()
    if (!name || seen.has(identity)) return []
    seen.add(identity)
    return [font]
  })
}

/** Declarations are passive: neither unused families nor aliases are preloaded. */
export function contentFontCss(assetUrl: (file: string) => string): string {
  const advances = [...new Set(FONT_CATALOG.map(font => font.latinAdvance))]
  return FONT_CATALOG.flatMap(font => advances.flatMap(advance => {
    const resolved = resolveFont(font, advance)
    return font.faces.map(face => `@font-face{font-family:${quoteFamily(resolved.family)};src:url(${JSON.stringify(assetUrl(face.file))}) format("woff2");font-weight:${face.weight};font-style:${face.style};font-display:swap;${resolved.sizeAdjust ? `size-adjust:${resolved.sizeAdjust};` : ''}}`)
  })).join('\n')
}
