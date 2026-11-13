/**
 * Input for the outer terminal surface, as the bytes xterm.js 6 sends in the surface's fixed
 * modes: application cursor keys, bracketed paste, any-motion mouse in
 * SGR encoding and focus reporting. Pure: no DOM, no state.
 */

import { bracketedPaste } from '../../../../shared/paste'

export type EncodedKey = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
>

const ESC = '\x1b'
// Keys named by `KeyboardEvent.code`, as [key code, unshifted, shifted] on a US layout.
const PUNCTUATION: Record<string, [number, string, string]> = {
  Semicolon: [186, ';', ':'],
  Equal: [187, '=', '+'],
  Comma: [188, ',', '<'],
  Minus: [189, '-', '_'],
  Period: [190, '.', '>'],
  Slash: [191, '/', '?'],
  Backquote: [192, '`', '~'],
  BracketLeft: [219, '[', '{'],
  Backslash: [220, '\\', '|'],
  BracketRight: [221, ']', '}'],
  Quote: [222, "'", '"'],
}
const SHIFTED_DIGITS = ')!@#$%^&*('
const CURSOR: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
}
const FUNCTION: Record<string, string | number> = {
  F1: 'P',
  F2: 'Q',
  F3: 'R',
  F4: 'S',
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
}

/**
 * The legacy key code xterm.js switches on, for the keys whose bytes depend on it. A Latin
 * letter is the layout's own (Ctrl+A is where the layout has A); any other key is named by its
 * position, so chords work on a layout without Latin letters.
 */
function keyCode(event: EncodedKey): number {
  const { key, code } = event
  if (code.startsWith('Numpad')) return 0
  if (/^[a-z]$/iu.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^Key[A-Z]$/u.test(code)) return code.charCodeAt(3)
  if (/^Digit\d$/u.test(code)) return code.charCodeAt(5)
  if (PUNCTUATION[code]) return PUNCTUATION[code][0]
  if (code === 'Space' || key === ' ') return 32
  if (/^\d$/u.test(key)) return key.charCodeAt(0)
  return Object.values(PUNCTUATION).find((entry) => entry.includes(key))?.[0] ?? 0
}

/**
 * The bytes for a key press, '' for a key that sends nothing, or undefined for a key that is
 * not the terminal's: the browser or an input method produces its text.
 *
 * `mac` keeps Option for the layout's third level and Command for the browser, as xterm.js does.
 */
export function encodeKey(event: EncodedKey, mac = false): string | undefined {
  const { key, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta } = event
  const modifiers = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0) | (meta ? 8 : 0)
  const csi = (body: string | number, final: string) =>
    `${ESC}[${body}${modifiers ? `;${modifiers + 1}` : ''}${final}`

  switch (key) {
    case 'Backspace':
      return (alt ? ESC : '') + (ctrl ? '\b' : '\x7f')
    case 'Tab':
      return shift ? `${ESC}[Z` : '\t'
    case 'Enter':
      return alt ? `${ESC}\r` : '\r'
    case 'Escape':
      return alt ? ESC + ESC : ESC
    case 'Insert':
      // Shift+Insert and Ctrl+Insert are the browser's paste and copy.
      return shift || ctrl ? undefined : `${ESC}[2~`
    case 'Delete':
      return csi(3, '~')
    case 'PageUp':
    case 'PageDown': {
      // Shift scrolls xterm.js's own buffer, which the surface does not have.
      if (shift) return ''
      const page = key === 'PageUp' ? 5 : 6
      return ctrl ? csi(page, '~') : `${ESC}[${page}~`
    }
  }
  const cursor = CURSOR[key]
  if (cursor) {
    if (meta && key.startsWith('Arrow')) return undefined
    return modifiers ? csi(1, cursor) : `${ESC}O${cursor}`
  }
  const fn = FUNCTION[key]
  if (typeof fn === 'number') return csi(fn, '~')
  if (fn) return modifiers ? csi(1, fn) : `${ESC}O${fn}`

  const code = keyCode(event)
  if (ctrl && !shift && !alt && !meta) {
    if (code >= 65 && code <= 90) return String.fromCharCode(code - 64)
    if (code === 32) return '\0'
    if (code >= 51 && code <= 55) return String.fromCharCode(code - 51 + 27)
    if (code === 56) return '\x7f'
    if (code >= 219 && code <= 221) return String.fromCharCode(code - 219 + 27)
    return undefined
  }
  if (alt && !meta && !mac) {
    const punctuation = Object.values(PUNCTUATION).find((entry) => entry[0] === code)
    if (punctuation) return ESC + punctuation[shift ? 2 : 1]
    if (code >= 48 && code <= 57)
      return ESC + (shift ? SHIFTED_DIGITS[code - 48]! : String.fromCharCode(code))
    if (code >= 65 && code <= 90) {
      const letter = String.fromCharCode(ctrl ? code - 64 : code + 32)
      return ESC + (shift ? letter.toUpperCase() : letter)
    }
    if (code === 32) return ESC + (ctrl ? '\0' : ' ')
    return undefined
  }
  if (ctrl) return key === '_' ? '\x1f' : key === '@' ? '\0' : undefined
  if (!alt && !meta && [...key].length === 1) return key
  return undefined
}

/** Pasted text between the bracketed-paste markers, with line ends as carriage returns. */
export function encodePaste(text: string): string {
  return bracketedPaste(text.replace(/\r?\n/gu, '\r'))
}

export function encodeFocus(focused: boolean): string {
  return focused ? `${ESC}[I` : `${ESC}[O`
}

export interface EncodedMouse {
  /** `move` with a button held is a drag; with `none`, plain motion. */
  type: 'press' | 'release' | 'move' | 'wheel'
  /** For a wheel event, the direction: `up` or `down`. */
  button: 'left' | 'middle' | 'right' | 'none' | 'up' | 'down'
  /** Zero-based cell. */
  column: number
  row: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

const BUTTONS = { left: 0, middle: 1, right: 2, none: 3 }

/** An SGR mouse report, or '' for an event the protocol has no report for. */
export function encodeMouse(event: EncodedMouse): string {
  const { type, button } = event
  if (event.column < 0 || event.row < 0) return ''
  const wheel = button === 'up' || button === 'down'
  if (wheel !== (type === 'wheel')) return ''
  if (button === 'none' && type !== 'move') return ''
  let code = (event.ctrl ? 16 : 0) | (event.shift ? 4 : 0) | (event.alt ? 8 : 0)
  if (wheel) code |= 64 | (button === 'down' ? 1 : 0)
  else code |= BUTTONS[button] | (type === 'move' ? 32 : 0)
  return `${ESC}[<${code};${event.column + 1};${event.row + 1}${type === 'release' ? 'm' : 'M'}`
}
