import { clipboardBorrowingFocus } from '../../utils/clipboard'
import { encodeFocus, encodePaste } from '../../utils/terminal/terminal-encoder'
import {
  hasModifiers,
  modifiedText,
  terminalKey,
  terminalShortcut,
  type TerminalModifiers,
} from '../../utils/terminal/terminal-input'
import { terminalInputChunks } from '../../utils/terminal/terminal-input-chunks'
import {
  claimFocus,
  contentFocusable,
  inputElement,
  interactive,
  maximizedElsewhere,
  online,
  setModifiers,
  type Session,
} from './terminal-session'

// What the user types, pastes and focuses, on its way to the window.

/** This view may act on the window: it is live, shown and not behind another maximized view. */
export function operable(session: Session) {
  return interactive(session) && online(session) && !maximizedElsewhere(session)
}
/** The wheel over this terminal scrolls it, rather than the canvas around it. */
export function ownsWheel(session: Session, event: WheelEvent) {
  return (
    !event.ctrlKey &&
    session.surface.contains(document.activeElement) &&
    document.hasFocus() &&
    operable(session) &&
    !session.state.readOnly
  )
}

/**
 * Bytes for the window, from the browser that controls it. Input never claims control by itself,
 * so a view that only watches sends nothing. `typed` input ends a selection.
 */
export function sendInput(session: Session, data: string, typed = true) {
  const connection = session.connection
  const writable = () =>
    session.connection === connection && operable(session) && !session.state.readOnly
  if (!data || !writable()) return
  if (typed) session.selection.clear()
  if (session.mobile && data.length === 1 && hasModifiers(session.modifiers)) {
    data = modifiedText(data, session.modifiers)
    setModifiers(session)
  }
  session.input.write(() => {
    for (const chunk of terminalInputChunks(data)) {
      if (!writable()) return
      connection!.send({ type: 'input', data: chunk })
    }
  })
}
/** Input from a deliberate act on this view, which takes control of the window first. */
export function sendTerminalData(session: Session, data: string) {
  if (!data || !operable(session)) return false
  setModifiers(session)
  claimFocus(session)
  sendInput(session, data)
  return true
}
export function sendTerminalKey(
  session: Session,
  key: string,
  modifiers: Partial<TerminalModifiers>,
) {
  return sendTerminalData(session, terminalKey(key, modifiers))
}
export function pasteText(session: Session, text: string) {
  clearTimeout(session.shiftPaste)
  session.shiftPaste = undefined
  session.nativeKey = undefined
  sendTerminalData(session, encodePaste(text))
}

/** Give the terminal the focus; `keyboard` also opens its touch keyboard. */
export function focusTerminal(session: Session, keyboard = false) {
  if (!contentFocusable(session) || session.state.status === 'closed') return
  claimFocus(session)
  if (session.mobile) session.keyboard?.focus(keyboard)
  else session.desktopInput?.element.focus({ preventScroll: true })
  session.keyboardLock?.refresh(true)
}
export function blurTerminal(session: Session) {
  if (session.mobile) session.keyboard?.blur()
  else session.desktopInput?.element.blur()
}
/** The terminal's input gained or lost the keyboard. */
export function inputFocused(session: Session, focused: boolean) {
  if (clipboardBorrowingFocus()) return
  if (!focused) {
    session.nativeKey = undefined
    setModifiers(session)
  } else claimFocus(session)
  session.painter.setFocus(focused)
  sendInput(session, encodeFocus(focused), false)
}

/**
 * A key before it is encoded as text: `sent` when it went to the window as a shortcut, `native`
 * when the browser must keep it (a paste, a copy, an input method), otherwise the caller's.
 */
export function handleKey(session: Session, event: KeyboardEvent): 'sent' | 'native' | undefined {
  if (!interactive(session)) return 'native'
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    ['Process', 'Dead', 'AltGraph'].includes(event.key) ||
    event.getModifierState('AltGraph')
  ) {
    // The input method owns every key of a composition, including copy and paste chords
    // reported with real key codes by some Linux IME bridges.
    session.nativeKey = undefined
    setModifiers(session)
    return 'native'
  }
  const shiftPaste =
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.code === 'KeyV' || event.key.toLowerCase() === 'v')
  if (
    shiftPaste &&
    session.settings.shiftPaste === 'paste' &&
    event.type === 'keydown' &&
    !event.repeat
  ) {
    const input = inputElement(session)
    clearTimeout(session.shiftPaste)
    session.shiftPaste = setTimeout(() => {
      session.shiftPaste = undefined
      if (document.activeElement !== input) return
      void navigator.clipboard?.readText?.().then(
        (text) => {
          if (text && document.activeElement === input) pasteText(session, text)
        },
        () => {},
      )
    }, 150)
  }
  if (!(shiftPaste && session.settings.shiftPaste === 'terminal')) {
    const clipboard = session.clipboard.key(event)
    if (clipboard) {
      session.nativeKey = undefined
      return clipboard
    }
  }
  const id = event.code || event.key
  if (event.type === 'keyup' && session.nativeKey?.id === id) {
    session.nativeKey = undefined
    event.preventDefault()
    event.stopPropagation()
    return 'sent'
  }
  if (event.type === 'keypress' && session.nativeKey) {
    event.preventDefault()
    event.stopPropagation()
    return 'sent'
  }
  if (event.type === 'keydown') {
    // A virtual latch is consumed once, but remains held for auto-repeat.
    // Physical modifiers are read afresh on every repeated keydown.
    const virtual =
      session.mobile && event.repeat && session.nativeKey?.id === id
        ? session.nativeKey.virtual
        : session.modifiers
    session.nativeKey = undefined
    const data = terminalShortcut(event, virtual, navigator.platform)
    if (data && sendTerminalData(session, data)) {
      session.nativeKey = { id, virtual }
      event.preventDefault()
      event.stopPropagation()
      return 'sent'
    }
  }
  const mobileInput = session.mobile ? session.mobileInput?.element : undefined
  if (
    mobileInput &&
    document.activeElement === mobileInput &&
    event.type === 'keydown' &&
    (event.key.length !== 1 ||
      (!mobileInput.isContentEditable && !event.ctrlKey && !event.altKey && !event.metaKey)) &&
    sendTerminalKey(session, event.key, {
      shift: event.key.length !== 1 && event.shiftKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
    })
  ) {
    event.preventDefault()
    return 'sent'
  }
  if (event.type === 'keydown' && session.state.readOnly) claimFocus(session)
}
