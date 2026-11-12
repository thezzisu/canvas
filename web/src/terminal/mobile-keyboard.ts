import { ref } from 'vue'
import { readViewportFrame } from '../lib/viewport-frame'

export const mobileKeyboardVisible = ref(false)
export const mobileKeyboardOpen = ref(false)
/** Height of a system IME overlaying the page (VirtualKeyboard API) in page CSS pixels, otherwise 0. */
export const mobileKeyboardInset = ref(0)
export type MobileKeyboardMode = 'system' | 'builtin'
/**
 * `dockHeight` is the keyboard area the terminal card reserves below its helper row;
 * `deck` shows the built-in keys in it rather than an empty area under the system IME.
 * While `switching`, keyboards are changing places and the terminal keeps its grid.
 */
export interface MobileKeyboardState {
  mode: MobileKeyboardMode
  dockHeight: number
  deck: boolean
  switching: boolean
  composer: boolean
}

interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean
  readonly boundingRect: { height: number }
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
  try {
    return localStorage.getItem(preferenceKey) === 'builtin' ? 'builtin' : 'system'
  } catch {
    return 'system'
  }
}
function saveMode(mode: MobileKeyboardMode) {
  try {
    localStorage.setItem(preferenceKey, mode)
  } catch {
    /* Storage can be unavailable. */
  }
}
// A requested IME that has not appeared by then was refused by the platform.
const arrivalLimit = 900
// An IME asked to close that still reports itself after this is laid out as it is.
const departureLimit = 600
// An IME whose height has not changed for this long has finished moving.
const steadyDelay = 150
// An IME that vanishes and is back within this was changing, not dismissed.
const dismissalGrace = 300
const resting = (element: Element | null) =>
  !element || element === document.body || element === document.documentElement
let owner: ReturnType<typeof bindMobileKeyboard> | undefined
// The page has one IME policy; only the keyboard owner changes it, so a new owner inherits it.
let overlaid = false
function setOverlay(api: VirtualKeyboard, value: boolean) {
  try {
    api.overlaysContent = value
    overlaid = value
  } catch {
    // The page then resizes as without the API.
    overlaid = false
  }
  document.documentElement.toggleAttribute('data-keyboard-overlay', overlaid)
}
export function hideMobileKeyboard() {
  owner?.blur()
}
export function dismissMobileKeyboard() {
  owner?.dismiss()
}
export function refreshMobileKeyboardViewport() {
  owner?.refreshViewport()
}

/**
 * One open intent owns either the system IME or the built-in keys, in one keyboard area under the
 * terminal. The area is never predicted: it is the IME's measured height, or the built-in keys'
 * own height, whichever is on screen. With the VirtualKeyboard API the IME overlays the page and
 * reports its rectangle; without it the page resizes and the area only holds the built-in keys.
 *
 * The user is in charge of the IME. Dismissing it (Back, the IME's own hide key) closes the
 * keyboard; nothing reopens it but a tap. Only an interruption the user did not aim at the
 * keyboard, such as a file picker or a dialog, asks for it again once, and gives up if refused.
 *
 * While keyboards change places there is one bounded wait (`pending`), so the terminal moves
 * once: the built-in keys stay until the IME that replaces them has arrived, and where the page
 * resizes they appear once the IME they replace has left.
 */
