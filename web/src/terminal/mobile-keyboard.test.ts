import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { viewportPolicy, type InteractiveWidget } from '../app/developer-mode.ts'
import { readViewportFrame } from '../lib/viewport-frame.ts'
import {
  bindMobileKeyboard,
  dismissMobileKeyboard,
  hideMobileKeyboard,
  mobileKeyboardInset,
  mobileKeyboardVisible,
  mobileKeyboardOpen,
  refreshMobileKeyboardViewport,
} from './mobile-keyboard.ts'

interface FixtureOptions {
  policy?: InteractiveWidget
  api?: boolean
  finishEditing?: () => Promise<void>
}
function fixture(
  t: TestContext,
  { policy = 'resizes-content', api = false, finishEditing }: FixtureOptions = {},
) {
  const previousPolicy = viewportPolicy.value
  viewportPolicy.value = { viewportFit: 'cover', interactiveWidget: policy }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visual = Object.assign(new EventTarget(), {
    width: 390,
    height: 844,
    offsetTop: 0,
    offsetLeft: 0,
  })
  const css = { width: 390, height: 844 }
  const probe = { style: {}, setAttribute() {}, getBoundingClientRect: () => css }
  const root = {
    attributes: new Set<string>(),
    toggleAttribute(name: string, force: boolean) {
      if (force) root.attributes.add(name)
      else root.attributes.delete(name)
    },
  }
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    body: { append() {} },
    documentElement: root,
    createElement: () => probe,
    activeElement: null as object | null,
  })
  document.activeElement = document.body
  const window = Object.assign(new EventTarget(), {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: visual,
  })
  // The VirtualKeyboard API: the IME overlays the page only after overlaysContent, as in Chromium.
  const virtualKeyboard = Object.assign(new EventTarget(), {
    overlaysContent: false,
    boundingRect: { height: 0 },
    shows: 0,
    hides: 0,
    show() {
      virtualKeyboard.shows++
    },
    hide() {
      virtualKeyboard.hides++
    },
  })
  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
  }
  const originals = new Map(
    ['window', 'document', 'navigator', 'localStorage'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  )
  for (const [name, value] of Object.entries({
    window,
    document,
    navigator: api ? { virtualKeyboard } : {},
    localStorage,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  // Focusing one input blurs the previously focused one, as in browsers.
  const input = () => {
    const element = Object.assign(new EventTarget(), {
      readOnly: false,
      inputMode: 'text',
      focusCalls: 0,
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        element.attributes.set(name, value)
      },
      removeAttribute(name: string) {
        element.attributes.delete(name)
      },
      focus() {
        element.focusCalls++
        if (document.activeElement === element) return
        const previous = document.activeElement as { blur?: () => void } | null
        previous?.blur?.()
        document.activeElement = element
        element.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('focusin'))
      },
      blur() {
        if (document.activeElement !== element) return
        document.activeElement = document.body
        element.dispatchEvent(new Event('blur'))
      },
    })
    return element
  }
  const textarea = input(),
    editor = input()
  let requested = false
  const control = bindMobileKeyboard(textarea as unknown as HTMLTextAreaElement, {
    active: () => true,
    changed: (value) => {
      requested = value
    },
    finishEditing,
  })
  // The built-in keys report their natural height once mounted.
  control.setBuiltinHeight(260)
  t.after(() => {
    control.dispose()
    viewportPolicy.value = previousPolicy
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  const resize = (height: number, visualHeight = height) => {
    css.width = window.innerWidth
    if (policy === 'resizes-content') {
      css.height = height
      window.innerHeight = Math.floor(height)
    } else css.height = window.innerHeight
    visual.height = visualHeight
    visual.dispatchEvent(new Event('resize'))
  }
  // One IME animation frame: an overlaid IME reports its geometry, otherwise the page resizes.
  const keyboard = (height: number) => {
    if (!virtualKeyboard.overlaysContent) {
      resize(844 - height)
      return
    }
    virtualKeyboard.boundingRect = { height }
    virtualKeyboard.dispatchEvent(new Event('geometrychange'))
  }
  // The phone turned: a new frame and no keyboard measurement carried over.
  const rotate = (width: number, height: number) => {
    window.innerWidth = css.width = visual.width = width
    window.innerHeight = css.height = visual.height = height
    window.dispatchEvent(new Event('resize'))
  }
  // Another terminal card on the same page.
  const second = () => {
    const other = input()
    return {
      control: bindMobileKeyboard(other as unknown as HTMLTextAreaElement, {
        active: () => true,
        changed() {},
      }),
    }
  }
  let lost = 0
  const compose = () =>
    control.composer(editor as unknown as HTMLElement, () => {
      lost++
    })
  // The terminal's free height: the frame minus the reserved keyboard area.
  const terminal = () => readViewportFrame().height - control.state.dockHeight
  return {
    control,
    textarea,
    editor,
    compose,
    lost: () => lost,
    document,
    root,
    storage,
    virtualKeyboard,
    resize,
    keyboard,
    terminal,
    rotate,
    second,
    requested: () => requested,
  }
}

const HIDDEN = 844
/** One IME animation: rising or falling through intermediate heights. */
function animate(f: ReturnType<typeof fixture>, heights: number[]) {
  for (const height of heights) f.keyboard(height)
}

for (const api of [true, false]) {
  const label = api ? 'overlay' : 'resizing page'

  test(`${label}: the system keyboard opens on request and the area follows what it reports`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    assert.equal(f.requested(), true)
    assert.equal(f.document.activeElement, f.textarea)
    assert.equal(f.textarea.inputMode, 'text')
    assert.equal(f.control.state.switching, true, 'waiting for the IME')
    animate(f, [120, 250, 344])
    assert.equal(f.control.state.switching, false)
    assert.equal(f.terminal(), HIDDEN - 344)
    f.keyboard(300)
    assert.equal(f.terminal(), HIDDEN - 300, 'another keyboard height is simply followed')
    assert.equal(f.control.state.deck, false)
  })

  test(`${label}: dismissing the IME closes the keyboard and nothing asks for it again`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    const asked = f.virtualKeyboard.shows
    animate(f, [200, 0])
    assert.equal(f.requested(), true, 'it may only be changing')
    t.mock.timers.tick(300)
    assert.equal(f.requested(), false)
    assert.equal(f.terminal(), HIDDEN)
    assert.equal(f.virtualKeyboard.shows, asked, 'the IME is never requested again')
    assert.equal(f.document.activeElement === f.textarea, false, 'and focus is given up')
    t.mock.timers.tick(5000)
    assert.equal(f.requested(), false)
  })

  test(`${label}: an IME that only changes for a moment keeps the keyboard open`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.keyboard(0)
    t.mock.timers.tick(200)
    f.keyboard(300)
    t.mock.timers.tick(1000)
    assert.equal(f.requested(), true)
    assert.equal(f.terminal(), HIDDEN - 300)
  })

  test(`${label}: an IME that never appears turns the keyboard off`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    t.mock.timers.tick(899)
    assert.equal(f.requested(), true)
    t.mock.timers.tick(1)
    assert.equal(f.requested(), false)
    assert.equal(f.control.state.switching, false)
  })

  test(`${label}: the built-in keys have their own height whatever IME they replace`, (t) => {
    const f = fixture(t, { api })
    for (const ime of [344, 420, 200]) {
      f.control.focus(true)
      f.keyboard(ime)
      f.control.switchMode()
      assert.equal(f.control.state.mode, 'builtin')
      animate(f, [ime / 2, 0])
      t.mock.timers.tick(0)
      assert.equal(f.textarea.inputMode, 'none')
      assert.equal(f.control.state.switching, false)
      assert.equal(f.control.state.deck, true)
      assert.equal(f.terminal(), HIDDEN - 260, `after a ${ime}px keyboard`)
      f.control.switchMode()
      f.keyboard(ime)
      f.control.focus(false)
      f.keyboard(0)
    }
  })

  test(`${label}: system to built-in changes the terminal once and never squeezes it`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    const sizes = [f.terminal()]
    f.control.switchMode()
    sizes.push(f.terminal())
    for (const height of [300, 200, 100, 0]) {
      f.keyboard(height)
      sizes.push(f.terminal())
    }
    assert.deepEqual(
      sizes,
      [500, 500, 544, 584, 584, 584],
      'the terminal only grows, to the size the built-in keys leave it',
    )
    assert.equal(f.control.state.switching, false)
  })

  test(`${label}: built-in to system keeps the keys until the IME is there`, (t) => {
    const f = fixture(t, { api })
    f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
    f.control.focus(true)
    assert.equal(f.terminal(), HIDDEN - 260)
    assert.equal(f.virtualKeyboard.shows, 0, 'the built-in keys never ask for the IME')
    f.control.switchMode()
    assert.equal(f.control.state.mode, 'system')
    assert.equal(f.control.state.deck, true, 'no blank frame while the IME is on its way')
    assert.equal(f.control.state.switching, true)
    f.keyboard(344)
    assert.equal(f.control.state.deck, false)
    assert.equal(f.control.state.switching, false)
    assert.equal(f.terminal(), HIDDEN - 344)
    assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'system')
  })

  test(`${label}: a refused switch to the system keyboard closes rather than loops`, (t) => {
    const f = fixture(t, { api })
    f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
    f.control.focus(true)
    f.control.switchMode()
    const asked = f.virtualKeyboard.shows
    t.mock.timers.tick(900)
    assert.equal(f.requested(), false)
    t.mock.timers.tick(5000)
    assert.equal(f.virtualKeyboard.shows, asked)
  })

  test(`${label}: a departing IME that never reports leaving does not hold the layout`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.control.switchMode()
    assert.equal(f.control.state.switching, true)
    t.mock.timers.tick(600)
    assert.equal(f.control.state.switching, false)
    assert.equal(f.control.state.deck, true)
  })

  test(`${label}: the composer takes the IME and gives the prior keyboard back`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.compose()
    assert.equal(f.document.activeElement, f.editor)
    assert.equal(f.control.state.composer, true)
    assert.equal(f.control.state.switching, false, 'the IME is already there')
    assert.equal(f.terminal(), HIDDEN - 344)
    f.control.composer()
    assert.equal(f.document.activeElement, f.textarea)
    assert.equal(f.control.state.composer, false)
    assert.equal(f.requested(), true)
    assert.equal(f.terminal(), HIDDEN - 344)
  })

  test(`${label}: the composer over the built-in keys borrows the IME and restores the keys`, (t) => {
    const f = fixture(t, { api })
    f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
    f.control.focus(true)
    f.compose()
    assert.equal(f.control.state.deck, true, 'keys stay until the IME is there')
    f.keyboard(344)
    assert.equal(f.control.state.deck, false)
    f.control.composer()
    animate(f, [150, 0])
    assert.equal(f.control.state.mode, 'builtin')
    assert.equal(f.terminal(), HIDDEN - 260)
    assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'builtin', 'preference untouched')
  })

  test(`${label}: a composer opened without a keyboard closes it again when collapsed`, (t) => {
    const f = fixture(t, { api })
    f.compose()
    f.keyboard(344)
    assert.equal(f.requested(), true)
    f.control.composer()
    assert.equal(f.requested(), false)
    assert.equal(f.control.state.composer, false)
  })

  test(`${label}: dismissing the IME under the composer keeps the draft open, keyboard off`, (t) => {
    const f = fixture(t, { api })
    f.compose()
    f.keyboard(344)
    f.keyboard(0)
    t.mock.timers.tick(300)
    assert.equal(f.control.state.composer, true)
    assert.equal(f.requested(), false)
    assert.equal(f.lost(), 0)
    const asked = f.editor.focusCalls
    f.compose()
    assert.equal(f.requested(), true, 'tapping the editor asks again')
    assert.equal(f.editor.focusCalls, asked + 1)
  })

  test(`${label}: a file picker returns the keyboard once and gives up if refused`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    const finish = f.control.filePicker()!
    f.keyboard(0)
    t.mock.timers.tick(2000)
    assert.equal(f.requested(), true, 'the picker took the IME, not the user')
    assert.equal(f.control.state.switching, true)
    const asked = f.textarea.focusCalls
    finish(true)
    assert.ok(f.textarea.focusCalls > asked)
    f.keyboard(344)
    assert.equal(f.control.state.switching, false)
    const again = f.control.filePicker()!
    f.keyboard(0)
    again(true)
    t.mock.timers.tick(900)
    assert.equal(f.requested(), false, 'refused after the picker')
  })

  test(`${label}: a dialog borrows focus and the keyboard returns after it`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.control.suspend(true)
    f.keyboard(0)
    t.mock.timers.tick(2000)
    assert.equal(f.requested(), true)
    f.control.suspend(false)
    t.mock.timers.tick(0)
    f.keyboard(344)
    assert.equal(f.document.activeElement, f.textarea)
    assert.equal(f.control.state.switching, false)
    dismissMobileKeyboard()
    assert.equal(f.requested(), false)
  })

  test(`${label}: another editor taking focus closes the keyboard`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.editor.focus()
    return Promise.resolve().then(() => {
      assert.equal(f.requested(), false)
      assert.equal(f.root.attributes.has('data-keyboard-overlay'), false)
    })
  })

  test(`${label}: a hidden page keeps the intent and asks once on return`, (t) => {
    const f = fixture(t, { api })
    f.control.focus(true)
    f.keyboard(344)
    f.document.hidden = true
    f.document.dispatchEvent(new Event('visibilitychange'))
    f.keyboard(0)
    t.mock.timers.tick(5000)
    assert.equal(f.requested(), true)
    f.document.hidden = false
    f.document.dispatchEvent(new Event('visibilitychange'))
    f.keyboard(344)
    assert.equal(f.control.state.switching, false)
    assert.equal(f.terminal(), HIDDEN - 344)
  })

  test(`${label}: rotation measures the keyboards again`, (t) => {
    const f = fixture(t, { api })
    f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
    f.control.focus(true)
    f.rotate(844, 390)
    assert.equal(f.control.state.dockHeight, 390 - 160, 'the keys leave the terminal 160px')
    f.rotate(390, 844)
    assert.equal(f.control.state.dockHeight, 260)
  })
}

