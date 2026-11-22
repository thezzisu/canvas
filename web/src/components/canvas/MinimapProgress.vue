<script setup lang="ts">
// A program's progress report (OSC 9;4) on its card's minimap block, as the card header shows it.
import { computed, useId } from 'vue'
import type { WindowProgress } from '../../../../shared/window-metadata'
import { SWEEP_BAND, progressLayers } from '../../utils/canvas/progress-fill'

const props = defineProps<{
  progress: WindowProgress
  x: number
  y: number
  width: number
  height: number
  radius?: number
}>()
const id = useId()
const layers = computed(() => progressLayers(props.progress, { x: props.x, width: props.width }))
</script>

<template>
  <g
    class="minimap-progress"
    :data-state="progress.state"
    :clip-path="`url(#${id}-card)`"
    pointer-events="none"
  >
    <defs>
      <clipPath :id="`${id}-card`">
        <rect :x="x" :y="y" :width="width" :height="height" :rx="radius" :ry="radius" />
      </clipPath>
      <clipPath :id="`${id}-filled`">
        <rect :x="layers.filled.x" :y="y" :width="layers.filled.width" :height="height" />
      </clipPath>
      <linearGradient :id="`${id}-glint`">
        <stop offset="0" class="minimap-progress-glint" stop-opacity="0" />
        <stop offset="0.5" class="minimap-progress-glint" />
        <stop offset="1" class="minimap-progress-glint" stop-opacity="0" />
      </linearGradient>
    </defs>
    <rect
      v-if="layers.rest"
      class="minimap-progress-rest"
      :x="layers.rest.x"
      :y="y"
      :width="layers.rest.width"
      :height="height"
    />
    <rect
      v-if="layers.sweep"
      class="minimap-progress-sweep"
      :class="layers.sweep"
      :clip-path="`url(#${id}-filled)`"
      :x="layers.filled.x"
      :y="y"
      :width="layers.filled.width * SWEEP_BAND"
      :height="height"
      :fill="`url(#${id}-glint)`"
    />
    <line
      v-if="layers.edge !== undefined"
      class="minimap-progress-edge"
      :x1="layers.edge"
      :x2="layers.edge"
      :y1="y"
      :y2="y + height"
      vector-effect="non-scaling-stroke"
    />
  </g>
</template>
