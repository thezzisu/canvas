import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useStorage } from '@vueuse/core'

export interface SidebarOrder { canvases: string[]; sources: string[] }

/** Apply known preferences, retaining new or unranked items in their supplied order. */
export function orderedItems<T extends { id: string }>(items: readonly T[], order: unknown): T[] {
  const rank = new Map<string, number>()
  if (Array.isArray(order)) for (const id of order) if (typeof id === 'string' && !rank.has(id)) rank.set(id, rank.size)
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

/** Display ordering is a browser preference, independent of shared connection data. */
export function useSidebarOrder(instance: MaybeRefOrGetter<string>) {
  const saved = useStorage<Record<string, SidebarOrder>>('canvas:sidebar-order', {}, undefined, {
    writeDefaults: false, shallow: true,
    onError() { /* A storage failure must not block navigation. */ },
  })
  const order = computed<SidebarOrder | undefined>(() => saved.value?.[toValue(instance)])
  function remember(kind: keyof SidebarOrder, ids: string[]) {
    const key = toValue(instance)
    if (key) saved.value = { ...saved.value, [key]: { canvases: order.value?.canvases || [], sources: order.value?.sources || [], [kind]: ids } }
  }
  return { order, remember }
}