test('with the API the IME overlays the page only while this terminal owns it', (t) => {
  const f = fixture(t, { api: true })
  assert.equal(f.textarea.attributes.get('virtualkeyboardpolicy'), 'manual')
  f.control.focus(true)
  assert.equal(f.virtualKeyboard.overlaysContent, true)
  assert.equal(f.virtualKeyboard.shows, 1)
  f.keyboard(344)
  assert.equal(mobileKeyboardInset.value, 344)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(mobileKeyboardOpen.value, true)
  hideMobileKeyboard()
  assert.equal(f.virtualKeyboard.hides, 1)
  assert.equal(f.virtualKeyboard.overlaysContent, true, 'until the closing IME has left')
  f.keyboard(0)
  assert.equal(f.virtualKeyboard.overlaysContent, false)
  assert.equal(mobileKeyboardInset.value, 0)
})

test('an overlay request the browser rejects leaves the page resizing', (t) => {
  const f = fixture(t, { api: true })
  Object.defineProperty(f.virtualKeyboard, 'overlaysContent', {
    get: () => false,
    set() {
      throw new Error('unsupported')
    },
  })
  f.control.focus(true)
  f.resize(500)
  assert.equal(f.root.attributes.has('data-keyboard-overlay'), false)
  assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.terminal(), 500)
})

