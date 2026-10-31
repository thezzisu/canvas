import { ref } from 'vue'

export type KeyboardLockState = 'unavailable' | 'idle' | 'pending' | 'active' | 'denied'
export type KeyboardLockUnavailableReason = 'insecure-context' | 'unsupported'
export const keyboardLockState = ref<KeyboardLockState>('unavailable')
export const keyboardLockUnavailableReason = ref<KeyboardLockUnavailableReason>()
export const keyboardLockError = ref<string>()

// Keyboard Lock takes physical key codes, not shortcuts. Escape remains the
// browser's fullscreen exit; Meta and operating-system keys are not requested.
const terminalCodes = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `Numpad${index}`),
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'IntlBackslash', 'IntlRo', 'IntlYen', 'Backspace', 'Tab', 'Enter', 'Space',
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumpadEqual', 'NumpadComma',
]
interface KeyboardLock { lock(codes: string[]): Promise<void>; unlock(): void }
interface Binding { input: HTMLElement; eligible(): boolean }
interface Request { binding: Binding; revision: number; cancelled?: boolean }
const bindings = new Set<Binding>()
let context: { document: Document; window: Window; keyboard: KeyboardLock } | undefined
let desired: Binding | undefined
let active: Binding | undefined
let pending: Request | undefined
let revision = 0
let attempted = -1
let windowFocused = false
let pageHidden = false
let focusQueued = false

function release() {
  if (context && (active || pending && !pending.cancelled)) context.keyboard.unlock()
  if (pending) pending.cancelled = true
  active = undefined
}
function drive() {
  if (!context || pending) return
  if (!desired) { keyboardLockState.value = 'idle'; return }
  if (active === desired) { keyboardLockState.value = 'active'; return }
  if (attempted === revision) return
  const keyboard = context.keyboard
  const request = pending = { binding: desired, revision }
  attempted = revision
  keyboardLockState.value = 'pending'
  keyboardLockError.value = undefined
  void (async () => {
    try {
      await keyboard.lock(terminalCodes)
      if (request.revision === revision && desired === request.binding && focusedBinding() === request.binding) {
        active = request.binding
        keyboardLockState.value = 'active'
      } else keyboard.unlock()
    } catch (error) {
      if (request.revision === revision && desired === request.binding) {
        keyboardLockError.value = error instanceof Error ? error.name : 'Error'
        keyboardLockState.value = 'denied'
      }
    } finally {
      pending = undefined
      refresh()
    }
  })()
}
function focusedBinding() {
  if (!context) return undefined
  const { document } = context
  return !pageHidden && windowFocused && document.hasFocus() && document.visibilityState === 'visible' && document.fullscreenElement
    ? [...bindings].find(binding => binding.input.isConnected && document.activeElement === binding.input && binding.eligible())
    : undefined
}
function refresh() {
  if (!context) return
  const next = focusedBinding()
  if (next !== desired) {
    desired = next
    revision++
    release()
    keyboardLockError.value = undefined
    keyboardLockState.value = desired ? 'pending' : 'idle'
  }
  drive()
}
function focusChanged() {
  // Clipboard copying temporarily borrows focus within one task.
  if (focusQueued) return
  focusQueued = true
  queueMicrotask(() => { focusQueued = false; refresh() })
}
function focused() { windowFocused = true; refresh() }
function blurred() { windowFocused = false; refresh() }
function hidden() { pageHidden = true; refresh() }
function shown() { pageHidden = false; windowFocused = context?.document.hasFocus() === true; refresh() }
function listen(add: boolean) {
  if (!context) return
  const { document, window } = context
  const method = add ? 'addEventListener' : 'removeEventListener'
  document[method]('focusin', focusChanged, true)
  document[method]('focusout', focusChanged, true)
  document[method]('fullscreenchange', refresh)
  document[method]('visibilitychange', refresh)
  window[method]('focus', focused)
  window[method]('blur', blurred)
  window[method]('pagehide', hidden)
  window[method]('pageshow', shown)
}

/** One page-wide lock follows the currently focused terminal input. */
export function bindTerminalKeyboardLock(input: HTMLElement, eligible: () => boolean): { refresh(retryDenied?: boolean): void; dispose(): void } {
  const document = input.ownerDocument
  const window = document.defaultView
  const keyboard = (window?.navigator as Navigator & { keyboard?: KeyboardLock } | undefined)?.keyboard
  const reason = !window?.isSecureContext ? 'insecure-context' : !keyboard?.lock || !keyboard.unlock ? 'unsupported' : undefined
  keyboardLockUnavailableReason.value = reason
  if (reason || !window || !keyboard) { keyboardLockState.value = 'unavailable'; keyboardLockError.value = undefined; return { refresh() {}, dispose() {} } }
  if (!bindings.size) {
    // A pending permission request remains serialized across replacement inputs.
    context = { document, window, keyboard }
    windowFocused = document.hasFocus()
    pageHidden = false
    listen(true)
  }
  const binding = { input, eligible }
  bindings.add(binding)
  refresh()
  return {
    refresh(retryDenied = false) {
      if (retryDenied && window.navigator.userActivation?.isActive && keyboardLockState.value === 'denied') attempted = -1
      refresh()
    },
    dispose() {
      if (!bindings.delete(binding)) return
      refresh()
      if (!bindings.size) listen(false)
    },
  }
}
