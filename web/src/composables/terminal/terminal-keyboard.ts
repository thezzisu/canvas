import { bindDesktopInput } from './desktop-input'
import { bindMobileInput } from './mobile-input'
import { bindMobileKeyboard, type MobileKeyboardState } from './mobile-keyboard'
import { handleKey, inputFocused, pasteText, sendInput, sendTerminalKey } from './terminal-keys'
import { claimFocus, interactive, setModifiers, setState, type Session } from './terminal-session'

/** The keyboard for the session's form factor: a desktop field, or the touch input and its keyboard. */
export function bindKeyboard(session: Session) {
  if (session.mobile === !!session.keyboard && session.mobile !== !!session.desktopInput) return
  session.keyboard?.dispose()
  session.keyboard = undefined
  session.mobileInput?.dispose()
  session.mobileInput = undefined
  session.desktopInput?.dispose()
  session.desktopInput = undefined
  if (!session.mobile) {
    session.desktopInput = bindDesktopInput(session.surface, {
      active: () =>
        interactive(session) &&
        session.state.status !== 'closed' &&
        !(session.state.presentation?.maximized && !session.state.presentation.owned),
      send: (data) => sendInput(session, data),
      key: (event) => handleKey(session, event),
      paste: (text) => pasteText(session, text),
      preedit: (text) => session.painter.setPreedit(text),
      focus: () => inputFocused(session, true),
      blur: () => inputFocused(session, false),
      mac: /Mac/.test(navigator.platform),
    })
    return
  }
  const input = (session.mobileInput = bindMobileInput(session.surface, {
    active: () => session.mobile && interactive(session) && !!session.host?.isConnected,
    input: (text) => {
      claimFocus(session)
      sendInput(session, text)
    },
    paste: (text) => pasteText(session, text),
    files: (files) => session.uploads.enqueue(files),
    key: (event) => void handleKey(session, event),
    special: (key) => void sendTerminalKey(session, key, session.modifiers),
    composing: () => {
      session.nativeKey = undefined
      setModifiers(session)
    },
    focus: () => inputFocused(session, true),
    blur: () => inputFocused(session, false),
  }))
  const keyboardChanged = (state: MobileKeyboardState) => {
    session.resizePrompted = true
    session.keyboardRequested = state.open
    setState(session, {
      ...session.state,
      keyboardMode: state.mode,
      keyboardDeck: state.deck,
      keyboardComposer: state.composer,
    })
  }
  session.keyboard = bindMobileKeyboard(input.element, {
    active: () => session.mobile && session.magnified && !!session.host?.isConnected,
    changed: keyboardChanged,
    setEditable: input.setEditable,
    finishEditing: input.finishEditing,
  })
  keyboardChanged(session.keyboard.state)
}
