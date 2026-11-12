<script setup lang="ts">
import ProseA from '@nuxt/ui/components/prose/A.vue'
import { requestTrustedPreview } from '../../composables/files/trusted-preview'
import { documentLinkNeedsTrust } from '../../utils/files/document-link'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ href?: string }>()
function follow(event: MouseEvent) {
  if (!props.href) return
  const url = new URL(props.href, location.href)
  if (!documentLinkNeedsTrust(url.href, location.href)) return
  event.preventDefault()
  requestTrustedPreview(url.pathname.split('/').at(-1) || url.hostname, () => {
    window.open(url.href, '_blank', 'noopener,noreferrer')
  })
}
</script>
<template>
  <ProseA v-bind="$attrs" :href="href" @click="follow"><slot /></ProseA>
</template>
