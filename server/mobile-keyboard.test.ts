import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { viewportPolicy } from '../web/src/developer-mode.ts'
import { readViewportFrame } from '../web/src/viewport-frame.ts'
import { bindMobileKeyboard, hideMobileKeyboard, mobileKeyboardFrame, mobileKeyboardVisible } from '../web/src/mobile-keyboard.ts'

function fixture(t: TestContext, policy: 'resizes-content' | 'resizes-visual' = 'resizes-content') {
  const previousPolicy = viewportPolicy.value
  viewportPolicy.value = { viewportFit: 'cover', interactiveWidget: policy }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visual = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 })
  const css = { width: 390, height: 844 }
  const probe = { style: {}, setAttribute() {}, getBoundingClientRect: () => css }
  const document = Object.assign(new EventTarget(), { hidden: false, body: { append() {} }, documentElement: {},
    createElement: () => probe, activeElement: null as object | null })
  document.activeElement = document.body
  const window = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, visualViewport: visual })
  const originals = new Map(['window', 'document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const [name, value] of Object.entries({ window, document, navigator: {} })) Object.defineProperty(globalThis, name, { configurable: true, value })
  const textarea = Object.assign(new EventTarget(), {
    readOnly: false, inputMode: 'text', focusCalls: 0,
    focus() {
      this.focusCalls++
      if (document.activeElement === this) return
      document.activeElement = this; textarea.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('focusin'))
    },
    blur() {
      if (document.activeElement !== this) return
      document.activeElement = document.body; textarea.dispatchEvent(new Event('blur'))
    },
  })
  let requested = false, active = true
  const control = bindMobileKeyboard(textarea as unknown as HTMLTextAreaElement, {
    active: () => active, changed: value => { requested = value },
  })
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
    if (policy === 'resizes-content') { css.height = height; window.innerHeight = Math.floor(height) }
    else css.height = window.innerHeight
    visual.height = visualHeight
    visual.dispatchEvent(new Event('resize'))
  }
  const open = () => { control.focus(true); resize(500) }
  return { control, textarea, window, document, visual, css, resize, open, requested: () => requested, deactivate: () => { active = false } }
}

test('mobile keyboard off gates all native focus while explicit opening permits input', t => {
  const f = fixture(t)
  f.control.focus(false)
  assert.equal(f.textarea.readOnly, true); assert.equal(f.textarea.inputMode, 'none')
  f.textarea.blur(); f.textarea.focus()
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true)
  f.open()
  assert.equal(f.requested(), true); assert.equal(f.textarea.inputMode, 'text'); assert.equal(f.textarea.readOnly, false)
  assert.equal(mobileKeyboardVisible.value, true)
  f.control.blur()
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true); assert.equal(f.textarea.inputMode, 'none')
  assert.equal(mobileKeyboardVisible.value, true, 'safe-area remains suppressed during the native closing animation')
  f.resize(844)
  assert.equal(mobileKeyboardVisible.value, false)
})

test('opening an already focused noneditable input refreshes the native focus type', t => {
  const f = fixture(t)
  const focusTypes: string[] = []
  f.textarea.addEventListener('focus', () => focusTypes.push(f.textarea.readOnly ? 'none' : f.textarea.inputMode))
  f.control.focus(false)
  assert.deepEqual(focusTypes, ['none'])
  f.open()
  assert.deepEqual(focusTypes, ['none', 'text'], 'native focus must see the newly enabled editor')
  f.control.focus()
  assert.deepEqual(focusTypes, ['none', 'text'], 'ordinary terminal touch must not restart an active IME')
  f.control.blur(); f.resize(844); f.control.focus()
  assert.deepEqual(focusTypes, ['none', 'text', 'none'])
  f.open()
  assert.deepEqual(focusTypes, ['none', 'text', 'none', 'text'], 'reopening refreshes input policy each time')
})

test('Android Back without blur restores once and locks the previous terminal viewport', async t => {
  const f = fixture(t); f.open()
  const before = f.textarea.focusCalls
  f.resize(844)
  assert.deepEqual(mobileKeyboardFrame.value, { width: 390, height: 500, top: 0, left: 0 })
  assert.equal(mobileKeyboardVisible.value, true)
  await Promise.resolve()
  assert.equal(f.textarea.focusCalls, before + 1)
  f.resize(500)
  assert.equal(mobileKeyboardFrame.value, undefined)
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, true)
})

test('blur followed by closing and reopening never releases the saved viewport early', async t => {
  const f = fixture(t); f.open(); f.textarea.blur()
  assert.equal(mobileKeyboardFrame.value?.height, 500)
  await Promise.resolve()
  f.resize(844); t.mock.timers.tick(140); f.resize(500)
  assert.equal(mobileKeyboardFrame.value, undefined)
  assert.equal(f.requested(), true)
})

