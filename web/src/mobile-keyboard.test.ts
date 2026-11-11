import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { viewportPolicy, type InteractiveWidget } from './developer-mode.ts'
import { readViewportFrame } from './viewport-frame.ts'
import { bindMobileKeyboard, dismissMobileKeyboard, hideMobileKeyboard, mobileKeyboardInset, mobileKeyboardVisible, mobileKeyboardOpen, refreshMobileKeyboardViewport, type MobileKeyboardState } from './mobile-keyboard.ts'

interface FixtureOptions { policy?: InteractiveWidget; api?: boolean; finishEditing?: () => Promise<void> }
function fixture(t: TestContext, { policy = 'resizes-content', api = false, finishEditing }: FixtureOptions = {}) {
  const previousPolicy = viewportPolicy.value
  viewportPolicy.value = { viewportFit: 'cover', interactiveWidget: policy }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visual = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 })
  const css = { width: 390, height: 844 }
  const probe = { style: {}, setAttribute() {}, getBoundingClientRect: () => css }
  const root = { attributes: new Set<string>(), toggleAttribute(name: string, force: boolean) { if (force) root.attributes.add(name); else root.attributes.delete(name) } }
  const document = Object.assign(new EventTarget(), { hidden: false, body: { append() {} }, documentElement: root,
    createElement: () => probe, activeElement: null as object | null })
  document.activeElement = document.body
  const window = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, visualViewport: visual })
  // The VirtualKeyboard API: the IME overlays the page only after overlaysContent, as in Chromium.
  const virtualKeyboard = Object.assign(new EventTarget(), { overlaysContent: false, boundingRect: { height: 0 }, shows: 0, hides: 0,
    show() { virtualKeyboard.shows++ }, hide() { virtualKeyboard.hides++ } })
  const storage = new Map<string, string>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const originals = new Map(['window', 'document', 'navigator', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const [name, value] of Object.entries({ window, document, navigator: api ? { virtualKeyboard } : {}, localStorage })) Object.defineProperty(globalThis, name, { configurable: true, value })
  // Focusing one input blurs the previously focused one, as in browsers.
  const input = () => {
    const element = Object.assign(new EventTarget(), {
      readOnly: false, inputMode: 'text', focusCalls: 0, attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) { element.attributes.set(name, value) },
      removeAttribute(name: string) { element.attributes.delete(name) },
      focus() {
        element.focusCalls++
        if (document.activeElement === element) return
        const previous = document.activeElement as { blur?: () => void } | null
        previous?.blur?.()
        document.activeElement = element; element.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('focusin'))
      },
      blur() {
        if (document.activeElement !== element) return
        document.activeElement = document.body; element.dispatchEvent(new Event('blur'))
      },
    })
    return element
  }
  const textarea = input(), editor = input()
  let requested = false, active = true
  const states: MobileKeyboardState[] = []
  const control = bindMobileKeyboard(textarea as unknown as HTMLTextAreaElement, {
    active: () => active, changed: (value, state) => { requested = value; states.push(state) }, finishEditing,
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
  // One IME animation frame: an overlaid IME reports its geometry, otherwise the page resizes.
  const keyboard = (height: number) => {
    if (!virtualKeyboard.overlaysContent) { resize(844 - height); return }
    virtualKeyboard.boundingRect = { height }
    virtualKeyboard.dispatchEvent(new Event('geometrychange'))
  }
  const open = () => { control.focus(true); resize(500) }
  let lost = 0
  const compose = () => control.composer(editor as unknown as HTMLElement, () => { lost++ })
  // The terminal's free height: the frame minus the reserved keyboard area.
  const terminal = () => readViewportFrame().height - control.state.dockHeight
  return { control, textarea, editor, compose, lost: () => lost, states, window, document, root, visual, css, storage, virtualKeyboard, resize, keyboard, terminal, open,
    requested: () => requested, deactivate: () => { active = false } }
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

test('Android Back without blur reopens at once while the keyboard area keeps the terminal in place', t => {
  const f = fixture(t); f.open()
  const before = f.textarea.focusCalls
  f.resize(844)
  assert.equal(f.textarea.focusCalls, before + 1, 'the reopen is requested immediately, not after a held frame')
  assert.equal(f.terminal(), 500); assert.equal(f.control.state.deck, false, 'an empty area, not the built-in keys')
  assert.equal(mobileKeyboardOpen.value, true, 'safe-area stays suppressed while reopening')
  f.resize(500)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.terminal(), 500)
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, true)
})

test('blur followed by closing and reopening keeps the terminal area throughout', async t => {
  const f = fixture(t); f.open(); f.textarea.blur()
  await Promise.resolve()
  assert.equal(f.document.activeElement, f.textarea, 'the reopen refocuses the input')
  for (const height of [700, 844, 700, 500]) { f.resize(height); assert.equal(f.terminal(), 500) }
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.requested(), true)
})

test('a refused reopen turns the keyboard off without a built-in fallback or retry loop', t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.resize(844); t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardOpen.value, false)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: false })
  assert.equal(f.textarea.readOnly, true); assert.equal(mobileKeyboardVisible.value, false)
  f.resize(844); t.mock.timers.tick(3000)
  assert.equal(f.textarea.focusCalls, before + 1, 'one native retry')
})

