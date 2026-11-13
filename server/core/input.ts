import { bracketedPaste } from '../../shared/paste.ts'
import type { ClientKeyCode, ClientPaneInputEvent } from '../herdr/wire.ts'

/** The modes which affect input are observed on the same parser lane as paint. */
export interface CoreInputModes {
  applicationCursor: boolean
  bracketedPaste: boolean
  mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouse: boolean
  pixelMouse: boolean
  utf8Mouse: boolean
  urxvtMouse: boolean
  kitty: number
  modifyOtherKeys: number
  win32: boolean
}
const SHIFT = 1,
  CONTROL = 2,
  ALT = 4,
  SUPER = 8
const ESC = '\x1b'
const modifiers = (bits: number) =>
  1 +
  (bits & SHIFT ? 1 : 0) +
  (bits & ALT ? 2 : 0) +
  (bits & CONTROL ? 4 : 0) +
  (bits & SUPER ? 8 : 0)
const control = (text: string) => {
  const code = text.toUpperCase().charCodeAt(0)
  if (text === ' ' || text === '2' || text === '@') return '\0'
  if (text === '?' || text === '8') return '\x7f'
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  if (text >= '3' && text <= '7') return String.fromCharCode(text.charCodeAt(0) - 24)
  return text
}
function keyName(code: ClientKeyCode): string {
  return typeof code === 'string' ? code : 'Char' in code ? code.Char : `F${code.F}`
}
function character(code: ClientKeyCode): number | undefined {
  if (typeof code === 'object' && 'Char' in code) return code.Char.codePointAt(0)
  const basic: Record<string, number> = {
    Enter: 13,
    Esc: 27,
    Backspace: 127,
    Tab: 9,
    BackTab: 9,
    Null: 0,
  }
  return typeof code === 'string' ? basic[code] : undefined
}
function win32Key(code: ClientKeyCode, bits: number): string | undefined {
  if (code !== 'Enter' && code !== 'Esc') return
  const vk = code === 'Enter' ? 13 : 27,
    scan = code === 'Enter' ? 28 : 1
  const typed = code === 'Enter' && bits & CONTROL ? 10 : vk
  const held = (bits & SHIFT ? 0x10 : 0) | (bits & CONTROL ? 8 : 0) | (bits & ALT ? 2 : 0)
  return [1, 0].map((down) => `${ESC}[${vk};${scan};${typed};${down};${held};1_`).join('')
}

