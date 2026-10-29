export interface FontSelection { family: string }
export interface ContentFontSettings { stack: FontSelection[]; ligatures: boolean }
export interface GlobalSettings { contentFont: ContentFontSettings }
export const defaultContentFont = (): ContentFontSettings => ({
  stack: [{ family: 'Maple Mono NF CN' }, { family: 'Cascadia Code PL' }, { family: 'monospace' }],
  ligatures: false,
})
export const defaultSettings = (): GlobalSettings => ({ contentFont: defaultContentFont() })
