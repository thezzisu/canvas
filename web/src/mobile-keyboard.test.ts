import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { viewportPolicy, type InteractiveWidget } from './developer-mode.ts'
import { readViewportFrame } from './viewport-frame.ts'
import { bindMobileKeyboard, dismissMobileKeyboard, hideMobileKeyboard, mobileKeyboardFrame, mobileKeyboardVisible, mobileKeyboardOpen, refreshMobileKeyboardViewport, type MobileKeyboardState } from './mobile-keyboard.ts'

function fixture(t: TestContext, policy: InteractiveWidget = 'resizes-content', finishEditing?: () => Promise<void>) {
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
  const storage = new Map<string, string>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const originals = new Map(['window', 'document', 'navigator', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const [name, value] of Object.entries({ window, document, navigator: {}, localStorage })) Object.defineProperty(globalThis, name, { configurable: true, value })
  // Focusing one input blurs the previously focused one, as in browsers.
  const input = () => {
    const element = Object.assign(new EventTarget(), {
      readOnly: false, inputMode: 'text', focusCalls: 0,
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
  const open = () => { control.focus(true); resize(500) }
  let lost = 0
  const compose = () => control.composer(editor as unknown as HTMLElement, () => { lost++ })
  return { control, textarea, editor, compose, lost: () => lost, states, window, document, visual, css, storage, resize, open, requested: () => requested, deactivate: () => { active = false } }
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

test('rejected keyboard restoration replaces the IME without resizing or retrying in a loop', async t => {
  const f = fixture(t); f.open(); const before = f.textarea.focusCalls
  f.resize(844); await Promise.resolve(); t.mock.timers.tick(800)
  t.mock.timers.tick(0)
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardFrame.value, undefined)
  assert.deepEqual(f.control.state, { mode: 'builtin', dockHeight: 344, switching: false, unavailable: true, composer: false })
  assert.equal(f.textarea.readOnly, true); assert.equal(mobileKeyboardVisible.value, false)
  assert.equal(mobileKeyboardOpen.value, true)
  f.resize(844); t.mock.timers.tick(3000); await Promise.resolve()
  assert.equal(f.textarea.focusCalls, before + 2, 'one native retry and one noneditable builtin focus')
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

test('other editors and explicit hiding close intent while hidden pages pause recovery', async t => {
  const f = fixture(t); f.open(); f.textarea.blur()
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardFrame.value, undefined)
  f.resize(844); f.open(); f.resize(844); hideMobileKeyboard(); await Promise.resolve()
  assert.equal(f.requested(), false); assert.equal(mobileKeyboardFrame.value, undefined)
  f.open(); f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.requested(), true); assert.equal(mobileKeyboardVisible.value, false)
  assert.equal(f.control.state.switching, true)
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


test('CSS-only overlay inset changes drive keyboard intent and bounded recovery without viewport events', async t => {
  const f = fixture(t, 'overlays-content')
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
  assert.equal(mobileKeyboardFrame.value?.height, 520.8)
  await Promise.resolve()
  assert.equal(f.textarea.focusCalls, focusCalls + 1)
  f.css.height = 520.8
  refreshMobileKeyboardViewport()
  assert.equal(Boolean(mobileKeyboardFrame.value), false)
  assert.equal(f.requested(), true)
  f.control.blur()
  f.css.height = 844
  refreshMobileKeyboardViewport()
  assert.equal(mobileKeyboardVisible.value, false)
})

test('overlay mode with no reported keyboard geometry retains the bounded opening failure behavior', t => {
  const f = fixture(t, 'overlays-content')
  f.control.focus(true)
  refreshMobileKeyboardViewport()
  t.mock.timers.tick(900)
  assert.equal(f.requested(), false)
  assert.equal(f.textarea.readOnly, true)
  assert.equal(mobileKeyboardVisible.value, false)
  assert.equal(mobileKeyboardFrame.value, undefined)
  assert.equal(readViewportFrame().height, 844)
})

test('native file selection suspends keyboard recovery and resumes once after foreground return', async t => {
  const f = fixture(t); f.open()
  const finish = f.control.filePicker()!, before = f.textarea.focusCalls
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  f.textarea.blur(); f.resize(844)
  await Promise.resolve(); t.mock.timers.tick(2000)
  assert.equal(f.requested(), true, 'the system picker does not turn off the user keyboard intent')
  assert.equal(f.textarea.focusCalls, before, 'no hidden recovery attempts')
  assert.equal(mobileKeyboardFrame.value, undefined, 'old keyboard geometry is not imposed on the picker')
  finish(true)
  assert.equal(f.textarea.focusCalls, before, 'a hidden change event waits for foreground')
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.textarea.focusCalls, before + 1)
  f.resize(500); finish(true); await Promise.resolve(); t.mock.timers.tick(2000)
  assert.equal(f.requested(), true); assert.equal(f.textarea.focusCalls, before + 1)
})

test('picker cancellation preserves a still-visible IME without cycling native focus', async t => {
  const f = fixture(t); f.open()
  let blurs = 0; f.textarea.addEventListener('blur', () => blurs++)
  const finish = f.control.filePicker()!
  finish(true); await Promise.resolve()
  assert.equal(blurs, 0); assert.equal(f.requested(), true)
  assert.equal(f.document.activeElement, f.textarea)
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

test('picker never opens an initially closed keyboard and a declined restoration remains bounded', async t => {
  const f = fixture(t)
  f.control.focus(false); assert.equal(f.control.filePicker(), undefined)
  f.open(); const finish = f.control.filePicker()!, before = f.textarea.focusCalls
  f.resize(844); finish(true)
  await Promise.resolve(); t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.control.state.mode, 'builtin')
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.control.state.unavailable, true)
  assert.equal(f.textarea.focusCalls, before + 2, 'native restoration then noneditable builtin focus')
  f.resize(844); t.mock.timers.tick(4000)
  assert.equal(f.textarea.focusCalls, before + 2)
})


test('native and builtin handoff preserves the available frame throughout both animations', t => {
  const f = fixture(t); f.open()
  f.control.setBuiltinMinHeight(260)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'builtin')
  assert.equal(f.requested(), true)
  for (const height of [500, 570, 660, 760, 844]) {
    f.resize(height)
    assert.equal(height - f.control.state.dockHeight, 500)
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false)
  assert.equal(f.textarea.readOnly, true)
  assert.equal(f.control.state.dockHeight, 344)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system')
  for (const height of [844, 760, 660, 570, 500]) {
    f.resize(height)
    assert.equal(height - f.control.state.dockHeight, 500)
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false)
  assert.equal(f.control.state.dockHeight, 0)
  assert.equal(f.textarea.readOnly, false)
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
  assert.equal(f.control.state.dockHeight, 260)
})

test('builtin height clamps oversized system geometry and allows one settled change', t => {
  const f = fixture(t)
  f.control.focus(true); f.resize(244)
  f.control.switchMode()
  assert.equal(f.control.state.switching, true)
  f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.control.state.dockHeight, 460)
  assert.equal(f.control.state.switching, false)
  assert.equal(844 - f.control.state.dockHeight, 384)
})

test('declined system switch keeps an available builtin dock and explicit preference', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system')
  assert.equal(f.control.state.dockHeight, 344)
  t.mock.timers.tick(900)
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.dockHeight, 344)
  assert.equal(f.control.state.unavailable, true); assert.equal(f.requested(), true)
  assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'system', 'one failure does not overwrite the preference')
})

