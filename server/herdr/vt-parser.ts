/**
 * Reads what a browser sends a terminal (keys, paste, focus reports and mouse reports, as a VT
 * terminal would receive them) into the native input events both runtimes accept.
 */
import { MAX_TERMINAL_PASTE_BYTES as MAX_PENDING } from '../../shared/paste.ts'
import type { ClientKeyCode, ClientMouseKind, ClientPaneInputEvent } from './wire.ts'

export const SHIFT = 1,
  CONTROL = 2
const ALT = 4,
  SUPER = 8
export type Mouse = {
  column: number
  row: number
  modifiers: number
  kind: ClientMouseKind | 'Release'
}
export type ParsedInput = { event: ClientPaneInputEvent } | { mouse: Mouse } | { focus: boolean }

function key(code: ClientKeyCode, modifiers = 0): ClientPaneInputEvent {
  return {
    Key: {
      code,
      modifiers,
      kind: 'Press',
      repeat_count: 1,
      shifted_codepoint: null,
      generated_text: null,
      tracks_release: false,
      physical_key_id: null,
      windows_record: null,
    },
  }
}
function modifiers(value = 1) {
  const bits = value - 1
  return (
    (bits & 1 ? SHIFT : 0) |
    (bits & 2 ? ALT : 0) |
    (bits & 4 ? CONTROL : 0) |
    (bits & 8 ? SUPER : 0)
  )
}
function character(value: string, extra = 0): ClientPaneInputEvent {
  const code = value.codePointAt(0)!
  if (code === 13) return key('Enter', extra)
  if (code === 9) return key('Tab', extra)
  if (code === 27) return key('Esc', extra)
  if (code === 127) return key('Backspace', extra)
  if (code === 0) return key({ Char: ' ' }, extra | CONTROL)
  if (code < 27) return key({ Char: String.fromCharCode(code + 96) }, extra | CONTROL)
  if (code < 32) return key({ Char: ['[', '\\', ']', '^', '_'][code - 27]! }, extra | CONTROL)
  return key({ Char: value }, extra | (/^[A-Z]$/.test(value) ? SHIFT : 0))
}
function extendedCharacter(value: number, modifiers: number): ClientPaneInputEvent {
  const code: ClientKeyCode =
    value === 8 || value === 127
      ? 'Backspace'
      : value === 9
        ? 'Tab'
        : value === 13
          ? 'Enter'
          : value === 27
            ? 'Esc'
            : { Char: String.fromCodePoint(value) }
  return key(code, modifiers)
}
function scalarLength(bytes: Buffer, start: number) {
  const first = bytes[start]!
  return first < 0x80
    ? 1
    : first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 1
}
function mouse(buttons: number, column: number, row: number, released: boolean): Mouse | undefined {
  if (
    ![buttons, column, row].every(Number.isSafeInteger) ||
    buttons < 0 ||
    column < 1 ||
    row < 1 ||
    column > 65536 ||
    row > 65536
  )
    return
  const mods = (buttons & 4 ? SHIFT : 0) | (buttons & 8 ? ALT : 0) | (buttons & 16 ? CONTROL : 0)
  const button = (['Left', 'Middle', 'Right'] as const)[buttons & 3]
  const kind: Mouse['kind'] =
    buttons & 64
      ? (['ScrollUp', 'ScrollDown', 'ScrollLeft', 'ScrollRight'] as const)[buttons & 3]!
      : released
        ? button
          ? { Up: button }
          : 'Release'
        : buttons & 32
          ? button
            ? { Drag: button }
            : 'Moved'
          : button
            ? { Down: button }
            : 'Release'
  return { kind, column: column - 1, row: row - 1, modifiers: mods }
}

/** Outer xterm bytes are decoded once; herdr encodes semantic keys for each child. */
export class VtInputParser implements Disposable {
  private pending = Buffer.alloc(0)
  private paste: Buffer[] | undefined
  private pasteBytes = 0
  private discardPaste = false
  private discardControl?: boolean
  private escapeTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  constructor(
    private readonly emit: (input: ParsedInput) => void,
    private readonly failed: (error: Error) => void,
    private readonly escapeDelay = 35,
  ) {}

