export interface ClipboardShortcutEvent {
  type?: string
  code?: string
  key?: string
  keyCode?: number
  which?: number
  charCode?: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  getModifierState?(key: string): boolean
}

function unidentified(value: string | undefined) {
  return !value || value === 'Unidentified'
}

/** Browser paste shortcuts may have no physical code when injected by the OS. */
export function isPasteShortcut(event: ClipboardShortcutEvent): boolean {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229
      || event.altKey || event.getModifierState?.('AltGraph')) return false
  const legacy = unidentified(event.code) && unidentified(event.key)
  const insert = event.code === 'Insert' || event.key === 'Insert' || legacy && (event.keyCode === 45 || event.which === 45)
  if (insert) return !!event.shiftKey && !event.ctrlKey && !event.metaKey
  if (!event.ctrlKey && !event.metaKey) return false
  return event.code === 'KeyV' || event.key?.toLowerCase() === 'v'
    || legacy && (event.keyCode === 86 || event.which === 86
      || event.type === 'keypress' && (event.charCode === 118 || event.charCode === 86 || event.which === 118 || event.keyCode === 118))
}
