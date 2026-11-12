<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import { contentZoomLimits } from '../../composables/canvas/content-zoom'
import type { ZoomReset } from '../../composables/canvas/content-zoom-menu'

const props = defineProps<
  { modelValue: number; label: string; mobile?: boolean; disabled?: boolean } & ZoomReset
>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const { t, n } = useI18n()
const open = ref(false),
  pointer = ref(false)
const percentage = computed(() => n(props.modelValue / 100, { style: 'percent' }))
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
const touchTarget = computed(() => (props.mobile ? 'min-w-[44px] min-h-[44px] justify-center' : ''))
function change(value: number) {
  emit('update:modelValue', Math.max(contentZoomLimits.min, Math.min(contentZoomLimits.max, value)))
}
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
      ><div
        class="content-zoom-controls flex items-center gap-0.5"
        data-preserve-content-focus
        role="group"
        :aria-label="label"
        @pointerdown.stop
        @wheel.stop
        @keydown="pointer = false"
      >
        <UButton
          color="neutral"
          variant="ghost"
          :size="mobile ? 'xl' : 'md'"
          square
          icon="i-lucide-minus"
          :class="touchTarget"
          :disabled="disabled || modelValue <= contentZoomLimits.min"
          :aria-label="t('common.zoomOut')"
          :title="t('common.zoomOut')"
          @pointerdown.prevent
          @click="change(modelValue - contentZoomLimits.step)"
        />
        <UButton
          color="neutral"
          variant="ghost"
          :size="mobile ? 'xl' : 'md'"
          class="content-zoom-reset min-w-14 justify-center tabular-nums"
          :class="touchTarget"
          :label="percentage"
          :disabled="disabled"
          :aria-label="resetLabel || t('common.resetZoom')"
          :title="resetLabel || t('common.resetZoom')"
          @pointerdown.prevent
          @click="reset ? reset() : change(100)"
        />
        <UButton
          color="neutral"
          variant="ghost"
          :size="mobile ? 'xl' : 'md'"
          square
          icon="i-lucide-plus"
          :class="touchTarget"
          :disabled="disabled || modelValue >= contentZoomLimits.max"
          :aria-label="t('common.zoomIn')"
          :title="t('common.zoomIn')"
          @pointerdown.prevent
          @click="change(modelValue + contentZoomLimits.step)"
        /></div
    ></template>
  </UPopover>
</template>