test('a browser that declines the initial keyboard request leaves the button off', t => {
  const f = fixture(t); f.control.focus(true); t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
})

test('ordinary candidate-bar or browser-toolbar growth never refocuses and changes the terminal once', t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.resize(540); assert.equal(f.terminal(), 500, 'a shrinking IME may be closing: the area holds')
  t.mock.timers.tick(499); assert.equal(f.terminal(), 500)
  t.mock.timers.tick(1)
  assert.equal(f.textarea.focusCalls, before); assert.equal(f.terminal(), 540, 'one change after it settled')
  assert.equal(f.requested(), true); assert.equal(f.control.state.switching, false)
  f.resize(844)
  assert.equal(f.terminal(), 540, 'later recovery holds the new settled native keyboard size')
})

test('a closing animation never grows the terminal', t => {
  const f = fixture(t); f.open()
  for (const height of [550, 600, 650, 700, 750, 800, 844]) {
    f.resize(height); t.mock.timers.tick(20)
    assert.equal(f.terminal(), 500, 'no growing animation frame expands the terminal')
    assert.equal(f.control.state.switching, true, 'native grid changes wait')
  }
  f.resize(500)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.control.state.switching, false)
})

test('other editors and explicit hiding close intent while hidden pages pause recovery', async t => {
  const f = fixture(t); f.open(); f.textarea.blur()
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(f.control.state.dockHeight, 0)
  f.resize(844); f.open(); f.resize(844); hideMobileKeyboard(); await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(f.control.state.dockHeight, 0)
  f.open(); const before = f.textarea.focusCalls
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, false)
  assert.equal(f.control.state.switching, true)
  f.resize(844); assert.equal(f.terminal(), 500, 'the hidden page keeps the area')
  t.mock.timers.tick(2000); assert.equal(f.textarea.focusCalls, before, 'no hidden recovery')
})

test('synchronous clipboard focus restoration preserves the keyboard without refocusing', async t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.textarea.blur(); f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  f.textarea.focus(); await Promise.resolve()
  assert.equal(f.requested(), true); assert.equal(f.textarea.focusCalls, before + 1)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(mobileKeyboardVisible.value, true)
})

test('rotation and terminal disposal invalidate the old dimensions', t => {
  const f = fixture(t); f.open(); f.resize(844)
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  assert.equal(f.control.state.dockHeight, 0, 'portrait keyboard geometry is not imposed on landscape')
  f.deactivate(); f.control.blur()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardVisible.value, false)
})

test('rotation without a reopened keyboard turns the stale intent off', t => {
  const f = fixture(t); f.open()
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  assert.equal(f.control.state.dockHeight, 0)
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
})

test('rotation accepts a keyboard restored at the new landscape dimensions', t => {
  const f = fixture(t); f.open()
  f.window.innerWidth = 844; f.window.innerHeight = 390; f.visual.width = 844; f.resize(390)
  t.mock.timers.tick(250); f.resize(220); t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.textarea.readOnly, false)
  assert.equal(mobileKeyboardVisible.value, true); assert.equal(f.control.state.dockHeight, 0)
  f.resize(390)
  assert.equal(f.control.state.dockHeight, 170, 'later recovery uses landscape keyboard geometry')
})

test('CSS keyboard recovery holds measured layout height, never the double-subtracted visual height', t => {
  const f = fixture(t)
  f.window.innerWidth = 384; f.visual.width = 384; f.css.width = 384
  f.window.innerHeight = 823; f.css.height = 823.47; f.visual.height = 823.47
  f.control.focus(true)
  f.resize(487.2, 199.2)
  assert.equal(f.requested(), true)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(readViewportFrame().height, 487.2)
  assert.equal(f.terminal(), 487.2)
  f.resize(823.47, 535.47)
  assert.equal(f.terminal(), 487.2)
  f.resize(487.2, 199.2)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(readViewportFrame().height, 487.2)
  assert.equal(f.requested(), true)
})

test('explicit visual keyboard mode follows the visual frame while CSS remains full height', t => {
  const f = fixture(t, { policy: 'resizes-visual' })
  f.window.innerWidth = 384; f.visual.width = 384; f.window.innerHeight = 823
  f.css.width = 384; f.css.height = 823.47; f.visual.height = 823.47
  f.control.focus(true)
  f.resize(535.47)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(readViewportFrame().height, 535.47)
  f.resize(823.47)
  assert.equal(f.terminal(), 535.47)
  f.resize(535.47)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.requested(), true)
})

test('CSS-only overlay inset changes drive keyboard intent and recovery without viewport events', t => {
  const f = fixture(t, { policy: 'overlays-content' })
  f.control.focus(true)
  const originalLayout = f.window.innerHeight, originalVisual = f.visual.height
  f.css.height = 520.8
  refreshMobileKeyboardViewport()
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true)
  assert.equal(mobileKeyboardVisible.value, true)
  assert.equal(readViewportFrame().height, 520.8)
  assert.equal(f.window.innerHeight, originalLayout)
  assert.equal(f.visual.height, originalVisual)
  const focusCalls = f.textarea.focusCalls
  f.css.height = 844
  refreshMobileKeyboardViewport()
  assert.equal(f.terminal(), 520.8)
  assert.equal(f.textarea.focusCalls, focusCalls + 1)
  f.css.height = 520.8
  refreshMobileKeyboardViewport()
  assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.requested(), true)
  f.control.blur()
  f.css.height = 844
  refreshMobileKeyboardViewport()
  assert.equal(mobileKeyboardVisible.value, false)
})

