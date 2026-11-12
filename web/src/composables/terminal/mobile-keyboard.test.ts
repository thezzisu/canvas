import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindMobileKeyboard,
  dismissMobileKeyboard,
  hideMobileKeyboard,
  systemKeyboardVisible,
  type MobileKeyboardState,
} from './mobile-keyboard.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(t: TestContext, preferred?: 'builtin') {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visual = Object.assign(new EventTarget(), { height: 844, scale: 1 })
  const window = Object.assign(new EventTarget(), {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: visual,
  })
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    body: {} as object,
    activeElement: null as object | null,
  })
  document.activeElement = document.body
  class Element {
    isContentEditable = false
    focuses = 0
    blurs = 0
    readonly tag: string
    constructor(tag = 'div') {
      this.tag = tag
    }
    matches() {
      return this.tag === 'textarea'
    }
    focus() {
      this.focuses++
      if (document.activeElement === this) return
      document.activeElement = this
      const event = new Event('focusin')
      Object.defineProperty(event, 'target', { value: this })
      document.dispatchEvent(event)
    }
    blur() {
      this.blurs++
      if (document.activeElement === this) document.activeElement = document.body
    }
  }
  const storage = new Map<string, string>(
    preferred ? [['canvas:mobile-keyboard-mode', preferred]] : [],
  )
  const globals = {
    window,
    document,
    HTMLElement: Element,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  }
  const originals = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  const bound: { dispose(): void }[] = []
  const bind = () => {
    const input = new Element()
    const states: MobileKeyboardState[] = []
    const keyboard = bindMobileKeyboard(input as unknown as HTMLElement, {
      active: () => true,
      changed: (state) => states.push(state),
      setEditable: (value) => {
        input.isContentEditable = value
      },
      finishEditing: () => Promise.resolve(),
    })
    bound.push(keyboard)
    return { input, keyboard, states }
  }
  t.after(() => {
    for (const keyboard of bound) keyboard.dispose()
    for (const [name, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as Record<string, unknown>)[name]
  })
  /** The page as the browser resizes it around an IME of this height. */
  const ime = (height: number) => {
    visual.height = window.innerHeight = 844 - height
    visual.dispatchEvent(new Event('resize'))
  }
  return { ...bind(), bind, document, window, visual, ime, storage, Element }
}

test('the system keyboard is an editable focused input and closes on blur', async (t) => {
  const { input, keyboard, document } = fixture(t)
  keyboard.focus(true)
  assert.deepEqual(keyboard.state, { open: true, mode: 'system', deck: false, composer: false })
  assert.equal(input.isContentEditable, true)
  assert.equal(document.activeElement, input)

  keyboard.blur()
  await tick()
  assert.equal(keyboard.state.open, false)
  assert.equal(input.isContentEditable, false)
  assert.equal(document.activeElement, document.body)
})

test('the built-in keys keep a read-only input focused for hardware keys', async (t) => {
  const { input, keyboard, document } = fixture(t, 'builtin')
  keyboard.focus(true)
  await tick()
  assert.deepEqual(keyboard.state, { open: true, mode: 'builtin', deck: true, composer: false })
  assert.equal(input.isContentEditable, false)
  assert.equal(document.activeElement, input)
})

test('an ime counts as visible only for a tall resize under an editor', (t) => {
  const { keyboard, ime, window, visual } = fixture(t)
  keyboard.focus(true)
  ime(56)
  assert.equal(systemKeyboardVisible.value, false)
  ime(300)
  assert.equal(systemKeyboardVisible.value, true)
  // A new orientation starts over.
  window.innerWidth = 844
  visual.height = window.innerHeight = 390
  visual.dispatchEvent(new Event('resize'))
  assert.equal(systemKeyboardVisible.value, false)
})

test('the built-in keys replace a visible ime once the page has resized', async (t) => {
  const { input, keyboard, document, ime, storage } = fixture(t)
  keyboard.focus(true)
  ime(300)
  keyboard.switchMode()
  await tick()
  assert.equal(keyboard.state.mode, 'builtin')
  assert.equal(keyboard.state.deck, false)
  assert.equal(input.isContentEditable, false)
  assert.equal(document.activeElement, input)
  assert.equal(storage.get('canvas:mobile-keyboard-mode'), 'builtin')
  ime(0)
  assert.equal(keyboard.state.deck, true)
})

test('the built-in keys do not wait for an ime that is not there', (t) => {
  const { keyboard } = fixture(t)
  keyboard.focus(true)
  keyboard.switchMode()
  assert.equal(keyboard.state.deck, true)
})

test('the built-in keys stay until the ime that replaces them arrives, or is refused', (t) => {
  const { input, keyboard, ime } = fixture(t, 'builtin')
  keyboard.focus(true)
  keyboard.switchMode()
  assert.equal(keyboard.state.mode, 'system')
  assert.equal(keyboard.state.deck, true)
  assert.equal(input.isContentEditable, true)
  ime(300)
  assert.equal(keyboard.state.deck, false)

  keyboard.switchMode()
  ime(0)
  keyboard.switchMode()
  assert.equal(keyboard.state.deck, true)
  t.mock.timers.tick(400)
  assert.equal(keyboard.state.deck, false)
})

