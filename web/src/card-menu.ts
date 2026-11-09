import { computed, onBeforeUnmount, shallowRef } from 'vue'

// Card menus share one local owner, including when focus stays in a mobile input.
const owner = shallowRef<symbol>()
export const cardMenuOpen = computed(() => owner.value !== undefined)

export function useCardMenu() {
  const id = Symbol('card menu')
  const open = computed({
    get: () => owner.value === id,
    set: (value: boolean) => { if (value) owner.value = id; else if (owner.value === id) owner.value = undefined },
  })
  onBeforeUnmount(() => { open.value = false })
  return open
}
