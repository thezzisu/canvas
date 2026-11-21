/**
 * Canvas's terminal colours as 0xRRGGBB. The browser paints with them; the server gives them to
 * herdr-core and to its own terminal engine, so a program asking for its colours is told these.
 */
export const terminalTheme = Object.freeze({
  foreground: 0xd5d7dd,
  background: 0x111317,
  cursor: 0xe8b183,
  cursorAccent: 0x000000,
  selectionBackground: 0x415168,
  // The normal eight and bright black and white are Canvas's; the rest are xterm.js's defaults.
  ansi: Object.freeze([
    0x20242b, 0xf08080, 0x9ecb8f, 0xe5c285, 0x8daed7, 0xc7a0df, 0x8fc5c4, 0xd5d7dd, 0x66707f,
    0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xf6f6f7,
  ]),
})

/** `#rrggbb` for an 0xRRGGBB colour. */
export const cssColour = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`
/** The red, green and blue bytes of an 0xRRGGBB colour. */
export const rgbBytes = (colour: number) =>
  [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255] as const
