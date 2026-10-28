<script setup lang="ts">
import { computed } from 'vue'
import UProgress from '@nuxt/ui/components/Progress.vue'
import Icon from './Icon.vue'
import { acceptDownload, cancelDownload, dismissDownload, downloadFinished, downloads, type Download } from '../downloads'

const props = defineProps<{ id: string }>()
const download = computed(() => downloads.value.find(item => item.id === props.id))
const getValueText = () => download.value ? `${percent(download.value)}%` : ''
function bytes(value: number) {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let unit = -1
  do { value /= 1024; unit++ } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
function percent(item: Download) {
  return item.size ? Math.min(100, Math.floor(item.transferred / item.size * 100)) : item.state === 'completed' ? 100 : 0
}
function status(item: Download) {
  if (item.cancelling) return '取消中…'
  if (item.state === 'completed') return '传输完成'
  if (item.state === 'cancelled') return '已取消'
  if (item.state === 'failed') {
    if (item.reason === 'disconnected') return '连接中断'
    if (item.reason === 'timed-out' || item.reason === 'not-started') return '下载超时'
    return '传输失败'
  }
  if (item.state === 'accepted') return '等待下载…'
  return `${percent(item)}%`
}
function accept(event: MouseEvent) {
  if (!acceptDownload(props.id)) event.preventDefault()
}
</script>

<template>
  <div v-if="download" class="download-content" :data-download-id="download.id" :data-download-state="download.state" :data-download-filename="download.filename" :data-state="download.state" @pointerdown.stop @wheel.stop>
    <div v-if="download.state === 'offered'" class="download-details">
      <span class="download-size offer-size">{{ bytes(download.size) }}</span>
      <button :disabled="download.cancelling" @click="cancelDownload(download.id)">{{ download.cancelling ? '取消中…' : '取消' }}</button>
      <a :href="download.url" :download="download.filename" :aria-disabled="download.cancelling || undefined" @click="accept">下载</a>
    </div>
    <template v-else>
      <div class="download-details">
        <span class="download-status" :class="{ failed: download.state === 'failed' }" role="status">{{ status(download) }}</span>
        <span class="download-size">{{ bytes(download.transferred) }} / {{ bytes(download.size) }}</span>
        <button v-if="!downloadFinished(download)" :disabled="download.cancelling" @click="cancelDownload(download.id)">取消</button>
        <button v-else class="download-dismiss" aria-label="关闭下载通知" @click="dismissDownload(download.id)"><Icon name="close" :size="13" /></button>
      </div>
      <UProgress v-if="!downloadFinished(download)" :model-value="download.transferred" :max="download.size || 1" size="xs" color="primary" :get-value-text="getValueText" :aria-label="download.filename" class="download-progress" />
    </template>
  </div>
</template>

<style scoped>
.download-content{min-height:40px;font-size:11px}
.download-details{display:flex;align-items:center;gap:10px;min-height:28px}
.download-size{flex-shrink:0;white-space:nowrap;font-size:10px;color:var(--ui-text-muted);font-variant-numeric:tabular-nums}
.offer-size{flex:1}
.download-details>a{display:inline-flex;align-items:center;justify-content:center;min-height:26px;padding:0 11px;border:1px solid #c49d7e;border-radius:4px;background:var(--ui-primary);color:#29211c;text-decoration:none;font-weight:500}
.download-details>a:hover{filter:brightness(1.07)}
.download-details>a[aria-disabled=true]{opacity:.55;cursor:default}
.download-details>a:focus-visible{outline:2px solid var(--ui-primary);outline-offset:3px}
.download-content button{min-height:24px;padding:0 3px;color:var(--ui-text-muted);font-size:11px;border-radius:3px}
.download-content button:hover{color:var(--ui-primary)}
.download-content button:disabled{cursor:default}
.download-content .download-dismiss{min-height:19px;width:19px;padding:0;flex-shrink:0}
.download-status{flex:1;color:var(--ui-text);font-size:10px;font-variant-numeric:tabular-nums}
.download-status.failed{color:var(--ui-error)}
.download-progress{margin-top:6px}
</style>
