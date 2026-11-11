<script lang="ts">
export interface WindowMenuItem {
  label: string
  icon: string
  color?: 'error'
  disabled?: boolean
  keepFocus?: boolean
  onSelect: () => void
}
</script>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import USeparator from '@nuxt/ui/components/Separator.vue'
import WindowTitle from './WindowTitle.vue'
import type { WindowResource } from '../types'

// Window actions as one list of stock buttons; groups are separated like menu groups.
defineProps<{
  window: Pick<WindowResource, 'name' | 'panes'>
  items: WindowMenuItem[][]
  busy: boolean
}>()
const emit = defineEmits<{ close: []; closeAutoFocus: [event: Event] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    :open="true"
    :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }"
    :ui="{
      content: 'window-menu [--dialog-width:24rem]',
      wrapper: 'min-w-0 pe-9',
      body: 'flex flex-col gap-0.5 p-2 sm:p-3',
    }"
    :content="{ onCloseAutoFocus: (event: Event) => emit('closeAutoFocus', event) }"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
  >
    <template #title><WindowTitle :window="window" /></template>
    <template #body>
      <template v-for="(group, index) in items" :key="index">
        <USeparator v-if="index" class="my-1" />
        <!-- keepFocus: the keyboard action hands focus to the terminal itself. -->
        <UButton
          v-for="item in group"
          :key="item.label"
          type="button"
          :color="item.color || 'neutral'"
          variant="ghost"
          size="lg"
          block
          :icon="item.icon"
          class="justify-start"
          :disabled="busy || item.disabled"
          @pointerdown="item.keepFocus && $event.preventDefault()"
          @click="item.onSelect()"
          >{{ item.label }}</UButton
        >
      </template>
    </template>
  </UModal>
</template>
