import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { MarkdownDocument } from '@comark/vue'
import { parseFileMarkdown, isMarkdownFile } from './markdown.ts'

async function render(markdown: string) {
  let mounted = 0
  const document = await parseFileMarkdown(markdown)
  const app = createSSRApp({ render: () => h(MarkdownDocument, { value: document }) })
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
