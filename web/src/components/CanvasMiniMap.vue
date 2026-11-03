<script setup lang="ts">
import { computed, provide } from 'vue'
import { useVueFlow, VueFlowInjection } from '@vue-flow/core'
import { MiniMap, type MiniMapEmits, type MiniMapProps } from '@vue-flow/minimap'

const props = defineProps<MiniMapProps>()
const emit = defineEmits<MiniMapEmits>()
const flow = useVueFlow()

// SVG paints in document order. Give only the minimap the same stacking order
// as VueFlow's cards, keeping ties in their original DOM order.
provide(VueFlowInjection, {
  ...flow,
  getNodesInitialized: computed(() => [...flow.getNodesInitialized.value]
    .sort((a, b) => a.computedPosition.z - b.computedPosition.z)),
})
</script>

<template>
  <MiniMap v-bind="props" @click="emit('click', $event)" @node-click="emit('nodeClick', $event)"
    @node-dblclick="emit('nodeDblclick', $event)" @node-mouseenter="emit('nodeMouseenter', $event)"
    @node-mousemove="emit('nodeMousemove', $event)" @node-mouseleave="emit('nodeMouseleave', $event)" />
</template>
