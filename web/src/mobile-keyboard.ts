import { ref } from 'vue'
import { readViewportFrame } from './viewport-frame'

export const mobileKeyboardVisible = ref(false)
export const mobileKeyboardOpen = ref(false)
/** Height of a system IME overlaying the page (VirtualKeyboard API) in page CSS pixels, otherwise 0. */
export const mobileKeyboardInset = ref(0)
export type MobileKeyboardMode = 'system' | 'builtin'
/**
 * `dockHeight` is the keyboard area the terminal card reserves below its helper row;
 * `deck` shows the built-in keys in it rather than an empty area under the system IME.
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
const confirmDelay = 900
// An IME that settles below a held area has finished animating once its geometry stays this long.
const settleDelay = 500
const resting = (element: Element | null) =>
  !element || element === document.body || element === document.documentElement
let owner: ReturnType<typeof bindMobileKeyboard> | undefined
// The page has one IME policy; only the keyboard owner changes it, so a new owner inherits it.
let overlaid = false
function setOverlay(api: VirtualKeyboard, value: boolean) {
  overlaid = value
  try {
    api.overlaysContent = value
  } catch {
    /* The page then resizes as without the API. */
  }
  document.documentElement.toggleAttribute('data-keyboard-overlay', value)
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
 * One open intent owns either the system IME or the built-in keys, both in one bottom keyboard area.
 * With the VirtualKeyboard API the IME overlays the page and the area reserves its inset, so the page
 * never relayouts per IME frame. Without it the page resizes and the area only bridges the difference.
 * A handoff never shrinks the area: it is held until the incoming keyboard covers it.
 */
