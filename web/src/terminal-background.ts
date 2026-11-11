/** Only the terminal's default background, which xterm sets inline on its renderer, fills the card margins. */
export function fillTerminalBackground(element: HTMLElement, host: HTMLElement) {
  const renderer = element.querySelector<HTMLElement>('.xterm-scrollable-element')
  if (!renderer) return
  // An inline read never forces the style recalculation a computed style would.
  const background = renderer.style.backgroundColor
  if (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent') return
  if (host.style.backgroundColor !== background) host.style.backgroundColor = background
}
