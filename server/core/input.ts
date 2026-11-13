import { bracketedPaste } from '../../shared/paste.ts'
import { MODS, type GhosttyTerminal } from '../ghostty/terminal.ts'
import type { ClientKeyCode, ClientPaneInputEvent } from '../herdr/wire.ts'

/** The cell size the core is told panes have; pixel mouse reports are in these cells. */
export const CORE_CELL = { width: 8, height: 16 } as const

// Herdr's modifier bits are the engine's: Shift 1, Control 2, Alt 4, Super 8.
const NAMED: Record<string, { key: string; text?: string; mods?: number }> = {
  // The engine sends these as text unless a mode or modifier asks for more.
  Backspace: { key: 'BACKSPACE', text: '\x7f' },
  Enter: { key: 'ENTER', text: '\r' },
  Tab: { key: 'TAB', text: '\t' },
  BackTab: { key: 'TAB', mods: MODS.shift },
  Esc: { key: 'ESCAPE', text: '\x1b' },
  Null: { key: 'SPACE', mods: MODS.ctrl },
  Left: { key: 'ARROW_LEFT' },
  Right: { key: 'ARROW_RIGHT' },
  Up: { key: 'ARROW_UP' },
  Down: { key: 'ARROW_DOWN' },
  Home: { key: 'HOME' },
  End: { key: 'END' },
  PageUp: { key: 'PAGE_UP' },
  PageDown: { key: 'PAGE_DOWN' },
  Delete: { key: 'DELETE' },
  Insert: { key: 'INSERT' },
}
/** The keys of a US keyboard by the character they type, and by its shifted character. */
const PLAIN = new Map<string, string>([
  [' ', 'SPACE'],
  ['`', 'BACKQUOTE'],
  ['-', 'MINUS'],
  ['=', 'EQUAL'],
  ['[', 'BRACKET_LEFT'],
  [']', 'BRACKET_RIGHT'],
  ['\\', 'BACKSLASH'],
  [';', 'SEMICOLON'],
  ["'", 'QUOTE'],
  [',', 'COMMA'],
  ['.', 'PERIOD'],
  ['/', 'SLASH'],
])
const SHIFTED = new Map<string, string>()
for (const [index, shifted] of [...')!@#$%^&*('].entries()) {
  PLAIN.set(String(index), `DIGIT_${index}`)
  SHIFTED.set(shifted, String(index))
}
for (const [shifted, plain] of ['~`', '_-', '+=', '{[', '}]', '|\\', ':;', '"\'', '<,', '>.', '?/'])
  SHIFTED.set(shifted!, plain!)
for (let code = 97; code <= 122; code++) {
  const letter = String.fromCharCode(code)
  PLAIN.set(letter, letter.toUpperCase())
  SHIFTED.set(letter.toUpperCase(), letter)
}

/**
 * Whether a pane's program wants win32 key records: the last `CSI ? … 9001 … h` or `l` in its
 * bytes. The engine has no such mode, and the core ends every first paint with one of the two.
 */
export class Win32InputMode {
  on = false
  /** The end of the bytes scanned last, where it may begin such a sequence. */
  private pending: Buffer | undefined

  /** Takes the next bytes and says whether they set or reset the mode. */
  scan(data: Uint8Array): boolean {
    let bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (this.pending) bytes = Buffer.concat([this.pending, bytes])
    this.pending = undefined
    let seen = false
    for (let at = bytes.indexOf(0x1b); at >= 0; at = bytes.indexOf(0x1b, at + 1)) {
      let end = at + 1
      if (end < bytes.length && bytes[end++] !== 0x5b) continue
      if (end < bytes.length && bytes[end++] !== 0x3f) continue
      const parameters = end
      while (
        end < bytes.length &&
        ((bytes[end]! >= 0x30 && bytes[end]! <= 0x39) || bytes[end] === 0x3b)
      )
        end++
      if (end >= bytes.length) {
        if (bytes.length - at <= 64) this.pending = Buffer.from(bytes.subarray(at))
        break
      }
      const final = bytes[end]
      if (
        (final === 0x68 || final === 0x6c) &&
        bytes.toString('latin1', parameters, end).split(';').includes('9001')
      ) {
        this.on = final === 0x68
        seen = true
      }
    }
    return seen
  }
}

