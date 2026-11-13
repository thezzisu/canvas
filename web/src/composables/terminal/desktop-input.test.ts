import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { bindDesktopInput } from './desktop-input.ts'

function fixture(t: TestContext, hostKey?: (event: KeyboardEvent) => boolean) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const element = Object.assign(new EventTarget(), {
    style: {} as Record<string, string>,
    attributes: new Map<string, string>(),
    value: '',
    removed: false,
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value)
    },
    remove() {
      this.removed = true
    },
  })
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => element },
  })
  const sent: string[] = []
  const preedits: string[] = []
  let active = true
  const control = bindDesktopInput({ append() {} } as unknown as HTMLElement, {
    active: () => active,
    send: (data) => sent.push(data),
    key: hostKey,
    preedit: (text) => preedits.push(text),
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
  const keydown = (key: string, code = key, properties: Record<string, unknown> = {}) =>
    dispatch('keydown', {
      key,
      code,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...properties,
    })
  /** The browser's own edit of the field, as an input method or a dead key makes it. */
  const edit = (text: string, properties: Record<string, unknown> = {}) => {
    element.value = text
    dispatch('input', properties)
  }
  return {
    control,
    element,
    sent,
    preedits,
    dispatch,
    keydown,
    edit,
    tick: () => t.mock.timers.tick(0),
    deactivate: () => {
      active = false
    },
  }
}

test('keys become bytes and never reach the field', (t) => {
  const { keydown, sent, element } = fixture(t)
  assert.equal(keydown('a', 'KeyA').defaultPrevented, true)
  assert.equal(keydown('c', 'KeyC', { ctrlKey: true }).defaultPrevented, true)
  assert.equal(keydown('ArrowUp').defaultPrevented, true)
  assert.equal(keydown('Enter').defaultPrevented, true)
  assert.deepEqual(sent, ['a', '\x03', '\x1bOA', '\r'])
  assert.equal(element.value, '')
})

test("a key that is not the terminal's is left to the browser", (t) => {
  const { keydown, sent } = fixture(t)
  assert.equal(keydown('v', 'KeyV', { ctrlKey: true, shiftKey: true }).defaultPrevented, false)
  assert.equal(keydown('Shift', 'ShiftLeft', { shiftKey: true }).defaultPrevented, false)
  assert.equal(keydown('Dead', 'Quote').defaultPrevented, false)
  // Shift+PageUp is the terminal's and sends nothing.
  assert.equal(keydown('PageUp', 'PageUp', { shiftKey: true }).defaultPrevented, true)
  assert.deepEqual(sent, [])
})

test('the host takes its own keys first', (t) => {
  const { keydown, sent } = fixture(t, (event) => event.key === 'k' && event.ctrlKey)
  assert.equal(keydown('k', 'KeyK', { ctrlKey: true }).defaultPrevented, true)
  keydown('k', 'KeyK')
  assert.deepEqual(sent, ['k'])
})

test('a composition sends nothing until it ends, then its text once', (t) => {
  const { dispatch, keydown, edit, sent, preedits, tick, element } = fixture(t)
  keydown('Process', 'KeyN', { keyCode: 229, isComposing: false })
  dispatch('compositionstart')
  dispatch('compositionupdate', { data: 'n' })
  edit('n', { isComposing: true })
  keydown('Process', 'KeyI', { keyCode: 229, isComposing: true })
  dispatch('compositionupdate', { data: 'ni' })
  edit('ni', { isComposing: true })
  // The key that confirms a candidate is the input method's, even where isComposing is unset.
  assert.equal(keydown('Enter').defaultPrevented, false)
  assert.deepEqual(sent, [])
  assert.deepEqual(preedits, ['n', 'ni'])
  dispatch('compositionend', { data: '你' })
  // Chromium edits the field before compositionend, Safari after it: one read covers both.
  edit('你')
  assert.deepEqual(sent, [])
  tick()
  assert.deepEqual(sent, ['你'])
  assert.deepEqual(preedits, ['n', 'ni', ''])
  assert.equal(element.value, '')
  tick()
  assert.deepEqual(sent, ['你'])
})

test('a composition whose final edit came first is still sent once', (t) => {
  const { dispatch, edit, sent, tick } = fixture(t)
  dispatch('compositionstart')
  edit('かな', { isComposing: true })
  dispatch('compositionend', { data: 'かな' })
  tick()
  assert.deepEqual(sent, ['かな'])
})

test('a cancelled composition sends nothing', (t) => {
  const { dispatch, edit, sent, tick } = fixture(t)
  dispatch('compositionstart')
  edit('n', { isComposing: true })
  edit('', { isComposing: true })
  dispatch('compositionend', { data: '' })
  tick()
  assert.deepEqual(sent, [])
})

test('a key typed right after a composition follows its text', (t) => {
  const { dispatch, edit, keydown, sent, tick } = fixture(t)
  dispatch('compositionstart')
  edit('好', { isComposing: true })
  dispatch('compositionend', { data: '好' })
  keydown('Enter')
  tick()
  assert.deepEqual(sent, ['好', '\r'])
})

test('text that is not a key is sent as it lands', (t) => {
  const { keydown, edit, sent, element } = fixture(t)
  // A dead key followed by a letter, AltGr, dictation, an emoji picker.
  keydown('Dead', 'Quote')
  edit('é')
  edit('😀')
  assert.deepEqual(sent, ['é', '😀'])
  assert.equal(element.value, '')
})

test('paste is bracketed and focus is reported', (t) => {
  const { dispatch, sent } = fixture(t)
  dispatch('focus')
  const event = dispatch('paste', {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? 'a\nb' : '') },
  })
  dispatch('blur')
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(sent, ['\x1b[I', '\x1b[200~a\rb\x1b[201~', '\x1b[O'])
})

test('an inactive terminal takes no input', (t) => {
  const { dispatch, keydown, edit, sent, deactivate, tick } = fixture(t)
  deactivate()
  assert.equal(keydown('a', 'KeyA').defaultPrevented, true)
  assert.equal(
    dispatch('beforeinput', { inputType: 'insertText', data: 'x' }).defaultPrevented,
    true,
  )
  edit('x')
  dispatch('paste', { clipboardData: { getData: () => 'p' } })
  dispatch('focus')
  dispatch('compositionstart')
  dispatch('compositionend', { data: 'y' })
  tick()
  assert.deepEqual(sent, [])
})

test('the field follows the cursor and is removed on dispose', (t) => {
  const { control, element } = fixture(t)
  control.moveTo({ left: 42.5, top: 36, height: 18 })
  assert.equal(element.style.transform, 'translate(42.5px,36px)')
  assert.equal(element.style.height, '18px')
  control.dispose()
  assert.equal(element.removed, true)
})
