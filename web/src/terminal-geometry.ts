/** Untransformed CSS boxes retain the fractional dimensions lost by client/offset sizes. */
export function terminalBox(element: HTMLElement) {
  const style = getComputedStyle(element)
  const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
  const vertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
  const width = parseFloat(style.width), height = parseFloat(style.height)
  return style.boxSizing === 'border-box'
    ? { width, height, contentWidth: width - horizontal, contentHeight: height - vertical }
    : { width: width + horizontal, height: height + vertical, contentWidth: width, contentHeight: height }
}

export function terminalInsets(card: HTMLElement, host: HTMLElement) {
  const outer = terminalBox(card), content = terminalBox(host)
  return { x: outer.width - content.contentWidth, y: outer.height - content.contentHeight }
}

export function fitTerminalGrid(available: { width: number; height: number }, rendered: { width: number; height: number; cols: number; rows: number }) {
  return {
    cols: Math.max(20, Math.min(500, Math.floor(available.width * rendered.cols / rendered.width))),
    rows: Math.max(5, Math.min(200, Math.floor(available.height * rendered.rows / rendered.height))),
  }
}
