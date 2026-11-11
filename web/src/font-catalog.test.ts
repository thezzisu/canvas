import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FONT_CATALOG, contentFontCss, fontChain } from './font-catalog.ts'

test('all known fallback combinations use exact half-width advances; local fonts retain their own metrics', () => {
  for (const primary of FONT_CATALOG) {
    const resolved = fontChain({
      stack: [primary, ...FONT_CATALOG, { family: 'monospace' }],
      ligatures: false,
    })
    assert.equal(resolved.length, 4)
    assert.equal(resolved[0]!.family, primary.cssFamily)
    const css = contentFontCss((file) => `/src/assets/fonts/${file}`)
    for (const font of resolved.filter((font) => font.bundled)) {
      const scale = font.sizeAdjust ? Number.parseFloat(font.sizeAdjust) / 100 : 1
      assert(Math.abs(font.bundled!.latinAdvance * scale - primary.latinAdvance) < 1e-12)
      assert(css.includes(`font-family:${JSON.stringify(font.family)};`))
    }
  }
  const local = fontChain({ stack: [{ family: 'Local Font' }, ...FONT_CATALOG], ligatures: false })
  assert(local.every((font) => font.sizeAdjust === undefined))
  assert.equal(local[0]!.family, 'Local Font')
})

test('CSS loads only bundled font files, never external or locally substituted fonts', () => {
  const css = contentFontCss((file) => `/src/assets/fonts/${file}`)
  assert(!css.includes('local(') && !css.includes('https:'))
  const sources = new Set([...css.matchAll(/src:url\("([^"]+)"\)/g)].map((match) => match[1]))
  assert.deepEqual(
    sources,
    new Set(
      FONT_CATALOG.flatMap((font) => font.faces.map((face) => `/src/assets/fonts/${face.file}`)),
    ),
  )
})
