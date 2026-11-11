import type { Terminal } from '@xterm/xterm'
import type { ContentFontSettings, TerminalCell } from '../../shared/settings.ts'
import { fontChain, quoteFamily } from './font-catalog'
import { createFontLoader } from './font-loading'
import { terminalBox } from './terminal-geometry'
import { t } from './i18n'

export { FONT_CATALOG } from './font-catalog'
export interface FontPresentation {
  family: string
  features: string
}

const fontUrls = import.meta.glob<string>('./assets/fonts/**/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
})
let loader: ReturnType<typeof createFontLoader> | undefined

export function buildFontPresentation(settings: ContentFontSettings): FontPresentation {
  return {
    // A newly ready fallback changes the actual family chain, which invalidates
    // xterm's cached glyph widths through its public fontFamily option.
    family:
      fontChain(settings)
        .filter((font) => !font.bundled || loader?.available(font))
        .map((font) => quoteFamily(font.family))
        .join(', ') || 'monospace',
    features: settings.ligatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0, "dlig" 0',
  }
}

/** Keep native styles consistent; optional families never delay the primary font. */
export async function ensureContentFont(
  settings: ContentFontSettings,
  fallbackReady?: () => void,
): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  loader ||= createFontLoader({
    fonts: document.fonts,
    url: (file) => fontUrls[`./assets/fonts/${file}`],
    timeoutError: () => new Error(t('common.fontTimeout')),
  })
  try {
    await loader.prepare(fontChain(settings), fallbackReady)
  } catch (error) {
    throw error instanceof Error ? error : new Error(t('common.fontLoadFailed'))
  }
}

/** Only an explicit shared-font edit records metrics; viewers never recalibrate
 * the shared terminal from their own platform's fallback or device scale. */
export async function measureTerminalCell(settings: ContentFontSettings): Promise<TerminalCell> {
  await ensureContentFont(settings)
  // A missing local family can fall through to a bundled one. Do not record a
  // temporary fallback while any configured bundled family is still loading.
  await Promise.all(
    fontChain(settings)
      .filter((font) => font.bundled)
      .map((font) => loader!.load(font)),
  )
  const { Terminal } = await import('@xterm/xterm')
  const host = document.createElement('div')
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    opacity: '0',
    pointerEvents: 'none',
  })
  document.body.append(host)
  const term = new Terminal({
    cols: 200,
    rows: 10,
    fontSize: 12,
    lineHeight: 1,
    fontFamily: buildFontPresentation(settings).family,
  })
  try {
    // open() synchronously measures with the renderer's own font metrics. Read
    // its CSS grid, not private xterm services or a separate canvas algorithm.
    term.open(host)
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) throw new Error(t('common.fontLoadFailed'))
    const box = terminalBox(screen)
    const cell = { width: box.contentWidth / term.cols, height: box.contentHeight / term.rows }
    if (
      !Number.isFinite(cell.width) ||
      !Number.isFinite(cell.height) ||
      cell.width <= 0 ||
      cell.height <= 0
    )
      throw new Error(t('common.fontLoadFailed'))
    return cell
  } finally {
    term.dispose()
    host.remove()
  }
}

// Documented programming sequences from Maple Mono and Cascadia Code. Grouping
// only makes their original OpenType shaping possible; it does not replace any
// input/output bytes. xterm still splits joins at cursor/selection boundaries.
const ligatures = [
  '{{!--',
  '<!---',
  '<!--',
  '--}}',
  '{{--',
  '<#--',
  '<!-->',
  '<!---->',
  '<====>',
  '<===>',
  '<==>',
  '<=>',
  '<---->',
  '<--->',
  '<-->',
  '<->',
  '<<<',
  '>>>',
  '<<=',
  '>>=',
  '<<-',
  '->>',
  '>->',
  '<-<',
  '<||',
  '||>',
  '<|||',
  '|||>',
  '===',
  '!==',
  '!===',
  '=!=',
  '=/=',
  '<=<',
  '>=>',
  '>=<',
  ':=:',
  '=:=',
  '=>',
  '->',
  '<-',
  '<=',
  '>=',
  '==',
  '!=',
  '/=',
  '~=',
  '=~',
  '!~',
  '<>',
  ':::',
  '::',
  '?:',
  ':?',
  ':?>',
  '?.',
  '.?',
  '..<',
  '..',
  '...',
  '</>',
  '</',
  '/>',
  '<:',
  ':>',
  ':<',
  '<:<',
  '>:>',
  '<*',
  '*>',
  '<*>',
  '<|>',
  '<|',
  '|>',
  '|->',
  '<-|',
  '<+',
  '+>',
  '<+>',
  '<~>',
  '<~',
  '~>',
  '||',
  '&&',
  '&&&',
  '??',
  '???',
  '!!',
  '++',
  '+++',
  ';;',
  ';;;',
  '//',
  '///',
  '/*',
  '/**',
  '*/',
  '--',
  '---',
  '__',
  '#_',
  '#__',
  '#_(',
  '#{',
  '#[',
  '#(',
  '#?',
  '#!',
  '#:',
  '#=',
  ']#',
  '{|',
  '|}',
  '[|',
  '|]',
  '\\\\',
  '\\"',
  "\\'",
  '\\.',
  '|=',
  '?=',
  '&=',
  '*=',
  '+*',
  '*+',
  '=*',
  '=:',
  ':=',
  'al',
  'cl',
  'el',
  'il',
  'tl',
  'ul',
  'xl',
  'ff',
  'tt',
  'all',
  'ell',
  'ill',
  'ull',
  'll',
]
  .filter((value) => !value.includes(' '))
  .sort((a, b) => b.length - a.length)
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
    const tag =
      /^\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|EROR|FATAL|TODO|FIXME|NOTE|HACK|MARK)\]/.exec(tail)
    const arrow = /^[<>|]?[-=~]{2,}[<>|]?/.exec(tail)
    const sequence = byFirst.get(text[index]!)?.find((value) => text.startsWith(value, index))
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
export function applyTerminalFontFeatures(
  term: Terminal,
  settings: ContentFontSettings,
): () => void {
  terminalFeatures.get(term)?.()
  const element = term.element
  if (!element) return () => {}
  element.style.fontFeatureSettings = buildFontPresentation(settings).features
  element.style.fontVariantLigatures = settings.ligatures ? 'normal' : 'none'
  const joiner = settings.ligatures
    ? term.registerCharacterJoiner(terminalLigatureRanges)
    : undefined
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
