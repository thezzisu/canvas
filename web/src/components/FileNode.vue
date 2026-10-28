<script setup lang="ts">
import { computed } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import type { FileData } from '../types'
import Icon from './Icon.vue'

const props = defineProps<Pick<NodeProps<FileData>, 'id' | 'data' | 'selected'>>()
const pdfPreview = navigator.pdfViewerEnabled
const url = computed(() => `/api/files/${encodeURIComponent(props.data.assetId)}`)
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
    <div class="file-body nodrag nopan" @pointerdown.stop @dblclick.stop>
      <img v-if="data.asset.preview === 'image'" class="file-image" :src="url" :alt="data.asset.filename" draggable="false" loading="lazy" />
      <iframe v-else-if="(data.asset.preview === 'pdf' && pdfPreview) || data.asset.preview === 'text'" class="file-preview nowheel" :src="url" :title="data.asset.filename" loading="lazy" referrerpolicy="no-referrer" />
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
.file-download { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center; flex-direction: column; gap: 14px; padding: 24px; color: #a9b0be; text-decoration: none; }
.file-download:hover { color: #e0e3ea; background: #ffffff04; }
.file-download span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
</style>