test('overlay policy with no reported keyboard geometry retains the bounded opening failure behavior', t => {
  const f = fixture(t, { policy: 'overlays-content' })
  f.control.focus(true)
  refreshMobileKeyboardViewport()
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false)
  assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
  assert.equal(readViewportFrame().height, 844)
})

test('native file selection holds the keyboard area and asks for the IME once after foreground return', async t => {
  const f = fixture(t); f.open()
  const finish = f.control.filePicker()!, before = f.textarea.focusCalls
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  f.textarea.blur(); f.resize(844)
  await Promise.resolve(); t.mock.timers.tick(2000)
  assert.equal(f.requested(), true, 'the system picker does not turn off the user keyboard intent')
  assert.equal(f.textarea.focusCalls, before, 'no hidden recovery attempts')
  assert.equal(f.terminal(), 500, 'the area holds the IME space while the chooser covers the page')
  assert.equal(f.control.state.switching, true, 'native grid changes wait for the return')
  finish(true)
  assert.equal(f.textarea.focusCalls, before, 'a hidden change event waits for foreground')
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.textarea.focusCalls, before + 1)
  f.resize(500); finish(true); await Promise.resolve(); t.mock.timers.tick(2000)
  assert.equal(f.requested(), true); assert.equal(f.textarea.focusCalls, before + 1)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.terminal(), 500)
})

test('picker cancellation preserves a still-visible IME without cycling native focus', async t => {
  const f = fixture(t); f.open()
  let blurs = 0; f.textarea.addEventListener('blur', () => blurs++)
  const finish = f.control.filePicker()!
  finish(true); await Promise.resolve()
  assert.equal(blurs, 0); assert.equal(f.requested(), true)
  assert.equal(f.document.activeElement, f.textarea)
  assert.equal(f.control.state.switching, false)
})

test('picker disposal, explicit keyboard hiding and another editor never restore the old input', async t => {
  const f = fixture(t); f.open()
  const discarded = f.control.filePicker()!, before = f.textarea.focusCalls
  discarded(false); discarded(true)
  assert.equal(f.requested(), false); assert.equal(f.textarea.focusCalls, before)
  f.resize(844); f.open()
  const hidden = f.control.filePicker()!
  hideMobileKeyboard(); hidden(true)
  assert.equal(f.requested(), false)
  f.resize(844); f.open()
  const moved = f.control.filePicker()!, other = {}
  f.textarea.blur(); f.document.activeElement = other
  f.document.dispatchEvent(new Event('focusin')); moved(true); await Promise.resolve()
  assert.equal(f.document.activeElement, other); assert.equal(f.requested(), false)
})

test('picker never opens an initially closed keyboard and a refused restoration turns it off', async t => {
  const f = fixture(t)
  f.control.focus(false); assert.equal(f.control.filePicker(), undefined)
  f.open(); const finish = f.control.filePicker()!, before = f.textarea.focusCalls
  f.resize(844); finish(true)
  assert.equal(f.textarea.focusCalls, before + 1, 'the IME is requested at the change event itself')
  await Promise.resolve(); t.mock.timers.tick(1000)
  assert.equal(f.requested(), false); assert.equal(f.control.state.mode, 'system')
  assert.equal(f.control.state.dockHeight, 0)
  f.resize(844); t.mock.timers.tick(4000)
  assert.equal(f.textarea.focusCalls, before + 1)
})

test('native and builtin handoff preserves the available frame throughout both animations', t => {
  const f = fixture(t); f.open()
  f.control.setBuiltinMinHeight(260)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.deck, true)
  assert.equal(f.requested(), true)
  for (const height of [500, 570, 660, 760, 844]) {
    f.resize(height)
    assert.equal(f.terminal(), 500)
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false)
  assert.equal(f.textarea.readOnly, true)
  assert.equal(f.control.state.dockHeight, 344)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system')
  assert.equal(f.control.state.deck, true, 'the built-in keys stay until the IME covers them')
  for (const height of [844, 760, 660, 570, 500]) {
    f.resize(height)
    assert.equal(f.terminal(), 500)
  }
  assert.equal(f.control.state.switching, false, 'covering the area ends the switch without a timer')
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.control.state.deck, false)
  assert.equal(f.textarea.readOnly, false)
})

test('a closing IME tail below the occlusion threshold still belongs to the switch', t => {
  const f = fixture(t); f.open(); f.control.switchMode()
  for (const height of [600, 760, 800, 830]) {
    f.resize(height)
    assert.equal(f.terminal(), 500, `the closing tail is not a new full frame (${height})`)
    assert.equal(f.control.state.switching, true)
  }
  f.resize(844)
  assert.equal(f.terminal(), 500); assert.equal(f.control.state.switching, false)
})

