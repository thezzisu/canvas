/** Reuse the DOM renderer's resolved colors, including palette and inverse video. */
export function fillTerminalBackground(element: HTMLElement, host: HTMLElement) {
  const rows = element.querySelector('.xterm-rows')?.children
  if (!rows?.length) return
  const base = getComputedStyle(element.querySelector('.xterm-scrollable-element') || element).backgroundColor
  const colors = new Map<string, number>()
  for (const rowIndex of new Set([0, Math.floor(rows.length / 2), rows.length - 1])) {
    const spans = rows[rowIndex]!.children
    for (const index of new Set([0, Math.floor(spans.length / 2), spans.length - 1])) {
      const span = spans[index]
      if (!span || span.matches('.xterm-cursor, .xterm-decoration-top')) continue
      const color = (span as HTMLElement).style.backgroundColor || getComputedStyle(span).backgroundColor
      const background = color === 'rgba(0, 0, 0, 0)' || color === 'transparent' ? base : color
      colors.set(background, (colors.get(background) || 0) + 1)
    }
  }
  if (!colors.size) return
  const background = [...colors].sort((a, b) => b[1] - a[1])[0]?.[0] || base
  if (host.style.backgroundColor !== background) host.style.backgroundColor = background
}
