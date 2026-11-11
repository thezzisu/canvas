import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { copyText, TerminalClipboard } from './clipboard'
import type { Terminal } from '@xterm/xterm'
import { installNotices } from './notify'

// Copy feedback is a notice; the last one shown is what the user sees.
const shown: Array<'copied' | 'failed'> = []
installNotices((notice) => shown.push(notice.color === 'error' ? 'failed' : 'copied'))
const feedback = () => shown.at(-1)

function clipboardEnvironment(
  t: TestContext,
  writeText?: (text: string) => Promise<void>,
  legacy = false,
) {
  const element = class {}
  const values = {
    HTMLElement: element,
    HTMLInputElement: class extends element {},
    HTMLTextAreaElement: class extends element {},
    document: {
      activeElement: null,
      fullscreenElement: null,
      body: { append() {} },
      getSelection: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, remove() {} }),
      addEventListener() {},
      removeEventListener() {},
      execCommand: () => legacy,
    },
    navigator: { clipboard: writeText ? { writeText } : undefined },
  }
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
}

test('legacy HTTP copy reports its completed write', async (t) => {
  clipboardEnvironment(t, undefined, true)
  assert.equal(await copyText('selected terminal text'), true)
  assert.equal(feedback(), 'copied')
})

test('secure fallback waits for clipboard completion before reporting success', async (t) => {
  const pending = Promise.withResolvers<void>()
  clipboardEnvironment(t, () => pending.promise)
  const previous = shown.length
  const copying = copyText('selection')
  assert.equal(shown.length, previous)
  pending.resolve()
  assert.equal(await copying, true)
  assert.equal(feedback(), 'copied')
})

test('a rejected clipboard write reports failure rather than early success', async (t) => {
  clipboardEnvironment(t, async () => {
    throw new Error('Permission denied')
  })
  assert.equal(await copyText('selection'), false)
  assert.equal(feedback(), 'failed')
})

test('an older failed write cannot replace feedback from a newer successful copy', async (t) => {
  const pending = Promise.withResolvers<void>()
  clipboardEnvironment(t, (text) => (text === 'older' ? pending.promise : Promise.resolve()))
  const older = copyText('older')
  assert.equal(await copyText('newer'), true)
  const latest = shown.length
  pending.reject(new Error('Late rejection'))
  assert.equal(await older, false)
  assert.equal(shown.length, latest)
})

test('empty and oversized content never attempt a clipboard write', async (t) => {
  let writes = 0
  clipboardEnvironment(t, async () => {
    writes++
  })
  assert.equal(await copyText(''), false)
  assert.equal(await copyText('a'.repeat(1024 * 1024 + 1)), false)
  assert.equal(writes, 0)
  assert.equal(feedback(), 'failed')
})

function terminalClipboard(t: TestContext, controlsInput = true) {
  const writes: string[] = []
  let clipboard: TerminalClipboard
  t.after(() => clipboard?.dispose())
  clipboardEnvironment(t, async (text) => {
    writes.push(text)
  })
  const surface = { addEventListener() {}, removeEventListener() {} }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: surface })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' })
  let selected = '',
    osc!: (data: string) => boolean
  const term = {
    element: { contains: () => true },
    getSelection: () => selected,
    hasSelection: () => !!selected,
    parser: {
      registerOscHandler(_code: number, handler: typeof osc) {
        osc = handler
        return { dispose() {} }
      },
    },
  } as unknown as Terminal
  clipboard = new TerminalClipboard(term, surface as unknown as HTMLElement, {
    visible: () => true,
    controlsInput: () => controlsInput,
  })
  return {
    clipboard,
    writes,
    select: (text: string) => {
      selected = text
    },
    osc: (text: string) => osc('c;' + btoa(text)),
  }
}

function copyKey(fields: Partial<KeyboardEvent> = {}) {
  let prevented = false
  const event = {
    type: 'keydown',
    code: 'KeyC',
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isTrusted: true,
    getModifierState: () => false,
    preventDefault: () => {
      prevented = true
    },
    ...fields,
  } as KeyboardEvent
  return { event, prevented: () => prevented }
}

test('copy chords consume only a local selection; empty-selection Cmd+C reaches the client', async (t) => {
  const f = terminalClipboard(t)
  for (const chord of [
    { metaKey: true },
    { ctrlKey: true, shiftKey: true },
    { key: 'Insert', code: 'Insert', ctrlKey: true },
  ]) {
    f.select('local selection')
    const local = copyKey(chord)
    assert.equal(f.clipboard.key(local.event), false)
    assert.equal(local.prevented(), true)
    f.select('')
    const native = copyKey(chord)
    assert.equal(f.clipboard.key(native.event), true)
    assert.equal(native.prevented(), false)
  }
  await Promise.resolve()
  assert.deepEqual(f.writes, Array(3).fill('local selection'))
})

test('Ctrl+C retains terminal input semantics even with browser selection', (t) => {
  const f = terminalClipboard(t)
  f.select('local selection')
  const key = copyKey({ ctrlKey: true })
  assert.equal(f.clipboard.key(key.event), true)
  assert.equal(key.prevented(), false)
  assert.deepEqual(f.writes, [])
})

test('composition and AltGraph never copy local selection or authorize program clipboard output', async (t) => {
  const f = terminalClipboard(t)
  for (const composing of [
    { isComposing: true },
    { keyCode: 229 },
    { key: 'Process' },
    { key: 'Dead' },
    { getModifierState: () => true },
  ]) {
    f.select('local selection')
    const key = copyKey({ ctrlKey: true, shiftKey: true, ...composing })
    assert.equal(f.clipboard.key(key.event), true)
    assert.equal(key.prevented(), false)
    f.osc('unsolicited')
  }
  await Promise.resolve()
  assert.deepEqual(f.writes, [])
})

test('program clipboard output needs an initiating trusted copy gesture and is consumed once', async (t) => {
  const f = terminalClipboard(t)
  f.osc('unsolicited')
  f.clipboard.key(copyKey({ metaKey: true, isTrusted: false }).event)
  f.osc('synthetic')
  f.clipboard.key(copyKey({ metaKey: true }).event)
  f.osc('initiated')
  f.osc('replayed')
  await Promise.resolve()
  assert.deepEqual(f.writes, ['initiated'])
})

test('passive viewers cannot write a shared client clipboard response', async (t) => {
  const f = terminalClipboard(t, false)
  f.clipboard.key(copyKey({ metaKey: true }).event)
  f.osc('from another viewer')
  await Promise.resolve()
  assert.deepEqual(f.writes, [])
})
