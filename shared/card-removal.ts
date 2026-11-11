export const CARD_REMOVAL_UNDO_MS = 5000
export interface CardRemovalUndo {
  token: string
  remainingMs: number
}
export interface CardRemovalResponse<Canvas> {
  canvas: Canvas
  undo: CardRemovalUndo | null
  lastReference: boolean
}
