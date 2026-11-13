import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import type { Terminal } from '@xterm/xterm'

type UnicodeHost = Pick<Terminal, 'unicode'>

/** The official addon uses only this public API, shared by browser and headless. */
export function terminalUnicodeAddon() {
  const addon = new UnicodeGraphemesAddon()
  return {
    activate(terminal: UnicodeHost) {
      addon.activate(terminal as Terminal)
    },
    dispose() {
      addon.dispose()
    },
  }
}