test('builtin preference survives closing without automatically reopening', t => {
  const f = fixture(t)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'builtin')
  assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'builtin')
  assert.equal(f.requested(), true)
  f.control.blur()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardOpen.value, false)
  f.control.focus()
  assert.equal(f.requested(), false)
  f.control.focus(true)
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.requested(), true)
  assert.equal(f.control.state.dockHeight, 260, 'without a measured IME the dock uses its natural height')
})

test('builtin height clamps oversized system geometry and allows one settled change', t => {
  const f = fixture(t)
  f.control.focus(true); f.resize(244)
  f.control.switchMode()
  assert.equal(f.control.state.switching, true)
  for (const height of [300, 430, 570, 700]) { f.resize(height); assert.equal(f.terminal(), 244, 'no intermediate growth') }
  f.resize(844)
  assert.equal(f.control.state.dockHeight, 460)
  assert.equal(f.control.state.switching, false)
  assert.equal(f.terminal(), 384)
})

test('a declined system switch turns the keyboard off and keeps the explicit preference', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system')
  assert.equal(f.control.state.dockHeight, 344, 'the area holds while the IME is awaited')
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'system')
})

test('copy and paste sheets borrow focus without revoking the builtin keyboard', async t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.control.suspend(true)
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  f.resize(500); await Promise.resolve()
  assert.equal(f.requested(), true); assert.equal(f.control.state.switching, true)
  assert.equal(f.terminal(), 500, 'a sheet IME never moves the terminal')
  f.control.suspend(false); t.mock.timers.tick(0)
  assert.equal(f.control.state.switching, true, 'sheet IME closing still owns the resize hold')
  f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.requested(), true); assert.equal(f.control.state.mode, 'builtin')
  assert.equal(f.control.state.dockHeight, 344)
  assert.equal(mobileKeyboardOpen.value, true)
})

test('builtin file picking preserves keyboard mode and never requests native input', async t => {
  const f = fixture(t); f.control.switchMode()
  const before = f.textarea.focusCalls, finish = f.control.filePicker()!
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(1500); await Promise.resolve()
  finish(true)
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.requested(), true); assert.equal(f.control.state.mode, 'builtin')
  assert.equal(f.control.state.switching, false)
  assert.equal(f.textarea.focusCalls, before)
})

test('explicit hide waits for native composition completion without reopening or late state changes', async t => {
  let finished: (() => void) | undefined
  const f = fixture(t, { finishEditing: () => new Promise<void>(resolve => { finished = resolve }) })
  f.open()
  const focusCalls = f.textarea.focusCalls
  f.control.blur()
  assert.equal(f.requested(), false)
  assert.equal(f.textarea.readOnly, false, 'the final native commit can still drain')
  finished!(); await Promise.resolve()
  assert.equal(f.textarea.readOnly, true)
  assert.equal(f.requested(), false); assert.equal(f.textarea.focusCalls, focusCalls)
  assert.equal(f.document.activeElement, f.document.body)
})

test('a completed builtin handoff restores noneditable terminal focus without stealing another editor', async t => {
  let finished: (() => void) | undefined
  const f = fixture(t, { finishEditing: () => new Promise<void>(resolve => { finished = resolve }) })
  f.open(); f.control.switchMode()
  finished!(); await Promise.resolve()
  assert.equal(f.document.activeElement, f.textarea)
  assert.equal(f.textarea.readOnly, true); assert.equal(f.requested(), true)
  f.control.switchMode(); f.resize(500); t.mock.timers.tick(250)
  f.control.switchMode()
  const other = {}; f.document.activeElement = other
  finished!(); await Promise.resolve()
  assert.equal(f.document.activeElement, other)
})

test('late completion of a hidden input cannot disable a newer system opening', async t => {
  let finished: (() => void) | undefined
  const f = fixture(t, { finishEditing: () => new Promise<void>(resolve => { finished = resolve }) })
  f.open(); f.control.blur()
  f.resize(844); f.open()
  finished!(); await Promise.resolve()
  assert.equal(f.requested(), true); assert.equal(f.textarea.readOnly, false)
  assert.equal(f.document.activeElement, f.textarea)
})

test('activating a closed cached terminal refreshes the device keyboard preference', t => {
  const f = fixture(t)
  assert.equal(f.control.state.mode, 'system')
  f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
  f.control.focus(false)
  assert.equal(f.control.state.mode, 'builtin')
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system', 'switch selects the alternate of the refreshed preference')
})

test('a settled builtin keyboard follows same-width full viewport changes without phantom native input', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.control.state.dockHeight, 344)
  f.resize(700)
  assert.equal(f.control.state.dockHeight, 344)
  assert.equal(f.control.state.switching, false)
  assert.equal(mobileKeyboardVisible.value, false)
  f.resize(390)
  assert.equal(f.control.state.dockHeight, 230, 'tiny frames refit once to retain terminal space')
  assert.equal(mobileKeyboardVisible.value, false)
})

