<script setup lang="ts">
import Icon from './Icon.vue'
import type { NodeProps } from '@vue-flow/core'
defineProps<NodeProps<{ name: string; subtitle?: string; kind: 'source' | 'space'; count?: number; width?: number; height?: number }>>()
</script>
<template>
  <div v-if="data.kind === 'source'" class="source-group" :style="{ width: `${data.width}px`, height: `${data.height}px` }">
    <header><span class="source-symbol"><Icon name="server" :size="17" /></span><strong>{{ data.name }}</strong><span class="source-count">{{ data.count }} 个窗口</span><span class="source-type">{{ data.subtitle }}</span></header>
  </div>
  <div v-else class="space-label"><Icon name="layers" :size="15" /><strong>{{ data.name }}</strong><i /><span>{{ data.count }} 个窗口</span></div>
</template>
