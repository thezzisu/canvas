import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { copyText } from './clipboard'
import { beginCopyFeedback, copyFeedback } from './copy-feedback'

function clipboardEnvironment(t: TestContext, writeText?: (text: string) => Promise<void>, legacy = false) {
  const element = class {}
  const values = {
    HTMLElement: element, HTMLInputElement: class extends element {}, HTMLTextAreaElement: class extends element {},
    document: {
      activeElement: null, fullscreenElement: null, body: { append() {} }, getSelection: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, remove() {} }),
      addEventListener() {}, removeEventListener() {}, execCommand: () => legacy,
    },
    navigator: { clipboard: writeText ? { writeText } : undefined },
  }
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) })
  }
}

test('legacy HTTP copy reports its completed write', async t => {
  clipboardEnvironment(t, undefined, true)
  assert.equal(await copyText('selected terminal text'), true)
  assert.equal(copyFeedback.value?.kind, 'copied')
})

test('secure fallback waits for clipboard completion before reporting success', async t => {
  const pending = Promise.withResolvers<void>()
  clipboardEnvironment(t, () => pending.promise)
  const previous = copyFeedback.value
  const copying = copyText('selection')
  assert.equal(copyFeedback.value, previous)
  pending.resolve()
  assert.equal(await copying, true)
  assert.equal(copyFeedback.value?.kind, 'copied')
})

test('a rejected clipboard write reports failure rather than early success', async t => {
  clipboardEnvironment(t, async () => { throw new Error('Permission denied') })
  assert.equal(await copyText('selection'), false)
  assert.equal(copyFeedback.value?.kind, 'failed')
})

test('an older failed write cannot replace feedback from a newer successful copy', async t => {
  const pending = Promise.withResolvers<void>()
  clipboardEnvironment(t, text => text === 'older' ? pending.promise : Promise.resolve())
  const older = copyText('older')
  assert.equal(await copyText('newer'), true)
  const latest = copyFeedback.value
  pending.reject(new Error('Late rejection'))
  assert.equal(await older, false)
  assert.equal(copyFeedback.value, latest)
})

test('Canvas file copies replace text copy feedback without claiming system clipboard support', async t => {
  const pending = Promise.withResolvers<void>()
  clipboardEnvironment(t, () => pending.promise)
  const older = copyText('older text')
  beginCopyFeedback()('canvas')
  const latest = copyFeedback.value
  assert.equal(latest?.kind, 'canvas')
  pending.resolve()
  await older
  assert.equal(copyFeedback.value, latest)
})

test('empty and oversized content never attempt a clipboard write', async t => {
  let writes = 0
  clipboardEnvironment(t, async () => { writes++ })
  assert.equal(await copyText(''), false)
  assert.equal(await copyText('a'.repeat(1024 * 1024 + 1)), false)
  assert.equal(writes, 0)
  assert.equal(copyFeedback.value?.kind, 'failed')
})
