import { ref, shallowRef } from 'vue'
import { readViewportFrame, type ViewportFrame } from './viewport-frame'

export const mobileKeyboardFrame = shallowRef<ViewportFrame>()
export const mobileKeyboardVisible = ref(false)

interface VirtualKeyboard extends EventTarget {
  boundingRect: { height: number }
  show(): void
  hide(): void
}
interface KeyboardOptions { active(): boolean; changed(requested: boolean): void; setEditable?(value: boolean): void }
let owner: ReturnType<typeof bindMobileKeyboard> | undefined
export function hideMobileKeyboard() { owner?.blur() }

/** Keep native keyboard intent, input focus and its temporary viewport together. */
export function bindMobileKeyboard(textarea: HTMLElement, options: KeyboardOptions) {
  const visual = window.visualViewport
  const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard
  const read = readViewportFrame
  let baseline = { width: window.innerWidth, height: Math.max(window.innerHeight, read().height) }
  let requested = false
  let changingFocus = false
  let lastVisible: ViewportFrame | undefined
  let recovery: { frame: ViewportFrame; moved: boolean } | undefined
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let visibleTimer: ReturnType<typeof setTimeout> | undefined
  const occluded = (frame: ViewportFrame) => (keyboard?.boundingRect.height || 0) > 0
    || baseline.height - frame.height > Math.max(80, baseline.height * .15)
  const updateIntent = (value: boolean) => { requested = value; options.changed(value) }
  const inputMode = () => {
    if (options.setEditable) options.setEditable(requested)
    else (textarea as HTMLTextAreaElement).readOnly = !requested
    textarea.inputMode = requested ? 'text' : 'none'
  }
  function confirmOpening() {
    openingTimer = setTimeout(() => { openingTimer = undefined; if (requested && !occluded(read())) controller.blur() }, 900)
  }
  function cancelTimers() {
    clearTimeout(openingTimer); openingTimer = undefined
    clearTimeout(recoveryTimer); recoveryTimer = undefined
    clearTimeout(visibleTimer); visibleTimer = undefined
    recovery = undefined
    if (owner === controller) mobileKeyboardFrame.value = undefined
  }
  function show(refocus = false) {
    changingFocus = true
    try {
      if (refocus) textarea.blur()
      textarea.focus({ preventScroll: true })
      try { keyboard?.show() } catch { /* Focus is the fallback when the platform declines explicit control. */ }
    } finally { changingFocus = false }
  }
  function finishRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined; recovery = undefined
    mobileKeyboardFrame.value = undefined
  }
  function recover() {
    if (recovery || !lastVisible || !requested || !options.active() || document.hidden) return
    clearTimeout(visibleTimer); visibleTimer = undefined
    recovery = { frame: { ...lastVisible }, moved: read().height > lastVisible.height + 2 }
    mobileKeyboardFrame.value = recovery.frame
    mobileKeyboardVisible.value = true
    recoveryTimer = setTimeout(() => {
      if (requested && options.active() && !document.hidden && occluded(read()) && document.activeElement === textarea) {
        finishRecovery(); observe()
      } else controller.blur()
    }, 800)
    queueMicrotask(() => {
      if (!recovery || !requested) return
      const active = document.activeElement
      if (!options.active() || document.hidden || (active && active !== textarea && active !== document.body && active !== document.documentElement)) {
        controller.blur(); return
      }
      // HTTP clipboard copying temporarily moves focus within one task.
      if (active === textarea && !recovery.moved && occluded(read())) { finishRecovery(); return }
      show(true)
    })
  }
  function observe() {
    if (owner !== controller) return
    if (!options.active() || document.hidden) { controller.blur(); mobileKeyboardVisible.value = false; return }
    const frame = read()
    if (Math.abs(window.innerWidth - baseline.width) > 1) {
      cancelTimers(); lastVisible = undefined
      baseline = { width: window.innerWidth, height: Math.max(window.innerHeight, frame.height) }
      if (requested) confirmOpening()
    }
    const visible = occluded(frame)
    if (!requested) {
      if (!visible) baseline.height = Math.max(window.innerHeight, frame.height)
      mobileKeyboardVisible.value = visible
      return
    }
    if (recovery) {
      if (frame.height > recovery.frame.height + 2) recovery.moved = true
      if (recovery.moved && visible && frame.height <= recovery.frame.height + 2 && document.activeElement === textarea) finishRecovery()
    } else if (lastVisible && !visible) recover()
    if (visible) {
      clearTimeout(openingTimer); openingTimer = undefined
      if (!recovery) {
        clearTimeout(visibleTimer)
        if (!lastVisible || frame.height <= lastVisible.height + 2) {
          lastVisible = frame; mobileKeyboardFrame.value = undefined
        } else {
          // A growing viewport can be keyboard dismissal or a smaller candidate
          // bar. Hold the last size until that distinction settles, without focus.
          mobileKeyboardFrame.value = lastVisible
          visibleTimer = setTimeout(() => {
            visibleTimer = undefined
            if (requested && !recovery && occluded(read())) { lastVisible = read(); mobileKeyboardFrame.value = undefined }
          }, 200)
        }
      }
    }
    mobileKeyboardVisible.value = visible || !!recovery
  }
  function focused() { if (options.active()) inputMode() }
  function blurred() { if (!changingFocus && requested) recover() }
  function focusChanged() {
    queueMicrotask(() => {
      if (requested && document.activeElement !== textarea && document.activeElement !== document.body && document.activeElement !== document.documentElement) controller.blur()
    })
  }
  function visibilityChanged() { if (document.hidden && owner === controller) controller.blur() }
  const controller = {
    focus(value?: boolean) {
      if (!options.active()) return
      if (owner !== controller) { owner?.blur(); owner = controller }
      if (value !== undefined && value !== requested) {
        cancelTimers(); lastVisible = undefined
        // Android caches rich-input support when focus changes. End the old
        // noneditable focus before enabling the editor, then focus it again
        // within the same user gesture so IME opening and image MIME types agree.
        changingFocus = true
        try { textarea.blur() } finally { changingFocus = false }
        updateIntent(value)
        if (value) {
          baseline = { width: window.innerWidth, height: Math.max(baseline.height, window.innerHeight, read().height) }
          confirmOpening()
        }
      }
      inputMode()
      if (requested) show()
      else textarea.focus({ preventScroll: true })
      observe()
    },
    blur() {
      cancelTimers(); lastVisible = undefined; updateIntent(false)
      if (options.active() || owner === controller) {
        changingFocus = true
        try {
          textarea.blur()
          inputMode()
          try { keyboard?.hide() } catch { /* Readonly and blur also close the native input. */ }
        } finally { changingFocus = false }
      }
      if (owner === controller) mobileKeyboardVisible.value = options.active() && !document.hidden && occluded(read())
    },
    dispose() {
      controller.blur()
      if (owner === controller) { owner = undefined; mobileKeyboardVisible.value = false }
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
