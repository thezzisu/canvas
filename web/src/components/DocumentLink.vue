<script setup lang="ts">
import ProseA from '@nuxt/ui/components/prose/A.vue'
import { requestTrustedPreview } from '../trusted-preview'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ href?: string }>()
function follow(event: MouseEvent) {
  if (!props.href) return
  const url = new URL(props.href, location.href)
  if (url.origin !== location.origin || !/\/api\/capture\/[A-Za-z0-9_-]{43}\/.*\.html?$/iu.test(url.pathname)) return
  event.preventDefault()
  requestTrustedPreview(decodeURIComponent(url.pathname.split('/').at(-1) || ''), () => {
    window.open(url.href, '_blank', 'noopener,noreferrer')
  })
}
</script>
<template><ProseA v-bind="$attrs" :href="href" @click="follow"><slot /></ProseA></template>
