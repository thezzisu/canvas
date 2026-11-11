import { computed, watch } from 'vue'
import {
  unrefElement,
  useElementBounding,
  usePointer,
  useResizeObserver,
  type MaybeComputedElementRef,
} from '@vueuse/core'
import { useDocumentFocus } from '../lib/document-focus'

/** Keep native pointer targeting while the canvas controls yield to terminal input. */
export function useTerminalOverlays(options: {
  enabled(): boolean
  surface: MaybeComputedElementRef<HTMLElement | undefined>
  controls: MaybeComputedElementRef[]
  geometry(): unknown
}) {
  const { activeElement, windowFocused } = useDocumentFocus()
  const body = computed(() => {
    if (!options.enabled()) return
    const active = activeElement.value
    if (!windowFocused.value || !active?.matches('.xterm-helper-textarea, .terminal-mobile-input'))
      return
    const host = active.closest<HTMLElement>('.terminal-host')
    return host && unrefElement(options.surface)?.contains(host) ? host : undefined
  })
  // Pointer coordinates remain in viewport CSS pixels; xterm normalizes mouse events.
  const mouse = usePointer()
  // VueFlow patches node transforms after its store update; measure the next frame.
  const bounds = useElementBounding(body, { updateTiming: 'next-frame' })
  const controls = options.controls.map((target) => ({
    target,
    bounds: useElementBounding(target, { updateTiming: 'next-frame' }),
  }))
  const contains = (rect: typeof bounds) =>
    rect.width.value > 0 &&
    rect.height.value > 0 &&
    mouse.x.value >= rect.left.value &&
    mouse.x.value < rect.right.value &&
    mouse.y.value >= rect.top.value &&
    mouse.y.value < rect.bottom.value
  const pointed = computed(() => {
    if (
      !body.value ||
      !mouse.isInside.value ||
      mouse.pointerType.value !== 'mouse' ||
      !contains(bounds)
    )
      return false
    // Ignore only these two controls: another card or dialog still owns its hit.
    const hit = document
      .elementsFromPoint(mouse.x.value, mouse.y.value)
      .find(
        (element) => !controls.some((control) => unrefElement(control.target)?.contains(element)),
      )
    return !!hit && body.value.contains(hit)
  })
  // A transformed ancestor does not resize its descendants. VueFlow geometry
  // changes refresh these three bounds even when the pointer stays still.
  const update = () => {
    bounds.update()
    for (const control of controls) control.bounds.update()
  }
  watch(options.geometry, update, { flush: 'post' })
  useResizeObserver(options.surface, update)
  return controls.map((control) =>
    computed(() => {
      const rect = control.bounds
      const overlap =
        pointed.value &&
        rect.width.value > 0 &&
        rect.height.value > 0 &&
        rect.left.value < bounds.right.value &&
        rect.right.value > bounds.left.value &&
        rect.top.value < bounds.bottom.value &&
        rect.bottom.value > bounds.top.value
      return overlap ? (contains(rect) ? 'pointer' : 'body') : undefined
    }),
  )
}
