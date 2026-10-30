export interface TerminalModifiers { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
export const emptyModifiers = (): TerminalModifiers => ({ shift: false, ctrl: false, alt: false, meta: false })
export const hasModifiers = (modifiers: Partial<TerminalModifiers>) => !!(modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta)

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
export function terminalShortcut(event: PhysicalKey, virtual: Partial<TerminalModifiers> = {}, applicationCursor = false, platform = ''): string {
  if (event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'AltGraph'].includes(event.key) || event.getModifierState?.('AltGraph')) return ''
  // xterm implements the platform's familiar local select-all shortcut.
  if (/Mac/.test(platform) && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') return ''
  const printable = [...event.key].length === 1
  // Preserve native third-level text entry, including browsers without AltGraph.
  if (printable && !event.metaKey && event.altKey &&
      (/Mac/.test(platform) && !event.ctrlKey || /Win/.test(platform) && event.ctrlKey)) return ''
  const modifiers = {
    shift: !!(virtual.shift || event.shiftKey), ctrl: !!(virtual.ctrl || event.ctrlKey),
    alt: !!(virtual.alt || event.altKey), meta: !!(virtual.meta || event.metaKey),
  }
  if (!hasModifiers(virtual) && !event.ctrlKey && !event.altKey && !event.metaKey &&
      !(event.shiftKey && !printable) && !/^F([1-9]|1[0-2])$/.test(event.key)) return ''
  const key = printable && virtual.shift && !event.shiftKey ? modifiedText(event.key, { shift: true }) : event.key
  const modifier = 1 + Number(modifiers.shift) + 2 * Number(modifiers.alt) + 4 * Number(modifiers.ctrl) + 8 * Number(modifiers.meta)
  if (printable) return `\x1b[${key.codePointAt(0)};${modifier}u`
  if (key === 'Tab' && modifiers.shift && !modifiers.ctrl && !modifiers.alt && !modifiers.meta) return '\x1b[Z'
  const basic: Record<string, number> = { Tab: 9, Enter: 13, Backspace: 127, Escape: 27 }
  if (basic[key] && modifier > 1) return `\x1b[${basic[key]};${modifier}u`
  return terminalKey(key, modifiers, applicationCursor)
}

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
  // Preserve Enter modifiers on the Canvas→herdr link. Herdr chooses the
  // child application's negotiated keyboard encoding from this semantic key.
  if (key === 'Enter' && (modifiers.shift || modifiers.ctrl || modifiers.meta)) return `\x1b[13;${modifier}u`
  if (key === 'BackTab' || (key === 'Tab' && modifiers.shift)) return '\x1b[Z'
  const basic: Record<string, string> = { Escape: '\x1b', Tab: '\t', Enter: '\r', Backspace: modifiers.ctrl ? '\b' : '\x7f' }
  if (basic[key]) return (modifiers.alt || modifiers.meta ? '\x1b' : '') + basic[key]
  return key.length === 1 ? modifiedText(key, modifiers) : ''
}