test('automatic modal dismissal preserves borrowed sheet and picker intent while explicit hide remains final', t => {
  const f = fixture(t); f.control.switchMode()
  f.control.suspend(true)
  dismissMobileKeyboard()
  assert.equal(f.requested(), true, 'a keyboard sheet is a temporary focus owner')
  f.control.suspend(false); t.mock.timers.tick(0)
  const finish = f.control.filePicker()!
  dismissMobileKeyboard()
  assert.equal(f.requested(), true, 'a native picker owns its pending restoration')
  hideMobileKeyboard(); finish(true)
  assert.equal(f.requested(), false, 'explicit close cancels even a borrowed input')
  f.control.focus(true)
  dismissMobileKeyboard()
  assert.equal(f.requested(), false, 'an unrelated modal still dismisses the keyboard')
})

test('composer opened over the system keyboard takes the IME in place and returns it to the terminal', t => {
  const f = fixture(t); f.open(); t.mock.timers.tick(1000)
  f.compose()
  assert.equal(f.document.activeElement, f.editor)
  assert.equal(f.lost(), 0)
  assert.equal(f.textarea.readOnly, true, 'the terminal input stops accepting IME input')
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: true })
  assert.equal(f.requested(), true, 'the header keyboard button stays pressed')
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, true)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system', 'the disabled switch cannot replace the composer IME')
  f.control.composer()
  assert.equal(f.document.activeElement, f.textarea); assert.equal(f.textarea.readOnly, false)
  assert.equal(f.control.state.composer, false); assert.equal(f.control.state.dockHeight, 0)
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.control.state.mode, 'system'); assert.equal(f.control.state.switching, false)
  assert.equal(f.lost(), 0)
  assert(f.states.every(state => f.terminal() === 500 && !state.deck))
})

test('composer opened over the builtin dock hands off to the system IME and restores the dock in place', t => {
  const f = fixture(t); f.open(); f.control.setBuiltinMinHeight(260)
  f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.document.activeElement, f.textarea)
  f.compose()
  assert.equal(f.document.activeElement, f.editor); assert.equal(f.control.state.mode, 'system')
  assert.equal(f.control.state.composer, true); assert.equal(f.requested(), true)
  for (const height of [844, 760, 660, 570, 500]) {
    f.resize(height)
    assert.equal(f.terminal(), 500, 'the terminal keeps its frame while the IME opens')
  }
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 0)
  f.control.composer()
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.composer, false)
  for (const height of [500, 570, 660, 760, 844]) {
    f.resize(height)
    assert.equal(f.terminal(), 500, 'the dock replaces the closing IME at the same height')
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 344)
  assert.equal(f.document.activeElement, f.textarea); assert.equal(f.textarea.readOnly, true)
  assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'builtin', 'the composer never changes the preference')
  assert.equal(f.lost(), 0)
})

test('composer opened without a keyboard opens the IME once and collapsing closes it again', t => {
  const f = fixture(t); f.control.focus(false)
  f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
  f.compose()
  assert.equal(f.document.activeElement, f.editor); assert.equal(f.requested(), true)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: true })
  f.resize(500); t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, true)
  f.control.composer()
  assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.document.activeElement, f.document.body)
  assert.equal(f.control.state.mode, 'builtin', 'the closed keyboard shows the device preference again')
  f.resize(844)
  assert.equal(mobileKeyboardVisible.value, false); assert.equal(f.lost(), 0)
})

test('the header keyboard button collapses the composer and closes the keyboard without restoring it', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.compose(); f.resize(500); t.mock.timers.tick(250)
  f.control.blur()
  assert.equal(f.lost(), 1, 'the composer is told to collapse')
  assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.document.activeElement, f.document.body)
  f.control.composer()
  assert.equal(f.requested(), false, 'the composer closing afterwards does not reopen the keyboard')
  f.resize(844); t.mock.timers.tick(2000)
  assert.equal(f.requested(), false); assert.equal(f.lost(), 1)
})

test('unexpected IME loss under the composer reopens on the editor at once, then a refusal collapses it', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const before = f.editor.focusCalls, terminalFocus = f.textarea.focusCalls
  f.resize(844)
  assert.equal(f.editor.focusCalls, before + 1, 'the reopen targets the composer editor immediately')
  assert.equal(f.terminal(), 500, 'the terminal keeps its frame while reopening')
  f.resize(500)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.control.state.composer, true)
  t.mock.timers.tick(1000)
  f.editor.blur(); f.resize(844); await Promise.resolve()
  assert.equal(f.editor.focusCalls, before + 2)
  t.mock.timers.tick(900)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.control.state.mode, 'system'); assert.equal(f.control.state.dockHeight, 0)
  t.mock.timers.tick(4000); await Promise.resolve()
  assert.equal(f.editor.focusCalls, before + 2); assert.equal(f.textarea.focusCalls, terminalFocus, 'no fallback onto the terminal input')
  assert(f.states.every(state => !state.deck), 'no built-in fallback')
})

test('a composer whose IME never appears stays open and editable without the builtin fallback', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.compose(); t.mock.timers.tick(2000)
  assert.equal(f.lost(), 0, 'a hardware keyboard or declined IME keeps the composer')
  assert.equal(f.requested(), true); assert.equal(f.document.activeElement, f.editor)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: true })
  f.resize(500); t.mock.timers.tick(250)
  f.resize(844); t.mock.timers.tick(2000)
  assert.equal(f.lost(), 1, 'once the IME has appeared, losing it for good collapses the composer')
  f.control.composer()
  assert.equal(f.requested(), false, 'the collapsing composer does not reopen the keyboard')
})

