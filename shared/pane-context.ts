export interface PanePoint {
  column: number
  row: number
  cols: number
  rows: number
  layout: string
}
export interface PaneContext {
  bootId: string
  paneId: string
  name: string
}
export type PaneAction =
  { action: 'rename'; name: string } | { action: 'split-right' | 'split-down' | 'zoom' | 'close' }
