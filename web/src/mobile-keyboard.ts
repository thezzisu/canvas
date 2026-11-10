import { ref, shallowRef } from 'vue'
import { readViewportFrame, type ViewportFrame } from './viewport-frame'

export const mobileKeyboardFrame = shallowRef<ViewportFrame>()
export const mobileKeyboardVisible = ref(false)
export const mobileKeyboardOpen = ref(false)
export type MobileKeyboardMode = 'system' | 'builtin'
export interface MobileKeyboardState { mode: MobileKeyboardMode; dockHeight: number; switching: boolean; unavailable: boolean; composer: boolean }

interface VirtualKeyboard extends EventTarget {
  boundingRect: { height: number }
  show(): void
  hide(): void
}
interface KeyboardOptions {
  active(): boolean
  changed(requested: boolean, state: MobileKeyboardState): void
  setEditable?(value: boolean): void
  finishEditing?(): Promise<void>
  scale?(): number
}
const preferenceKey = 'canvas:mobile-keyboard-mode'
function preferredMode(): MobileKeyboardMode {
  try { return localStorage.getItem(preferenceKey) === 'builtin' ? 'builtin' : 'system' } catch { return 'system' }
}
function saveMode(mode: MobileKeyboardMode) { try { localStorage.setItem(preferenceKey, mode) } catch { /* Storage can be unavailable. */ } }
let owner: ReturnType<typeof bindMobileKeyboard> | undefined
export function hideMobileKeyboard() { owner?.blur() }
export function dismissMobileKeyboard() { owner?.dismiss() }
export function refreshMobileKeyboardViewport() { owner?.refreshViewport() }

