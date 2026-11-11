<script setup lang="ts">
import { computed } from 'vue'
import type { WindowResource } from '../api/types'
import { windowTerminalTitle } from './window-title'

const props = defineProps<{
  window: Pick<WindowResource, 'name' | 'panes'>
  paneId?: string
  description?: string
}>()
const terminalTitle = computed(() => windowTerminalTitle(props.window, props.paneId))
const title = computed(() =>
  [props.window.name, terminalTitle.value, props.description].filter(Boolean).join('\n'),
)
</script>

<template>
  <span class="window-title" :title="title"
    ><span class="terminal-tab-name">{{ window.name }}</span
    ><span v-if="terminalTitle" class="terminal-live-title">{{ terminalTitle }}</span></span
  >
</template>

<style scoped>
.window-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.terminal-tab-name,
.terminal-live-title {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.window-title:has(.terminal-live-title) .terminal-tab-name {
  max-width: 40%;
  flex-shrink: 0;
}
.terminal-live-title {
  color: var(--window-title-color, #939ba8);
  font-weight: 400;
}
</style>
