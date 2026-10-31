import type { ContentFontFace, ResolvedFont } from './font-catalog.ts'

interface FontLoaderOptions {
  fonts: FontFaceSet
  url: (file: string) => string
  createFace?: (family: string, source: string, descriptors: FontFaceDescriptors) => FontFace
  timeout?: number
  timeoutError: () => Error
}

/** Reuse each successful or pending face, including across interrupted settings previews. */
export function createFontLoader(options: FontLoaderOptions) {
  const requests = new Map<string, Promise<FontFace>>()
  const ready = new Set<string>()
  const createFace = options.createFace || ((family, source, descriptors) => new FontFace(family, source, descriptors))

  function loadFace(font: ResolvedFont, source: ContentFontFace): Promise<FontFace> {
    const key = `${font.family}/${source.style}/${source.weight}`
    const existing = requests.get(key)
    if (existing) return existing
    // A rejected FontFace cannot be retried. Replace only that face, retaining
    // its immutable URL so successful HTTP/cache entries are never discarded.
    // CSS declarations can share a failed source across otherwise unloaded
    // aliases. An independent face also makes same-URL recovery reliable.
    const face = createFace(font.family, `url(${JSON.stringify(options.url(source.file))}) format("woff2")`, {
      style: source.style, weight: source.weight, ...(font.sizeAdjust ? { sizeAdjust: font.sizeAdjust } : {}),
    })
    const request = face.load().then(loaded => {
      options.fonts.add(loaded)
      return loaded
    }).catch(error => {
      if (requests.get(key) === request) requests.delete(key)
      throw error
    })
    requests.set(key, request)
    return request
  }

  async function load(font: ResolvedFont): Promise<void> {
    if (!font.bundled || ready.has(font.family)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(font.bundled.faces.map(face => loadFace(font, face))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(options.timeoutError()), options.timeout ?? 45_000) }),
      ])
      ready.add(font.family)
    } finally { clearTimeout(timer) }
    // A UI timeout does not cancel FontFace.load(). Keep pending requests so a
    // retry joins the same download instead of starting another large transfer.
  }

  async function prepare(chain: ResolvedFont[], fallbackReady?: () => void): Promise<void> {
    const [primary, ...fallbacks] = chain
    if (primary?.bundled) await load(primary)
    for (const font of fallbacks) {
      if (!font.bundled || ready.has(font.family)) continue
      void load(font).then(fallbackReady, () => { /* Retry optional families on the next application. */ })
    }
  }

  return { load, prepare, available: (font: ResolvedFont) => !font.bundled || ready.has(font.family) }
}