test('a dismissed ime stays away until the terminal is tapped', (t) => {
  const { input, keyboard, ime } = fixture(t)
  keyboard.focus(true)
  ime(300)
  ime(0)
  assert.equal(keyboard.state.open, true)
  const blurs = input.blurs
  // Only a fresh focus asks the platform for its IME again.
  keyboard.focus()
  assert.equal(input.blurs, blurs + 1)
  assert.equal(input.isContentEditable, true)

  ime(300)
  keyboard.focus()
  assert.equal(input.blurs, blurs + 1)
})

test('another editor taking focus closes the system keyboard; a button does not', async (t) => {
  const { keyboard, Element } = fixture(t)
  keyboard.focus(true)
  new Element('button').focus()
  assert.equal(keyboard.state.open, true)
  new Element('textarea').focus()
  await tick()
  assert.equal(keyboard.state.open, false)
})

test('a dialog borrows focus and gives the keyboard back', async (t) => {
  const { input, keyboard, document } = fixture(t)
  keyboard.focus(true)
  keyboard.suspend(true)
  await tick()
  assert.equal(document.activeElement, document.body)
  assert.equal(input.isContentEditable, false)
  assert.equal(keyboard.state.open, true)
  keyboard.suspend(false)
  t.mock.timers.tick(0)
  assert.equal(document.activeElement, input)
  assert.equal(input.isContentEditable, true)
})

test('a file picker returns the keyboard, or closes it when nothing was picked', (t) => {
  const { input, keyboard, document } = fixture(t)
  assert.equal(keyboard.filePicker(), undefined)
  keyboard.focus(true)
  input.blur()
  keyboard.filePicker()?.(true)
  assert.equal(document.activeElement, input)
  keyboard.filePicker()?.(false)
  assert.equal(keyboard.state.open, false)
})

test('the composer editor owns native input and returns the prior keyboard', async (t) => {
  const { input, keyboard, document, ime, Element } = fixture(t, 'builtin')
  const editor = new Element('textarea')
  let lost = 0
  keyboard.focus(true)
  await tick()
  keyboard.composer(editor as unknown as HTMLElement, () => lost++)
  await tick()
  assert.equal(document.activeElement, editor)
  // The keys stay until the editor's IME has resized the page.
  assert.deepEqual(keyboard.state, { open: true, mode: 'builtin', deck: true, composer: true })
  ime(300)
  assert.equal(keyboard.state.deck, false)
  keyboard.switchMode()
  assert.equal(keyboard.state.mode, 'builtin')

  keyboard.composer()
  await tick()
  assert.equal(document.activeElement, input)
  assert.equal(keyboard.state.composer, false)
  assert.equal(keyboard.state.deck, false)
  ime(0)
  assert.equal(keyboard.state.deck, true)

  keyboard.composer(editor as unknown as HTMLElement, () => lost++)
  keyboard.blur()
  assert.equal(lost, 1)
  assert.deepEqual(keyboard.state, { open: false, mode: 'builtin', deck: false, composer: false })
})

test('a composer opened over a closed keyboard is the open keyboard until it leaves', async (t) => {
  const { keyboard, document, Element } = fixture(t)
  const editor = new Element('textarea')
  keyboard.composer(editor as unknown as HTMLElement)
  assert.deepEqual(keyboard.state, { open: true, mode: 'system', deck: false, composer: true })
  keyboard.composer()
  await tick()
  assert.deepEqual(keyboard.state, { open: false, mode: 'system', deck: false, composer: false })
  assert.equal(document.activeElement, document.body)
})

test('a file picker over the composer returns focus to its editor', (t) => {
  const { keyboard, document, Element } = fixture(t)
  const editor = new Element('textarea')
  keyboard.composer(editor as unknown as HTMLElement)
  const finish = keyboard.filePicker()
  editor.blur()
  finish?.(true)
  assert.equal(document.activeElement, editor)
})

test('one terminal owns the keyboard', async (t) => {
  const first = fixture(t)
  const second = first.bind()
  first.keyboard.focus(true)
  second.keyboard.focus(true)
  assert.equal(first.keyboard.state.open, false)
  assert.equal(second.keyboard.state.open, true)

  second.keyboard.suspend(true)
  dismissMobileKeyboard()
  assert.equal(second.keyboard.state.open, true)
  hideMobileKeyboard()
  await tick()
  assert.equal(second.keyboard.state.open, false)
  assert.equal(second.input.isContentEditable, false)
})

test('changes are published once', (t) => {
  const { keyboard, states } = fixture(t)
  keyboard.focus(true)
  keyboard.focus()
  keyboard.focus(true)
  assert.deepEqual(
    states.map((state) => state.open),
    [true],
  )
})
