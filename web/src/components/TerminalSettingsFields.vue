<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import type { TerminalOverrides, TerminalSettings } from '../terminal-settings'
import { contentZoomLimits } from '../content-zoom'

const props = defineProps<{ modelValue: TerminalOverrides; defaults?: TerminalSettings; showZoom?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: TerminalOverrides] }>()
const { t } = useI18n(), id = useId()
const rows = computed(() => [
  { key: 'rightClick' as const, label: t('terminal.settings.rightClick'), items: [
    { value: 'menu', label: t('terminal.settings.paneMenu') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'shiftPaste' as const, label: t('terminal.settings.shiftPaste'), items: [
    { value: 'paste', label: t('terminal.settings.paste') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'mouseHover' as const, label: t('terminal.settings.mouseHover'), items: [
    { value: 'true', label: t('terminal.settings.followProgram') }, { value: 'false', label: t('terminal.settings.hoverOff') }] },
].map(row => ({ ...row,
  inherited: props.defaults && props.modelValue[row.key] === undefined ? t('terminal.settings.defaultValue', {
    value: row.items.find(item => item.value === String(props.defaults![row.key]))!.label,
  }) : undefined,
  items: props.defaults ? [{ value: '__default', label: t('terminal.settings.inherit') }, ...row.items] : row.items,
})))
function update(key: 'rightClick' | 'shiftPaste' | 'mouseHover', value: string | number) {
  const next = { ...props.modelValue }
  if (value === '__default') delete next[key]
  else Object.assign(next, { [key]: key === 'mouseHover' ? value === 'true' : value })
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="@container">
    <div class="grid gap-4">
      <div v-for="row in rows" :key="row.key" role="group" :aria-labelledby="`${id}-${row.key}`" class="grid min-w-0 items-center gap-2 @min-[360px]:grid-cols-[minmax(0,1fr)_240px] @min-[360px]:gap-x-4">
        <span :id="`${id}-${row.key}`" class="text-sm text-muted">{{ row.label }}</span>
        <div class="min-w-0">
          <UTabs :model-value="modelValue[row.key] === undefined ? '__default' : String(modelValue[row.key])" :items="row.items" :content="false" color="neutral" variant="pill" size="sm"
            :ui="{ list: 'w-full', trigger: 'flex-1 min-w-0 whitespace-normal justify-center', label: 'whitespace-normal text-center' }" :aria-label="row.label" :aria-labelledby="`${id}-${row.key}`" @update:model-value="value => update(row.key, value)" />
          <p v-if="row.inherited" class="mt-1 text-xs text-dimmed break-words">{{ row.inherited }}</p>
        </div>
      </div>
      <div v-if="showZoom" class="grid min-w-0 items-center gap-2 @min-[360px]:grid-cols-[minmax(0,1fr)_240px] @min-[360px]:gap-x-4">
        <label :for="`${id}-zoom`" class="text-sm text-muted">{{ t('terminal.settings.defaultZoom') }}</label>
        <UInputNumber :id="`${id}-zoom`" :model-value="modelValue.maximizedZoom" :min="contentZoomLimits.min" :max="contentZoomLimits.max" :step="contentZoomLimits.step" :step-snapping="false" :format-options="{ style: 'unit', unit: 'percent' }" class="w-full" color="neutral" :aria-label="t('terminal.settings.defaultZoom')" @update:model-value="value => emit('update:modelValue', { ...modelValue, maximizedZoom: value })" />
      </div>
    </div>
  </div>
</template>