/** win32-input-mode, which ConPTY asks for, has its own record for the keys it must tell apart. */
function win32Key(code: ClientKeyCode, mods: number): string | undefined {
  if (code !== 'Enter' && code !== 'Esc') return
  const vk = code === 'Enter' ? 13 : 27,
    scan = code === 'Enter' ? 28 : 1
  const typed = code === 'Enter' && mods & MODS.ctrl ? 10 : vk
  const held =
    (mods & MODS.shift ? 0x10 : 0) | (mods & MODS.ctrl ? 8 : 0) | (mods & MODS.alt ? 2 : 0)
  return [1, 0].map((down) => `\x1b[${vk};${scan};${typed};${down};${held};1_`).join('')
}

function key(
  event: Extract<ClientPaneInputEvent, { Key: unknown }>['Key'],
  terminal: GhosttyTerminal,
  win32: boolean,
): Uint8Array {
  const action = event.kind === 'Press' ? 'PRESS' : event.kind === 'Repeat' ? 'REPEAT' : 'RELEASE'
  if (win32 && action !== 'RELEASE' && !terminal.kittyKeyboard) {
    const record = win32Key(event.code, event.modifiers)
    if (record) return Buffer.from(record)
  }
  const input = { action, mods: event.modifiers, consumed: 0, text: '', unshifted: 0 } as const
  if (typeof event.code === 'string') {
    const named = NAMED[event.code]!,
      mods = event.modifiers | (named.mods ?? 0)
    // Text is what the key types by itself; with a modifier the engine decides.
    return terminal.encodeKey({
      ...input,
      key: named.key,
      mods,
      text: mods ? '' : (named.text ?? ''),
    })
  }
  if ('F' in event.code) return terminal.encodeKey({ ...input, key: `F${event.code.F}` })
  // Outside the kitty protocol no byte says Super; the chord must not type its letter.
  if (event.modifiers & MODS.super && !terminal.kittyKeyboard) return new Uint8Array()
  const text = event.code.Char,
    plain = SHIFTED.get(text),
    base = plain ?? text
  const mods = event.modifiers | (plain ? MODS.shift : 0)
  return terminal.encodeKey({
    ...input,
    key: PLAIN.get(base) ?? 'UNIDENTIFIED',
    mods,
    consumed: plain ? MODS.shift : 0,
    text,
    unshifted: base.codePointAt(0)!,
  })
}

function mouse(
  event: Extract<ClientPaneInputEvent, { Mouse: unknown }>['Mouse'],
  terminal: GhosttyTerminal,
): Uint8Array {
  const kind = event.kind,
    position =
      'Pixels' in event.position
        ? event.position.Pixels
        : {
            x: (event.position.Cell.column + 0.5) * CORE_CELL.width,
            y: (event.position.Cell.row + 0.5) * CORE_CELL.height,
          }
  const input = { mods: event.modifiers, x: position.x, y: position.y, cell: CORE_CELL }
  if (typeof kind === 'string') {
    if (kind === 'Moved')
      return terminal.encodeMouse({
        ...input,
        action: 'MOTION',
        button: 'UNKNOWN',
        dragging: false,
      })
    // A wheel is the press of one of the buttons past the third, once per line.
    const button = {
      ScrollUp: 'FOUR',
      ScrollDown: 'FIVE',
      ScrollLeft: 'SIX',
      ScrollRight: 'SEVEN',
    }[kind]
    const report = terminal.encodeMouse({ ...input, action: 'PRESS', button, dragging: false })
    return Buffer.concat(
      Array.from({ length: Math.max(1, Math.min(15, event.lines)) }, () => report),
    )
  }
  const [action, button] =
    'Down' in kind
      ? (['PRESS', kind.Down] as const)
      : 'Up' in kind
        ? (['RELEASE', kind.Up] as const)
        : (['MOTION', kind.Drag] as const)
  return terminal.encodeMouse({
    ...input,
    action,
    button: button.toUpperCase(),
    dragging: action !== 'RELEASE',
  })
}

/**
 * What a person's input sends to a pane's program, in the modes that program asked for: the
 * engine that parsed its output encodes its keys and mouse.
 */
export function coreInput(
  event: ClientPaneInputEvent,
  terminal: GhosttyTerminal,
  win32 = false,
): Uint8Array {
  if ('TextCommit' in event) return Buffer.from(event.TextCommit)
  if ('Paste' in event)
    return Buffer.from(terminal.mode(2004) ? bracketedPaste(event.Paste) : event.Paste)
  return 'Mouse' in event ? mouse(event.Mouse, terminal) : key(event.Key, terminal, win32)
}
