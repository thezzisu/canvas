<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import { contentZoomLimits } from '../../composables/canvas/content-zoom'
import ZoomStepper from '../ZoomStepper.vue'
import type { ZoomReset } from '../../composables/canvas/content-zoom-menu'

defineProps<{ label: string; mobile?: boolean; disabled?: boolean } & ZoomReset>()
const zoom = defineModel<number>({ required: true })
const { n } = useI18n()
const open = ref(false),
  pointer = ref(false)
const percentage = computed(() => n(zoom.value / 100, { style: 'percent' }))
const content = {
  side: 'bottom' as const,
  align: 'end' as const,
  sideOffset: 6,
  collisionPadding: 8,
  onOpenAutoFocus: (event: Event) => {
    if (pointer.value) event.preventDefault()
  },
  onCloseAutoFocus: (event: Event) => {
    if (pointer.value) event.preventDefault()
  },
}
useEventListener(
  computed(() => (open.value ? document : undefined)),
  'keydown',
  (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // Let the IME consume Escape without dismissing the surrounding popover.
    if (event.isComposing || event.keyCode === 229) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    open.value = false
  },
  { capture: true },
)
</script>

<template>
  <UPopover v-model:open="open" :content="content" :ui="{ content: 'p-1' }">
    <UButton
      class="content-zoom-trigger tabular-nums"
      :icon="mobile ? 'i-lucide-zoom-in' : undefined"
      :label="mobile ? undefined : percentage"
      :active="open"
      data-preserve-content-focus
      :title="label"
      :aria-label="label"
      :aria-expanded="open"
      @pointerdown.stop.prevent="pointer = true"
      @keydown="pointer = false"
    />
    <template #content
      ><ZoomStepper
        v-model="zoom"
        class="content-zoom-controls"
        data-preserve-content-focus
        :range="contentZoomLimits"
        :label="label"
        :reset-label="resetLabel"
        :mobile="mobile"
        :disabled="disabled"
        @pointerdown.stop
        @wheel.stop
        @keydown="pointer = false"
        @reset="reset ? reset() : (zoom = 100)"
    /></template>
  </UPopover>
</template>
