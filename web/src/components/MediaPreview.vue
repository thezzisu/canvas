<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useDocumentVisibility, useIntersectionObserver } from '@vueuse/core'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ src: string; kind: 'audio' | 'video'; title: string; readOnly?: boolean }>()
const emit = defineEmits<{ download: []; loaded: [width: number, height: number] }>()
const { t } = useI18n()
const root = ref<HTMLElement>(), player = ref<HTMLMediaElement>()
const failed = ref(false), visible = ref(true)
const visibility = useDocumentVisibility()
let position = 0, resume = false
useIntersectionObserver(root, ([entry]) => { visible.value = !!entry?.isIntersecting })
watch([visible, visibility], ([onScreen, documentVisibility]) => {
  if (!onScreen || documentVisibility !== 'visible') { player.value?.pause(); resume = false }
})
watch(() => props.src, (_, previous) => {
  position = previous ? player.value?.currentTime || 0 : 0
  resume = !!previous && !!player.value && !player.value.paused
  failed.value = false
})
function loaded() {
  const media = player.value
  if (!media) return
  if (media instanceof HTMLVideoElement) emit('loaded', media.videoWidth, media.videoHeight)
  if (position && Number.isFinite(media.duration)) media.currentTime = Math.min(position, media.duration)
  if (resume && visible.value && visibility.value === 'visible') void media.play().catch(() => {})
  position = 0; resume = false
}
onBeforeUnmount(() => {
  player.value?.pause()
  player.value?.removeAttribute('src')
  player.value?.load()
})
</script>

<template>
  <div ref="root" class="media-preview nowheel nopan" :class="`media-preview-${kind}`" @keydown.stop @wheel.stop>
    <component :is="kind" v-if="!failed" ref="player" :src="src" :controls="!readOnly" preload="metadata" playsinline :aria-label="title" @loadedmetadata="loaded" @error="failed = true" />
    <div v-else class="media-preview-error" role="status"><span>{{ t('panels.preview.mediaUnavailable') }}</span><button v-if="!readOnly" type="button" @click="emit('download')">{{ t('panels.file.downloadOriginal') }}</button></div>
  </div>
</template>

<style scoped>
.media-preview{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0}
.media-preview video{display:block;width:100%;height:100%;object-fit:contain;background:#111}
.media-preview audio{width:min(100%,560px);max-width:100%}
.media-preview-audio{padding:20px}
.media-preview-error{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px;text-align:center;font-size:12px;color:#96a0af}
.media-preview-error button{color:#d4ac8e}
</style>
