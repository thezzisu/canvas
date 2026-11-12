<script setup lang="ts">
import { computed } from 'vue'
import { useVueFlow, type GraphNode, type NodeMouseEvent } from '@vue-flow/core'
import { MiniMap, MiniMapNode, type MiniMapNodeFunc, type MiniMapProps } from '@vue-flow/minimap'
import { minimapOrder } from '../../composables/canvas/minimap-order'

defineOptions({ inheritAttrs: false })
const props = defineProps<MiniMapProps>()
const emit = defineEmits<{ nodeClick: [event: NodeMouseEvent] }>()
const { getNodesInitialized } = useVueFlow()
const visible = computed(() =>
  getNodesInitialized.value.filter(
    (node) => !node.hidden && node.dimensions.width && node.dimensions.height,
  ),
)
const ordered = computed(() => minimapOrder(visible.value))
const types = computed(() => [...new Set(getNodesInitialized.value.map((node) => node.type))])
const value = (setting: string | MiniMapNodeFunc | undefined, node: GraphNode) =>
  typeof setting === 'function' ? setting(node) : setting
function clicked(event: MouseEvent, node: GraphNode) {
  event.stopPropagation()
  emit('nodeClick', { event, node })
}
</script>

<template>
  <MiniMap v-bind="{ ...props, ...$attrs }">
    <!-- Node slots replace the built-in rectangles. One slot paints the ordered
         layer while MiniMap retains its viewport, mask, pan and zoom behavior. -->
    <template v-for="type in types" :key="type" #[`node-${type}`]="slot">
      <g v-if="slot.id === visible[0]?.id">
        <g v-for="node in ordered" :key="node.id">
          <!-- The status pulse changes alpha; keep covered cards occluded. -->
          <rect
            v-if="value(props.nodeColor, node) !== 'transparent'"
            class="minimap-card-backing"
            :x="node.computedPosition.x"
            :y="node.computedPosition.y"
            :width="node.dimensions.width"
            :height="node.dimensions.height"
            :rx="slot.borderRadius"
            :ry="slot.borderRadius"
            fill="#191c21"
            pointer-events="none"
          />
          <MiniMapNode
            :id="node.id"
            type="canvas-minimap-rect"
            :position="node.computedPosition"
            :dimensions="node.dimensions"
            :selected="node.selected"
            :dragging="node.dragging"
            :class="value(props.nodeClassName, node)"
            :color="value(props.nodeColor, node) || '#e2e2e2'"
            :border-radius="slot.borderRadius"
            :stroke-color="value(props.nodeStrokeColor, node)"
            :stroke-width="slot.strokeWidth"
            :shape-rendering="slot.shapeRendering"
            @click="clicked($event, node)"
          />
        </g>
      </g>
    </template>
  </MiniMap>
</template>