test('copy and paste sheets borrow focus without revoking the builtin keyboard', async t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.control.suspend(true)
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'))
  f.resize(500); await Promise.resolve()
  assert.equal(f.requested(), true); assert.equal(f.control.state.switching, true)
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
  const f = fixture(t, 'resizes-content', () => new Promise<void>(resolve => { finished = resolve }))
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
  const f = fixture(t, 'resizes-content', () => new Promise<void>(resolve => { finished = resolve }))
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
  const f = fixture(t, 'resizes-content', () => new Promise<void>(resolve => { finished = resolve }))
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
  assert.equal(mobileKeyboardFrame.value, undefined, 'the terminal input blur starts no recovery'); assert.equal(f.lost(), 0)
  assert.equal(f.textarea.readOnly, true, 'the terminal input stops accepting IME input')
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, switching: true, unavailable: false, composer: true })
  assert.equal(f.requested(), true, 'the header keyboard button stays pressed')
  t.mock.timers.tick(1000)
  assert.equal(f.control.state.switching, false); assert.equal(f.requested(), true)
  assert.equal(mobileKeyboardFrame.value, undefined); assert.equal(mobileKeyboardVisible.value, true)
  f.control.switchMode()
  assert.equal(f.control.state.mode, 'system', 'the disabled switch cannot replace the composer IME')
  f.control.composer()
  assert.equal(f.document.activeElement, f.textarea); assert.equal(f.textarea.readOnly, false)
  assert.equal(f.control.state.composer, false); assert.equal(f.control.state.dockHeight, 0)
  t.mock.timers.tick(1000)
  assert.equal(f.requested(), true); assert.equal(f.control.state.mode, 'system'); assert.equal(f.control.state.switching, false)
  assert.equal(f.lost(), 0)
  assert(f.states.every(state => !state.unavailable))
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
    assert.equal(height - f.control.state.dockHeight, 500, 'the terminal keeps its frame while the IME opens')
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 0)
  f.control.composer()
  assert.equal(f.control.state.mode, 'builtin'); assert.equal(f.control.state.composer, false)
  for (const height of [500, 570, 660, 760, 844]) {
    f.resize(height)
    assert.equal(height - f.control.state.dockHeight, 500, 'the dock replaces the closing IME at the same height')
  }
  t.mock.timers.tick(250)
  assert.equal(f.control.state.switching, false); assert.equal(f.control.state.dockHeight, 344)
  assert.equal(f.document.activeElement, f.textarea); assert.equal(f.textarea.readOnly, true)
  assert.equal(f.storage.get('canvas:mobile-keyboard-mode'), 'builtin', 'the composer never changes the preference')
  assert.equal(f.lost(), 0); assert(f.states.every(state => !state.unavailable))
})

