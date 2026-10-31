import type { Plugin } from 'vite'
import { contentFontCss } from './web/src/font-catalog.ts'

/** Let Vite resolve, hash and publish font URLs just like other imported assets. */
export function contentFontsPlugin(): Plugin {
  const id = 'virtual:canvas-fonts.css'
  return {
    name: 'canvas-fonts',
    resolveId(source) { if (source === id) return `\0${id}` },
    load(source) { if (source === `\0${id}`) return contentFontCss(file => `/src/assets/fonts/${file}`) },
  }
}
