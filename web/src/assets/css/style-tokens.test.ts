import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Every colour, type size, radius and transition length is a token from ui.css, so one role
// looks the same on every surface. Data colours (program, status, note, file type, terminal
// palette) live in TypeScript and are not stylesheets.
const source = fileURLToPath(new URL('../..', import.meta.url))
const tokens = 'assets/css/ui.css'
// A deliberately loud test pattern for the viewport diagnostics.
const exempt = new Set(['components/settings/ViewportDiagnostics.vue'])
// Root sizes that define what rem means.
const rootSizes = new Set(['assets/css/style.css|:root', 'components/files/DocumentPreview.vue|html.document-mode'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    return statSync(file).isDirectory() ? files(file) : /\.(css|vue)$/.test(name) ? [file] : []
  })
}

interface Declaration {
  file: string
  selector: string
  property: string
  value: string
}

function declarations(file: string, css: string): Declaration[] {
  const found: Declaration[] = []
  let selector = ''
  for (const match of css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{};]+)\{|([a-z-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    if (match[1] !== undefined) selector = match[1].trim()
    else found.push({ file, selector, property: match[2]!, value: match[3]!.trim() })
  }
  return found
}

const sheets = files(source).flatMap((file) => {
  const name = path.relative(source, file).split(path.sep).join('/')
  if (name === tokens || exempt.has(name)) return []
  const text = readFileSync(file, 'utf8')
  const styles = file.endsWith('.vue')
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]!)
    : [text]
  return styles.flatMap((css) => declarations(name, css))
})
const where = (item: Declaration) => `${item.file} ${item.selector} { ${item.property}: ${item.value} }`

test('stylesheets take colours from tokens', () => {
  const raw = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.]/i
  assert.deepEqual(sheets.filter((item) => raw.test(item.value)).map(where), [])
})

test('type sizes are tokens, apart from the root size and fluid key labels', () => {
  const literal = sheets.filter(
    (item) =>
      item.property === 'font-size' &&
      /\d(px|rem|em)\b/.test(item.value.replace(/clamp\([^)]*\)/g, '')) &&
      !/^0?\.\d+em$/.test(item.value) &&
      !rootSizes.has(`${item.file}|${item.selector}`),
  )
  assert.deepEqual(literal.map(where), [])
})

test('corner radii come from the shared radius', () => {
  const literal = sheets.filter(
    (item) =>
      item.property === 'border-radius' &&
      item.value.split(/\s+/).some((part) => /^\d*\.?\d+px$/.test(part) && part !== '0px' && part !== '999px'),
  )
  assert.deepEqual(literal.map(where), [])
})

test('transitions share one duration', () => {
  const literal = sheets.filter(
    (item) => /^transition/.test(item.property) && /\b(?!0s\b)(\d*\.\d+s|\d+ms)\b/.test(item.value),
  )
  assert.deepEqual(literal.map(where), [])
})

test('templates use token utilities, not arbitrary colours or sizes', () => {
  const arbitrary = /\b(?:text|bg|border|ring|fill|stroke|outline|shadow|from|via|to)-\[(?:#|rgb|oklch|\d+px)|\[--ui-[a-z-]+:#/
  const found = files(source)
    .filter((file) => file.endsWith('.vue'))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
        .split('\n')
        .filter((line) => arbitrary.test(line))
        .map((line) => `${path.relative(source, file)}: ${line.trim()}`),
    )
  const config = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8')
  assert.deepEqual(found, [])
  assert.doesNotMatch(config, /#[0-9a-f]{3,8}\b/i, 'the Nuxt UI theme in vite.config.ts takes colours from ui.css')
})

test('colours that TypeScript must paint itself match their tokens', () => {
  const read = (file: string) => readFileSync(path.join(source, file), 'utf8')
  const token = (name: string) => read(tokens).match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1]
  assert.equal(token('terminal-bg'), `#${read('composables/terminal/terminal-create.ts').match(/\bbackground: 0x([0-9a-f]{6})/)?.[1]}`)
  assert.match(read('components/canvas/CanvasStage.vue'), new RegExp(`'${token('material')}'`))
  assert.match(read('utils/workspace/wallpaper-material.ts'), new RegExp(`fillStyle = '${token('material')}'`))
})
