import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { FONT_CATALOG, contentFontCss, fontChain } from './font-catalog.ts'
import manifest from './assets/fonts/manifest.json' with { type: 'json' }

test('bundled assets retain every upstream glyph, native style and verified byte', async () => {
  const files = FONT_CATALOG.flatMap(font => font.faces.map(face => face.file)).sort()
  assert.deepEqual(files, manifest.files.map(face => face.file).sort())
  await Promise.all(manifest.files.map(async face => {
    const bytes = await readFile(new URL(`./assets/fonts/${face.file}`, import.meta.url))
    assert.equal(bytes.byteLength, face.bytes, face.file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), face.sha256, face.file)
  }))
})

test('all known fallback combinations use exact half-width advances; local fonts retain their own metrics', () => {
  for (const primary of FONT_CATALOG) {
    const resolved = fontChain({ stack: [primary, ...FONT_CATALOG, { family: 'monospace' }], ligatures: false })
    assert.equal(resolved.length, 4)
    assert.equal(resolved[0]!.family, primary.cssFamily)
    const css = contentFontCss(file => `/src/assets/fonts/${file}`)
    for (const font of resolved.filter(font => font.bundled)) {
      const scale = font.sizeAdjust ? Number.parseFloat(font.sizeAdjust) / 100 : 1
      assert(Math.abs(font.bundled!.latinAdvance * scale - primary.latinAdvance) < 1e-12)
      assert(css.includes(`font-family:${JSON.stringify(font.family)};`))
    }
  }
  const local = fontChain({ stack: [{ family: 'Local Font' }, ...FONT_CATALOG], ligatures: false })
  assert(local.every(font => font.sizeAdjust === undefined))
  assert.equal(local[0]!.family, 'Local Font')
})

test('CSS declares native styles and variable weight ranges without external or locally substituted fonts', () => {
  const css = contentFontCss(file => `/src/assets/fonts/${file}`)
  assert(css.includes('font-weight:200 700;font-style:italic'))
  assert(css.includes('font-weight:700;font-style:italic'))
  assert(css.includes('size-adjust:102.4%'))
  assert(css.includes('size-adjust:97.65625%'))
  assert(!css.includes('local('))
  assert(!css.includes('https:'))
  const sources = [...css.matchAll(/src:url\("([^"]+)"\)/g)].map(match => match[1])
  assert.equal(new Set(sources).size, 10)
})
