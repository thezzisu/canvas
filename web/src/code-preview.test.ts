import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textCapabilities, processCodePreview, type CodePreviewRequest, type CodePreviewResult } from './code-preview'
import { MAX_HIGHLIGHT_TOKENS, processCode } from './code-preview-process'

const request = (filename: string, text: string, format = false, highlight = false) => ({ filename, text, format, highlight })

test('text capabilities distinguish formatting, highlighting and actual HTML files', () => {
  assert.deepEqual(textCapabilities('report.HTML'), { format: true, highlight: true, html: true })
  assert.deepEqual(textCapabilities('/path/component.vue'), { format: true, highlight: true, html: false })
  assert.deepEqual(textCapabilities('scripts/example.py'), { format: false, highlight: true, html: false })
  for (const name of ['README', 'notes.txt', 'html', 'archive.html.gz'])
    assert.deepEqual(textCapabilities(name), { format: false, highlight: false, html: false })
})

test('plain and disabled processing returns original text without creating a worker', async () => {
  const original = '\n <script>plain text</script>\r\n'
  assert.deepEqual(await processCodePreview(request('page.html', original)), { text: original })
  assert.deepEqual(await processCodePreview(request('notes.txt', original, true, true)), { text: original })
  const aborted = AbortSignal.abort(new Error('Closed preview'))
  await assert.rejects(processCodePreview(request('page.html', original, true), aborted), /Closed preview/)
})

test('shared worker isolates cancellation, rejects failures and safely recreates after errors', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const workers: FakeWorker[] = []
  class FakeWorker {
    static failCreation = true
    onmessage?: (event: { data: { id: number; result?: CodePreviewResult } }) => void
    onerror?: (event: { preventDefault(): void }) => void
    messages: { id: number; request: CodePreviewRequest }[] = []
    terminated = false
    constructor() {
      if (FakeWorker.failCreation) throw new Error('Worker blocked')
      workers.push(this)
    }
    postMessage(message: { id: number; request: CodePreviewRequest }) { this.messages.push(message) }
    terminate() { this.terminated = true }
    fail() { this.onerror?.({ preventDefault() {} }) }
    reply(index: number, result: CodePreviewResult) { this.onmessage?.({ data: { id: this.messages[index]!.id, result } }) }
  }
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true })
  try {
    await assert.rejects(processCodePreview(request('file.json', '{}', true)), /Worker blocked/)
    FakeWorker.failCreation = false
    const controller = new AbortController()
    const cancelled = processCodePreview(request('file.json', '{}', true), controller.signal)
    const concurrent = processCodePreview(request('other.json', '[]', true))
    assert.equal(workers.length, 1)
    controller.abort(new Error('Preview closed'))
    await assert.rejects(cancelled, /Preview closed/)
    workers[0]!.reply(0, { text: 'stale' })
    workers[0]!.reply(1, { text: '[]\n' })
    assert.deepEqual(await concurrent, { text: '[]\n' })
    assert.equal(workers[0]!.terminated, false)

    const failed = processCodePreview(request('file.json', '{}', true))
    workers[0]!.fail()
    await assert.rejects(failed, /processing failed/)
    assert.equal(workers[0]!.terminated, true)
    const recovered = processCodePreview(request('file.json', '{}', true))
    assert.equal(workers.length, 2)
    workers[0]!.fail()
    workers[1]!.reply(0, { text: '{}\n' })
    assert.deepEqual(await recovered, { text: '{}\n' })
    assert.equal(workers[1]!.terminated, false)
  } finally {
    workers.at(-1)?.fail()
    if (original) Object.defineProperty(globalThis, 'Worker', original)
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
})

test('HTML formatting includes embedded CSS and JavaScript without changing the original input', async () => {
  const text = '<!doctype html><html><head><style>body{color:red}</style></head><body><p>中文 &amp; text</p><script>const config={a:1};</script></body></html>'
  const input = request('page.html', text, true, true)
  const result = await processCode(input)
  assert.equal(result.formatError, undefined)
  assert.equal(result.highlightError, undefined)
  assert.match(result.text, /\n {2}<head>\n/u)
  assert.match(result.text, /body \{\n {8}color: red;/u)
  assert.match(result.text, /const config = \{ a: 1 \};/u)
  assert(result.text.includes('<p>中文 &amp; text</p>'))
  assert.equal(input.text, text)
  assert.equal(result.tokens?.map(token => token.text).join(''), result.text)
  assert(new Set(result.tokens?.flatMap(token => token.color || [])).size > 1)
})

test('highlight tokens preserve leading/trailing and mixed newlines plus literal markup', async () => {
  const text = '\r\n<script>alert("<img src=x>")</script>\r\n<div>雪\t &amp; </div>\r<p>CR line ending</p>\r\n\n'
  const result = await processCode(request('page.html', text, false, true))
  assert.equal(result.highlightError, undefined)
  assert.equal(result.text, text)
  assert.equal(result.tokens?.map(token => token.text).join(''), text)
  assert(result.tokens?.every(token => typeof token.text === 'string' && (!token.color || /^#[\da-f]{3,8}$/iu.test(token.color))))
})

test('long formatted files highlight a bounded prefix and keep the rest as exact plain text', async () => {
  const text = '<!doctype html><html><head><style>' + Array.from({ length: 4000 }, (_, i) => `.c${i}{color:#${(i % 4096).toString(16).padStart(3, '0')};margin:${i}px}`).join('') + '</style></head><body></body></html>'
  const result = await processCode(request('large.html', text, true, true))
  assert.equal(result.formatError, undefined)
  assert.equal(result.highlightError, undefined)
  assert.equal(result.tokens?.length, MAX_HIGHLIGHT_TOKENS + 1)
  assert.equal(result.tokens?.at(-1)?.color, undefined)
  assert.equal(result.tokens?.map(token => token.text).join(''), result.text)
})

test('malformed code reports a formatting failure and still highlights the original content', async () => {
  const text = '{"missing": [1, 2, }'
  const result = await processCode(request('broken.json', text, true, true))
  assert.equal(result.formatError, true)
  assert.equal(result.text, text)
  assert.equal(result.tokens?.map(token => token.text).join(''), text)
})

test('common formatters and highlight-only languages stay separate', async () => {
  for (const [filename, text] of [['example.ts', 'const n:number=1'], ['example.json', '{"n":1}'], ['example.css', 'body{color:red}'], ['example.yml', 'a: [1,2]'], ['example.md', '#Title\n\ntext']]) {
    const result = await processCode(request(filename!, text!, true, true))
    assert.equal(result.formatError, undefined, filename)
    assert.equal(result.highlightError, undefined, filename)
    assert.equal(result.tokens?.map(token => token.text).join(''), result.text, filename)
  }
  const python = 'print("hello")\n'
  const result = await processCode(request('example.py', python, true, true))
  assert.equal(result.text, python)
  assert.equal(result.formatError, undefined)
  assert(result.tokens?.some(token => token.color))
})
