<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import Icon from './Icon.vue'
import { contentZoomLimits } from '../content-zoom'

const props = defineProps<{ modelValue: number; label: string; mobile?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const { t, n } = useI18n()
const trigger = ref<HTMLElement>(), open = ref(false), pointer = ref(false)
const percentage = computed(() => n(props.modelValue / 100, { style: 'percent' }))
const portal = computed(() => trigger.value?.closest<HTMLElement>('.app-shell') || document.body)
const content = { side: 'bottom' as const, align: 'end' as const, sideOffset: 6, collisionPadding: 8,
  onOpenAutoFocus: (event: Event) => { if (pointer.value) event.preventDefault() },
  onCloseAutoFocus: (event: Event) => { if (pointer.value) event.preventDefault() } }
useEventListener(computed(() => open.value ? document : undefined), 'keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  // Let the IME consume Escape without dismissing the surrounding popover.
  if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); return }
  event.preventDefault(); event.stopPropagation(); open.value = false
}, { capture: true })
function change(value: number) { emit('update:modelValue', Math.max(contentZoomLimits.min, Math.min(contentZoomLimits.max, value))) }
</script>

<template>
  <UPopover v-model:open="open" :portal="portal" :content="content" :ui="{ content: 'content-zoom-popover' }">
    <button ref="trigger" class="content-zoom-trigger" data-preserve-content-focus :title="label" :aria-label="label" :aria-expanded="open" @pointerdown.stop.prevent="pointer = true" @keydown="pointer = false"><Icon v-if="mobile" name="search" :size="18" /><span v-else>{{ percentage }}</span></button>
    <template #content><div class="content-zoom-controls" data-preserve-content-focus role="group" :aria-label="label" @pointerdown.stop @wheel.stop @keydown="pointer = false">
      <UButton color="neutral" variant="ghost" :disabled="disabled || modelValue <= contentZoomLimits.min" :aria-label="t('common.zoomOut')" :title="t('common.zoomOut')" @pointerdown.prevent @click="change(modelValue - contentZoomLimits.step)"><Icon name="minus" :size="17" /></UButton>
      <UButton color="neutral" variant="ghost" class="content-zoom-reset" :disabled="disabled" :aria-label="t('common.resetZoom')" :title="t('common.resetZoom')" @pointerdown.prevent @click="change(100)">{{ percentage }}</UButton>
      <UButton color="neutral" variant="ghost" :disabled="disabled || modelValue >= contentZoomLimits.max" :aria-label="t('common.zoomIn')" :title="t('common.zoomIn')" @pointerdown.prevent @click="change(modelValue + contentZoomLimits.step)"><Icon name="plus" :size="17" /></UButton>
    </div></template>
  </UPopover>
</template>

<style scoped>
.content-zoom-trigger{width:43px;min-width:43px;height:23px;font-size:10px;font-variant-numeric:tabular-nums;padding:0 4px;border-radius:4px}
.content-zoom-trigger[aria-expanded=true]{background:#ffffff12;color:#e3c9b5}
.mobile-layout .content-zoom-trigger{width:44px;min-width:44px;height:44px}
</style>

<style>
.content-zoom-popover{z-index:70;padding:4px;background:#252b34;border:1px solid #414b59;border-radius:8px;box-shadow:0 8px 24px #0005}
.content-zoom-controls{display:flex;align-items:center;gap:2px}.content-zoom-controls>button{justify-content:center;width:36px;height:36px;min-width:36px;padding:0;color:#bac6d6;border-radius:5px}
.content-zoom-controls>.content-zoom-reset{width:60px;font-size:12px;font-variant-numeric:tabular-nums}
.mobile-layout .content-zoom-controls>button{height:44px;min-width:44px}
</style>
