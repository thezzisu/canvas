import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** Fade existing graph layers around an order change; keyed cards never unmount. */
export function useOrderTransition(displayed: Ref<string[]>, options: {
  order(): readonly string[]
  active(): boolean
  instance(): unknown
  reduced(): boolean
  host(): HTMLElement | undefined
}) {
  let generation = 0, running = false
  let animations: Animation[] = []
  const equal = () => displayed.value.join('\0') === options.order().join('\0')
  const cancel = () => {
    generation++; running = false
    for (const animation of animations) animation.cancel()
    animations = []
  }
  async function update() {
    if (running || equal()) return
    running = true
    const revision = generation
    try {
      while (revision === generation && !equal()) {
        const next = options.order(), existing = new Set(displayed.value)
        const reordered = existing.size === next.length && next.every(id => existing.has(id))
        const layers = [...(options.host()?.querySelectorAll<HTMLElement>('.vue-flow__viewport,.vue-flow__minimap') || [])]
        if (!options.active() || options.reduced() || document.hidden || !reordered || !layers.length) {
          displayed.value = [...options.order()]; return
        }
        animations = layers.map(layer => layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' }))
        await Promise.allSettled(animations.map(animation => animation.finished))
        if (revision !== generation) return
        displayed.value = [...options.order()]
        await nextTick()
        if (revision !== generation) return
        const leaving = animations
        animations = layers.filter(layer => layer.isConnected).map(layer => layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out', fill: 'forwards' }))
        for (const animation of leaving) animation.cancel()
        await Promise.allSettled(animations.map(animation => animation.finished))
        if (revision !== generation) return
        for (const animation of animations) animation.cancel()
        animations = []
      }
    } finally { if (revision === generation) running = false }
  }
  watch(() => options.order().join('\0'), () => { void update() }, { immediate: true, flush: 'post' })
  watch([options.active, options.instance, options.reduced], () => {
    cancel(); displayed.value = [...options.order()]
  }, { flush: 'sync' })
  onBeforeUnmount(cancel)
}
