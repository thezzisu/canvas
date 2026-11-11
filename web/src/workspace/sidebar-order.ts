import { computed, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { NavigationOrder, NavigationOrderKind } from '../../../shared/navigation-order'

/** Apply known preferences, retaining new or unranked items in their supplied order. */
export function orderedItems<T extends { id: string }>(items: readonly T[], order: unknown): T[] {
  const rank = new Map<string, number>()
  if (Array.isArray(order))
    for (const id of order) if (typeof id === 'string' && !rank.has(id)) rank.set(id, rank.size)
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

/** Optimistic rows, one serialized writer per list; the shared snapshot owns saved order. */
export function useSidebarOrder(
  shared: MaybeRefOrGetter<NavigationOrder | undefined>,
  instance: MaybeRefOrGetter<unknown>,
  save: (kind: NavigationOrderKind, ids: string[]) => Promise<void>,
  error: (reason: unknown) => void,
) {
  const pending = shallowRef<Partial<NavigationOrder>>({}),
    running = new Map<NavigationOrderKind, Promise<void>>()
  let generation = 0
  const order = computed(() => ({ ...toValue(shared), ...pending.value }))
  const reset = () => {
    generation++
    pending.value = {}
    running.clear()
  }
  watch(() => toValue(instance), reset, { flush: 'sync' })
  onScopeDispose(reset)
  function remember(kind: NavigationOrderKind, ids: string[]) {
    pending.value = { ...pending.value, [kind]: [...ids] }
    if (running.has(kind)) return
    const revision = generation
    const task = (async () => {
      try {
        while (revision === generation && pending.value[kind]) {
          const batch = pending.value[kind]!
          await save(kind, batch)
          if (revision === generation && pending.value[kind] === batch) {
            const next = { ...pending.value }
            delete next[kind]
            pending.value = next
          }
        }
      } catch (reason) {
        if (revision === generation) {
          const next = { ...pending.value }
          delete next[kind]
          pending.value = next
          error(reason)
        }
      }
    })().finally(() => {
      if (running.get(kind) === task) running.delete(kind)
    })
    running.set(kind, task)
  }
  return { order, remember }
}