test('composer opened without a keyboard opens the IME once and collapsing closes it again', t => {
  const f = fixture(t); f.control.focus(false)
  f.storage.set('canvas:mobile-keyboard-mode', 'builtin')
  f.compose()
  assert.equal(f.document.activeElement, f.editor); assert.equal(f.requested(), true)
  assert.deepEqual(f.control.state, { mode: 'system', dockHeight: 0, switching: false, unavailable: false, composer: true })
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

test('unexpected IME loss under the composer gets one bounded reopen on the editor, then collapses it', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const before = f.editor.focusCalls, terminalFocus = f.textarea.focusCalls
  f.resize(844)
  assert.equal(mobileKeyboardFrame.value?.height, 500, 'the terminal keeps its frame while recovering')
  await Promise.resolve()
  assert.equal(f.editor.focusCalls, before + 1, 'the reopen targets the composer editor')
  f.resize(500)
  assert.equal(mobileKeyboardFrame.value, undefined); assert.equal(f.control.state.composer, true)
  t.mock.timers.tick(1000)
  f.editor.blur(); f.resize(844); await Promise.resolve()
  assert.equal(f.editor.focusCalls, before + 2)
  t.mock.timers.tick(800)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
  assert.equal(f.control.state.mode, 'system'); assert.equal(f.control.state.dockHeight, 0)
  assert.equal(mobileKeyboardFrame.value, undefined)
  t.mock.timers.tick(4000); await Promise.resolve()
  assert.equal(f.editor.focusCalls, before + 2); assert.equal(f.textarea.focusCalls, terminalFocus, 'no fallback onto the terminal input')
  assert(f.states.every(state => !state.unavailable), 'no system-keyboard-unavailable fallback')
})

test('a declined composer IME collapses the composer with the keyboard closed instead of the builtin fallback', t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.compose(); t.mock.timers.tick(900)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
  assert.deepEqual(f.control.state, { mode: 'builtin', dockHeight: 0, switching: false, unavailable: false, composer: false })
  assert(f.states.every(state => !state.unavailable))
  f.control.composer()
  assert.equal(f.requested(), false, 'the collapsing composer does not reopen the keyboard')
})

test('returning from a hidden page reopens the IME on the composer once, then collapses it', t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'))
  f.editor.blur(); f.resize(844); t.mock.timers.tick(2000)
  assert.equal(f.lost(), 0, 'a hidden page does not revoke the composer')
  const before = f.editor.focusCalls
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.editor.focusCalls, before + 1); assert.equal(f.document.activeElement, f.editor)
  t.mock.timers.tick(900)
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
  assert(f.states.every(state => !state.unavailable))
})

test('releasing during recovery hands back to the prior keyboard and a reclaim keeps that prior', async t => {
  const f = fixture(t); f.open(); f.control.switchMode(); f.resize(844); t.mock.timers.tick(250)
  f.compose(); f.resize(500); t.mock.timers.tick(250)
  f.resize(844); await Promise.resolve()
  assert.equal(mobileKeyboardFrame.value?.height, 500, 'recovering')
  f.control.composer()
  assert.equal(mobileKeyboardFrame.value, undefined); assert.equal(f.control.state.mode, 'builtin')
  t.mock.timers.tick(250)
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.requested(), true)
  f.compose(); f.resize(500); t.mock.timers.tick(250)
  f.control.composer(); f.resize(844); t.mock.timers.tick(250)
  assert.equal(f.control.state.mode, 'builtin', 'a reclaim after a refused send restores the same dock')
  assert.equal(f.control.state.dockHeight, 344); assert.equal(f.lost(), 0)
  t.mock.timers.tick(2000); assert(f.states.every(state => !state.unavailable))
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
  assert(f.states.every(state => !state.unavailable))
})

test('modal dismissal and another editor taking focus collapse the composer', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  dismissMobileKeyboard()
  assert.equal(f.lost(), 1); assert.equal(f.requested(), false)
  f.resize(844); f.open(); f.compose(); t.mock.timers.tick(1000)
  f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin')); await Promise.resolve()
  assert.equal(f.lost(), 2); assert.equal(f.requested(), false); assert.equal(f.control.state.composer, false)
})

test('the composer file picker keeps the composer and its IME through the native chooser', async t => {
  const f = fixture(t); f.open(); f.compose(); t.mock.timers.tick(1000)
  const finish = f.control.filePicker()
  assert(finish, 'an open composer IME can be held for the picker')
  f.editor.blur(); f.resize(844); t.mock.timers.tick(2000); await Promise.resolve()
  assert.equal(f.lost(), 0, 'leaving for the chooser does not collapse the composer')
  assert.equal(f.control.state.composer, true)
  finish(true); await Promise.resolve()
  assert.equal(f.document.activeElement, f.editor, 'returning restores the composer editor')
  f.resize(500); t.mock.timers.tick(1000)
  assert.equal(f.lost(), 0); assert.equal(f.control.state.composer, true)
  assert(f.states.every(state => !state.unavailable))
})
