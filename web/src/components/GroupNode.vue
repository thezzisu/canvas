<script setup lang="ts">
import Icon from './Icon.vue'
import type { NodeProps } from '@vue-flow/core'
defineProps<NodeProps<{ name: string; subtitle?: string; kind: 'machine' | 'space'; count?: number; width?: number; height?: number }>>()
</script>
<template>
  <div v-if="data.kind === 'machine'" class="machine-group" :style="{ width: `${data.width}px`, height: `${data.height}px` }">
    <header><span class="machine-symbol"><Icon name="server" :size="17" /></span><strong>{{ data.name }}</strong><span class="machine-count">{{ data.count }} 个窗口</span><span class="machine-type">{{ data.subtitle }}</span></header>
    <p v-if="!data.count" class="machine-empty">暂无窗口</p>
  </div>
  <div v-else class="space-label"><Icon name="layers" :size="15" /><strong>{{ data.name }}</strong><span>{{ data.subtitle }}</span><i /><span>{{ data.count }} 个窗口</span></div>
</template>