/** Encode actual human keys, without the quiet/submit behavior of terminal.keys/send. */
export function coreInput(event: ClientPaneInputEvent, modes: CoreInputModes): Buffer {
  if ('TextCommit' in event) return Buffer.from(event.TextCommit)
  if ('Paste' in event)
    return Buffer.from(modes.bracketedPaste ? bracketedPaste(event.Paste) : event.Paste)
  if ('Mouse' in event) {
    const mouse = event.Mouse,
      kind = mouse.kind
    if (modes.mouse === 'none') return Buffer.alloc(0)
    const released = typeof kind === 'object' && 'Up' in kind
    const dragged = typeof kind === 'object' && 'Drag' in kind
    if (
      modes.mouse === 'x10' &&
      (released || dragged || (typeof kind === 'string' && !kind.startsWith('Scroll')))
    )
      return Buffer.alloc(0)
    if (
      (dragged && modes.mouse !== 'drag' && modes.mouse !== 'any') ||
      (kind === 'Moved' && modes.mouse !== 'any')
    )
      return Buffer.alloc(0)
    const button = typeof kind === 'object' ? Object.values(kind)[0] : undefined
    let code = button === 'Left' ? 0 : button === 'Middle' ? 1 : button === 'Right' ? 2 : 3
    if (typeof kind === 'string' && kind.startsWith('Scroll'))
      code =
        (
          { ScrollUp: 64, ScrollDown: 65, ScrollLeft: 66, ScrollRight: 67 } as Record<
            string,
            number
          >
        )[kind] ?? 64
    if (dragged || kind === 'Moved') code += 32
    if (mouse.modifiers & SHIFT) code += 4
    if (mouse.modifiers & ALT) code += 8
    if (mouse.modifiers & CONTROL) code += 16
    const position = 'Cell' in mouse.position ? mouse.position.Cell : mouse.position.Pixels
    let x = position.column + 1,
      y = position.row + 1
    if (modes.pixelMouse && 'Pixels' in mouse.position) {
      x = mouse.position.Pixels.x + 1
      y = mouse.position.Pixels.y + 1
    }
    const repeats =
      typeof kind === 'string' && kind.startsWith('Scroll')
        ? Math.max(1, Math.min(15, mouse.lines))
        : 1
    if (modes.sgrMouse || modes.pixelMouse)
      return Buffer.from(`${ESC}[<${code};${x};${y}${released ? 'm' : 'M'}`.repeat(repeats))
    if (released) code = 3 + (code & 28)
    if (modes.urxvtMouse) return Buffer.from(`${ESC}[${code + 32};${x};${y}M`.repeat(repeats))
    if (modes.utf8Mouse)
      return Buffer.from(
        (
          ESC +
          '[M' +
          String.fromCodePoint(code + 32, Math.min(x, 2015) + 32, Math.min(y, 2015) + 32)
        ).repeat(repeats),
      )
    return Buffer.concat(
      Array.from({ length: repeats }, () =>
        Buffer.from([27, 91, 77, code + 32, Math.min(x, 223) + 32, Math.min(y, 223) + 32]),
      ),
    )
  }
  const key = event.Key,
    bits = key.modifiers,
    name = keyName(key.code),
    modifier = modifiers(bits)
  if (key.kind === 'Release' && !(modes.kitty & 2)) return Buffer.alloc(0)
  const cp = character(key.code)
  const eventType =
    modes.kitty & 2 ? (key.kind === 'Release' ? ':3' : key.kind === 'Repeat' ? ':2' : '') : ''
  if (modes.win32 && !modes.kitty) {
    const encoded = win32Key(key.code, bits)
    if (encoded) return Buffer.from(encoded)
  }
  const kitty =
    modes.kitty &&
    cp !== undefined &&
    (modes.kitty & 8 ||
      bits & (CONTROL | ALT | SUPER) ||
      name === 'Esc' ||
      (bits & SHIFT && ['Enter', 'Backspace', 'Tab', 'BackTab'].includes(name)))
  if (kitty) {
    return Buffer.from(
      `${ESC}[${cp}${modifier > 1 || eventType ? `;${modifier}${eventType}` : ''}u`,
    )
  }
  const cursor: Record<string, string> = {
    Up: 'A',
    Down: 'B',
    Right: 'C',
    Left: 'D',
    Home: 'H',
    End: 'F',
  }
  if (cursor[name])
    return Buffer.from(
      modifier > 1 || eventType
        ? `${ESC}[1;${modifier}${eventType}${cursor[name]}`
        : `${ESC}${modes.applicationCursor ? 'O' : '['}${cursor[name]}`,
    )
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
  if (tilde[name])
    return Buffer.from(
      `${ESC}[${tilde[name]}${modifier > 1 || eventType ? `;${modifier}${eventType}` : ''}~`,
    )
  const fn: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
  if (fn[name])
    return Buffer.from(
      modifier > 1 || eventType
        ? `${ESC}[1;${modifier}${eventType}${fn[name]}`
        : `${ESC}O${fn[name]}`,
    )
  if (key.kind === 'Release') return Buffer.alloc(0)
  if ((name === 'Tab' && bits === SHIFT) || name === 'BackTab') return Buffer.from(`${ESC}[Z`)
  if (
    modes.modifyOtherKeys &&
    cp !== undefined &&
    modifier > 1 &&
    (modes.modifyOtherKeys >= 2 || bits & (CONTROL | ALT))
  )
    return Buffer.from(`${ESC}[27;${modifier};${cp}~`)
  // Legacy terminals have no distinct Super key. Dropping it avoids typing escape junk.
  if (bits & SUPER) return Buffer.alloc(0)
  let value = cp === undefined ? '' : String.fromCodePoint(cp)
  if (name === 'Backspace') value = bits & CONTROL ? '\b' : '\x7f'
  else if (name === 'Tab') value = '\t'
  else if (name === 'Enter') value = '\r'
  else if (name === 'Esc') value = ESC
  else if (bits & CONTROL) value = control(value)
  if (bits & ALT) value = ESC + value
  return Buffer.from(value)
}
