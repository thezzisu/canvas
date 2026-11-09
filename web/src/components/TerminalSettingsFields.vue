<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UFormField from '@nuxt/ui/components/FormField.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import type { TerminalOverrides, TerminalSettings } from '../terminal-settings'
import { contentZoomLimits } from '../content-zoom'

const props = defineProps<{ modelValue: TerminalOverrides; defaults?: TerminalSettings; showZoom?: boolean; portal?: HTMLElement }>()
const emit = defineEmits<{ 'update:modelValue': [value: TerminalOverrides] }>()
const { t } = useI18n()
const rows = computed(() => [
  { key: 'rightClick' as const, label: t('terminal.settings.rightClick'), items: [
    { value: 'menu', label: t('terminal.settings.paneMenu') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'shiftPaste' as const, label: t('terminal.settings.shiftPaste'), items: [
    { value: 'paste', label: t('terminal.settings.paste') }, { value: 'terminal', label: t('terminal.settings.sendToTerminal') }] },
  { key: 'mouseHover' as const, label: t('terminal.settings.mouseHover'), items: [
    { value: 'true', label: t('terminal.settings.followProgram') }, { value: 'false', label: t('terminal.settings.hoverOff') }] },
].map(row => ({ ...row, items: props.defaults ? [{ value: '__default', label: t('terminal.settings.defaultValue', {
  value: row.items.find(item => item.value === String(props.defaults![row.key]))!.label,
}) }, ...row.items] : row.items })))
function update(key: 'rightClick' | 'shiftPaste' | 'mouseHover', value: string) {
  const next = { ...props.modelValue }
  if (value === '__default') delete next[key]
  else Object.assign(next, { [key]: key === 'mouseHover' ? value === 'true' : value })
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="grid gap-3">
    <UFormField v-for="row in rows" :key="row.key" :label="row.label" orientation="horizontal" :ui="{ root: 'items-center', container: 'w-48 max-w-full' }">
      <USelect :model-value="modelValue[row.key] === undefined ? '__default' : String(modelValue[row.key])" :items="row.items" :portal="portal || false" class="w-full" color="neutral" :aria-label="row.label" @update:model-value="value => update(row.key, value)" />
    </UFormField>
    <UFormField v-if="showZoom" :label="t('terminal.settings.defaultZoom')" orientation="horizontal" :ui="{ root: 'items-center', container: 'w-48 max-w-full' }">
      <UInputNumber :model-value="modelValue.maximizedZoom" :min="contentZoomLimits.min" :max="contentZoomLimits.max" :step="contentZoomLimits.step" :format-options="{ style: 'unit', unit: 'percent' }" class="w-full" color="neutral" :aria-label="t('terminal.settings.defaultZoom')" @update:model-value="value => emit('update:modelValue', { ...modelValue, maximizedZoom: value })" />
    </UFormField>
  </div>
</template>
