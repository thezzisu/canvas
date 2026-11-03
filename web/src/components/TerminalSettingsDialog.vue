<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import URadioGroup from '@nuxt/ui/components/RadioGroup.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UModal from './CanvasModal.vue'
import type { RightClickMode } from '../terminal-settings'

defineProps<{ open: boolean; portal?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const mode = defineModel<RightClickMode>({ required: true })
const { t } = useI18n()
const items = computed(() => [
  { label: t('terminal.settings.paneMenu'), value: 'menu' },
  { label: t('terminal.settings.sendToTerminal'), value: 'terminal' },
])
</script>

<template>
  <UModal :open="open" :portal="portal || false" :title="t('terminal.settings.title')" :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'terminal-settings-dialog', overlay: 'app-dialog-overlay' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <UFormField :label="t('terminal.settings.rightClick')"><URadioGroup v-model="mode" :items="items" variant="card" :ui="{ fieldset: 'terminal-settings-options', item: 'terminal-settings-option' }" /></UFormField>
    </template>
  </UModal>
</template>

<style>
.terminal-settings-dialog{z-index:50;width:min(380px,calc(var(--ui-viewport-width) - 28px));max-height:calc(var(--mobile-height,var(--ui-viewport-height)) - 32px)}
.terminal-settings-dialog label{margin-top:0}
.terminal-settings-options{margin:0;padding:0;border:0;min-width:0}
.terminal-settings-dialog .terminal-settings-option{display:flex;align-items:center}
</style>