test('without the API the page resize is the keyboard; the area adds nothing to it', (t) => {
  const f = fixture(t)
  f.control.focus(true)
  f.resize(500)
  assert.equal(f.control.state.dockHeight, 0)
  assert.equal(mobileKeyboardInset.value, 0)
  assert.equal(mobileKeyboardVisible.value, true)
  f.resize(790)
  refreshMobileKeyboardViewport()
  assert.equal(f.requested(), true, 'a small change is browser chrome, not a dismissal')
})

test('physical keys keep typing under the built-in keys and the copy sheet keeps them', (t) => {
  const f = fixture(t)
  f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
  f.control.focus(true)
  t.mock.timers.tick(0)
  assert.equal(f.document.activeElement, f.textarea)
  assert.equal(f.textarea.readOnly, true)
  f.control.suspend(true)
  f.control.suspend(false)
  t.mock.timers.tick(0)
  assert.equal(f.requested(), true)
  assert.equal(f.control.state.deck, true)
  assert.equal(f.control.state.dockHeight, 260)
})

test('a native composition finishes before the input stops being editable', async (t) => {
  const finished = Promise.withResolvers<void>()
  const f = fixture(t, { finishEditing: () => finished.promise })
  f.control.focus(true)
  f.resize(500)
  f.control.switchMode()
  assert.equal(f.textarea.readOnly, false, 'still editable while the composition drains')
  finished.resolve()
  await finished.promise
  await Promise.resolve()
  assert.equal(f.textarea.readOnly, true)
})

test('another terminal taking the keyboard closes this one', (t) => {
  const f = fixture(t, { api: true })
  f.control.focus(true)
  f.keyboard(344)
  const other = f.second()
  other.control.focus(true)
  assert.equal(f.requested(), false)
  assert.equal(f.virtualKeyboard.overlaysContent, true, 'the new owner inherits the overlay')
  other.control.dispose()
})
