import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { contentFontsPlugin } from './fonts.config.ts'
import manifest from './web/public/fonts/manifest.json' with { type: 'json' }

test('Vite emits each complete font once under a hashed URL shared by every CSS alias', async () => {
  const result = await build({
    configFile: false, logLevel: 'silent', root: fileURLToPath(new URL('./web', import.meta.url)), publicDir: false,
    plugins: [contentFontsPlugin(), {
      name: 'font-build-fixture',
      resolveId(id) { if (id === 'font-entry') return '\0font-entry' },
      load(id) { if (id === '\0font-entry') return `import 'virtual:canvas-fonts.css'` },
    }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: 'font-entry' } },
  })
  assert(!Array.isArray(result) && 'output' in result)
  const fonts = result.output.filter(file => file.type === 'asset').filter(file => file.fileName.endsWith('.woff2'))
  assert.equal(fonts.length, manifest.files.length)
  assert.deepEqual(fonts.map(file => typeof file.source === 'string' ? Buffer.byteLength(file.source) : file.source.byteLength).sort((a, b) => a - b),
    manifest.files.map(file => file.bytes).sort((a, b) => a - b))
  for (const font of fonts) assert.match(font.fileName, /^assets\/[^/]+-[\w-]{8,}\.woff2$/)
  const css = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.css'))
  assert(css?.type === 'asset')
  const text = String(css.source)
  assert(!text.includes('/src/assets/fonts/'))
  assert(!text.includes('/fonts/maple/'))
  for (const font of fonts) assert(text.includes(`/${font.fileName}`), font.fileName)
})
