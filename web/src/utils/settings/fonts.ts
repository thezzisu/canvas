import type { ContentFontSettings, TerminalCell } from '../../../../shared/settings.ts'
import { fontChain, quoteFamily } from './font-catalog'
import { createFontLoader } from './font-loading'
import { measureCellFont } from '../../composables/terminal/cell-font'
import { t } from '../../plugins/i18n'

export { FONT_CATALOG } from './font-catalog'
export interface FontPresentation {
  family: string
  features: string
}

const fontUrls = import.meta.glob<string>('../../assets/fonts/**/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
})
let loader: ReturnType<typeof createFontLoader> | undefined

export function buildFontPresentation(settings: ContentFontSettings): FontPresentation {
  return {
    // A newly ready fallback changes the actual family chain, and with it the terminal's cell.
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
    url: (file) => fontUrls[`../../assets/fonts/${file}`],
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
  const font = measureCellFont(
    {
      family: buildFontPresentation(settings).family,
      size: 12,
      lineHeight: 1,
      ligatures: settings.ligatures,
    },
    window.devicePixelRatio || 1,
  )
  if (!(font.width > 0 && font.height > 0)) throw new Error(t('common.fontLoadFailed'))
  // The font's own advance: how a screen rounds its cells is not shared.
  return { width: +(font.width - font.spacing).toFixed(3), height: font.height }
}