  write(data: string | Buffer) {
    if (this.disposed || !data.length) return
    clearTimeout(this.escapeTimer)
    this.pending = Buffer.concat([
      this.pending,
      typeof data === 'string' ? Buffer.from(data) : data,
    ])
    this.parse()
    if (
      this.pending.length === 1 &&
      this.pending[0] === 27 &&
      !this.paste &&
      this.discardControl === undefined
    ) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined
        this.flushEscape()
      }, this.escapeDelay)
      this.escapeTimer.unref()
    }
  }
  flushEscape() {
    if (
      !this.disposed &&
      this.pending.length === 1 &&
      this.pending[0] === 27 &&
      !this.paste &&
      this.discardControl === undefined
    ) {
      this.pending = Buffer.alloc(0)
      this.emit({ event: key('Esc') })
    }
  }
  private consume(bytes: number) {
    this.pending = this.pending.subarray(bytes)
  }
  private parse() {
    while (this.pending.length) {
      if (this.discardControl !== undefined) {
        const st = this.pending.indexOf('\x1b\\'),
          bell = this.discardControl ? this.pending.indexOf(7) : -1
        const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : -1
        if (end < 0) {
          this.pending = this.pending.subarray(Math.max(0, this.pending.length - 1))
          return
        }
        this.consume(end)
        this.discardControl = undefined
        continue
      }
      if (this.paste) {
        const end = this.pending.indexOf('\x1b[201~')
        // Retain enough bytes for an end marker split across network frames.
        const count = end < 0 ? Math.max(0, this.pending.length - 5) : end
        if (!this.discardPaste && this.pasteBytes + count > MAX_PENDING) {
          this.paste = []
          this.pasteBytes = 0
          this.discardPaste = true
          this.failed(new Error('Pasted text exceeds the herdr input limit'))
        }
        if (!this.discardPaste && count) {
          this.paste.push(this.pending.subarray(0, count))
          this.pasteBytes += count
        }
        this.consume(end < 0 ? count : end + 6)
        if (end < 0) return
        const text = !this.discardPaste ? Buffer.concat(this.paste).toString('utf8') : undefined
        this.paste = undefined
        this.pasteBytes = 0
        this.discardPaste = false
        if (text !== undefined) this.emit({ event: { Paste: text } })
        continue
      }
      if (this.pending[0] !== 27) {
        const count = scalarLength(this.pending, 0)
        if (this.pending.length < count) return
        const value = this.pending.subarray(0, count).toString('utf8')
        this.consume(count)
        this.emit({ event: count > 1 ? { TextCommit: value } : character(value) })
        continue
      }
      if (this.pending.length < 2) return
      let offset = 0,
        extra = 0
      if (this.pending[1] === 27) {
        if (this.pending.length < 3) {
          this.consume(1)
          this.emit({ event: key('Esc') })
          continue
        }
        if (this.pending[2] === 91 || this.pending[2] === 79) {
          offset = 1
          extra = ALT
        } else {
          this.consume(1)
          this.emit({ event: key('Esc') })
          continue
        }
      }
      const introducer = this.pending[offset + 1]
      if (introducer === 91 || introducer === 79) {
        if (this.pending.length <= offset + 2) return
        if (introducer === 91 && this.pending[offset + 2] === 77) {
          if (this.pending.length < offset + 6) return
          const event = mouse(
            this.pending[offset + 3]! - 32,
            this.pending[offset + 4]! - 32,
            this.pending[offset + 5]! - 32,
            false,
          )
          this.consume(offset + 6)
          if (event) this.emit({ mouse: event })
          continue
        }
        let end = offset + 2
        while (
          end < this.pending.length &&
          (this.pending[end]! < 0x40 || this.pending[end]! > 0x7e)
        )
          end++
        if (end === this.pending.length) {
          if (end > 128) {
            this.consume(end)
            this.failed(new Error('Invalid terminal control sequence'))
          }
          return
        }
        const body = this.pending.subarray(offset + 2, end).toString('ascii')
        const final = String.fromCharCode(this.pending[end]!)
        this.consume(end + 1)
        if (introducer === 91 && body === '200' && final === '~') {
          this.paste = []
          continue
        }
        if (introducer === 91 && !body && (final === 'I' || final === 'O')) {
          this.emit({ focus: final === 'I' })
          continue
        }
        if (introducer === 91 && body.startsWith('<') && (final === 'M' || final === 'm')) {
          const match = /^<(\d+);(\d+);(\d+)$/.exec(body)
          const event =
            match && mouse(Number(match[1]), Number(match[2]), Number(match[3]), final === 'm')
          if (event) this.emit({ mouse: event })
          continue
        }
        const event = this.sequence(body, final, introducer === 79, extra)
        if (event) this.emit({ event })
        continue
      }
      // Terminal replies (OSC/DCS/APC) are not keyboard input.
      if ([93, 80, 95, 94].includes(introducer!)) {
        const st = this.pending.indexOf('\x1b\\', 2),
          bell = introducer === 93 ? this.pending.indexOf(7, 2) : -1
        const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : -1
        if (end < 0) {
          if (this.pending.length > MAX_PENDING) {
            this.discardControl = introducer === 93
            this.pending = this.pending.subarray(this.pending.length - 1)
            this.failed(new Error('Terminal control sequence exceeds the pending input limit'))
          }
          return
        }
        this.consume(end)
        continue
      }
      const count = scalarLength(this.pending, 1)
      if (this.pending.length < count + 1) return
      const value = this.pending.subarray(1, count + 1).toString('utf8')
      this.consume(count + 1)
      for (const scalar of value) this.emit({ event: character(scalar, ALT) })
    }
  }
  private sequence(
    body: string,
    final: string,
    ss3: boolean,
    extra: number,
  ): ClientPaneInputEvent | undefined {
    if (ss3 && !body) {
      const keypad: Record<string, string> = {
        p: '0',
        q: '1',
        r: '2',
        s: '3',
        t: '4',
        u: '5',
        v: '6',
        w: '7',
        x: '8',
        y: '9',
        n: '.',
        l: ',',
        m: '-',
        k: '+',
        j: '*',
        o: '/',
      }
      if (keypad[final]) return character(keypad[final], extra)
      if (final === 'M') return key('Enter', extra)
    }
    if (!/^[0-9;]*$/.test(body)) return
    const values = body ? body.split(';').map(Number) : []
    if (values.some((value) => !Number.isSafeInteger(value))) return
    const mods = extra | modifiers(values[1] || 1)
    const cursor: Record<string, ClientKeyCode> = {
      A: 'Up',
      B: 'Down',
      C: 'Right',
      D: 'Left',
      H: 'Home',
      F: 'End',
      P: { F: 1 },
      Q: { F: 2 },
      R: { F: 3 },
      S: { F: 4 },
    }
    if (cursor[final] && (!body || (values.length <= 2 && values[0] === 1)))
      return key(cursor[final], mods)
    if (final === 'Z' && !body) return key('BackTab', extra | SHIFT)
    if (final === '~') {
      const tilde: Record<number, ClientKeyCode> = {
        1: 'Home',
        2: 'Insert',
        3: 'Delete',
        4: 'End',
        5: 'PageUp',
        6: 'PageDown',
        7: 'Home',
        8: 'End',
        11: { F: 1 },
        12: { F: 2 },
        13: { F: 3 },
        14: { F: 4 },
        15: { F: 5 },
        17: { F: 6 },
        18: { F: 7 },
        19: { F: 8 },
        20: { F: 9 },
        21: { F: 10 },
        23: { F: 11 },
        24: { F: 12 },
      }
      if (tilde[values[0]!] && values.length <= 2) return key(tilde[values[0]!]!, mods)
      if (
        values.length === 3 &&
        values[0] === 27 &&
        values[2]! > 0 &&
        values[2]! <= 0x10ffff &&
        !(values[2]! >= 0xd800 && values[2]! <= 0xdfff)
      )
        return extendedCharacter(values[2]!, mods)
    }
    if (
      final === 'u' &&
      values.length <= 2 &&
      values[0]! > 0 &&
      values[0]! <= 0x10ffff &&
      !(values[0]! >= 0xd800 && values[0]! <= 0xdfff)
    )
      return extendedCharacter(values[0]!, mods)
  }
  private reset() {
    clearTimeout(this.escapeTimer)
    this.pending = Buffer.alloc(0)
    this.paste = undefined
    this.pasteBytes = 0
    this.discardPaste = false
    this.discardControl = undefined
  }
  [Symbol.dispose]() {
    this.disposed = true
    this.reset()
  }
}