test('returning from a hidden page reopens the IME on the composer once, then collapses it', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  f.editor.blur(); f.resize(844); t.mock.timers.tick(2000)
  assert.equal(f.lost(), 0, 'a hidden page does not revoke the composer')
  assert.equal(f.terminal(), 500)
  const before = f.editor.focusCalls
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.editor.focusCalls, before + 1); assert.equal(f.document.activeElement, f.editor)
  t.mock.timers.tick(900)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
})

test('releasing during recovery hands back to the prior keyboard and a reclaim keeps that prior', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.compose(); f.resize(500); t.mock.timers.tick(250)
  f.resize(844)
  assert.equal(f.terminal(), 500, 'recovering')
  f.control.composer()
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.dockHeight, 344)
  t.mock.timers.tick(250)
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.requested(), true)
  f.compose(); f.resize(500); t.mock.timers.tick(250)
  f.control.composer(); f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.control.state.mode, 'builtin', 'a reclaim after a refused send restores the same dock')
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.lost(), 0)
})

test('a keyboard-less terminal focus closes the keyboard and the composer', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.control.focus(false)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.document.activeElement, f.textarea); assert.equal(f.textarea.readOnly, true)
})

test('a terminal IME that does not survive the composer handback closes without the builtin fallback', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.control.composer(); f.resize(844); t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.control.state.mode, 'system')
  assert(f.states.every(state => !state.deck))
})

test('modal dismissal and another editor taking focus collapse the composer', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  dismissMobileKeyboard()
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
  f.resize(844); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin')); await Promise.resolve()
  assert.equal(f.lost(), 2); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
})

test('the composer file picker keeps the composer and asks for its IME at the change event', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const finish = f.control.filePicker()
  assert(finish, 'an open composer IME can be held for the picker')
  f.editor.blur(); f.resize(844); t.mock.timers.tick(2000); await Promise.resolve()
  assert.equal(f.lost(), 0, 'leaving for the chooser does not collapse the composer')
  assert.equal(f.control.state.composer, true); assert.equal(f.terminal(), 500)
  finish(true)
  assert.equal(f.document.activeElement, f.editor, 'returning restores the composer editor at once')
  f.resize(500); t.mock.timers.tick(1000)
  assert.equal(f.lost(), 0); assert.equal(f.control.state.composer, true); assert.equal(f.requested(), true)
})

test('a refused IME after the composer picker keeps the composer open with the keyboard off until a tap', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const finish = f.control.filePicker()!
  f.editor.blur(); f.resize(844); finish(true); t.mock.timers.tick(900)
  assert.equal(f.lost(), 0, 'the composer stays open with its new attachment')
  assert.equal(f.requested(), false, 'the header keyboard button shows off')
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: true })
  assert.equal(f.document.activeElement, f.editor)
  const before = f.editor.focusCalls
  f.compose()
  assert.equal(f.requested(), true); assert.equal(f.editor.focusCalls, before + 1, 'a tap on the editor asks for its IME')
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false, 'a refused retry returns to the same state'); assert.equal(f.lost(), 0)
  f.control.focus(true)
  assert.equal(f.requested(), true, 'the keyboard button retries on the editor'); assert.equal(f.document.activeElement, f.editor)
  f.resize(500); t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.control.state.composer, true)
  f.resize(844); t.mock.timers.tick(900)
  assert.equal(f.lost(), 1, 'an IME lost later collapses it as usual')
})

test('collapsing a composer whose IME is off leaves the keyboard closed', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const finish = f.control.filePicker()!
  f.editor.blur(); f.resize(844); finish(true); t.mock.timers.tick(900)
  const terminalFocus = f.textarea.focusCalls
  f.control.composer()
  assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.textarea.focusCalls, terminalFocus, 'no IME is requested for the terminal')
})

test('with the VirtualKeyboard API the IME overlays the page and the area reserves its inset', t => {
  const f = fixture(t, { api: true })
  assert.equal(f.textarea.attributes.get('virtualkeyboardpolicy'), 'manual', 'the IME opens only on explicit requests')
  assert.equal(f.virtualKeyboard.overlaysContent, false, 'a closed keyboard leaves the page policy alone')
  f.control.focus(true)
  assert.equal(f.virtualKeyboard.overlaysContent, true); assert(f.root.attributes.has('data-keyboard-overlay'))
  assert.equal(f.virtualKeyboard.shows, 1)
  f.keyboard(340)
  assert.equal(f.window.innerHeight, 844, 'the page never resizes for the IME')
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 340, deck: false, switching: false, composer: false })
  assert.equal(mobileKeyboardInset.value, 340); assert.equal(mobileKeyboardVisible.value, true)
  t.mock.timers.tick(1000); assert.equal(f.requested(), true)
  f.keyboard(380)
  assert.equal(f.control.state.dockHeight, 380, 'a taller IME grows the area at once')
  f.control.blur()
  assert.equal(f.virtualKeyboard.hides, 1)
  assert.equal(f.control.state.dockHeight, 380, 'the area follows its own closing IME')
  assert.equal(f.virtualKeyboard.overlaysContent, true)
  f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.virtualKeyboard.overlaysContent, false); assert(!f.root.attributes.has('data-keyboard-overlay'))
  assert.equal(mobileKeyboardInset.value, 0)
})

