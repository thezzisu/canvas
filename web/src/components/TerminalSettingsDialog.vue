<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import TerminalSettingsFields from './TerminalSettingsFields.vue'
import { useTerminalDefaults, type TerminalOverrides } from '../terminal-settings'

defineProps<{ open: boolean; portal?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const settings = defineModel<TerminalOverrides>({ required: true })
const defaults = useTerminalDefaults()
const { t } = useI18n()
</script>

<template>
  <UModal :open="open" :portal="portal || false" :title="t('terminal.settings.title')" :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'terminal-settings-dialog', overlay: 'app-dialog-overlay' }" @update:open="value => { if (!value) emit('close') }">
    <template #body><TerminalSettingsFields v-model="settings" :defaults="defaults" /></template>
  </UModal>
</template>

<style>
.terminal-settings-dialog{z-index:50;width:min(440px,calc(var(--ui-viewport-width) - 28px));max-height:calc(var(--dialog-height) - 32px)}
</style>
