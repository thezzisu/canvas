<script setup lang="ts">
import { computed } from 'vue'
import { computedAsync } from '@vueuse/core'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })
const url = computedAsync(async () => (await import('../file-icons')).fileIconUrl(props.name))
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px`, backgroundImage: url.value && `url("${url.value}")` }))
</script>

<template>
  <span class="inline-block flex-none align-middle bg-center bg-contain bg-no-repeat" aria-hidden="true" :style="style" />
</template>
