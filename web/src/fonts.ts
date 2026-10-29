import type { Terminal } from '@xterm/xterm'
import type { ContentFontSettings } from '../../shared/settings.ts'
import './fonts.css'

export interface FontPresentation { family: string; features: string }

export interface ContentFontFace {
  url: string
  weight: string
  style: 'normal' | 'italic'
}
export interface ContentFontCatalogEntry {
  family: string
  label: string
  cssFamily: string
  /** Native half-width advance, divided by units per em. */
  latinAdvance: number
  faces: readonly ContentFontFace[]
}

function staticFaces(directory: string): ContentFontFace[] {
  return [
    { url: `/fonts/${directory}/regular.woff2`, weight: '400', style: 'normal' },
    { url: `/fonts/${directory}/bold.woff2`, weight: '700', style: 'normal' },
    { url: `/fonts/${directory}/italic.woff2`, weight: '400', style: 'italic' },
    { url: `/fonts/${directory}/bold-italic.woff2`, weight: '700', style: 'italic' },
  ]
}

/** Bundled and local fonts share one ordered list of family names. */
export const FONT_CATALOG: readonly ContentFontCatalogEntry[] = [
  {
    family: 'Maple Mono NF CN', label: 'Maple Mono NF CN',
    cssFamily: 'Canvas Maple Mono NF CN', latinAdvance: 600 / 1000, faces: staticFaces('maple'),
  },
  {
    family: 'Maple Mono Normal NF CN', label: 'Maple Mono Normal NF CN',
    cssFamily: 'Canvas Maple Mono Normal NF CN', latinAdvance: 600 / 1000, faces: staticFaces('maple-normal'),
  },
  {
    family: 'Cascadia Code PL', label: 'Cascadia Code PL',
    cssFamily: 'Canvas Cascadia Code PL', latinAdvance: 1200 / 2048,
    faces: [
      { url: '/fonts/cascadia/regular.woff2', weight: '200 700', style: 'normal' },
      { url: '/fonts/cascadia/italic.woff2', weight: '200 700', style: 'italic' },
    ],
  },
]
const catalog = new Map(FONT_CATALOG.map(font => [font.family.toLowerCase(), font]))
const genericFamilies = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'])

function quoteFamily(name: string): string {
  return genericFamilies.has(name.toLowerCase()) ? name.toLowerCase()
    : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f\x7f]/g, character => `\\${character.charCodeAt(0).toString(16)} `)}"`
}

interface ResolvedFont { family: string; bundled?: ContentFontCatalogEntry; sizeAdjust?: string }

function fontChain(settings: ContentFontSettings): ResolvedFont[] {
  const seen = new Set<string>()
  let primaryAdvance: number | undefined
  return settings.stack.flatMap((entry, index) => {
    const name = entry.family.trim()
    if (!name) return []
    const bundled = catalog.get(name.toLowerCase())
    if (index === 0) primaryAdvance = bundled?.latinAdvance
    // A common, data-driven metric adaptation applies to every bundled fallback.
    // An unknown system family keeps native metrics; its advance is not guessed.
    const scale = bundled && primaryAdvance ? primaryAdvance / bundled.latinAdvance : 1
    const family = bundled ? bundled.cssFamily + (scale !== 1 ? ` @${scale.toFixed(8)}` : '') : name
    const identity = family.toLowerCase()
    if (seen.has(identity)) return []
    seen.add(identity)
    return [{ family, bundled, ...(scale !== 1 ? { sizeAdjust: `${scale * 100}%` } : {}) }]
  })
}

export function buildFontPresentation(settings: ContentFontSettings): FontPresentation {
  return {
    family: fontChain(settings).map(font => quoteFamily(font.family)).join(', '),
    features: settings.ligatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0, "dlig" 0',
  }
}

const loaded = new Map<string, Promise<void>>()
const attempts = new Map<string, number>()

function loadFamily(font: ResolvedFont): Promise<void> {
  const existing = loaded.get(font.family)
  if (existing) return existing
  const attempt = attempts.get(font.family) || 0
  attempts.set(font.family, attempt + 1)
  const load = async () => {
    // Load all native styles before applying the family. Otherwise the first
    // bold/italic terminal output can change fallback metrics after a resize.
    // A new FontFace on retry avoids reusing a permanently rejected load promise.
    return Promise.all(font.bundled!.faces.map(source => {
      const url = source.url + (attempt ? `?retry=${attempt}` : '')
      const face = new FontFace(font.family, `url("${url}") format("woff2")`, {
        style: source.style, weight: source.weight,
        ...(font.sizeAdjust ? { sizeAdjust: font.sizeAdjust } : {}),
      })
      return face.load()
    }))
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const request = Promise.race([load(), new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('字体加载超时，请重试')), 45_000)
  })]).then(faces => {
    for (const face of faces) document.fonts.add(face)
  }).catch(error => {
    if (loaded.get(font.family) === request) loaded.delete(font.family)
    throw error instanceof Error ? error : new Error('字体加载失败，请重试')
  }).finally(() => clearTimeout(timeout))
  loaded.set(font.family, request)
  return request
}

