import { computed, type Ref } from 'vue'
import { unrefElement, useEventListener, type MaybeComputedElementRef } from '@vueuse/core'

/** Dismiss before canvas and terminal gestures stop pointer propagation. */
export function usePointerDismiss(
  open: Ref<boolean>,
  trigger: MaybeComputedElementRef,
  options: { event?: 'pointerdown' | 'click'; outside?: (event: Event) => boolean } = {},
) {
  let pointerDismissed = false
  useEventListener(
    computed(() => (open.value ? document : undefined)),
    options.event || 'pointerdown',
    (event: Event) => {
      const anchor = unrefElement(trigger)
      const contentId = anchor?.getAttribute('aria-controls')
      const content = contentId ? anchor?.ownerDocument.getElementById(contentId) : undefined
      const path = event.composedPath()
      if ([anchor, content].some((element) => element && path.includes(element))) return
      if (options.outside && !options.outside(event)) return
      pointerDismissed = true
      open.value = false
    },
    { capture: true, passive: true },
  )

  return {
    // Let Reka retain its own focus policy when its outside listener ran.
    onInteractOutside() {
      pointerDismissed = false
    },
    onCloseAutoFocus(event: Event) {
      // Canvas gestures can stop the event before Reka's bubble listener.
      if (pointerDismissed) event.preventDefault()
      pointerDismissed = false
    },
  }
}
