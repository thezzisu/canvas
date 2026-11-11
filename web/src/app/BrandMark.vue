<script setup lang="ts">
import CanvasGlyph from '../components/CanvasGlyph.vue'

defineProps<{ size: number }>()
</script>

<template>
  <div class="brand">
    <span class="brand-symbol"><CanvasGlyph name="canvas" :size="size" /></span>
    <span class="brand-name">canvas</span>
    <slot />
  </div>
</template>