/** One open intent owns either the native IME or its replacement dock. */
export function bindMobileKeyboard(textarea: HTMLElement, options: KeyboardOptions) {
  const visual = window.visualViewport
  const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard
  const read = readViewportFrame
  const scale = () => options.scale?.() || 1
  let baseline = { width: window.innerWidth, height: Math.max(window.innerHeight, read().height), scale: scale() }
  let requested = false, mode = preferredMode(), unavailable = false
  let changingFocus = false, suspended = false
  let picker: { returned: boolean } | undefined
  let lastVisible: ViewportFrame | undefined
  let nativeHeight = 0, builtinMinHeight = 260 * scale(), builtinHeight = builtinMinHeight
  let switching = false, bridgeTarget: number | undefined
  let recovery: { frame: ViewportFrame; moved: boolean } | undefined
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let visibleTimer: ReturnType<typeof setTimeout> | undefined
  let switchTimer: ReturnType<typeof setTimeout> | undefined
  let disableTimer: ReturnType<typeof setTimeout> | undefined
  let inputRevision = 0, resumeTimer: ReturnType<typeof setTimeout> | undefined
  let published: string | undefined
  // The composer editor owns native input while open; release restores the prior keyboard.
  // `shown` records that its IME appeared; only then can losing the IME collapse it.
  let composer: { element: HTMLElement; prior?: MobileKeyboardMode; lost?: () => void; shown?: boolean } | undefined
  const input = () => composer?.element || textarea
  const occluded = (frame: ViewportFrame) => (keyboard?.boundingRect.height || 0) > 0
    || baseline.height - frame.height > Math.max(80, baseline.height * .15)
  function state(): MobileKeyboardState {
    const frame = recovery?.frame || read()
    const target = mode === 'builtin' ? baseline.height - builtinHeight : bridgeTarget
    return { mode, dockHeight: requested && target !== undefined ? Math.max(0, frame.height - target) : 0,
      switching: switching || suspended || !!picker || requested && document.hidden, unavailable, composer: !!composer }
  }
  function publish() {
    if (owner === controller) {
      mobileKeyboardOpen.value = requested && options.active()
      mobileKeyboardVisible.value = options.active() && !document.hidden && (occluded(read()) || !!recovery)
    }
    const next = state(), signature = JSON.stringify([requested, next])
    if (signature === published) return
    published = signature; options.changed(requested, next)
  }
  const inputMode = (restoreBuiltinFocus = false) => {
    clearTimeout(disableTimer); disableTimer = undefined
    const revision = ++inputRevision
    const editable = requested && mode === 'system' && !suspended && !composer
    const apply = () => {
      if (options.setEditable) options.setEditable(editable)
      else (textarea as HTMLTextAreaElement).readOnly = !editable
      textarea.inputMode = editable ? 'text' : 'none'
      if (restoreBuiltinFocus && requested && mode === 'builtin' && !suspended && !picker && owner === controller && options.active() && !document.hidden) {
        const active = document.activeElement
        if (active === textarea || active === document.body || active === document.documentElement) textarea.focus({ preventScroll: true })
      }
    }
    // Native blur may finish a composition after blur itself. Let its final
    // input task drain before making the rich editor noneditable.
    if (!editable && options.finishEditing) {
      void options.finishEditing().then(() => { if (revision === inputRevision) apply() })
    } else if (!editable && mode === 'builtin') {
      disableTimer = setTimeout(() => { disableTimer = undefined; if (revision === inputRevision) apply() }, 0)
    } else apply()
  }
  function fitHeight(height: number) {
    const maximum = Math.max(0, Math.min(460 * scale(), baseline.height - 160 * scale()))
    return Math.min(maximum, Math.max(Math.min(builtinMinHeight, maximum), height))
  }
  function cancelTimers() {
    clearTimeout(openingTimer); openingTimer = undefined
    clearTimeout(recoveryTimer); recoveryTimer = undefined
    clearTimeout(visibleTimer); visibleTimer = undefined
    clearTimeout(switchTimer); switchTimer = undefined
    recovery = undefined; switching = false; bridgeTarget = undefined
    if (owner === controller) mobileKeyboardFrame.value = undefined
  }
  function show(refocus = false) {
    const element = input()
    changingFocus = true
    try {
      if (refocus) element.blur()
      element.focus({ preventScroll: true })
      try { keyboard?.show() } catch { /* Focus is the fallback when the platform declines explicit control. */ }
    } finally { changingFocus = false }
  }
  function hideNative(restoreBuiltinFocus = false) {
    changingFocus = true
    try { input().blur(); inputMode(restoreBuiltinFocus); try { keyboard?.hide() } catch { /* Blur also closes native input. */ } }
    finally { changingFocus = false }
  }
  function settleSwitch() {
    clearTimeout(switchTimer)
    switchTimer = setTimeout(() => {
      switchTimer = undefined
      if (!requested || suspended || picker) return
      if (mode === 'system' && !occluded(read())) return
      switching = false; bridgeTarget = undefined; publish()
    }, 200)
  }
  function useBuiltin(failed = false) {
    const oldHeight = nativeHeight || baseline.height - (lastVisible?.height || read().height)
    cancelTimers(); mode = 'builtin'; unavailable = failed
    builtinHeight = fitHeight(oldHeight || builtinHeight || builtinMinHeight)
    switching = occluded(read()); hideNative(true); publish()
    if (switching) settleSwitch()
  }
  function confirmOpening(fallback = false) {
    clearTimeout(openingTimer)
    openingTimer = setTimeout(() => {
      openingTimer = undefined
      if (!requested || mode !== 'system' || occluded(read())) return
      // A composer whose IME never appeared (hardware keyboard, declined focus)
      // stays open and editable; a tap on the editor can still raise the IME.
      if (composer && !composer.shown) { switching = false; bridgeTarget = undefined; publish() }
      else if (fallback && !composer) useBuiltin(true)
      else controller.blur()
    }, 900)
  }
  /** Move the system IME to the current input while holding the terminal's available frame. */
  function handoff(fallback: boolean, target = (recovery?.frame || read()).height - state().dockHeight) {
    cancelTimers(); mode = 'system'; switching = true; bridgeTarget = target
    inputMode(); show(true); confirmOpening(fallback); publish()
    if (occluded(read())) settleSwitch()
  }
  function dropComposer(close: boolean) {
    const current = composer
    if (!current) return
    composer = undefined
    current.element.removeEventListener('blur', blurred)
    if (close) { current.element.blur(); mode = preferredMode() }
    return current
  }
  function finishRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined; recovery = undefined
    mobileKeyboardFrame.value = undefined
  }
  function recover() {
    if (picker || suspended || recovery || mode !== 'system' || !lastVisible || !requested || !options.active() || document.hidden) return
    clearTimeout(visibleTimer); visibleTimer = undefined
    recovery = { frame: { ...lastVisible }, moved: read().height > lastVisible.height + 2 }
    mobileKeyboardFrame.value = recovery.frame
    publish()
    recoveryTimer = setTimeout(() => {
      if (requested && options.active() && !document.hidden && occluded(read()) && document.activeElement === input()) {
        finishRecovery(); observe()
      // The composer has no replacement keyboard: losing its IME collapses it instead.
      } else if (requested && options.active() && !document.hidden && !composer) useBuiltin(true)
      else controller.blur()
    }, 800)
    queueMicrotask(() => {
      if (!recovery || !requested) return
      const active = document.activeElement
      if (!options.active() || document.hidden || (active && active !== input() && active !== document.body && active !== document.documentElement)) {
        controller.blur(); return
      }
      // Synchronous clipboard copying can return focus within this task.
      if (active === input() && !recovery.moved && occluded(read())) { finishRecovery(); publish(); return }
      show(true)
    })
  }
  function observe() {
    if (owner !== controller || picker || suspended) return
    if (!options.active()) { controller.blur(); return }
    if (document.hidden) return
    const frame = read()
    if (Math.abs(window.innerWidth - baseline.width) > 1 || scale() !== baseline.scale) {
      cancelTimers(); lastVisible = undefined; nativeHeight = 0
      baseline = { width: window.innerWidth, height: Math.max(window.innerHeight, frame.height), scale: scale() }
      builtinHeight = fitHeight(builtinHeight)
      if (requested && mode === 'system') confirmOpening()
    }
    const visible = occluded(frame)
    if (!requested) {
      if (!visible) baseline.height = Math.max(window.innerHeight, frame.height)
      publish(); return
    }
    if (mode === 'builtin') {
      if (!switching && frame.height !== baseline.height) {
        // With native input disabled this is the full available frame, not a
        // newly opened IME inferred from an obsolete larger baseline.
        baseline.height = frame.height; nativeHeight = 0; lastVisible = undefined
        builtinHeight = fitHeight(builtinHeight)
      } else if (!visible) baseline.height = Math.max(baseline.height, window.innerHeight, frame.height)
      if (switching) settleSwitch()
      publish(); return
    }
    if (recovery) {
      if (frame.height > recovery.frame.height + 2) recovery.moved = true
      if (recovery.moved && visible && frame.height <= recovery.frame.height + 2 && document.activeElement === input()) finishRecovery()
    } else if (!switching && lastVisible && !visible) recover()
    if (visible) {
      clearTimeout(openingTimer); openingTimer = undefined
      if (composer) composer.shown = true
      if (switching) {
        lastVisible = frame; nativeHeight = Math.max(0, baseline.height - frame.height); settleSwitch()
      } else if (!recovery) {
        clearTimeout(visibleTimer)
        if (!lastVisible || frame.height <= lastVisible.height + 2) {
          lastVisible = frame; nativeHeight = Math.max(0, baseline.height - frame.height); mobileKeyboardFrame.value = undefined
        } else {
          // Candidate bars and a closing animation share growing frames. Settle
          // the former without refocus, keep the latter's stable terminal size.
          mobileKeyboardFrame.value = lastVisible
          visibleTimer = setTimeout(() => {
            visibleTimer = undefined
            if (requested && mode === 'system' && !recovery && occluded(read())) {
              lastVisible = read(); nativeHeight = Math.max(0, baseline.height - lastVisible.height)
              mobileKeyboardFrame.value = undefined; publish()
            }
          }, 200)
        }
      }
    }
    publish()
  }
  function focused() { if (options.active()) inputMode() }
  function blurred() { if (!changingFocus && requested && !suspended) recover() }
  function focusChanged() {
    queueMicrotask(() => {
      if (!picker && !suspended && mode === 'system' && requested && document.activeElement !== input() && document.activeElement !== document.body && document.activeElement !== document.documentElement) controller.blur()
    })
  }
  function finishPicker() {
    if (!picker?.returned || document.hidden) return
    picker = undefined
    if (!requested || owner !== controller || !options.active()) { publish(); return }
    const active = document.activeElement
    if (active !== input() && active !== document.body && active !== document.documentElement) { controller.blur(); return }
    if (mode === 'system') {
      const visible = occluded(read())
      switching = true; bridgeTarget = baseline.height - (nativeHeight || builtinHeight)
      inputMode(); show(!visible)
      if (!visible) confirmOpening(true)
    } else inputMode(true)
    observe()
  }
  function visibilityChanged() {
    if (picker) { finishPicker(); return }
    if (document.hidden && owner === controller) {
      cancelTimers(); publish()
    } else if (requested && owner === controller && options.active()) {
      if (mode === 'system') { inputMode(); show(); confirmOpening(true) }
      observe()
    }
  }
  const controller = {
    get state() { return state() },
    refreshViewport: observe,
    setBuiltinMinHeight(height: number) {
      if (!(height > 0) || !Number.isFinite(height) || Math.abs(height - builtinMinHeight) < 1) return
      builtinMinHeight = height
      if (requested && mode === 'builtin') builtinHeight = fitHeight(builtinHeight)
      publish()
    },
    switchMode() {
      if (!options.active() || composer) return
      if (owner !== controller) { owner?.blur(); owner = controller }
      if (!requested) mode = preferredMode()
      const next = mode === 'system' ? 'builtin' : 'system'
      baseline.height = Math.max(baseline.height, window.innerHeight, read().height)
      unavailable = false; requested = true
      saveMode(next)
      if (next === 'builtin') useBuiltin()
      else handoff(true, baseline.height - builtinHeight)
    },
    /** Lend the system IME to the composer editor in place, or return it to the prior keyboard. */
    composer(element?: HTMLElement, lost?: () => void) {
      if (!element) {
        const prior = composer?.prior, available = options.active() && !document.hidden
        if (!composer) return
        if (prior === 'system' && available) { dropComposer(false); handoff(false) }
        else if (prior === 'builtin' && available) { dropComposer(true); useBuiltin() }
        else { dropComposer(true); controller.blur() }
        return
      }
      if (!options.active()) return
      if (owner !== controller) { owner?.blur(); owner = controller }
      const prior = composer ? composer.prior : requested ? mode : undefined
      dropComposer(false)
      composer = { element, prior, lost }
      element.addEventListener('blur', blurred)
      unavailable = false
      if (prior) { handoff(false); return }
      cancelTimers(); lastVisible = undefined; requested = true; mode = 'system'
      baseline = { width: window.innerWidth, height: Math.max(baseline.height, window.innerHeight, read().height), scale: scale() }
      confirmOpening(); inputMode(); show(); observe()
    },
    suspend(value: boolean) {
      clearTimeout(resumeTimer); resumeTimer = undefined
      if (value) {
        if (suspended) return
        suspended = true; cancelTimers(); hideNative(); publish()
      } else if (suspended) {
        // Let the closing modal release its own focus before restoring native
        // input. Its temporary focus target must not revoke the open intent.
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined; suspended = false
          if (requested && options.active() && !document.hidden) {
            if (mode === 'system') {
              switching = true; bridgeTarget = baseline.height - (nativeHeight || builtinHeight)
              inputMode(); show(); confirmOpening(true)
            } else if (occluded(read())) { switching = true; hideNative(true); settleSwitch() }
            else inputMode(true)
          }
          observe(); publish()
        }, 0)
      }
    },
    /** Native file selection temporarily owns foreground/focus, not open intent. */
    filePicker() {
      if (!requested || owner !== controller) return
      const current: { returned: boolean } = { returned: false }
      picker = current
      cancelTimers(); lastVisible = undefined; publish()
      return (restore: boolean) => {
        if (picker !== current) return
        if (!restore) { controller.blur(); return }
        current.returned = true; finishPicker()
      }
    },
    focus(value?: boolean) {
      if (!options.active()) return
      if (value === false && composer) controller.blur()
      if (!requested) mode = preferredMode()
      if (owner !== controller) { owner?.blur(); owner = controller }
      if (value !== undefined && value !== requested) {
        cancelTimers(); lastVisible = undefined
        changingFocus = true
        try { textarea.blur() } finally { changingFocus = false }
        requested = value
        if (value) {
          mode = preferredMode(); unavailable = false
          baseline = { width: window.innerWidth, height: Math.max(baseline.height, window.innerHeight, read().height), scale: scale() }
          if (mode === 'system') confirmOpening()
          else builtinHeight = fitHeight(nativeHeight || builtinMinHeight)
        }
      }
      if (suspended) { publish(); return }
      inputMode()
      if (requested && mode === 'system') show()
      else textarea.focus({ preventScroll: true })
      observe()
    },
    dismiss() { if (!suspended && !picker) controller.blur() },
    blur() {
      const lost = dropComposer(true)?.lost
      picker = undefined; suspended = false
      clearTimeout(resumeTimer); resumeTimer = undefined; inputRevision++
      cancelTimers(); lastVisible = undefined; requested = false; unavailable = false
      if (options.active() || owner === controller) hideNative()
      publish(); lost?.()
    },
    dispose() {
      controller.blur()
      if (owner === controller) { owner = undefined; mobileKeyboardVisible.value = false; mobileKeyboardOpen.value = false }
      textarea.removeEventListener('focus', focused); textarea.removeEventListener('blur', blurred)
      document.removeEventListener('focusin', focusChanged); document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('resize', observe); visual?.removeEventListener('resize', observe); visual?.removeEventListener('scroll', observe)
      keyboard?.removeEventListener('geometrychange', observe)
    },
  }
  textarea.addEventListener('focus', focused); textarea.addEventListener('blur', blurred)
  document.addEventListener('focusin', focusChanged); document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('resize', observe); visual?.addEventListener('resize', observe); visual?.addEventListener('scroll', observe)
  keyboard?.addEventListener('geometrychange', observe)
  return controller
}
