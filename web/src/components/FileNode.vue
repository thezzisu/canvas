<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import type { FileData } from '../types'
import Icon from './Icon.vue'
import { readTextPreview } from '../text-preview'

const props = defineProps<Pick<NodeProps<FileData>, 'id' | 'data' | 'selected'>>()
const pdfPreview = navigator.pdfViewerEnabled
const url = computed(() => `/api/files/${encodeURIComponent(props.data.assetId)}`)
const fileBody = ref<HTMLElement>()
const text = ref('')
const textLoading = ref(false)
const textError = ref('')
const truncated = ref(false)
let visibility: IntersectionObserver | undefined
let request: AbortController | undefined
async function loadText() {
  if (props.data.asset.preview !== 'text') return
  request?.abort()
  const current = request = new AbortController()
  textLoading.value = true; textError.value = ''; truncated.value = false
  try {
    const result = await readTextPreview(url.value, props.data.asset.size, current.signal)
    if (request !== current || current.signal.aborted) return
    text.value = result.text; truncated.value = result.truncated
  } catch (reason) {
    if (request === current && !current.signal.aborted) textError.value = reason instanceof Error ? reason.message : '无法读取文本'
  } finally { if (request === current) textLoading.value = false }
}
watch([fileBody, () => props.data.assetId, () => props.data.asset.preview], ([element, _id, preview]) => {
  request?.abort(); request = undefined; visibility?.disconnect()
  text.value = ''; textError.value = ''; truncated.value = false; textLoading.value = preview === 'text'
  if (!element || preview !== 'text') return
  visibility = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visibility?.disconnect()
    void loadText()
  }, { rootMargin: '200px' })
  visibility.observe(element)
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => { request?.abort(); visibility?.disconnect() })
const size = computed(() => {
  const bytes = props.data.asset.size
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`
})
</script>

<template>
  <template v-if="selected">
    <NodeResizeControl v-for="position in (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)" :key="position" :node-id="id" :position="position" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  </template>
  <article class="file-card" :data-asset-id="data.assetId" :data-preview-kind="data.asset.preview">
    <header class="file-header drag-handle">
      <Icon name="file" :size="13" />
      <span class="file-title" :title="data.asset.filename">{{ data.asset.filename }}</span>
      <span class="file-size">{{ size }}</span>
      <a class="file-action nodrag" :href="`${url}?download=1`" :download="data.asset.filename" title="下载文件" aria-label="下载文件" @pointerdown.stop><Icon name="download" :size="14" /></a>
      <button class="file-action nodrag" title="删除文件" aria-label="删除文件" @click.stop="data.onRemove(id)"><Icon name="close" :size="14" /></button>
    </header>
    <div ref="fileBody" class="file-body nodrag nopan" @pointerdown.stop @dblclick.stop>
      <img v-if="data.asset.preview === 'image'" class="file-image" :src="url" :alt="data.asset.filename" draggable="false" loading="lazy" />
      <div v-else-if="data.asset.preview === 'text'" class="file-text-body nowheel" @wheel.stop>
        <div v-if="textLoading" class="file-text-status" role="status"><span class="spinner" />加载中…</div>
        <div v-else-if="textError" class="file-text-status" role="alert"><span>{{ textError }}</span><button type="button" @click="loadText">重试</button></div>
        <pre v-else class="file-text-preview" :aria-label="data.asset.filename" tabindex="0">{{ text }}</pre>
        <div v-if="truncated" class="file-text-truncated"><span>已显示前 1 MiB</span><a :href="`${url}?download=1`" :download="data.asset.filename">下载原文件</a></div>
      </div>
      <iframe v-else-if="data.asset.preview === 'pdf' && pdfPreview" class="file-preview nowheel" :src="url" :title="data.asset.filename" loading="lazy" referrerpolicy="no-referrer" />
      <a v-else class="file-download" :href="`${url}?download=1`" :download="data.asset.filename" :aria-label="`下载 ${data.asset.filename}`"><Icon name="file" :size="42" /><span>{{ data.asset.filename }}</span></a>
    </div>
  </article>
</template>

<style scoped>
.file-card { height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #3a3d46; border-radius: 7px; background: #1b1d23; box-shadow: 0 5px 18px #0003; }
.file-header { display: flex; align-items: center; gap: 7px; height: 30px; flex: 0 0 30px; padding: 0 7px 0 10px; color: #a9b0be; cursor: grab; border-bottom: 1px solid #343740; }
.file-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #e0e3ea; }
.file-size { font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.file-action { display: inline-flex; justify-content: center; align-items: center; flex: 0 0 23px; width: 23px; height: 23px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #a9b0be; cursor: pointer; }
.file-action:hover { color: #fff; background: #ffffff12; }
.file-action:focus-visible, .file-download:focus-visible { outline: 2px solid #8c9ef8; outline-offset: -2px; }
.file-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.file-image { width: 100%; height: 100%; object-fit: contain; }
.file-preview { border: 0; width: 100%; height: 100%; background: #fff; color-scheme: light; }
.file-text-body { display: flex; flex-direction: column; width: 100%; min-width: 0; min-height: 0; background: #14191f; }
.file-text-preview { flex: 1; min-width: 0; min-height: 0; overflow: auto; margin: 0; padding: 12px; font-family: var(--content-font-family); font-feature-settings: var(--content-font-features); font-size: 13px; line-height: 1.5; white-space: pre; tab-size: 4; color: #cdd5e1; user-select: text; -webkit-user-select: text; touch-action: pan-x pan-y; scrollbar-width: thin; outline: none; }
.file-text-preview:focus-visible { box-shadow: inset 0 0 0 1px #b18a6d; }
.file-text-status { display: flex; flex: 1; align-items: center; justify-content: center; gap: 8px; padding: 12px; color: #8b98a9; font-size: 11px; }
.file-text-status button { color: #d4ac8e; font-size: 11px; }
.file-text-truncated { display: flex; justify-content: space-between; gap: 8px; flex: 0 0 auto; padding: 7px 10px; border-top: 1px solid #303947; font-size: 10px; color: #7f8da1; }
.file-text-truncated a { color: #c7aa93; text-decoration: none; }
.file-download { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center; flex-direction: column; gap: 14px; padding: 24px; color: #a9b0be; text-decoration: none; }
.file-download:hover { color: #e0e3ea; background: #ffffff04; }
.file-download span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
</style>