/** Load only bundled families in the effective chain; no external font CDN. */
export async function ensureContentFont(settings: ContentFontSettings): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(fontChain(settings).filter(font => font.bundled).map(font => loadFamily(font)))
}

// Documented programming sequences from Maple Mono and Cascadia Code. Grouping
// only makes their original OpenType shaping possible; it does not replace any
// input/output bytes. xterm still splits joins at cursor/selection boundaries.
const ligatures = [
  '{{!--', '<!---', '<!--', '--}}', '{{--', '<#--', '<!-->', '<!---->',
  '<====>', '<===>', '<==>', '<=>', '<---->', '<--->', '<-->', '<->',
  '<<<', '>>>', '<<=', '>>=', '<<-', '->>', '>->', '<-<', '<||', '||>', '<|||', '|||>',
  '===', '!==', '!===', '=!=', '=/=', '<=<', '>=>', '>=<', ':=:', '=:=',
  '=>', '->', '<-', '<=', '>=', '==', '!=', '/=', '~=', '=~', '!~', '<>',
  ':::', '::', '?:', ':?', ':?>', '?.', '.?', '..<', '..', '...',
  '</>', '</', '/>', '<:', ':>', ':<', '<:<', '>:>', '<*', '*>', '<*>',
  '<|>', '<|', '|>', '|->', '<-|', '<+', '+>', '<+>', '<~>', '<~', '~>',
  '||', '&&', '&&&', '??', '???', '!!', '++', '+++', ';;', ';;;',
  '//', '///', '/*', '/**', '*/', '--', '---', '__', '#_', '#__', '#_(',
  '#{', '#[', '#(', '#?', '#!', '#:', '#=', ']#', '{|', '|}', '[|', '|]',
  '\\\\', '\\"', "\\'", '\\.', '|=', '?=', '&=', '*=', '+*', '*+', '=*', '=:', ':=',
  'al', 'cl', 'el', 'il', 'tl', 'ul', 'xl', 'ff', 'tt', 'all', 'ell', 'ill', 'ull', 'll',
].filter(value => !value.includes(' ')).sort((a, b) => b.length - a.length)
const byFirst = new Map<string, string[]>()
for (const value of ligatures) {
  const matches = byFirst.get(value[0]!) || []
  matches.push(value)
  byFirst.set(value[0]!, matches)
}

export function terminalLigatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  for (let index = 0; index < text.length; index++) {
    const tail = text.slice(index, index + 128)
    const tag = /^\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|EROR|FATAL|TODO|FIXME|NOTE|HACK|MARK)\]/.exec(tail)
    const arrow = /^[<>|]?[-=~]{2,}[<>|]?/.exec(tail)
    const sequence = byFirst.get(text[index]!)?.find(value => text.startsWith(value, index))
    const length = Math.max(tag?.[0].length || 0, arrow?.[0].length || 0, sequence?.length || 0)
    if (length > 1) {
      ranges.push([index, index + length])
      index += length - 1
    }
  }
  return ranges
}

const terminalFeatures = new WeakMap<Terminal, () => void>()

/** Call after term.open(); the public character-joiner API needs allowProposedApi. */
export function applyTerminalFontFeatures(term: Terminal, settings: ContentFontSettings): () => void {
  terminalFeatures.get(term)?.()
  const element = term.element
  if (!element) return () => {}
  element.style.fontFeatureSettings = buildFontPresentation(settings).features
  element.style.fontVariantLigatures = settings.ligatures ? 'normal' : 'none'
  const joiner = settings.ligatures ? term.registerCharacterJoiner(terminalLigatureRanges) : undefined
  let active = true
  const cleanup = () => {
    if (!active) return
    active = false
    if (joiner !== undefined) term.deregisterCharacterJoiner(joiner)
    if (terminalFeatures.get(term) === cleanup) terminalFeatures.delete(term)
  }
  terminalFeatures.set(term, cleanup)
  term.refresh(0, term.rows - 1)
  return cleanup
}