test('rejected keyboard restoration closes intent and never retries in a loop', async t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.resize(844); await Promise.resolve(); t.mock.timers.tick(800)
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardFrame.value, undefined)
  assert.equal(f.textarea.readOnly, true); assert.equal(mobileKeyboardVisible.value, false)
  f.resize(844); t.mock.timers.tick(3000); await Promise.resolve()
  assert.equal(f.textarea.focusCalls, before + 1)
})

test('a browser that declines the initial keyboard request leaves the button off', t => {
  const f = fixture(t); f.control.focus(true); t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
})

test('ordinary candidate-bar or browser-toolbar growth never refocuses the input', async t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.resize(540); assert.equal(mobileKeyboardFrame.value?.height, 500)
  await Promise.resolve(); t.mock.timers.tick(250)
  assert.equal(f.textarea.focusCalls, before); assert.equal(mobileKeyboardFrame.value?.height, undefined)
  assert.equal(f.requested(), true)
  f.resize(844)
  assert.equal(mobileKeyboardFrame.value?.height, 540, 'later recovery uses the new settled native keyboard size')
})

test('closing animation does not replace the last stable keyboard viewport', async t => {
  const f = fixture(t); f.open()
  for (const height of [550, 600, 650, 700, 750, 800, 844]) {
    f.resize(height); t.mock.timers.tick(20)
    assert.equal(mobileKeyboardFrame.value?.height, 500, 'no growing animation frame expands the terminal')
  }
  await Promise.resolve()
  assert.equal(mobileKeyboardFrame.value?.height, 500)
  f.resize(500)
  assert.equal(mobileKeyboardFrame.value, undefined)
})

test('other editors, explicit hiding and hidden pages cancel pending recovery', async t => {
  const f = fixture(t); f.open(); f.textarea.blur()
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardFrame.value, undefined)
  f.resize(844); f.open(); f.resize(844); hideMobileKeyboard(); await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardFrame.value, undefined)
  f.open(); f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardVisible.value, false)
})

test('synchronous clipboard focus restoration preserves the keyboard without refocusing', async t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.textarea.blur(); f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  f.textarea.focus(); await Promise.resolve()
  assert.equal(f.requested(), true); assert.equal(f.textarea.focusCalls, before + 1)
  assert.equal(mobileKeyboardFrame.value, undefined); assert.equal(mobileKeyboardVisible.value, true)
})

test('rotation and terminal disposal invalidate the old locked dimensions', async t => {
  const f = fixture(t); f.open(); f.resize(844); await Promise.resolve()
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  assert.equal(mobileKeyboardFrame.value, undefined)
  f.deactivate(); f.control.blur()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardVisible.value, false)
})

test('rotation without a reopened keyboard turns the stale intent off', t => {
  const f = fixture(t); f.open()
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  assert.equal(mobileKeyboardFrame.value, undefined)
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
})

test('rotation accepts a keyboard restored at the new landscape dimensions', t => {
  const f = fixture(t); f.open()
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  t.mock.timers.tick(250); f.resize(220); t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.textarea.readOnly, false)
  assert.equal(mobileKeyboardVisible.value, true); assert.equal(mobileKeyboardFrame.value?.height, undefined)
  f.resize(390)
  assert.equal(mobileKeyboardFrame.value?.height, 220, 'later recovery uses landscape keyboard geometry')
})


test('CSS keyboard recovery holds measured layout height, never the double-subtracted visual height', async t => {
  const f = fixture(t)
  f.window.innerWidth = 384; f.visual.width = 384; f.css.width = 384
  f.window.innerHeight = 823; f.css.height = 823.47; f.visual.height = 823.47
  f.control.focus(true)
  f.resize(487.2, 199.2)
  assert.equal(f.requested(), true)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(Boolean(mobileKeyboardFrame.value), false)
  assert.equal(readViewportFrame().height, 487.2)
  f.resize(823.47, 535.47)
  assert.equal(mobileKeyboardFrame.value?.height, 487.2)
  await Promise.resolve()
  f.resize(487.2, 199.2)
  assert.equal(Boolean(mobileKeyboardFrame.value), false)
  assert.equal(readViewportFrame().height, 487.2)
  assert.equal(f.requested(), true)
})

test('explicit visual keyboard mode follows the visual frame while CSS remains full height', async t => {
  const f = fixture(t, 'resizes-visual')
  f.window.innerWidth = 384; f.visual.width = 384; f.window.innerHeight = 823
  f.css.width = 384; f.css.height = 823.47; f.visual.height = 823.47
  f.control.focus(true)
  f.resize(535.47)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(readViewportFrame().height, 535.47)
  f.resize(823.47)
  assert.equal(mobileKeyboardFrame.value?.height, 535.47)
  await Promise.resolve()
  f.resize(535.47)
  assert.equal(Boolean(mobileKeyboardFrame.value), false)
  assert.equal(f.requested(), true)
})