test('switching system and built-in keyboards keeps the overlay area height on every frame', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340); f.control.setBuiltinMinHeight(258)
  const switches = f.states.length
  f.control.switchMode()
  assert.equal(f.virtualKeyboard.hides, 1)
  for (const height of [340, 280, 190, 90, 20, 0]) {
    f.keyboard(height)
    assert.equal(f.control.state.dockHeight, 340, `built-in keys replace the IME at its height (${height})`)
    assert.equal(f.control.state.deck, true)
  }
  assert.equal(f.control.state.switching, false, 'the closed IME ends the switch')
  f.control.switchMode()
  assert.equal(f.virtualKeyboard.shows, 2)
  for (const height of [0, 40, 150, 260, 330]) {
    f.keyboard(height)
    assert.equal(f.control.state.dockHeight, 340, `the IME rises over the built-in keys (${height})`)
    assert.equal(f.control.state.deck, true); assert.equal(f.control.state.switching, true)
  }
  f.keyboard(340)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 340, deck: false, switching: false, composer: false })
  assert(f.states.slice(switches).every(state => state.dockHeight === 340), 'no published frame changes the area')
})

test('the built-in keys take the height of the system keyboard they replace within their bounds', t => {
  const f = fixture(t, { api: true }); f.control.setBuiltinMinHeight(258)
  f.control.focus(true); f.keyboard(300); f.control.switchMode(); f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 300)
  f.control.switchMode(); f.keyboard(500); f.control.switchMode(); f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 460, 'an oversized IME is clamped')
  f.control.switchMode(); f.keyboard(200); t.mock.timers.tick(500); f.control.switchMode(); f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 258, 'the keys never shrink below their minimum rows')
})

test('an oversized overlay IME replaced by the built-in keys changes the area once, after it closed', t => {
  const f = fixture(t, { api: true }); f.control.setBuiltinMinHeight(258); f.control.focus(true); f.keyboard(600)
  const switches = f.states.length
  f.control.switchMode()
  for (const height of [520, 400, 260, 100, 10]) { f.keyboard(height); assert.equal(f.control.state.dockHeight, 600) }
  f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 460); assert.equal(f.control.state.switching, false)
  assert.deepEqual([...new Set(f.states.slice(switches).map(state => state.dockHeight))], [600, 460])
})

test('a built-in switch whose IME stops reporting geometry still ends and releases native resizing', t => {
  const f = fixture(t, { api: true }); f.control.setBuiltinMinHeight(258); f.control.focus(true); f.keyboard(340)
  f.control.switchMode()
  assert.equal(f.control.state.switching, true)
  t.mock.timers.tick(500)
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 340)
})

test('without a measured system keyboard the built-in keys use their minimum rows', t => {
  const f = fixture(t, { api: true }); f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
  f.control.setBuiltinMinHeight(258); f.control.focus(true)
  assert.equal(f.control.state.dockHeight, 258); assert.equal(f.virtualKeyboard.overlaysContent, true)
  assert.equal(f.virtualKeyboard.shows, 0, 'the built-in keys never request the IME')
})

test('an IME settling below the held area releases it once', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340); f.control.switchMode(); f.keyboard(0)
  f.control.switchMode()
  for (const height of [100, 200, 300]) { f.keyboard(height); assert.equal(f.control.state.dockHeight, 340) }
  t.mock.timers.tick(499)
  assert.equal(f.control.state.dockHeight, 340); assert.equal(f.control.state.switching, true)
  t.mock.timers.tick(1)
  assert.equal(f.control.state.dockHeight, 300); assert.equal(f.control.state.switching, false)
})

test('an unexpectedly dismissed overlay IME is shown again at once and a refusal turns the keyboard off', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  f.keyboard(0)
  assert.equal(f.virtualKeyboard.shows, 2, 'show() is called immediately')
  assert.equal(f.control.state.dockHeight, 340); assert.equal(f.control.state.deck, false)
  f.keyboard(340)
  assert.equal(f.control.state.dockHeight, 340); assert.equal(f.control.state.switching, false)
  for (const height of [300, 200, 80, 0]) { f.keyboard(height); assert.equal(f.control.state.dockHeight, 340) }
  assert.equal(f.virtualKeyboard.shows, 3, 'one request per dismissal')
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.virtualKeyboard.overlaysContent, false)
  t.mock.timers.tick(4000); assert.equal(f.virtualKeyboard.shows, 3)
})

test('the overlay composer owns the IME through a dismissal; a refused reopen collapses it', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  f.compose()
  assert.equal(f.editor.attributes.get('virtualkeyboardpolicy'), 'manual')
  assert.equal(f.document.activeElement, f.editor); assert.equal(f.control.state.dockHeight, 340)
  f.keyboard(0)
  assert.equal(f.virtualKeyboard.shows, 3, 'reopened on the editor'); assert.equal(f.control.state.dockHeight, 340)
  t.mock.timers.tick(900)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
  assert(!f.editor.attributes.has('virtualkeyboardpolicy'))
})

