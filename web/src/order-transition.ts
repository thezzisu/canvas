import { nextTick, onScopeDispose, watch } from 'vue'
import { useTimeoutFn } from '@vueuse/core'

export interface OrderedNode {
  id: string
  type?: string
  position: { x: number; y: number }
  data?: { width?: number; height?: number }
}
/** Compare visible geometry, not status, titles or the source array's order. */
export function layoutChange(before: readonly OrderedNode[], after: readonly OrderedNode[]): 'none' | 'order' | 'resize' | 'membership' {
  const previous = new Map(before.map(node => [node.id, node]))
  if (previous.size !== after.length) return 'membership'
  let moved = false, resized = false
  for (const node of after) {
    const old = previous.get(node.id)
    if (!old || old.type !== node.type) return 'membership'
    const sizeChanged = old.data?.width !== node.data?.width || old.data?.height !== node.data?.height
    resized ||= sizeChanged && node.type !== 'group'
    moved ||= sizeChanged || old.position.x !== node.position.x || old.position.y !== node.position.y
  }
  return resized ? 'resize' : moved ? 'order' : 'none'
}
type Change = 'auto' | 'order' | 'manual'

/** One layout commit boundary: live data stays reactive while geometry waits. */
export function useOrderTransition<T extends OrderedNode>(options: {
  current(): readonly T[]
  target(): T[]
  commit(nodes: T[]): void
  refresh(nodes: T[]): void
  settled(manual: boolean): Promise<void>
  enabled(): boolean
  active(): boolean
  blocked(): boolean
  scope(): unknown
  reduced(): boolean
  host(): HTMLElement | undefined
}) {
  let pending: Change | undefined, generation = 0, running = false, lastAutomatic = -Infinity, delayMs = 0
  let animations: Animation[] = []
  const { start: later, stop: stopLater } = useTimeoutFn(() => { void update() }, () => delayMs, { immediate: false })
  function cancel() {
    generation++; running = false; stopLater()
    for (const animation of animations) animation.cancel()
    animations = []
  }
  async function update() {
    if (!pending || !options.enabled()) return
    const next = options.target(), current = options.current()
    options.refresh(next)
    const change = layoutChange(current, next)
    if (change === 'none') { pending = undefined; stopLater(); return }
    const manual = pending === 'manual', reorder = change === 'order'
    const immediate = !options.active() || options.reduced() || !manual && (!current.length || !reorder)
    if (immediate) {
      cancel(); pending = undefined; options.commit(next)
      const revision = generation
      await nextTick(); if (revision === generation && options.enabled()) await options.settled(manual)
      return
    }
    if (running || !manual && options.blocked()) return
    const delay = pending === 'auto' ? 1000 - (performance.now() - lastAutomatic) : 0
    if (delay > 0) { delayMs = delay; later(); return }
    stopLater(); running = true
    const revision = generation
    const layers = () => [...(options.host()?.querySelectorAll<HTMLElement>('.canvas-layout-layer') || [])]
    try {
      animations = layers().map(layer => layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' }))
      await Promise.allSettled(animations.map(animation => animation.finished))
      if (revision !== generation) return
      const intent = pending
      pending = undefined
      options.commit(options.target())
      if (intent === 'auto') lastAutomatic = performance.now()
      await nextTick()
      if (revision !== generation) return
      await options.settled(intent === 'manual')
      if (revision !== generation) return
      const leaving = animations
      animations = layers().map(layer => layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out', fill: 'forwards' }))
      for (const animation of leaving) animation.cancel()
      await Promise.allSettled(animations.map(animation => animation.finished))
      if (revision !== generation) return
      for (const animation of animations) animation.cancel()
      animations = []
    } finally {
      if (revision === generation) { running = false; void update() }
    }
  }
  function request(change: Change = 'auto') {
    if (change === 'manual' || !pending || pending === 'auto') pending = change
    void update()
  }
  watch(options.blocked, blocked => {
    if (blocked && pending !== 'manual') cancel()
    if (!blocked) void update()
  }, { flush: 'sync' })
  watch([options.active, options.reduced], () => { cancel(); void update() }, { flush: 'sync' })
  watch(options.scope, () => { cancel(); pending = undefined; lastAutomatic = -Infinity }, { flush: 'sync' })
  onScopeDispose(cancel)
  return { request }
}