export function bindMobileKeyboard(textarea: HTMLElement, options: KeyboardOptions) {
  const visual = window.visualViewport
  const api = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard
  const scale = () => options.scale?.() || 1
  const frameHeight = () => Math.max(window.innerHeight, readViewportFrame().height)
  // The page's height without an IME, for the current width and interface scale.
  let baseline = { width: window.innerWidth, height: frameHeight(), scale: scale() }
  let open = false,
    mode = preferredMode()
  // `inset` is the IME's height over the page bottom; `shrink` is the part of it by which the page
  // itself resized (all of it without the API, none of it under an honoured overlay).
  let inset = 0,
    shrink = 0
  // The IME has been on screen for the current system keyboard; losing it then is a dismissal.
  let seen = false
  // What the keyboards are waiting for: the IME to arrive, to stop moving, to leave, or to
  // return after it vanished.
  // `fromDeck` keeps the built-in keys painted until the IME that replaces them is there.
  let pending:
    | {
        for: 'arrival' | 'steady' | 'departure' | 'return'
        timer: ReturnType<typeof setTimeout>
        fromDeck: boolean
      }
    | undefined
  let suspended = false
  let picker: { returned: boolean } | undefined
  let changingFocus = false
  let deckHeight = 0
  let disableTimer: ReturnType<typeof setTimeout> | undefined
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  let inputRevision = 0
  let published: string | undefined
  // The composer editor owns native input while open; releasing it restores the prior keyboard.
  let composer: { element: HTMLElement; prior?: MobileKeyboardMode; lost?: () => void } | undefined
  const input = () => composer?.element || textarea
  const threshold = () => Math.max(80, baseline.height * 0.15)
  const reported = () => (overlaid && api ? api.boundingRect.height : 0)
  // Small page resizes are browser chrome, not an IME.
  const present = () => reported() > 0 || shrink > threshold()
  // An IME asked to leave is gone once nothing of it is left on screen.
  const gone = () => reported() <= 0 && shrink <= 1
  const interrupted = () => suspended || !!picker || document.hidden

  function measure() {
    shrink = Math.max(0, baseline.height - readViewportFrame().height)
    inset = Math.max(shrink, reported())
  }
  // The built-in keys leave part of a short frame to the terminal.
  const deck = () => Math.max(0, Math.min(deckHeight, baseline.height - 160 * scale()))
  // The keys also stay painted while the IME that replaces them is on its way.
  const deckShown = () => open && (mode === 'builtin' || !!pending?.fromDeck)
  function state(): MobileKeyboardState {
    // The taller of the two keyboards on screen: while they change places the terminal only ever
    // moves towards its new size.
    const area = Math.max(inset, deckShown() ? deck() : 0)
    return {
      mode,
      // Where the page already shrank by the IME, the area only adds what that does not cover.
      dockHeight: Math.max(0, area - shrink),
      deck: deckShown(),
      switching: !!pending || suspended || !!picker || (open && document.hidden),
      composer: !!composer,
    }
  }
  // The IME overlays the page while this terminal owns it, and after that until it has left the
  // screen. Focus in another editor ends the overlay at once.
  function syncOverlay() {
    if (!api || owner !== controller) return
    const active = document.activeElement
    const value =
      options.active() &&
      (active === input() || active === textarea || resting(active)) &&
      (open || reported() > 0)
    if (value !== overlaid) {
      setOverlay(api, value)
      measure()
    }
  }
  function publish() {
    syncOverlay()
    if (owner === controller) {
      mobileKeyboardOpen.value = open && options.active()
      mobileKeyboardVisible.value = options.active() && !document.hidden && present()
      mobileKeyboardInset.value = overlaid ? inset : 0
    }
    const next = state(),
      signature = JSON.stringify([open, next])
    if (signature === published) return
    published = signature
    options.changed(open, next)
  }
  /** Only the system keyboard edits the terminal input; otherwise it takes focus without an IME. */
  function inputMode(focusKeys = false) {
    clearTimeout(disableTimer)
    disableTimer = undefined
    const revision = ++inputRevision
    const editable = open && mode === 'system' && !suspended && !composer
    const apply = () => {
      if (options.setEditable) options.setEditable(editable)
      else (textarea as HTMLTextAreaElement).readOnly = !editable
      textarea.inputMode = editable ? 'text' : 'none'
      // Hardware keys still type under the built-in keys.
      if (
        focusKeys &&
        open &&
        mode === 'builtin' &&
        !interrupted() &&
        owner === controller &&
        options.active()
      ) {
        const active = document.activeElement
        if (active === textarea || resting(active)) textarea.focus({ preventScroll: true })
      }
    }
    // Native blur may finish a composition after blur itself. Let its final
    // input task drain before making the rich editor noneditable.
    if (!editable && options.finishEditing)
      void options.finishEditing().then(() => {
        if (revision === inputRevision) apply()
      })
    else if (!editable && mode === 'builtin')
      disableTimer = setTimeout(() => {
        disableTimer = undefined
        if (revision === inputRevision) apply()
      }, 0)
    else apply()
  }
  /** Take keyboard ownership from another terminal, whose IME may still be on screen. */
  function claim() {
    if (owner === controller) return
    owner?.blur()
    owner = controller
    measure()
  }
  function settle() {
    clearTimeout(pending?.timer)
    pending = undefined
  }
  function wait(
    what: 'arrival' | 'steady' | 'departure' | 'return',
    limit: number,
    fromDeck = false,
  ) {
    settle()
    pending = { for: what, timer: setTimeout(expired, limit), fromDeck }
  }
  /** The wait ran out: lay out what is measured, and give up on an IME that never came. */
  function expired() {
    const waited = pending?.for
    pending = undefined
    measure()
    if (waited !== 'departure' && open && mode === 'system' && !present() && !interrupted()) {
      refused()
      return
    }
    if (present() && mode === 'system') seen = true
    publish()
  }
  /** No IME for the system keyboard. A composer stays open without one; the terminal closes. */
  function refused() {
    if (!composer) {
      controller.blur()
      return
    }
    open = false
    seen = false
    publish()
  }
  /** Ask for the system IME on input(). Without the API only a fresh focus asks again. */
  function raise(refocus = false) {
    const element = input()
    changingFocus = true
    try {
      if (refocus && !api) element.blur()
      element.focus({ preventScroll: true })
      // A manual keyboard policy shows nothing on focus: the overlay is in place before show().
      syncOverlay()
      try {
        api?.show()
      } catch {
        /* Focus remains the request. */
      }
    } finally {
      changingFocus = false
    }
  }
  /** Take focus from input() and, with `hide`, close the system IME. Under a manual policy
   * only hide() on its focused input closes it. */
  function lower(hide = true) {
    const element = input()
    changingFocus = true
    try {
      const active = document.activeElement
      // Another editor that took focus owns the IME now.
      if (hide && api && (active === element || resting(active))) {
        element.focus({ preventScroll: true })
        try {
          api.hide()
        } catch {
          /* Blur also closes native input. */
        }
      }
      element.blur()
    } finally {
      changingFocus = false
    }
  }
  /** Open or return the system IME on input(), waiting for it where it is not on screen yet. */
  function requestSystem(refocus: boolean, fromDeck = false) {
    mode = 'system'
    inputMode()
    raise(refocus)
    measure()
    seen = present()
    if (seen) settle()
    else wait('arrival', arrivalLimit, fromDeck)
    publish()
  }
  /** Show the built-in keys and close the IME they replace. */
  function useBuiltin() {
    mode = 'builtin'
    seen = false
    lower()
    inputMode(true)
    measure()
    if (!gone()) wait('departure', departureLimit)
    else settle()
    publish()
  }
  function dropComposer(close: boolean) {
    const current = composer
    if (!current) return
    composer = undefined
    current.element.removeEventListener('blur', blurred)
    if (close) {
      lowerElement(current.element)
      mode = preferredMode()
    }
    if (api) current.element.removeAttribute('virtualkeyboardpolicy')
    return current
  }
  function lowerElement(element: HTMLElement) {
    changingFocus = true
    try {
      if (document.activeElement === element)
        try {
          api?.hide()
        } catch {
          /* Blur also closes native input. */
        }
      element.blur()
    } finally {
      changingFocus = false
    }
  }
  /** After an interruption: give the open keyboard back, asking once for a system IME. */
  function resume() {
    if (!open || owner !== controller || !options.active() || document.hidden) {
      observe()
      return
    }
    const active = document.activeElement
    if (active !== input() && !resting(active)) {
      controller.blur()
      return
    }
    if (mode === 'builtin') {
      measure()
      if (present()) lower()
      inputMode(true)
      observe()
    } else requestSystem(true)
  }
  function observe() {
    if (owner !== controller) return
    if (!options.active()) {
      controller.blur()
      return
    }
    const height = frameHeight(),
      smaller = baseline.height - height
    if (Math.abs(window.innerWidth - baseline.width) > 1 || scale() !== baseline.scale)
      // A new orientation or interface scale makes the old frame obsolete.
      baseline = { width: window.innerWidth, height, scale: scale() }
    else if (
      smaller < 0 ||
      // Browser chrome coming and going; an IME may instead be resizing the page in steps.
      (!open && smaller <= threshold()) ||
      // Under the built-in keys there is no IME to resize the page.
      (open && mode === 'builtin' && !pending)
    )
      baseline.height = height
    const before = inset
    measure()
    const here = present(),
      changed = Math.abs(inset - before) > 0.5
    if (open && !interrupted()) {
      if (mode === 'builtin') {
        if (pending?.for === 'departure' && gone()) settle()
      } else if (here) {
        seen = true
        // An IME reports its rise and fall in steps: the keyboards have changed places once
        // its height has stopped changing.
        if (pending ? pending.for !== 'steady' || changed : changed)
          wait('steady', steadyDelay, !!pending?.fromDeck)
      } else if (seen && pending?.for !== 'return')
        // The IME left without being asked to. It may only be changing; otherwise it was dismissed.
        wait('return', dismissalGrace)
    }
    publish()
  }
  function focused() {
    if (options.active()) inputMode()
  }
  function blurred() {
    if (changingFocus || !open || interrupted() || mode !== 'system') return
    // Focus can return within this task (synchronous clipboard copy) or move to another editor.
    queueMicrotask(() => {
      if (!open || interrupted() || mode !== 'system' || owner !== controller) return
      const active = document.activeElement
      if (active === input()) return
      if (!resting(active) || !options.active()) controller.blur()
      // Focus fell to the page: under a manual policy the IME is still up and types into input().
      else if (api) input().focus({ preventScroll: true })
    })
  }
  function focusChanged() {
    queueMicrotask(() => {
      if (owner !== controller) return
      const active = document.activeElement
      if (
        !interrupted() &&
        mode === 'system' &&
        (open || composer) &&
        active !== input() &&
        !resting(active)
      )
        controller.blur()
      else publish()
    })
  }
  function finishPicker() {
    if (!picker?.returned || document.hidden) return
    picker = undefined
    resume()
  }
  function visibilityChanged() {
    if (picker) {
      finishPicker()
      return
    }
    if (owner !== controller) return
    if (document.hidden) {
      // Going to the background takes the IME away; that is not a dismissal.
      settle()
      publish()
    } else resume()
  }
  const controller = {
    get state() {
      return state()
    },
    refreshViewport: observe,
    /** The measured natural height of the built-in keys. */
    setBuiltinHeight(height: number) {
      if (!(height > 0) || !Number.isFinite(height) || Math.abs(height - deckHeight) < 1) return
      deckHeight = height
      publish()
    },
    switchMode() {
      if (!options.active() || composer) return
      claim()
      if (!open) mode = preferredMode()
      const next = mode === 'system' ? 'builtin' : 'system',
        fromDeck = open && mode === 'builtin'
      saveMode(next)
      open = true
      if (next === 'builtin') useBuiltin()
      else requestSystem(true, fromDeck)
    },
    /** Lend the system IME to the composer editor, or return the prior keyboard to the terminal. */
    composer(element?: HTMLElement, lost?: () => void) {
      if (!element) {
        if (!composer) return
        const prior = composer.prior,
          usable = open && options.active() && !document.hidden
        if (usable && prior === 'system') {
          dropComposer(false)
          requestSystem(true)
        } else if (usable && prior === 'builtin') {
          dropComposer(true)
          useBuiltin()
        } else {
          // Opened without a keyboard, or left without its IME: back to a closed keyboard.
          dropComposer(true)
          controller.blur()
        }
        return
      }
      if (!options.active()) return
      claim()
      if (composer?.element === element) {
        // Tapping the editor while its IME is off asks for it again; the tap itself is the focus.
        if (lost) composer.lost = lost
        if (!open || (!present() && !pending)) {
          open = true
          requestSystem(false)
        }
        return
      }
      const prior = composer ? composer.prior : open ? mode : undefined
      dropComposer(false)
      composer = { element, prior, lost }
      element.addEventListener('blur', blurred)
      if (api) element.setAttribute('virtualkeyboardpolicy', 'manual')
      open = true
      requestSystem(true, prior === 'builtin')
    },
    /** A dialog over the terminal borrows focus, not the open intent. */
    suspend(value: boolean) {
      clearTimeout(resumeTimer)
      resumeTimer = undefined
      if (value) {
        if (suspended) return
        suspended = true
        settle()
        if (open) lower()
        inputMode()
        publish()
      } else if (suspended)
        // Let the closing dialog release its own focus before native input returns.
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined
          suspended = false
          resume()
        }, 0)
    },
    /** Native file selection temporarily owns foreground/focus, not open intent. */
    filePicker() {
      if (!open || owner !== controller) return
      const current: { returned: boolean } = { returned: false }
      picker = current
      settle()
      publish()
      return (restore: boolean) => {
        if (picker !== current) return
        if (!restore) {
          controller.blur()
          return
        }
        current.returned = true
        finishPicker()
      }
    },
    /** Focus the terminal; `true` opens the preferred keyboard and `false` closes it. */
    focus(value?: boolean) {
      if (!options.active()) return
      if (value === false && (open || composer)) controller.blur()
      claim()
      if (value && composer) {
        // The keyboard button over a composer without its IME asks for it again.
        if (!open) {
          open = true
          requestSystem(true)
        }
        return
      }
      if (value && !open) {
        open = true
        mode = preferredMode()
        baseline.height = Math.max(baseline.height, frameHeight())
        if (suspended) publish()
        else if (mode === 'system') requestSystem(true)
        else useBuiltin()
        return
      }
      if (suspended) {
        publish()
        return
      }
      inputMode()
      if (open && mode === 'system') raise()
      else textarea.focus({ preventScroll: true })
      observe()
    },
    dismiss() {
      if (!interrupted()) controller.blur()
    },
    /** Close the keyboard and the composer, whoever asked. */
    blur() {
      const lost = dropComposer(true)?.lost
      picker = undefined
      suspended = false
      clearTimeout(resumeTimer)
      resumeTimer = undefined
      settle()
      const wasOpen = open
      open = false
      seen = false
      if (options.active() || owner === controller) {
        lower(wasOpen || present())
        inputMode()
      }
      publish()
      lost?.()
    },
    dispose() {
      controller.blur()
      clearTimeout(disableTimer)
      if (owner === controller) {
        owner = undefined
        if (api && overlaid) setOverlay(api, false)
        mobileKeyboardVisible.value = false
        mobileKeyboardOpen.value = false
        mobileKeyboardInset.value = 0
      }
      if (api) textarea.removeAttribute('virtualkeyboardpolicy')
      textarea.removeEventListener('focus', focused)
      textarea.removeEventListener('blur', blurred)
      document.removeEventListener('focusin', focusChanged)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('resize', observe)
      visual?.removeEventListener('resize', observe)
      visual?.removeEventListener('scroll', observe)
      api?.removeEventListener('geometrychange', observe)
    },
  }
  // With the API, focus and blur alone neither open nor close the IME: this controller asks for both.
  if (api) textarea.setAttribute('virtualkeyboardpolicy', 'manual')
  textarea.addEventListener('focus', focused)
  textarea.addEventListener('blur', blurred)
  document.addEventListener('focusin', focusChanged)
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('resize', observe)
  visual?.addEventListener('resize', observe)
  visual?.addEventListener('scroll', observe)
  api?.addEventListener('geometrychange', observe)
  return controller
}
