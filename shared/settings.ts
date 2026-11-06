export interface FontSelection { family: string }
export interface ContentFontSettings { stack: FontSelection[]; ligatures: boolean }
/** Normal 12px terminal cells, measured when the shared font is selected. */
export interface TerminalCell { width: number; height: number }
export const defaultTerminalCell = (): TerminalCell => ({ width: 7.2, height: 16 })
export interface GlobalSettings { contentFont: ContentFontSettings; terminalCell: TerminalCell }
export const defaultContentFont = (): ContentFontSettings => ({
  stack: [{ family: 'Maple Mono NF CN' }, { family: 'Cascadia Code PL' }, { family: 'monospace' }],
  ligatures: false,
})
export const defaultSettings = (): GlobalSettings => ({ contentFont: defaultContentFont(), terminalCell: defaultTerminalCell() })
