<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UModal from './CanvasModal.vue'
import type { TerminalSettings } from '../terminal-settings'

defineProps<{ open: boolean; portal?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const settings = defineModel<TerminalSettings>({ required: true })
const { t } = useI18n()
const rows = computed(() => [
  { key: 'rightClick' as const, label: t('terminal.settings.rightClick'),
    items: [{ label: t('terminal.settings.paneMenu'), value: 'menu' }, { label: t('terminal.settings.sendToTerminal'), value: 'terminal' }] },
  { key: 'shiftPaste' as const, label: t('terminal.settings.shiftPaste'),
    items: [{ label: t('terminal.settings.paste'), value: 'paste' }, { label: t('terminal.settings.sendToTerminal'), value: 'terminal' }] },
])
function update(key: keyof TerminalSettings, value: string | number) { settings.value = { ...settings.value, [key]: String(value) } as TerminalSettings }
</script>

<template>
  <UModal :open="open" :portal="portal || false" :title="t('terminal.settings.title')" :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'terminal-settings-dialog', overlay: 'app-dialog-overlay' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div class="terminal-settings-rows">
        <div v-for="row in rows" :key="row.key" class="terminal-setting-row">
          <span :id="`terminal-setting-${row.key}`" class="terminal-setting-label">{{ row.label }}</span>
          <UTabs :model-value="settings[row.key]" :items="row.items" :content="false" color="neutral" variant="pill" size="sm"
            :ui="{ list: 'w-[220px]', trigger: 'flex-1' }" :aria-labelledby="`terminal-setting-${row.key}`" @update:model-value="value => update(row.key, value)" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style>
.terminal-settings-dialog{z-index:50;width:min(440px,calc(var(--ui-viewport-width) - 28px));max-height:calc(var(--dialog-height) - 32px)}
.terminal-settings-rows{display:grid;gap:12px}
.terminal-setting-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:16px}
.terminal-setting-label{min-width:0;color:#b8c0cc;font-size:13px;overflow-wrap:anywhere}
</style>
