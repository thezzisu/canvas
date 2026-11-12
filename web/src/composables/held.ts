import { onScopeDispose, readonly, ref, watch } from 'vue'

/**
 * `source`, kept true for at least `minimum` ms once it turns true, and for `linger` ms after it
 * turns false. A state that would last a frame or two then reads as a transition, not as a
 * flicker, and one that returns at once is the same transition, not a second one.
 */
export function useHeld(source: () => boolean, minimum: number, linger = 0) {
  const held = ref(source())
  let since = 0,
    timer: ReturnType<typeof setTimeout> | undefined
  watch(
    source,
    (value) => {
      clearTimeout(timer)
      if (!value)
        timer = setTimeout(
          () => (held.value = false),
          Math.max(linger, since + minimum - performance.now()),
        )
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
