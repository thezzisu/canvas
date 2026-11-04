<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import { statusColor, statusLabel } from '../status'
import type { CanvasIndicator } from '../canvas-status'

const props = defineProps<{ name: string; overview?: boolean; active?: boolean; indicator?: CanvasIndicator; reorderable?: boolean }>()
defineEmits<{ select: [] }>()
const { t, n } = useI18n()
const label = computed(() => props.indicator?.status ? t('canvasUi.canvasStatus', { name: props.name, status: statusLabel(props.indicator.status) }) : props.name)
</script>

<template>
  <button class="nav-item canvas-nav-item" :class="{ active }" :aria-current="active ? 'page' : undefined" :aria-label="label" :title="label" @click="$emit('select')">
    <span v-if="reorderable" data-reorder-handle :title="t('app.reorderHint')"><Icon name="canvas" :size="16" /></span>
    <Icon v-else :name="overview ? 'grid' : 'canvas'" :size="16" />
    <span class="canvas-nav-name"><span>{{ name }}</span><small v-if="indicator" class="canvas-nav-count">{{ n(indicator.count) }}</small></span>
    <span class="canvas-nav-status" aria-hidden="true"><i v-if="indicator?.status" class="program-dot" :style="{ '--program-color': statusColor(indicator.status) }" /></span>
  </button>
</template>
