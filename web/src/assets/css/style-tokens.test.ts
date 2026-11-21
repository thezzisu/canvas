import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Every colour, type size, radius, shadow and transition length is a token from ui.css, so one
// role looks the same on every surface. Data colours (program, status, note, file type, terminal
// palette) live in TypeScript and are not stylesheets.
const source = fileURLToPath(new URL('../..', import.meta.url))
const project = fileURLToPath(new URL('../../../..', import.meta.url))
const tokens = 'assets/css/ui.css'
// A deliberately loud test pattern for the viewport diagnostics.
const exempt = new Set(['components/settings/ViewportDiagnostics.vue'])
const read = (file: string) => readFileSync(path.join(source, file), 'utf8')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    return statSync(file).isDirectory() ? files(file) : /\.(css|vue)$/.test(name) ? [file] : []
  })
}
const relative = (file: string) => path.relative(source, file).split(path.sep).join('/')

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
  const name = relative(file)
  if (name === tokens || exempt.has(name)) return []
  const text = readFileSync(file, 'utf8')
  const styles = file.endsWith('.vue')
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]!)
    : [text]
  return styles.flatMap((css) => declarations(name, css))
})
const templates = files(source)
  .filter((file) => file.endsWith('.vue'))
  .map((file) => ({
    file: relative(file),
    // Markup only: colours in <script> are data (status, file type) or image pixels (QR, icons).
    text: readFileSync(file, 'utf8').match(/<template[^>]*>([\s\S]*)<\/template>/)?.[1] ?? '',
  }))
const where = (item: Declaration) => `${item.file} ${item.selector} { ${item.property}: ${item.value} }`
const lines = (pattern: RegExp) =>
  templates.flatMap(({ file, text }) =>
    text
      .split('\n')
      .filter((line) => pattern.test(line))
      .map((line) => `${file}: ${line.trim()}`),
  )

const named =
  /\b(?:white|black|silver|gr[ae]y|red|maroon|orange|yellow|olive|lime|green|teal|aqua|cyan|blue|navy|purple|fuchsia|magenta|pink)\b/i
const colourProperty = /^(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|caret-color|accent-color|scrollbar-color|--[a-z-]+)$/

test('stylesheets take colours from tokens', () => {
  const raw = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(\s*[\d.a-z]/i
  const found = sheets.filter(
    (item) =>
      raw.test(item.value.replace(/\bcolor-mix\(/g, '')) ||
      (colourProperty.test(item.property) && named.test(item.value.replace(/var\([^)]*\)/g, ''))),
  )
  assert.deepEqual(found.map(where), [])
})

test('type sizes are tokens, apart from fluid key labels', () => {
  const literal = sheets.filter(
    (item) =>
      (item.property === 'font-size' || item.property === 'font') &&
      /\d(px|rem|em)\b/.test(item.value.replace(/clamp\([^)]*\)/g, '')) &&
      !/^0?\.\d+em$/.test(item.value),
  )
  assert.deepEqual(literal.map(where), [])
})

test('corner radii come from the shared radius', () => {
  const literal = sheets.filter(
    (item) =>
      /radius$/.test(item.property) &&
      item.value.split(/\s+/).some((part) => /^\d*\.?\d+px$/.test(part) && part !== '0px' && part !== '999px'),
  )
  assert.deepEqual(literal.map(where), [])
})

// State changes share one duration; keyframe animations (blink, breathing, canvas morph) keep
// their own choreographed timing.
test('transitions share one duration', () => {
  const duration = /(?<![\w.-])(\d*\.?\d+)m?s\b/g
  const literal = sheets.filter(
    (item) =>
      /^transition/.test(item.property) &&
      [...item.value.matchAll(duration)].some((match) => Number(match[1]) !== 0),
  )
  assert.deepEqual(literal.map(where), [])
})

test('templates use token utilities, not raw colours or arbitrary sizes', () => {
  const palette =
    /\b(?:text|bg|border|ring|fill|stroke|outline|divide|from|via|to|shadow|caret|accent|decoration)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/
  const arbitrary =
    /\b(?:text|bg|border|ring|fill|stroke|outline|from|via|to)-\[(?:#|rgb|oklch|\d+px)|\b(?:rounded|shadow|duration)-\[|\[--ui-[a-z-]+:#/
  const literal = /(?:rgba?|hsla?|oklch)\(\s*\d|["'`]#[0-9a-f]{3,8}["'`]/i
  assert.deepEqual(lines(palette), [])
  assert.deepEqual(lines(arbitrary), [])
  assert.deepEqual(lines(literal), [])
  assert.doesNotMatch(
    readFileSync(path.join(project, 'vite.config.ts'), 'utf8'),
    /#[0-9a-f]{3,8}\b/i,
    'the Nuxt UI theme in vite.config.ts takes colours from ui.css',
  )
})

/** The sRGB hex of an OKLCH colour, as the browser paints it. */
function oklchHex(lightness: number, chroma: number, hue: number) {
  const a = chroma * Math.cos((hue * Math.PI) / 180),
    b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${linear
    .map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
    .join('')}`
}

test('colours that cannot read a token are kept equal to it', () => {
  const token = (name: string) => read(tokens).match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1]
  assert.equal(
    token('terminal-bg'),
    `#${readFileSync(path.join(project, 'shared/terminal-theme.ts'), 'utf8').match(/\bbackground: 0x([0-9a-f]{6})/)?.[1]}`,
  )
  assert.match(read('utils/workspace/wallpaper-material.ts'), new RegExp(`fillStyle = '${token('material')}'`))
  // The app chrome is the muted surface, neutral 900; the browser and installed app paint it too.
  const [, lightness, chroma, hue] = read(tokens).match(/--color-canvas-900: oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/)!
  const chrome = oklchHex(Number(lightness) / 100, Number(chroma), Number(hue))
  const html = readFileSync(path.join(project, 'web/index.html'), 'utf8')
  const pwa = readFileSync(path.join(project, 'pwa.config.ts'), 'utf8')
  assert.match(html, new RegExp(`name="theme-color" content="${chrome}"`))
  assert.match(pwa, new RegExp(`theme_color: '${chrome}',\\s*background_color: '${chrome}'`))
  assert.match(read('components/notifications/NotificationCenter.vue'), new RegExp(`stroke="${chrome}"`))
})
