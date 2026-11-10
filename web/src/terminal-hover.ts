import type { Terminal } from '@xterm/xterm'

/** Whether passive pointer motion must stay out of xterm's mouse reporting. */
export function suppressHover(event: Pick<MouseEvent, 'buttons'>, enabled: boolean, selected: boolean) {
  return event.buttons === 0 && (!enabled || selected)
}

/**
 * Keep passive movement out of xterm's input lane while hover is off or a
 * local selection owns it. xterm's link detection listens on `.xterm-screen`,
 * below the `.xterm` mouse-reporting listener, so motion over the screen is
 * stopped as it bubbles past the screen; motion elsewhere stops at the surface.
 */
export function bindTerminalHover(surface: HTMLElement, terminal: Pick<Terminal, 'hasSelection' | 'element'>, enabled: () => boolean) {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  const suppressed = (event: MouseEvent) => suppressHover(event, enabled(), terminal.hasSelection())
  const outside = (event: MouseEvent) => {
    if (!screen?.contains(event.target as Node | null) && suppressed(event)) event.stopImmediatePropagation()
  }
  const over = (event: MouseEvent) => { if (suppressed(event)) event.stopPropagation() }
  const options = { capture: true }
  surface.addEventListener('mousemove', outside, options)
  screen?.addEventListener('mousemove', over)
  return () => {
    surface.removeEventListener('mousemove', outside, options)
    screen?.removeEventListener('mousemove', over)
  }
}
