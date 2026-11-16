import { computed, inject, provide, ref, shallowRef, type InjectionKey, type Ref } from 'vue'

export interface SegmentedFit {
  /** Every segmented control of the dialog is shown as a drop-down. */
  compact: Readonly<Ref<boolean>>
  report(id: string, fits: boolean): void
}
const key: InjectionKey<SegmentedFit> = Symbol('segmented-fit')

/** One decision per dialog: if any segmented control does not fit its row, all become drop-downs. */
export function provideSegmentedFit() {
  const misfits = shallowRef<ReadonlySet<string>>(new Set())
  provide(key, {
    compact: computed(() => misfits.value.size > 0),
    report(id, fits) {
      if (fits !== misfits.value.has(id)) return
      const next = new Set(misfits.value)
      if (fits) next.delete(id)
      else next.add(id)
      misfits.value = next
    },
  })
}

/** Outside a dialog that provides one, a control decides for itself. */
export function useSegmentedFit(): SegmentedFit {
  const shared = inject(key, undefined)
  if (shared) return shared
  const fits = ref(true)
  return { compact: computed(() => !fits.value), report: (_id, value) => (fits.value = value) }
}
