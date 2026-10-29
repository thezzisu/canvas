import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { bindMobileInput } from '../web/src/mobile-input.ts'

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const element = Object.assign(new EventTarget(), {
    style: {}, attributes: new Map<string, string>(), textContent: '', contentEditable: '', inputMode: '', removed: false,
    setAttribute(name: string, value: string) { this.attributes.set(name, value) },
    remove() { this.removed = true },
  })
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = { createElement: () => element, activeElement: element, getSelection: () => ({ collapse() {} }) }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const events: Array<{ type: string; data?: unknown }> = []
  let active = true
  const control = bindMobileInput({ append() {} } as unknown as HTMLElement, {
    active: () => active,
    input: text => events.push({ type: 'input', data: text }),
    paste: text => events.push({ type: 'paste', data: text }),
    files: files => events.push({ type: 'files', data: files }),
    key: event => events.push({ type: 'key', data: event.key }),
    special: key => events.push({ type: 'special', data: key }),
    composing: () => events.push({ type: 'composing' }),
    focus: () => events.push({ type: 'focus' }),
    blur: () => events.push({ type: 'blur' }),
  })
  t.after(() => {
    control.dispose()
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  function dispatch(type: string, properties: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), properties)
    element.dispatchEvent(event)
    return event
  }
  const edit = (text: string, properties: Record<string, unknown> = {}) => {
    element.textContent = `\u200b${text}`; dispatch('input', properties)
  }
  return { control, element, events, dispatch, edit, deactivate: () => { active = false } }
}

test('mobile input enables rich editing only while the keyboard is requested', t => {
  const f = fixture(t)
  assert.equal(f.element.contentEditable, 'false')
  assert.equal(f.element.inputMode, 'none')
  assert.equal(f.element.attributes.get('aria-readonly'), 'true')
  f.control.setEditable(true)
  assert.equal(f.element.contentEditable, 'true', 'plaintext-only cannot accept Android image commits')
  assert.equal(f.element.inputMode, 'text')
  assert.equal(f.element.attributes.get('aria-readonly'), 'false')
  f.control.setEditable(false)
  assert(f.dispatch('beforeinput', { inputType: 'insertText', data: 'x' }).defaultPrevented)
  f.edit('x')
  assert.deepEqual(f.events, [])
})

test('ordinary input sends only inserted text and retains an Android deletion anchor', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.edit('a'); f.edit('🙂'); f.edit('\u200b')
  assert.deepEqual(f.events, [{ type: 'input', data: 'a' }, { type: 'input', data: '🙂' }, { type: 'input', data: '\u200b' }])
  assert.equal(f.element.textContent, '\u200b')
})

test('IME updates stay local and the final composition commits once', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart')
  f.edit('pin', { isComposing: true }); f.edit('拼', { isComposing: true })
  assert.deepEqual(f.events, [{ type: 'composing' }])
  f.dispatch('compositionend', { data: '拼音' })
  f.dispatch('beforeinput', { inputType: 'insertText', data: '拼音' })
  f.edit('拼音')
  assert.deepEqual(f.events, [{ type: 'composing' }])
  t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'input', data: '拼音' }])
})

test('composition commit uses the final DOM value rather than a stale composition event', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart'); f.edit('한', { isComposing: true })
  f.dispatch('compositionend', { data: 'ㅎ' }); f.edit('한')
  t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'input', data: '한' }])
})

test('back-to-back compositions flush the previous completed edit before starting another', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart'); f.edit('甲', { isComposing: true }); f.dispatch('compositionend')
  f.dispatch('compositionstart'); f.edit('乙', { isComposing: true }); f.dispatch('compositionend')
  t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'input', data: '甲' }, { type: 'composing' }, { type: 'input', data: '乙' }])
})

test('a pending IME commit precedes the Enter key and does not replay later', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart'); f.edit('运行', { isComposing: true }); f.dispatch('compositionend')
  f.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false })
  t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'input', data: '运行' }, { type: 'key', data: 'Enter' }])
})

test('Enter confirms an active candidate without sending an early terminal newline', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart'); f.edit('拼音', { isComposing: true })
  assert.equal(f.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false }).defaultPrevented, false)
  f.dispatch('compositionend'); t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'input', data: '拼音' }])
})

test('cancelled and disabled compositions emit no partial command', t => {
  const f = fixture(t); f.control.setEditable(true)
  f.dispatch('compositionstart'); f.edit('pin', { isComposing: true }); f.edit('', { isComposing: true }); f.dispatch('compositionend')
  t.mock.timers.tick(0)
  f.dispatch('compositionstart'); f.edit('拼音', { isComposing: true }); f.dispatch('compositionend'); f.control.setEditable(false)
  t.mock.timers.tick(0)
  assert.deepEqual(f.events, [{ type: 'composing' }, { type: 'composing' }])
})

test('beforeinput deletion and Enter reuse terminal keys without inserting DOM breaks', t => {
  const f = fixture(t); f.control.setEditable(true)
  for (const type of ['deleteContentBackward', 'deleteContentForward', 'insertParagraph', 'insertLineBreak']) {
    assert(f.dispatch('beforeinput', { inputType: type }).defaultPrevented)
  }
  assert.deepEqual(f.events, ['Backspace', 'Delete', 'Enter', 'Enter'].map(data => ({ type: 'special', data })))
  assert.equal(f.element.textContent, '\u200b')
})

test('plain paste uses bracketed terminal paste while beforeinput files use the upload queue', t => {
  const f = fixture(t); f.control.setEditable(true)
  const clipboard = { getData: () => 'cat hello\nworld' }
  assert(f.dispatch('paste', { clipboardData: clipboard }).defaultPrevented)
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  assert(f.dispatch('beforeinput', { inputType: 'insertFromPaste', dataTransfer: { files: [file] } }).defaultPrevented)
  assert.deepEqual(f.events, [{ type: 'paste', data: 'cat hello\nworld' }, { type: 'files', data: [file] }])
})

test('inactive and disposed mobile input cannot send pending native edits', t => {
  const f = fixture(t); f.control.setEditable(true); f.deactivate()
  assert(f.dispatch('keydown', { key: 'x' }).defaultPrevented)
  assert(f.dispatch('beforeinput', { inputType: 'insertText', data: 'x' }).defaultPrevented)
  f.edit('x')
  assert.deepEqual(f.events, [])
  f.dispatch('compositionstart'); f.edit('中文', { isComposing: true }); f.dispatch('compositionend'); f.control.dispose()
  t.mock.timers.tick(0)
  assert.equal(f.element.removed, true)
  assert.deepEqual(f.events, [{ type: 'composing' }])
})
