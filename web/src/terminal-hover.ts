import type { Terminal } from '@xterm/xterm'

/** Keep passive movement out of xterm's input lane while a local selection owns it. */
export function bindTerminalHover(surface: HTMLElement, terminal: Pick<Terminal, 'hasSelection'>, enabled: () => boolean) {
  const move = (event: MouseEvent) => {
    if (event.buttons === 0 && (!enabled() || terminal.hasSelection())) event.stopImmediatePropagation()
  }
  const options = { capture: true }
  surface.addEventListener('mousemove', move, options)
  return () => surface.removeEventListener('mousemove', move, options)
}