test('the overlay composer picker asks show() at the change event and keeps the composer when refused', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340); f.compose()
  const finish = f.control.filePicker()!, shows = f.virtualKeyboard.shows
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  f.editor.blur(); f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 340, 'the area holds while the chooser covers the page')
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.virtualKeyboard.shows, shows, 'foreground alone does not ask for the IME')
  finish(true)
  assert.equal(f.virtualKeyboard.shows, shows + 1, 'the change event asks within its user activation')
  assert.equal(f.document.activeElement, f.editor)
  t.mock.timers.tick(900)
  assert.equal(f.lost(), 0); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, true)
  assert.equal(f.control.state.dockHeight, 0); assert.equal(f.virtualKeyboard.overlaysContent, false)
  f.compose()
  assert.equal(f.virtualKeyboard.overlaysContent, true); assert.equal(f.virtualKeyboard.shows, shows + 2)
  f.keyboard(340)
  assert.equal(f.requested(), true); assert.equal(f.control.state.dockHeight, 340)
})

test('an overlay composer without any IME (hardware keyboard) stays open', t => {
  const f = fixture(t, { api: true })
  f.compose(); t.mock.timers.tick(2000)
  assert.equal(f.lost(), 0); assert.equal(f.requested(), true)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, deck: false, switching: false, composer: true })
})

test('another editor taking focus ends the overlay at once so its page can resize', async t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin')); await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(f.virtualKeyboard.overlaysContent, false)
  assert.equal(f.control.state.dockHeight, 0)
})

test('a keyboard-less terminal focus hides an open overlay IME', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  f.control.focus(false)
  assert.equal(f.virtualKeyboard.hides, 1, 'a manual keyboard policy does not hide on blur alone')
  assert.equal(f.requested(), false); assert.equal(f.document.activeElement, f.textarea)
})

test('another terminal taking the keyboard inherits and ends the page overlay', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  const other = Object.assign(new EventTarget(), { inputMode: 'text', readOnly: false, setAttribute() {}, removeAttribute() {},
    focus() { f.document.activeElement = other }, blur() { if (f.document.activeElement === other) f.document.activeElement = f.document.body } })
  const second = bindMobileKeyboard(other as unknown as HTMLElement, { active: () => true, changed() {} })
  second.focus(false)
  assert.equal(f.virtualKeyboard.hides, 1, 'the previous terminal closes its IME')
  assert.equal(f.virtualKeyboard.overlaysContent, true, 'its closing IME still overlays the page')
  f.keyboard(0)
  assert.equal(f.virtualKeyboard.overlaysContent, false, 'the new owner ends the overlay once that IME closed')
  assert(!f.root.attributes.has('data-keyboard-overlay'))
  second.dispose()
})

test('without the API, opening the system keyboard on an already focused input refocuses it', t => {
  const f = fixture(t); f.storage.set('canvas:mobile-keyboard-mode', 'builtin'); f.control.focus(false)
  let focusEvents = 0; f.textarea.addEventListener('focus', () => focusEvents++)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system'); assert.equal(focusEvents, 1, 'a fresh focus requests the IME')
})

test('without the API, the keyboard button over a kept composer refocuses its editor', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const finish = f.control.filePicker()!
  f.resize(844); finish(true); t.mock.timers.tick(900)
  assert.equal(f.requested(), false); assert.equal(f.document.activeElement, f.editor)
  let focusEvents = 0; f.editor.addEventListener('focus', () => focusEvents++)
  f.control.focus(true)
  assert.equal(focusEvents, 1)
})

test('tapping an overlay composer whose IME never appeared asks for it', t => {
  const f = fixture(t, { api: true })
  f.compose(); t.mock.timers.tick(2000)
  const shows = f.virtualKeyboard.shows
  f.compose()
  assert.equal(f.virtualKeyboard.shows, shows + 1)
  t.mock.timers.tick(900); assert.equal(f.lost(), 0, 'still a hardware-keyboard composer when refused')
})

test('a blur that leaves the overlay IME up releases the held area after confirmation', async t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340); f.control.switchMode(); f.keyboard(0)
  f.control.switchMode(); f.keyboard(300); t.mock.timers.tick(500)
  f.textarea.blur(); await Promise.resolve()
  assert.equal(f.control.state.switching, true)
  t.mock.timers.tick(900)
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 300); assert.equal(f.requested(), true)
})

test('an overlay built-in deck refits when the window gets shorter at the same width', t => {
  const f = fixture(t, { api: true }); f.control.setBuiltinMinHeight(258); f.control.focus(true); f.keyboard(400)
  f.control.switchMode(); f.keyboard(0)
  assert.equal(f.control.state.dockHeight, 400)
  f.window.innerHeight = 500; f.css.height = 500; f.visual.height = 500; f.visual.dispatchEvent(new Event('resize'))
  assert.equal(f.control.state.dockHeight, 340, 'the terminal keeps its 160px reserve')
})

test('disposing the overlay owner restores the page policy', t => {
  const f = fixture(t, { api: true }); f.control.focus(true); f.keyboard(340)
  f.control.dispose()
  assert.equal(f.virtualKeyboard.overlaysContent, false); assert(!f.root.attributes.has('data-keyboard-overlay'))
  assert(!f.textarea.attributes.has('virtualkeyboardpolicy')); assert.equal(mobileKeyboardInset.value, 0)
})
