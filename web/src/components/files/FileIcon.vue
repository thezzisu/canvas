<script setup lang="ts">
import { computed } from 'vue'
import { computedAsync } from '@vueuse/core'

const props = withDefaults(defineProps<{ name: string; size?: number | string }>(), { size: 16 })
const url = computedAsync(async () =>
  (await import('../../utils/files/file-icons')).fileIconUrl(props.name),
)
const dimension = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
const style = computed(() => ({
  width: dimension.value,
  height: dimension.value,
  backgroundImage: url.value && `url("${url.value}")`,
}))
</script>

<template>
  <span
    class="inline-block flex-none align-middle bg-center bg-contain bg-no-repeat"
    aria-hidden="true"
    :style="style"
  />
</template>
