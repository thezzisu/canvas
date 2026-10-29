import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import type { IUnicodeHandling, IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

type UnicodeHost = Pick<Terminal, 'unicode'>

/** The official addon uses only this public API, shared by browser and headless. */
export function terminalUnicodeAddon() {
  const addon = new UnicodeGraphemesAddon()
  return {
    activate(terminal: UnicodeHost) { addon.activate(terminal as Terminal) },
    dispose() { addon.dispose() },
  }
}

function widthProvider(): IUnicodeVersionProvider {
  const providers = new Map<string, IUnicodeVersionProvider>()
  const unicode: IUnicodeHandling = {
    register(provider) { providers.set(provider.version, provider) },
    get versions() { return [...providers.keys()] },
    activeVersion: '6',
  }
  // Capture the addon's registration through the public API. Its Unicode data
  // and grapheme rules stay identical to both terminal instances.
  terminalUnicodeAddon().activate({ unicode })
  const provider = providers.get(unicode.activeVersion)
  if (!provider) throw new Error('The terminal Unicode provider was not registered')
  return provider
}

const provider = widthProvider()
/** xterm 6 encodes width in bits 1–2 and joining in bit 0 of charProperties. */
export function terminalCellWidth(text: string): number {
  let width = 0, preceding = 0
  for (const character of text) {
    const properties = provider.charProperties(character.codePointAt(0)!, preceding)
    width += (properties >> 1 & 3) - (properties & 1 ? preceding >> 1 & 3 : 0)
    preceding = properties
  }
  return width
}
