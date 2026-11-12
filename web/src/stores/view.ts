import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { activeInstance } from '../composables/instances/instances'
import {
  overviewFocusStatuses,
  overviewStatuses,
  type OverviewOrder,
  type OverviewScope,
} from '../utils/canvas/overview'
import type { ProgramStatus } from '../../../shared/status'

const local = { listenToStorageChanges: false, writeDefaults: false }
export const allFeatures = ['working-set'] as const
export type Feature = (typeof allFeatures)[number]

/** How this browser shows canvases. Filters hide windows; arrangement never does. */
export const useViewStore = defineStore('view', () => {
  const minimap = useLocalStorage('canvas:view:minimap', true, local)
  const navigation = useLocalStorage('canvas:view:navigation', true, local)
  const autoYieldControls = useLocalStorage('canvas:view:auto-yield-controls', true, local)
  /** The optional features the sidebar offers. */
  const features = useLocalStorage<Feature[]>('canvas:view:features', [...allFeatures], local)

  const overviewKey = (name: string) => () => `canvas:overview:${activeInstance.value.id}:${name}`
  // Filters: which windows Overview lists.
  const statuses = useLocalStorage<ProgramStatus[]>(
    overviewKey('statuses'),
    [...overviewStatuses],
    local,
  )
  const scope = useLocalStorage<OverviewScope>(overviewKey('scope'), 'all', local)
  // Arrangement: how the listed windows are laid out.
  const order = useLocalStorage<OverviewOrder>(overviewKey('order'), 'native', local)
  const perRow = useLocalStorage(overviewKey('per-row'), 0, local)

  const statusFiltered = computed(() => statuses.value.length !== overviewStatuses.length)
  const focusPreset = computed(
    () =>
      statuses.value.length === overviewFocusStatuses.length &&
      overviewFocusStatuses.every((status) => statuses.value.includes(status)),
  )
  /** Some windows are hidden. Sorting and wrapping change the layout, not the set. */
  const filtered = computed(() => statusFiltered.value || scope.value !== 'all')
  const arranged = computed(() => order.value !== 'native' || perRow.value !== 0)
  /** Windows without an agent status are listed, so Overview can also offer to create one. */
  const showsCreation = computed(() => statuses.value.includes('unknown'))

  function clearFilters() {
    statuses.value = [...overviewStatuses]
    scope.value = 'all'
  }
  function reset() {
    clearFilters()
    order.value = 'native'
    perRow.value = 0
  }

  return {
    minimap,
    navigation,
    autoYieldControls,
    features,
    statuses,
    scope,
    order,
    perRow,
    statusFiltered,
    focusPreset,
    filtered,
    arranged,
    showsCreation,
    clearFilters,
    reset,
  }
})
