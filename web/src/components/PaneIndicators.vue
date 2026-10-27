<script setup lang="ts">
import { paneLabel, paneShortId, statusColor } from '../status'
import type { PaneResource } from '../types'
defineProps<{ panes: PaneResource[] }>()
</script>

<template>
  <div v-if="panes.length > 1" class="pane-indicators nodrag" aria-label="Pane 状态" @pointerdown.stop>
    <span v-for="pane in panes" :key="pane.id" class="pane-indicator" :class="[`program-${pane.status}`, { active: pane.active }]" :style="{ '--program-color': statusColor(pane.status) }" :data-pane-id="pane.id" :data-program-status="pane.status" :title="paneLabel(pane)" :aria-label="paneLabel(pane)"><i class="program-dot" /><span>{{ paneShortId(pane) }}</span></span>
  </div>
</template>
