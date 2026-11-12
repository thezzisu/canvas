import { ref } from 'vue'

export type MobileKeyboardMode = 'system' | 'builtin'
/** `deck` paints the built-in keys; `composer` means the composer editor owns native input. */
export interface MobileKeyboardState {
  open: boolean
  mode: MobileKeyboardMode
  deck: boolean
  composer: boolean
}
interface KeyboardOptions {
  active(): boolean
  changed(state: MobileKeyboardState): void
  setEditable(value: boolean): void
  finishEditing(): Promise<void>
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

// Browser toolbars move the viewport by less than this; a docked IME by more.
const imeMinimum = 120
// Keyboards that change places wait this long at most for the page to resize.
const swapLimit = 400

/** A system IME is on screen: the viewport is well short of its height without one. */
export const systemKeyboardVisible = ref(false)
let owner: ReturnType<typeof bindMobileKeyboard> | undefined
let tallest = { width: 0, height: 0 }
const editing = (element: EventTarget | null) =>
  element instanceof HTMLElement &&
  (element.isContentEditable || element.matches('input, textarea'))
function viewportChanged() {
  const visual = window.visualViewport
  const width = window.innerWidth,
    height = visual ? visual.height * visual.scale : window.innerHeight
  // Without an editor in focus there is no IME: the viewport is then at its full height.
  if (width !== tallest.width || height > tallest.height || !editing(document.activeElement))
    tallest = { width, height }
  systemKeyboardVisible.value = tallest.height - height > imeMinimum
  owner?.viewportChanged()
}
export function hideMobileKeyboard() {
  owner?.blur()
}
export function dismissMobileKeyboard() {
  owner?.dismiss()
}

/**
 * The keyboard of one terminal: the system IME or the built-in keys.
 *
 * The browser owns the IME and resizes the page around it. This controller only decides whether
 * the terminal input is editable and focused: an editable focused input brings the IME, a
 * read-only one takes hardware keys under the built-in keys, and blur closes the IME. Nothing
 * is predicted or measured, so the keyboard cannot disagree with what is on screen. An IME the
 * user dismisses stays away until the terminal is tapped again.
 *
 * When the two keyboards change places, the built-in keys wait for the page's own resize, so
 * the terminal moves once.
 */
export function bindMobileKeyboard(input: HTMLElement, options: KeyboardOptions) {
  let open = false,
    mode = preferredMode(),
    deck = false
  // A dialog or file picker has borrowed focus; the keyboard returns when it is done.
  let paused = false
  let composer: { element: HTMLElement; lost?: () => void } | undefined
  let swap: ReturnType<typeof setTimeout> | undefined
  let resume: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let published: string | undefined

  const state = (): MobileKeyboardState => ({ open, mode, deck, composer: !!composer })
  function publish() {
    const next = state(),
      signature = JSON.stringify(next)
    if (signature === published) return
    published = signature
    options.changed(next)
  }
  /** Paint the keys the mode calls for; `wait` holds that until the IME has resized the page. */
  function layout(wait = false) {
    clearTimeout(swap)
    swap = undefined
    const wanted = open && mode === 'builtin' && !composer
    if (wanted !== deck) {
      if (wait) swap = setTimeout(layout, swapLimit)
      else deck = wanted
    }
    publish()
  }
  /**
   * Put the terminal input in the state the keyboard calls for. With `hold` it keeps focus;
   * `reopen` asks again for an IME the user dismissed, which only a fresh focus does.
   */
  async function attach(hold: boolean, reopen = false) {
    const current = ++revision
    const focused = hold && !paused && !composer && options.active()
    const typing = focused && open && mode === 'system'
    if (!typing) {
      if (input.isContentEditable || !focused) input.blur()
      // A composition can end after the blur; its text is sent before the input goes read-only.
      await options.finishEditing()
      if (current !== revision) return
    }
    options.setEditable(typing)
    if (!focused) return
    if (typing && reopen) input.blur()
    input.focus({ preventScroll: true })
  }
  function claim() {
    if (owner === controller) return
    owner?.blur()
    owner = controller
  }
  function focusMoved(event: FocusEvent) {
    // Another editor took focus and the IME with it.
    if (
      open &&
      !paused &&
      !composer &&
      mode === 'system' &&
      event.target !== input &&
      editing(event.target)
    )
      controller.blur()
  }
  function visibilityChanged() {
    if (!document.hidden && owner === controller && open) void attach(true)
  }
  const controller = {
    get state() {
      return state()
    },
    viewportChanged() {
      if (swap) layout()
    },
    switchMode() {
      if (!options.active() || composer) return
      claim()
      if (!open) mode = preferredMode()
      const next = mode === 'system' ? 'builtin' : 'system'
      // The built-in keys follow an IME that is leaving, and stay until one has arrived.
      const wait = next === 'builtin' ? systemKeyboardVisible.value : deck
      saveMode(next)
      open = true
      mode = next
      void attach(true, true)
      layout(wait)
    },
    /** Lend native input to the composer editor, or return the keyboard to the terminal. */
    composer(element?: HTMLElement, lost?: () => void) {
      if (!element) {
        if (!composer) return
        const editor = composer.element
        composer = undefined
        const typing = open && mode === 'system'
        if (!typing && document.activeElement === editor) editor.blur()
        void attach(open, true)
        layout(systemKeyboardVisible.value && !typing)
        return
      }
      if (!options.active()) return
      claim()
      composer = { element, lost }
      void attach(false)
      element.focus({ preventScroll: true })
      layout(deck)
    },
    /** A dialog over the terminal borrows focus, not the open keyboard. */
    suspend(value: boolean) {
      clearTimeout(resume)
      resume = undefined
      if (value) {
        paused = true
        void attach(false)
      } else if (paused)
        // The closing dialog releases its own focus first.
        resume = setTimeout(() => {
          resume = undefined
          paused = false
          void attach(true, true)
        }, 0)
    },
    /** A native file picker borrows the foreground; the result says whether the keyboard returns. */
    filePicker() {
      if (!open || owner !== controller) return
      paused = true
      return (restore: boolean) => {
        if (!paused) return
        paused = false
        if (restore) void attach(true, true)
        else controller.blur()
      }
    },
    /** Focus the terminal; `true` opens its keyboard and `false` closes it. */
    focus(value?: boolean) {
      if (!options.active()) return
      if (value === false) controller.blur()
      claim()
      if (value) open = true
      void attach(true, open && !systemKeyboardVisible.value)
      layout()
    },
    dismiss() {
      if (!paused) controller.blur()
    },
    /** Close the keyboard and the composer, whoever asked. */
    blur() {
      const lost = composer?.lost
      composer = undefined
      paused = false
      open = false
      clearTimeout(resume)
      resume = undefined
      void attach(false)
      layout()
      lost?.()
    },
    dispose() {
      controller.blur()
      if (owner === controller) owner = undefined
      document.removeEventListener('focusin', focusMoved)
      document.removeEventListener('visibilitychange', visibilityChanged)
    },
  }
  // One shared listener, however many terminals bind.
  window.addEventListener('resize', viewportChanged)
  window.visualViewport?.addEventListener('resize', viewportChanged)
  viewportChanged()
  document.addEventListener('focusin', focusMoved)
  document.addEventListener('visibilitychange', visibilityChanged)
  return controller
}
