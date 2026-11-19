export interface TerminalModifiers {
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
}
export const emptyModifiers = (): TerminalModifiers => ({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
})
export const hasModifiers = (modifiers: Partial<TerminalModifiers>) =>
  !!(modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta)

interface PhysicalKey {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
  getModifierState?(key: string): boolean
}

/** DOM key values already include the physical layout, Shift and Caps Lock. */
export function terminalShortcut(
  event: PhysicalKey,
  virtual: Partial<TerminalModifiers> = {},
  platform = '',
): string {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    ['Process', 'Dead', 'AltGraph'].includes(event.key) ||
    event.getModifierState?.('AltGraph')
  )
    return ''
  // The platform's select-all is not a key for the window.
  if (
    /Mac/.test(platform) &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'a'
  )
    return ''
  const printable = [...event.key].length === 1
  // Preserve native third-level text entry, including browsers without AltGraph.
  if (
    printable &&
    !event.metaKey &&
    event.altKey &&
    ((/Mac/.test(platform) && !event.ctrlKey) || (/Win/.test(platform) && event.ctrlKey))
  )
    return ''
  const modifiers = {
    shift: !!(virtual.shift || event.shiftKey),
    ctrl: !!(virtual.ctrl || event.ctrlKey),
    alt: !!(virtual.alt || event.altKey),
    meta: !!(virtual.meta || event.metaKey),
  }
  if (
    !hasModifiers(virtual) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !(event.shiftKey && !printable) &&
    !/^F([1-9]|1[0-2])$/.test(event.key)
  )
    return ''
  // Caps Lock raises a letter's text, not its control code: Ctrl+C under Caps Lock is Ctrl+C,
  // and only Shift makes it Ctrl+Shift+C.
  const key =
    printable && virtual.shift && !event.shiftKey
      ? shifted(event.key)
      : modifiers.ctrl && !modifiers.shift && /^[A-Z]$/.test(event.key)
        ? event.key.toLowerCase()
        : event.key
  const modifier =
    1 +
    Number(modifiers.shift) +
    2 * Number(modifiers.alt) +
    4 * Number(modifiers.ctrl) +
    8 * Number(modifiers.meta)
  if (printable) return `\x1b[${key.codePointAt(0)};${modifier}u`
  if (key === 'Tab' && modifiers.shift && !modifiers.ctrl && !modifiers.alt && !modifiers.meta)
    return '\x1b[Z'
  const basic: Record<string, number> = { Tab: 9, Enter: 13, Backspace: 127, Escape: 27 }
  if (basic[key] && modifier > 1) return `\x1b[${basic[key]};${modifier}u`
  return terminalKey(key, modifiers)
}

const shiftedSymbols: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
}
/** The character Shift makes of a key on a US layout; Shift swaps a letter Caps Lock raised. */
function shifted(text: string) {
  if (/^[a-z]$/.test(text)) return text.toUpperCase()
  if (/^[A-Z]$/.test(text)) return text.toLowerCase()
  return shiftedSymbols[text] ?? text
}

/**
 * The bytes for a key pressed on the built-in keyboard, or for one character typed while its
 * modifiers are latched: exactly what that key sends from a physical keyboard. The server's
 * terminal engine encodes the chord for the program's own keyboard mode.
 */
export function pressedKey(key: string, modifiers: Partial<TerminalModifiers> = {}): string {
  const printable = [...key].length === 1
  const event = {
    key: printable && modifiers.shift ? shifted(key) : key,
    shiftKey: !!modifiers.shift,
    ctrlKey: !!modifiers.ctrl,
    altKey: !!modifiers.alt,
    metaKey: !!modifiers.meta,
  }
  return terminalShortcut(event) || (printable ? event.key : terminalKey(key))
}

/** A named key as the window's fixed modes take it; cursor keys are in application mode. */
function terminalKey(key: string, modifiers: Partial<TerminalModifiers> = {}): string {
  const modifier =
    1 +
    (modifiers.shift ? 1 : 0) +
    (modifiers.alt ? 2 : 0) +
    (modifiers.ctrl ? 4 : 0) +
    (modifiers.meta ? 8 : 0)
  const cursor: Record<string, string> = {
    ArrowUp: 'A',
    ArrowDown: 'B',
    ArrowRight: 'C',
    ArrowLeft: 'D',
    Home: 'H',
    End: 'F',
  }
  if (cursor[key]) return modifier > 1 ? `\x1b[1;${modifier}${cursor[key]}` : `\x1bO${cursor[key]}`
  const tilde: Record<string, number> = {
    Insert: 2,
    Delete: 3,
    PageUp: 5,
    PageDown: 6,
    F5: 15,
    F6: 17,
    F7: 18,
    F8: 19,
    F9: 20,
    F10: 21,
    F11: 23,
    F12: 24,
  }
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ''}~`
  const fn: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
  if (fn[key]) return modifier > 1 ? `\x1b[1;${modifier}${fn[key]}` : `\x1bO${fn[key]}`
  // A chord on one of these is sent whole above; here they are pressed alone.
  const basic: Record<string, string> = {
    Escape: '\x1b',
    Tab: '\t',
    Enter: '\r',
    Backspace: '\x7f',
  }
  return basic[key] ?? ''
}
