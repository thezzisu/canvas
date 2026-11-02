/** Native mouse input must not also open a browser menu or paste its selection. */
export function bindTerminalMouseDefaults(surface: HTMLElement, active: () => boolean) {
  let middlePaste = false
  const context = (event: Event) => {
    if (!active()) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const reset = () => { middlePaste = false }
  const pointer = (event: PointerEvent) => { middlePaste = active() && event.button === 1 }
  const press = (event: MouseEvent) => { if (event.button === 2) context(event) }
  const paste = (event: Event) => {
    const native = middlePaste
    middlePaste = false
    // Chromium can emit primary-selection paste even after cancelled auxclick.
    if (native) context(event)
  }
  const auxiliary = (event: MouseEvent) => { if (event.button === 1) context(event) }
  const options = { capture: true }
  surface.ownerDocument.addEventListener('pointerdown', reset, options)
  surface.ownerDocument.addEventListener('visibilitychange', reset)
  surface.ownerDocument.defaultView?.addEventListener('blur', reset)
  surface.addEventListener('pointerdown', pointer, options)
  surface.addEventListener('mousedown', press, options)
  surface.addEventListener('keydown', reset, options)
  surface.addEventListener('paste', paste, options)
  surface.addEventListener('contextmenu', context, options)
  surface.addEventListener('auxclick', auxiliary, options)
  return () => {
    surface.ownerDocument.removeEventListener('pointerdown', reset, options)
    surface.ownerDocument.removeEventListener('visibilitychange', reset)
    surface.ownerDocument.defaultView?.removeEventListener('blur', reset)
    surface.removeEventListener('pointerdown', pointer, options)
    surface.removeEventListener('mousedown', press, options)
    surface.removeEventListener('keydown', reset, options)
    surface.removeEventListener('paste', paste, options)
    surface.removeEventListener('contextmenu', context, options)
    surface.removeEventListener('auxclick', auxiliary, options)
  }
}
