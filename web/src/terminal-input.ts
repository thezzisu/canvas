export interface TerminalModifiers { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
export const emptyModifiers = (): TerminalModifiers => ({ shift: false, ctrl: false, alt: false, meta: false })
export const hasModifiers = (modifiers: Partial<TerminalModifiers>) => !!(modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta)

const shifted: Record<string, string> = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
}

export function modifiedText(text: string, modifiers: Partial<TerminalModifiers>): string {
  // Compose/paste text is not a sequence of keyboard chords. Only a single
  // ASCII key can consume the on-screen modifier latch.
  if (text.length !== 1 || text.charCodeAt(0) < 32 || text.charCodeAt(0) > 126) return text
  let value = text
  if (modifiers.shift) value = /[a-z]/.test(value) ? value.toUpperCase() : /[A-Z]/.test(value) ? value.toLowerCase() : shifted[value] || value
  if (modifiers.ctrl) {
    const code = value.toUpperCase().charCodeAt(0)
    if (value === ' ' || value === '2') value = '\x00'
    else if (value === '?' || value === '8') value = '\x7f'
    else if (code >= 64 && code <= 95) value = String.fromCharCode(code - 64)
    else if (code >= 96 && code <= 126) value = String.fromCharCode(code & 31)
    else if (value >= '3' && value <= '7') value = String.fromCharCode(value.charCodeAt(0) - 24)
  }
  // Traditional terminal Meta uses the same ESC prefix as Alt for characters.
  // Special keys below retain the distinct Meta modifier bit.
  return (modifiers.alt || modifiers.meta ? '\x1b' : '') + value
}

export function terminalKey(key: string, modifiers: Partial<TerminalModifiers> = {}, applicationCursor = false): string {
  const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0) + (modifiers.meta ? 8 : 0)
  const cursor: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }
  if (cursor[key]) return modifier > 1 ? `\x1b[1;${modifier}${cursor[key]}` : `\x1b${applicationCursor ? 'O' : '['}${cursor[key]}`
  const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ''}~`
  const fn: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
  if (fn[key]) return modifier > 1 ? `\x1b[1;${modifier}${fn[key]}` : `\x1bO${fn[key]}`
  if (key === 'BackTab' || (key === 'Tab' && modifiers.shift)) return '\x1b[Z'
  const basic: Record<string, string> = { Escape: '\x1b', Tab: '\t', Enter: '\r', Backspace: modifiers.ctrl ? '\b' : '\x7f' }
  if (basic[key]) return (modifiers.alt || modifiers.meta ? '\x1b' : '') + basic[key]
  return key.length === 1 ? modifiedText(key, modifiers) : ''
}
