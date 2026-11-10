import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { MarkdownDocument } from '@comark/vue'
import { KatexMath as Math } from './katex-math.ts'
import { parseFileMarkdown, isMarkdownFile } from './markdown.ts'

async function render(markdown: string) {
  let mounted = 0
  const document = await parseFileMarkdown(markdown)
  const app = createSSRApp({ render: () => h(MarkdownDocument, { value: document, components: { Math } }) })
  app.component('Canary', defineComponent({ setup() { mounted++; return () => h('div', 'component-ran') } }))
  return { document, html: await renderToString(app), mounted }
}

test('official Markdown renderer supports headings, tables, code and explicit external links', async () => {
  const { html } = await render('# Heading\n\n| Column | Value |\n|---|---|\n| A | **B** |\n\n```ts\nconst a = 1\n```\n\n[Docs](https://example.test/path?q=1)')
  assert.match(html, /<h1[^>]*>Heading<\/h1>/u)
  assert.match(html, /<table/u); assert.match(html, /<strong>B<\/strong>/u); assert.match(html, /const a = 1/u)
  assert.match(html, /target="_blank"/u); assert.match(html, /rel="noopener noreferrer"/u)
  assert.match(html, /referrerpolicy="no-referrer"/u)
  assert(isMarkdownFile('README.MD')); assert(isMarkdownFile('document.markdown')); assert(!isMarkdownFile('report.txt'))
})

test('HTML, event attributes and Vue/MDC syntax stay text and never instantiate components', async () => {
  const { html, mounted, document } = await render([
    '<script>globalThis.previewExecuted = true</script>',
    '<img src="x" onerror="globalThis.previewExecuted = true">',
    '<Canary @click="globalThis.previewExecuted = true" />',
    '::canary\ncomponent body\n::',
    '{{ globalThis.previewExecuted }}',
    '[styled]{onclick="run()"}',
    '---\ncomponent: Canary\n---',
  ].join('\n\n'))
  assert.equal(mounted, 0)
  assert.doesNotMatch(html, /<(?:script|img|canary)\b/iu)
  assert.doesNotMatch(html, /<[^>]+\son(?:click|error)=/iu)
  assert.match(html, /&lt;script&gt;/u)
  assert.match(html, /::canary/u)
  assert.match(html, /\{\{ globalThis\.previewExecuted \}\}/u)
  assert.deepEqual(document.frontmatter, {})
})

test('script, credentialed and file-relative URLs cannot become active preview links', async () => {
  const { html } = await render('[bad](javascript:alert%281%29)\n\n[data](data:text/html,unsafe)\n\n[relative](../api/state)\n\n[auth](https://user:DUMMY_PASSWORD@example.test/)\n\n![relative](./picture.png)')
  assert.doesNotMatch(html, /href="(?:javascript:|data:|\.\.\/|https:\/\/user:)/iu)
  assert.doesNotMatch(html, /src="\.\//u)
  assert.match(html, /relative/u)
})

test('source documents resolve adjacent resources within their root and preserve exact encoded names', async () => {
  const root = `https://canvas.test/prefix/api/capture/${'x'.repeat(43)}/`
  const tree = await parseFileMarkdown('# Heading\n\n[Anchor](#heading)\n\n![figure](../images/a%20%23%20%E4%B8%AD.png)\n\n[Next](next.md)\n\n[HTML](page.html)\n\n![outside](../../outside.png)\n\n[API](../../state)', { root, document: root + 'docs/readme.md' })
  const html = await renderToString(createSSRApp({ render: () => h(MarkdownDocument, { value: tree }) }))
  assert.match(html, new RegExp('src="' + root + 'images/a%20%23%20%E4%B8%AD.png"'))
  assert(html.includes(`href="${root}docs/next.md"`)); assert(html.includes(`href="${root}docs/page.html"`))
  assert(!html.includes('outside.png')); assert(!html.includes('href="https://canvas.test/prefix/api/state'))
  assert(html.includes('href="#heading"')); assert(html.includes('id="heading"'))
  assert.match(html, /target="_self"/u)
  assert.doesNotMatch(html, /target="_blank"/u)
})

test('KaTeX renders dollar math while backslash brackets stay Markdown escapes', async () => {
  const { html } = await render('Inline $x^2$ and \\[not math\\].\n\n$$\n\\sum_{i=1}^n i\n$$')
  assert.equal(html.match(/<span class="math inline"><span class="katex">/gu)?.length, 1)
  assert.equal(html.match(/<div class="math block"><span class="katex-display">/gu)?.length, 1)
  assert.match(html, /<annotation encoding="application\/x-tex">\\sum_\{i=1\}\^n i<\/annotation>/u)
  assert(html.includes('[not math]'))
})

test('formulas in code spans and blocks stay literal text', async () => {
  const { html } = await render('`$x^2$` and `\\(y\\)`\n\n```\n$$\nz\n$$\n\\[w\\]\n```')
  assert.doesNotMatch(html, /katex/u)
  assert(html.includes('$x^2$')); assert(html.includes('\\(y\\)')); assert(html.includes('$$\nz\n$$\n\\[w\\]'))
})

test('an invalid formula keeps its source visible instead of an ellipsis', async () => {
  const { html } = await render('Bad $\\frac{1}$ formula')
  assert.match(html, /katex-error/u)
  assert(html.includes('\\frac{1}'))
})
