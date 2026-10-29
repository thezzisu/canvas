<script setup lang="ts">
import type { NodeProps } from '@vue-flow/core'
import Icon from './Icon.vue'

defineProps<NodeProps<{
  sourceId: string; spaceId?: string; context: string; available: boolean
  pending(): boolean; create(): void
}>>()
</script>

<template>
  <button class="overview-create nodrag nopan" :class="data.spaceId ? 'overview-create-tab' : 'overview-create-space'"
    :data-source-id="data.sourceId" :data-space-id="data.spaceId"
    :aria-label="`${data.spaceId ? '新建 Tab' : '新建 Space'} · ${data.context}`"
    :aria-busy="data.pending()" :disabled="!data.available || data.pending()"
    :title="data.available ? undefined : '连接不可用'" @pointerdown.stop @click.stop="data.create()" @dblclick.stop>
    <span v-if="data.pending()" class="spinner" />
    <Icon v-else :name="data.spaceId ? 'plus' : 'layers'" :size="data.spaceId ? 22 : 15" />
    <span>{{ data.spaceId ? '新建 Tab' : '新建 Space' }}</span>
    <i v-if="!data.spaceId" />
  </button>
</template>

<style scoped>
:global(.vue-flow__node-create) { padding: 0; border: 0; background: transparent; pointer-events: auto !important; }
.overview-create { width: 100%; height: 100%; color: #80909f; cursor: pointer; }
.overview-create:hover:not(:disabled), .overview-create:focus-visible { color: #dfbb9b; }
.overview-create:focus-visible { outline: 2px solid #c59d7c; outline-offset: 3px; }
.overview-create:disabled { cursor: default; opacity: .45; }
.overview-create-tab { flex-direction: column; gap: 10px; border: 1px dashed #46505b; border-radius: 8px; background: #1b202633; font-size: 12px; }
.overview-create-tab:hover:not(:disabled) { background: #29262055; border-color: #967f68; }
.overview-create-space { justify-content: flex-start; gap: 8px; font-size: 10px; border-radius: 4px; }
.overview-create-space i { flex: 1; border-top: 1px dashed #45505c66; margin-left: 4px; }
</style>
