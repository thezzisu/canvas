export const NOTE_TEXT_TYPE = 'application/x-canvas-note-text'

/** Keep the full note as plain text for both Canvas and an explicit external drop. */
export function writeNoteTransfer(data: DataTransfer | null, text: string): boolean {
  if (!data || !text) return false
  data.effectAllowed = 'copy'
  data.setData(NOTE_TEXT_TYPE, text)
  data.setData('text/plain', text)
  return true
}

export function isNoteTransfer(data: DataTransfer | null): data is DataTransfer {
  return !!data && data.types.includes(NOTE_TEXT_TYPE) && !data.types.includes('Files')
}

/** Leave ordinary text and file drops to their existing handlers. */
export function claimNoteDrop(event: DragEvent, available: boolean): boolean {
  if (!isNoteTransfer(event.dataTransfer)) return false
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = available ? 'copy' : 'none'
  return true
}

export function readNoteTransfer(data: DataTransfer | null): string {
  return isNoteTransfer(data) ? data.getData(NOTE_TEXT_TYPE) : ''
}
