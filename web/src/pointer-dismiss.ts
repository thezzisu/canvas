import { computed, type Ref } from 'vue'
import { unrefElement, useEventListener, type MaybeComputedElementRef } from '@vueuse/core'

/** Dismiss before canvas and terminal gestures stop pointer propagation. */
export function usePointerDismiss(open: Ref<boolean>, trigger: MaybeComputedElementRef,
  options: { event?: 'pointerdown' | 'click'; outside?: (event: Event) => boolean } = {}) {
  let pointerDismissed = false
  useEventListener(computed(() => open.value ? document : undefined), options.event || 'pointerdown', (event: Event) => {
    const anchor = unrefElement(trigger)
    const contentId = anchor?.getAttribute('aria-controls')
    const content = contentId ? anchor?.ownerDocument.getElementById(contentId) : undefined
    const path = event.composedPath()
    if ([anchor, content].some(element => element && path.includes(element))) return
    if (options.outside && !options.outside(event)) return
    pointerDismissed = true
    open.value = false
  }, { capture: true, passive: true })

  // Reka's bubble listener did not see this interaction. Do not return focus to
  // the trigger after the user has already focused a terminal or another field.
  return { onCloseAutoFocus(event: Event) {
    if (pointerDismissed) event.preventDefault()
    pointerDismissed = false
  } }
}
