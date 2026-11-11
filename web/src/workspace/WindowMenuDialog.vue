<script lang="ts">
export interface WindowMenuItem {
  label: string
  icon: string
  /** What the dialog closes with when this item is chosen. */
  value: string
  color?: 'error'
  disabled?: boolean
  /** Takes focus as the dialog closes, instead of returning it to the menu's trigger. */
  focus?: () => void
}
</script>

<script setup lang="ts">
import UModal from '../components/CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import USeparator from '@nuxt/ui/components/Separator.vue'
import WindowTitle from './WindowTitle.vue'
import type { WindowResource } from '../api/types'

// Window actions as one list of stock buttons; groups are separated like menu groups.
defineProps<{ window: Pick<WindowResource, 'name' | 'panes'>; items: WindowMenuItem[][] }>()
const emit = defineEmits<{ close: [value?: string] }>()
let chosen: WindowMenuItem | undefined
function choose(item: WindowMenuItem) {
  chosen = item
  emit('close', item.value)
}
function handFocusOn(event: Event) {
  if (!chosen?.focus) return
  event.preventDefault()
  chosen.focus()
}
</script>

<template>
  <UModal
    :ui="{
      content: 'window-menu [--dialog-width:24rem]',
      wrapper: 'min-w-0 pe-9',
      body: 'flex flex-col gap-0.5 p-2 sm:p-3',
    }"
    :content="{ onCloseAutoFocus: handFocusOn }"
  >
    <template #title><WindowTitle :window="window" /></template>
    <template #body>
      <template v-for="(group, index) in items" :key="index">
        <USeparator v-if="index" class="my-1" />
        <!-- An item that takes focus keeps it away from the button being pressed. -->
        <UButton
          v-for="item in group"
          :key="item.value"
          :color="item.color || 'neutral'"
          variant="ghost"
          size="lg"
          block
          :icon="item.icon"
          class="justify-start"
          :disabled="item.disabled"
          @pointerdown="item.focus && $event.preventDefault()"
          @click="choose(item)"
        >
          {{ item.label }}
        </UButton>
      </template>
    </template>
  </UModal>
</template>
