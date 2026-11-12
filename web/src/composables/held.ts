import { onScopeDispose, readonly, ref, watch } from 'vue'

/**
 * `source`, kept true for at least `duration` ms once it turns true. A state that would only
 * last a frame or two then reads as a transition, not as a flicker.
 */
export function useHeld(source: () => boolean, duration: number) {
  const held = ref(source())
  let since = 0,
    timer: ReturnType<typeof setTimeout> | undefined
  watch(
    source,
    (value) => {
      clearTimeout(timer)
      if (!value)
        timer = setTimeout(() => (held.value = false), since + duration - performance.now())
      else if (!held.value) {
        since = performance.now()
        held.value = true
      }
    },
    // The state is on screen in the frame it begins.
    { flush: 'sync' },
  )
  onScopeDispose(() => clearTimeout(timer))
  return readonly(held)
}
