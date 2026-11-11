<script setup lang="ts">
import Icon from '../components/Icon.vue'

defineProps<{ size: number }>()
</script>

<template>
  <div class="brand">
    <span class="brand-symbol"><Icon name="canvas" :size="size" /></span>
    <span class="brand-name">canvas</span>
    <slot />
  </div>
</template>