export function bindMobileKeyboard(textarea: HTMLElement, options: KeyboardOptions) {
  const visual = window.visualViewport
  const api = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard
  const read = readViewportFrame
  const scale = () => options.scale?.() || 1
  let baseline = {
    width: window.innerWidth,
    height: Math.max(window.innerHeight, read().height),
    scale: scale(),
  }
  let requested = false,
    mode = preferredMode()
  let changingFocus = false,
    suspended = false
  let picker: { returned: boolean } | undefined
  // `inset` is the IME's height over the page bottom; while `overlaid` the page does not resize for it.
  // `shrink` is the part of it by which the page itself resized.
  let inset = 0,
    shrink = 0
  // A handoff keeps `hold` reserved until the incoming keyboard covers it (system) or the
  // replaced IME has closed (built-in); `bridge` keeps the built-in keys shown meanwhile.
  let hold = 0,
    bridge = false,
    switching = false
  let nativeHeight = 0,
    builtinMinHeight = 260 * scale(),
    builtinHeight = builtinMinHeight
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let disableTimer: ReturnType<typeof setTimeout> | undefined
  let inputRevision = 0,
    resumeTimer: ReturnType<typeof setTimeout> | undefined
  let published: string | undefined
  // The composer editor owns native input while open; release restores the prior keyboard.
  // `shown` records that its IME appeared; only then can losing the IME collapse it.
  // `keep` makes a refused IME leave it open with the keyboard off (picker return, explicit reopen).
  let composer:
    | {
        element: HTMLElement
        prior?: MobileKeyboardMode
        lost?: () => void
        shown?: boolean
        keep?: boolean
      }
    | undefined
  const input = () => composer?.element || textarea
  const threshold = () => Math.max(80, baseline.height * 0.15)
  const occluded = (height: number) => (overlaid ? height > 0 : height > threshold())
  // A page that still resizes for its IME under the overlay request (no reported rectangle) is followed as without the API.
  const measure = () => {
    const resized = Math.max(0, baseline.height - read().height)
    shrink = !overlaid || resized > threshold() ? resized : 0
    return Math.max(shrink, overlaid && api ? api.boundingRect.height : 0)
  }
  const area = () =>
    !requested ? inset : Math.max(inset, hold, mode === 'builtin' ? builtinHeight : 0)
  function state(): MobileKeyboardState {
    // Where the page already shrank by the IME, the area only adds what it does not cover.
    return {
      mode,
      dockHeight: Math.max(0, area() - shrink),
      deck: requested && (mode === 'builtin' || bridge),
      switching: switching || suspended || !!picker || (requested && document.hidden),
      composer: !!composer,
    }
  }
  // The IME overlays the page while this terminal owns input, and until the IME it overlays has closed.
  function syncOverlay() {
    if (!api || owner !== controller) return
    const active = document.activeElement
    const value =
      options.active() &&
      (active === input() || active === textarea || resting(active)) &&
      (requested || (overlaid && inset > 0))
    if (value !== overlaid) {
      setOverlay(api, value)
      inset = measure()
    }
  }
  function publish() {
    syncOverlay()
    if (owner === controller) {
      mobileKeyboardOpen.value = requested && options.active()
      mobileKeyboardVisible.value = options.active() && !document.hidden && occluded(inset)
      mobileKeyboardInset.value = overlaid ? inset : 0
    }
    const next = state(),
      signature = JSON.stringify([requested, next])
    if (signature === published) return
    published = signature
    options.changed(requested, next)
  }
  const inputMode = (restoreBuiltinFocus = false) => {
    clearTimeout(disableTimer)
    disableTimer = undefined
    const revision = ++inputRevision
    const editable = requested && mode === 'system' && !suspended && !composer
    const apply = () => {
      if (options.setEditable) options.setEditable(editable)
      else (textarea as HTMLTextAreaElement).readOnly = !editable
      textarea.inputMode = editable ? 'text' : 'none'
      if (
        restoreBuiltinFocus &&
        requested &&
        mode === 'builtin' &&
        !suspended &&
        !picker &&
        owner === controller &&
        options.active() &&
        !document.hidden
      ) {
        const active = document.activeElement
        if (active === textarea || resting(active)) textarea.focus({ preventScroll: true })
      }
    }
    // Native blur may finish a composition after blur itself. Let its final
    // input task drain before making the rich editor noneditable.
    if (!editable && options.finishEditing) {
      void options.finishEditing().then(() => {
        if (revision === inputRevision) apply()
      })
    } else if (!editable && mode === 'builtin') {
      disableTimer = setTimeout(() => {
        disableTimer = undefined
        if (revision === inputRevision) apply()
      }, 0)
    } else apply()
  }
  function fitHeight(height: number) {
    const maximum = Math.max(0, Math.min(460 * scale(), baseline.height - 160 * scale()))
    return Math.min(maximum, Math.max(Math.min(builtinMinHeight, maximum), height))
  }
  /** Take keyboard ownership from another terminal, whose IME may still be on screen. */
  function claim() {
    if (owner === controller) return
    owner?.blur()
    owner = controller
    inset = measure()
  }
  function clearTimers() {
    clearTimeout(confirmTimer)
    confirmTimer = undefined
    clearTimeout(settleTimer)
    settleTimer = undefined
  }
  /** Request the system IME on input(); without the API only a fresh focus can request it again. */
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
  function hideNative(restoreBuiltinFocus = false) {
    changingFocus = true
    // A manual keyboard policy only honours hide() while its input is focused.
    try {
      try {
        api?.hide()
      } catch {
        /* Blur also closes native input. */
      }
      input().blur()
      inputMode(restoreBuiltinFocus)
    } finally {
      changingFocus = false
    }
  }
  /** The IME was requested on input(); without it after `confirmDelay` the platform refused it. */
  function confirm() {
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => {
      confirmTimer = undefined
      inset = measure()
      if (!requested || mode !== 'system' || suspended || picker || document.hidden) return
      // The IME stayed up (e.g. a blur that did not close it): settle the area as for any visible IME.
      if (occluded(inset)) {
        observe()
        return
      }
      hold = 0
      bridge = false
      switching = false
      // A composer whose IME never appeared (hardware keyboard) stays open and editable.
      if (composer && !composer.shown) publish()
      // A kept composer stays open with the keyboard off; tapping it or the keyboard button retries.
      else if (composer?.keep) {
        requested = false
        composer.keep = false
        publish()
      } else controller.blur()
    }, confirmDelay)
  }
  /** The requested IME is on screen. */
  function appeared() {
    clearTimeout(confirmTimer)
    confirmTimer = undefined
    if (composer) {
      composer.shown = true
      composer.keep = false
    }
  }
  function release() {
    clearTimeout(settleTimer)
    settleTimer = undefined
    hold = 0
    bridge = false
    switching = false
    if (occluded(inset)) nativeHeight = inset
  }
  /** An IME that stopped changing ends the transition, even short of the held area. */
  function settle() {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      inset = measure()
      if (!requested || suspended || picker || document.hidden) return
      if (mode === 'builtin') {
        switching = false
        hold = 0
      } else if (occluded(inset)) release()
      else return
      publish()
    }, settleDelay)
  }
  /** The IME disappeared under open intent: request it again at once; a refusal turns the keyboard off. */
  function lost() {
    if (confirmTimer || suspended || picker || document.hidden || !options.active()) return
    const active = document.activeElement
    if (active !== input() && !resting(active)) {
      controller.blur()
      return
    }
    switching = true
    raise(true)
    confirm()
  }
  /** Show the built-in keys at the height of the area they replace, then close the IME under them. */
  function useBuiltin(replaced: number) {
    clearTimers()
    mode = 'builtin'
    bridge = false
    builtinHeight = fitHeight(replaced || nativeHeight || builtinMinHeight)
    switching = inset >= 1
    // An area outside the built-in bounds changes once, after the IME under it has closed.
    hold = switching ? replaced : 0
    hideNative(true)
    publish()
    if (switching) settle()
  }
  /** Move the system IME to input(), holding the current area until the IME covers it. */
  function toSystem(reserve: number) {
    const fromBuiltin = mode === 'builtin'
    clearTimers()
    mode = 'system'
    hold = reserve
    bridge = fromBuiltin && reserve > 0
    inputMode()
    raise(true)
    inset = measure()
    if (!occluded(inset)) {
      switching = reserve > 0
      confirm()
      publish()
      return
    }
    appeared()
    if (inset >= hold - 1) release()
    else {
      switching = true
      settle()
    }
    publish()
  }
  /** Open the system IME from a closed keyboard; the area follows it as it appears. */
  function openSystem(refocus = true) {
    clearTimers()
    requested = true
    mode = 'system'
    hold = 0
    bridge = false
    switching = false
    baseline = {
      width: window.innerWidth,
      height: Math.max(baseline.height, window.innerHeight, read().height),
      scale: scale(),
    }
    inputMode()
    raise(refocus)
    confirm()
    observe()
  }
  function dropComposer(close: boolean) {
    const current = composer
    if (!current) return
    composer = undefined
    current.element.removeEventListener('blur', blurred)
    if (close) {
      changingFocus = true
      try {
        if (document.activeElement === current.element)
          try {
            api?.hide()
          } catch {
            /* Blur also closes native input. */
          }
        current.element.blur()
      } finally {
        changingFocus = false
      }
      mode = preferredMode()
    }
    if (api) current.element.removeAttribute('virtualkeyboardpolicy')
    return current
  }
  function observe() {
    if (owner !== controller) return
    if (!options.active()) {
      controller.blur()
      return
    }
    const frame = read()
    if (Math.abs(window.innerWidth - baseline.width) > 1 || scale() !== baseline.scale) {
      // A new orientation or interface scale makes every keyboard measurement obsolete.
      clearTimeout(settleTimer)
      settleTimer = undefined
      hold = 0
      bridge = false
      nativeHeight = 0
      baseline = {
        width: window.innerWidth,
        height: Math.max(window.innerHeight, frame.height),
        scale: scale(),
      }
      builtinHeight = fitHeight(builtinHeight)
      inset = measure()
      if (requested && mode === 'system' && !picker && !suspended && !document.hidden) confirm()
    }
    const refit = requested && mode === 'builtin' && !switching && !suspended && !picker,
      resized = baseline.height - frame.height
    // An overlay request the browser does not honour leaves the system IME resizing the page instead.
    const resizingIme =
      overlaid &&
      requested &&
      mode === 'system' &&
      resized > threshold() &&
      !(api && api.boundingRect.height > 0)
    if ((overlaid && !resizingIme) || (!requested && !occluded(resized))) {
      baseline.height = Math.max(window.innerHeight, frame.height)
      if (refit) builtinHeight = fitHeight(builtinHeight)
    } else if (refit && frame.height !== baseline.height) {
      // Without native input this is the full available frame, not a newly opened IME.
      baseline.height = frame.height
      builtinHeight = fitHeight(builtinHeight)
    }
    const previous = inset
    inset = measure()
    const visible = occluded(inset),
      changed = Math.abs(inset - previous) > 0.5
    if (requested && !document.hidden && !picker && !suspended) {
      if (mode === 'builtin') {
        // The replaced IME is closing under the built-in keys until it is gone.
        if (switching && inset < 1) {
          switching = false
          hold = 0
        } else if (switching && (changed || !settleTimer)) settle()
      } else {
        if (visible) appeared()
        // A shrinking IME may be closing: hold the area until it settles or returns.
        if (inset < previous - 1) {
          hold = Math.max(hold, previous)
          switching = true
        }
        if (visible) {
          if (inset >= hold - 1) release()
          else if (changed || !settleTimer) settle()
        } else if (occluded(previous)) lost()
      }
    }
    publish()
  }
  function focused() {
    if (options.active()) inputMode()
  }
  function blurred() {
    if (changingFocus || !requested || suspended || picker || mode !== 'system') return
    // Focus can return within this task (synchronous clipboard copy) or move to another editor.
    queueMicrotask(() => {
      if (!requested || suspended || picker || mode !== 'system' || owner !== controller) return
      const active = document.activeElement
      if (active === input()) return
      if (!resting(active) || !options.active()) {
        controller.blur()
        return
      }
      if (!document.hidden) {
        hold = Math.max(hold, area())
        lost()
        publish()
      }
    })
  }
  function focusChanged() {
    queueMicrotask(() => {
      if (owner !== controller) return
      const active = document.activeElement
      if (
        !picker &&
        !suspended &&
        mode === 'system' &&
        (requested || composer) &&
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
    if (!requested || owner !== controller || !options.active()) {
      publish()
      return
    }
    const active = document.activeElement
    if (active !== input() && !resting(active)) {
      controller.blur()
      return
    }
    if (mode === 'builtin') {
      inputMode(true)
      observe()
      return
    }
    // At change or cancel, still within the picker's user activation, ask for the IME again.
    if (composer) composer.keep = true
    inputMode()
    inset = measure()
    if (!occluded(inset)) {
      switching = true
      raise(true)
      confirm()
    }
    observe()
  }
  function visibilityChanged() {
    if (picker) {
      finishPicker()
      return
    }
    if (owner !== controller) return
    if (document.hidden) {
      clearTimers()
      if (requested && mode === 'system') {
        hold = Math.max(hold, area())
        switching = true
      }
      publish()
      return
    }
    if (requested && options.active() && mode === 'system') {
      inputMode()
      raise()
      inset = measure()
      if (!occluded(inset)) confirm()
    }
    observe()
  }
  const controller = {
    get state() {
      return state()
    },
    refreshViewport: observe,
    setBuiltinMinHeight(height: number) {
      if (!(height > 0) || !Number.isFinite(height) || Math.abs(height - builtinMinHeight) < 1)
        return
      builtinMinHeight = height
      if (requested && mode === 'builtin') builtinHeight = fitHeight(builtinHeight)
      publish()
    },
    switchMode() {
      if (!options.active() || composer) return
      claim()
      if (!requested) mode = preferredMode()
      const next = mode === 'system' ? 'builtin' : 'system',
        reserve = requested ? area() : 0
      baseline.height = Math.max(baseline.height, window.innerHeight, read().height)
      saveMode(next)
      if (next === 'builtin') {
        requested = true
        useBuiltin(reserve)
      } else if (reserve) toSystem(reserve)
      else openSystem()
    },
    /** Lend the system IME to the composer editor in place, or return it to the prior keyboard. */
    composer(element?: HTMLElement, lost?: () => void) {
      if (!element) {
        if (!composer) return
        const prior = composer.prior,
          reserve = area()
        // A composer left without its IME returns to a closed keyboard.
        if (!requested) {
          dropComposer(true)
          publish()
          return
        }
        if (prior === 'system' && options.active() && !document.hidden) {
          dropComposer(false)
          toSystem(reserve)
        } else if (prior === 'builtin' && options.active() && !document.hidden) {
          dropComposer(true)
          useBuiltin(reserve)
        } else {
          dropComposer(true)
          controller.blur()
        }
        return
      }
      if (!options.active()) return
      claim()
      if (composer?.element === element) {
        // Tapping the editor while its IME is off asks for it again; the tap itself is the focus request.
        if (lost) composer.lost = lost
        if (!requested) {
          composer.keep = true
          openSystem(false)
        } else if (mode === 'system' && !occluded(inset) && !confirmTimer) {
          raise()
          confirm()
        }
        return
      }
      const prior = composer ? composer.prior : requested ? mode : undefined,
        reserve = area()
      dropComposer(false)
      composer = { element, prior, lost }
      element.addEventListener('blur', blurred)
      if (api) element.setAttribute('virtualkeyboardpolicy', 'manual')
      if (prior && requested) toSystem(reserve)
      else openSystem()
    },
    suspend(value: boolean) {
      clearTimeout(resumeTimer)
      resumeTimer = undefined
      if (value) {
        if (suspended) return
        if (requested && mode === 'system') hold = Math.max(hold, area())
        suspended = true
        clearTimers()
        hideNative()
        publish()
      } else if (suspended) {
        // Let the closing modal release its own focus before restoring native
        // input. Its temporary focus target must not revoke the open intent.
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined
          suspended = false
          if (requested && options.active() && !document.hidden) {
            if (mode === 'system') {
              switching = true
              inputMode()
              raise()
              confirm()
            } else if (occluded(measure())) {
              switching = true
              hideNative(true)
            } else inputMode(true)
          }
          observe()
        }, 0)
      }
    },
    /** Native file selection temporarily owns foreground/focus, not open intent. */
    filePicker() {
      if (!requested || owner !== controller) return
      const current: { returned: boolean } = { returned: false }
      if (mode === 'system') hold = Math.max(hold, area())
      picker = current
      clearTimers()
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
    focus(value?: boolean) {
      if (!options.active()) return
      if (value === false && composer) controller.blur()
      claim()
      // The keyboard button over a composer without its IME asks for it again.
      if (value && composer) {
        if (!requested) {
          composer.keep = true
          openSystem()
        }
        return
      }
      if (!requested) mode = preferredMode()
      if (value !== undefined && value !== requested) {
        clearTimers()
        hold = 0
        bridge = false
        switching = false
        if (value) {
          changingFocus = true
          try {
            textarea.blur()
          } finally {
            changingFocus = false
          }
        } else hideNative()
        requested = value
        if (value) {
          mode = preferredMode()
          baseline = {
            width: window.innerWidth,
            height: Math.max(baseline.height, window.innerHeight, read().height),
            scale: scale(),
          }
          if (mode === 'system') confirm()
          else builtinHeight = fitHeight(nativeHeight || builtinMinHeight)
        }
      }
      if (suspended) {
        publish()
        return
      }
      inputMode()
      if (requested && mode === 'system') raise()
      else textarea.focus({ preventScroll: true })
      observe()
    },
    dismiss() {
      if (!suspended && !picker) controller.blur()
    },
    blur() {
      const lost = dropComposer(true)?.lost
      picker = undefined
      suspended = false
      clearTimeout(resumeTimer)
      resumeTimer = undefined
      inputRevision++
      clearTimers()
      hold = 0
      bridge = false
      switching = false
      requested = false
      if (options.active() || owner === controller) hideNative()
      publish()
      lost?.()
    },
    dispose() {
      controller.blur()
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
  // With the API, the IME opens and closes only on explicit requests, never on focus alone.
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
