/** Only the terminal's resolved default background fills the card margins. */
export function fillTerminalBackground(element: HTMLElement, host: HTMLElement) {
  const renderer = element.querySelector('.xterm-scrollable-element')
  if (!renderer) return
  const background = getComputedStyle(renderer).backgroundColor
  if (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent') return
  if (host.style.backgroundColor !== background) host.style.backgroundColor = background
}
