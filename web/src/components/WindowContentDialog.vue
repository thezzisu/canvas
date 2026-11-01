<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { Canvas } from '../types'
import type { WindowContentItem, WindowContentOpen, WindowContentScan } from '../../../shared/window-content'
import { api, apiContext, apiUrl, requireCurrentApi, segment, uuid } from '../api'
import { copyText } from '../clipboard'
import { presentDownload } from '../downloads'
import { filePreview } from '../file-preview'
import Icon from './Icon.vue'
import { presentUrl } from '../urls'

type Target = { sourceId: string; spaceId: string; windowId: string; name: string }
type FileItem = Extract<WindowContentItem, { kind: 'file' }>
type FileAction = 'download' | 'preview' | Canvas
const props = defineProps<{ target: Target | null; canvases: Canvas[]; portal?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const result = shallowRef<{ scan: WindowContentScan; target: Target }>()
const loading = ref(false)
const opening = ref('')
const error = shallowRef<string | Error>('')
const copied = ref<{ id: string; failed: boolean }>()
const added = ref<string>()
const errorMessage = computed(() => error.value instanceof Error ? error.value.message : error.value ? t(error.value) : '')
const panes = computed(() => result.value?.scan.panes.filter(pane => pane.items.length).map(pane => ({ ...pane,
  items: pane.items.map(item => ({ ...item,
    previewable: item.kind === 'file' && !!item.path && filePreview({ filename: item.path }) !== 'file',
    displayLabel: item.kind === 'file' ? item.label.split('/').filter(Boolean).at(-1) || item.label : item.label,
    href: item.kind === 'link' ? externalLink(item.url) : undefined })),
})) || [])
let scanRequest: AbortController | undefined
let fileRequest: AbortController | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
let retryItem: { item: FileItem; action: FileAction } | undefined

function externalLink(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) ||
        host === '[::1]' || host === '0.0.0.0' || host === '[::]') return
    return url.href
  } catch { return }
}
function cancelRequests() {
  scanRequest?.abort(); scanRequest = undefined
  fileRequest?.abort(); fileRequest = undefined
  loading.value = false; opening.value = ''
}
async function scan() {
  const target = props.target
  if (!target) return
  cancelRequests()
  result.value = undefined; error.value = ''; retryItem = undefined
  copied.value = undefined; clearTimeout(copyTimer)
  const current = scanRequest = new AbortController()
  loading.value = true
  try {
    const snapshot = await api<WindowContentScan>(`/api/sources/${segment(target.sourceId)}/spaces/${segment(target.spaceId)}/windows/${segment(target.windowId)}/scan`,
      { method: 'POST', body: '{}', signal: current.signal })
    if (scanRequest !== current || current.signal.aborted || props.target !== target) return
    result.value = { scan: snapshot, target }
  } catch (reason) {
    if (scanRequest === current && !current.signal.aborted && props.target === target) error.value = reason instanceof Error ? reason : 'panels.scan.failed'
  } finally {
    if (scanRequest === current) { scanRequest = undefined; loading.value = false }
  }
}
function close(open = false) {
  if (open) return
  cancelRequests()
  emit('close')
}
async function openFile(item: FileItem, action: FileAction = 'download') {
  const snapshot = result.value
  if (!snapshot || !item.path || opening.value || loading.value || props.target !== snapshot.target) return
  const canvas = typeof action === 'string' ? undefined : action
  const context = apiContext()
  const current = fileRequest = new AbortController()
  opening.value = item.id; error.value = ''; retryItem = undefined
  const anchor = canvas?.nodes.find(node => node.type === 'terminal' && node.sourceId === snapshot.target.sourceId && node.windowId === snapshot.target.windowId)
  const destination = !canvas ? {} : anchor ? { canvasId: canvas.id, anchorId: anchor.id } : { canvasId: canvas.id,
    position: { x: Math.min(1e7, canvas.nodes.length ? Math.max(...canvas.nodes.map(node => node.x + node.width)) + 24 : 80), y: 80 } }
  try {
    const file = await api<WindowContentOpen>(`/api/content-scans/${segment(snapshot.scan.id)}/items/${segment(item.id)}/open`,
      { method: 'POST', body: JSON.stringify(destination), signal: current.signal }, context)
    if (fileRequest !== current || current.signal.aborted || result.value !== snapshot || props.target !== snapshot.target) return
    const url = apiUrl(file.url, context)
    if (!/^api\/(?:files|downloads)\/[^/]+$/.test(url.pathname.slice(new URL(context.base).pathname.length)) || url.search) throw new Error(t('panels.scan.openFailed'))
    requireCurrentApi(context)
    if (canvas) added.value = item.id
    else await presentDownload(file, action === 'download')
  } catch (reason) {
    if (!current.signal.aborted && result.value === snapshot && props.target === snapshot.target) {
      error.value = reason instanceof Error ? reason : 'panels.scan.openFailed'
      retryItem = { item, action }
    }
  } finally {
    if (fileRequest === current) { fileRequest = undefined; opening.value = '' }
  }
}
function retry() { if (retryItem) void openFile(retryItem.item, retryItem.action); else void scan() }
function destinations(item: FileItem): DropdownMenuItem[] {
  return props.canvases.map(canvas => ({ label: canvas.name, onSelect: () => { void openFile(item, canvas) } }))
}
async function openLink(item: Extract<WindowContentItem, { kind: 'link' }>) {
  const snapshot = result.value, context = apiContext()
  if (!snapshot || opening.value || props.target !== snapshot.target) return
  const current = fileRequest = new AbortController()
  opening.value = item.id; error.value = ''
  try {
    const opened = await api<{ url: string; forwarded: boolean }>('/api/urls', { method: 'POST',
      body: JSON.stringify({ sourceId: snapshot.target.sourceId, url: item.url }), signal: current.signal }, context)
    if (current.signal.aborted || result.value !== snapshot || props.target !== snapshot.target) return
    fileRequest = undefined; opening.value = ''; emit('close'); await nextTick()
    requireCurrentApi(context); presentUrl({ id: uuid(), ...opened })
  } catch (reason) {
    if (!current.signal.aborted && result.value === snapshot) error.value = reason instanceof Error ? reason : 'panels.scan.openFailed'
  } finally { if (fileRequest === current) { fileRequest = undefined; opening.value = '' } }
}
function copy(item: WindowContentItem) {
  clearTimeout(copyTimer)
  const owner = result.value
  const value = item.kind === 'link' ? item.url : item.path || item.label
  const failed = () => { if (result.value === owner) copied.value = { id: item.id, failed: true } }
  if (copyText(value, failed)) copied.value = { id: item.id, failed: false }
  copyTimer = setTimeout(() => { copied.value = undefined }, 1800)
}
const modalContent = { onCloseAutoFocus: (event: Event) => event.preventDefault(), onEscapeKeyDown: (event: Event) => event.stopPropagation() }
watch(() => props.target, target => {
  cancelRequests(); result.value = undefined; error.value = ''; copied.value = undefined; added.value = undefined; retryItem = undefined; clearTimeout(copyTimer)
  if (target) void scan()
}, { immediate: true })
onBeforeUnmount(() => { cancelRequests(); clearTimeout(copyTimer) })
</script>

<template>
  <UModal v-if="target" :open="true" :transition="false" :title="t('panels.scan.title')" :portal="portal || false" :content="modalContent"
    :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'content-scan-modal', overlay: 'content-scan-overlay', header: 'content-scan-header', wrapper: 'content-scan-heading', title: 'content-scan-title', description: 'content-scan-description', body: 'content-scan-body', close: 'content-scan-close' }"
    @update:open="close">
    <template #description><span :title="target.name">{{ target.name }}</span><span>{{ t('panels.scan.scope') }}</span></template>
    <template #actions><UButton type="button" color="neutral" variant="ghost" class="content-scan-action" :disabled="loading || !!opening" :aria-label="t('panels.scan.refresh')" :title="t('panels.scan.refresh')" @click="scan"><Icon name="refresh" :size="15" /></UButton></template>
    <template #body>
      <div v-if="error" class="content-scan-error" role="alert"><span>{{ errorMessage }}</span><UButton type="button" color="neutral" variant="link" size="xs" :disabled="loading || !!opening" @click="retry">{{ t('common.retry') }}</UButton></div>
      <div v-if="loading" class="content-scan-empty" role="status"><span class="spinner" />{{ t('common.loading') }}</div>
      <div v-else-if="result && !panes.length" class="content-scan-empty">{{ t('panels.scan.empty') }}</div>
      <section v-for="pane in panes" :key="pane.id" class="content-scan-pane" :data-scan-pane="pane.id">
        <header><strong>{{ pane.name || t('terminal.pane', { name: pane.id.split(':').at(-1) || pane.id }) }}</strong><span v-if="pane.cwd" :title="pane.cwd">{{ pane.cwd }}</span></header>
        <div v-for="item in pane.items" :key="item.id" class="content-scan-item" :data-scan-item="item.id" :data-item-kind="item.kind" :aria-busy="opening === item.id">
          <div v-if="item.kind === 'file'" class="content-scan-open content-scan-file-label" :title="item.path || item.label">
            <span v-if="opening === item.id" class="spinner" /><Icon v-else name="file" :size="16" />
            <span><strong>{{ item.displayLabel }}</strong><small v-if="item.path !== item.displayLabel">{{ item.path || t('panels.scan.unresolved') }}</small></span>
          </div>
          <a v-else-if="item.href" class="content-scan-open" :href="item.href" target="_blank" rel="noopener noreferrer" :title="item.url"><Icon name="globe" :size="16" /><span><strong>{{ item.label }}</strong><small v-if="item.url !== item.label">{{ item.url }}</small></span></a>
          <button v-else class="content-scan-open" type="button" :disabled="!!opening" :title="item.url" @click="openLink(item)">
            <span v-if="opening === item.id" class="spinner" /><Icon v-else name="globe" :size="16" />
            <span><strong>{{ item.displayLabel }}</strong><small>{{ t('urls.open') }}</small></span>
          </button>
          <UButton type="button" color="neutral" variant="ghost" class="content-scan-action" :aria-label="t(item.kind === 'file' ? 'panels.scan.copyPath' : 'panels.scan.copyLink')" :title="copied?.id === item.id ? t(copied.failed ? 'terminal.clipboard.failed' : 'terminal.clipboard.copied') : t(item.kind === 'file' ? 'panels.scan.copyPath' : 'panels.scan.copyLink')" @click="copy(item)"><Icon :name="copied?.id === item.id ? copied.failed ? 'info' : 'check' : 'copy'" :size="15" /></UButton>
          <div v-if="item.kind === 'file' && item.path" class="content-scan-file-actions">
            <UButton v-if="item.previewable" type="button" color="neutral" variant="ghost" size="xs" :disabled="!!opening" @click="openFile(item, 'preview')"><Icon name="eye" :size="13" />{{ t('panels.scan.preview') }}</UButton>
            <UButton type="button" color="neutral" variant="ghost" size="xs" :disabled="!!opening" @click="openFile(item)"><Icon name="download" :size="13" />{{ t('panels.file.download') }}</UButton>
            <UDropdownMenu :items="destinations(item)" :portal="portal || false" :content="{ side: 'bottom', align: 'start' }" :ui="{ content: 'content-scan-destinations' }">
              <UButton type="button" color="neutral" variant="ghost" size="xs" :disabled="!!opening || !canvases.length" :title="!canvases.length ? t('panels.scan.createCanvasFirst') : undefined"><Icon :name="added === item.id ? 'check' : 'plus'" :size="13" />{{ t(added === item.id ? 'panels.scan.added' : 'panels.scan.addNote') }}<Icon name="down" :size="11" /></UButton>
            </UDropdownMenu>
          </div>
        </div>
      </section>
      <p v-if="result?.scan.truncated" class="content-scan-truncated">{{ t('panels.scan.truncated') }}</p>
      <p v-if="result?.scan.incomplete" class="content-scan-truncated">{{ t('panels.scan.incomplete') }}</p>
      <span class="sr-only" role="status">{{ opening ? t('panels.scan.staging') : copied ? t(copied.failed ? 'terminal.clipboard.failed' : 'terminal.clipboard.copied') : '' }}</span>
    </template>
  </UModal>
</template>

<style>
.content-scan-overlay{z-index:82}
.content-scan-modal{--scan-safe-top:var(--mobile-safe-top,var(--ui-safe-top));--scan-safe-bottom:var(--mobile-safe-bottom,var(--ui-safe-bottom));position:fixed;left:calc(var(--mobile-left,0px) + (var(--mobile-width,var(--ui-viewport-width)) + var(--ui-safe-left) - var(--ui-safe-right))/2);top:calc(var(--mobile-top,0px) + (var(--mobile-height,var(--ui-viewport-height)) + var(--scan-safe-top) - var(--scan-safe-bottom))/2);translate:-50% -50%;z-index:83;display:flex;flex-direction:column;gap:0;width:min(620px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px - var(--ui-safe-left) - var(--ui-safe-right)));max-width:none;max-height:min(680px,calc(var(--mobile-height,var(--ui-viewport-height)) - 24px - var(--scan-safe-top) - var(--scan-safe-bottom)));overflow:hidden;border:1px solid #414b59;border-radius:10px;background:#20252d;color:#cbd4df;box-shadow:0 16px 50px #0007}
.content-scan-header{display:flex;align-items:center;flex:none;gap:6px;min-height:60px;padding:10px 8px 10px 14px;border-bottom:1px solid #343d49}
.content-scan-heading{flex:1;min-width:0}
.content-scan-title{font-size:14px;font-weight:550;line-height:1.4;color:#e0e5ec}
.content-scan-description{display:flex;gap:10px;min-width:0;margin-top:3px;font-size:10px;color:#8290a1}
.content-scan-description>span:first-child{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.content-scan-description>span:last-child{flex:none}
.content-scan-body{flex:1;min-height:0;padding:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.content-scan-pane{padding:7px 8px 8px}
.content-scan-pane+.content-scan-pane{border-top:1px solid #333b47}
.content-scan-pane>header{display:flex;align-items:center;gap:12px;min-width:0;padding:5px 6px 7px;color:#8998aa;font-size:10px}
.content-scan-pane>header strong{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:#b8c3d1}
.content-scan-pane>header>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--content-font-family,monospace)}
.content-scan-item{display:flex;align-items:center;gap:2px;min-width:0;border-radius:6px}
.content-scan-item[data-item-kind='file']{display:grid;grid-template-columns:minmax(0,1fr) auto}
.content-scan-file-label{cursor:default;padding-bottom:3px;min-height:43px}
.content-scan-file-actions{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:5px;padding:0 5px 6px 29px}.content-scan-file-actions>button,.content-scan-file-actions>span{font-size:10px}.content-scan-destinations{z-index:90;max-width:280px}
.content-scan-item:hover{background:#ffffff04}
.content-scan-open{display:flex;align-items:center;flex:1;min-width:0;gap:9px;min-height:47px;padding:8px 6px;color:#b9c5d4;text-align:left;text-decoration:none;border-radius:5px}
.content-scan-open>svg,.content-scan-open>.spinner{flex:none;color:#8796aa}
.content-scan-open>span:last-child{display:block;min-width:0;flex:1}
.content-scan-open strong,.content-scan-open small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.content-scan-open strong{font-family:var(--content-font-family,monospace);font-size:12px;font-weight:400;line-height:1.5;color:#d0d9e5}
.content-scan-open small{margin-top:2px;font-size:10px;line-height:1.4;color:#7f8ea1}
.content-scan-open:hover:not(:disabled) strong{color:#edd0b8}
.content-scan-open:focus-visible{outline:1px solid #b18a6d;outline-offset:-1px}
.content-scan-open:disabled{opacity:.5;cursor:wait}
.content-scan-action,.content-scan-close{position:static;display:flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;min-width:32px;height:34px;padding:0;border-radius:5px;color:#8594a7}
.content-scan-action:hover:not(:disabled),.content-scan-close:hover{background:#ffffff08;color:#d5dfe9}
.content-scan-empty{display:flex;align-items:center;justify-content:center;gap:8px;min-height:130px;padding:24px;color:#8492a4;font-size:12px}
.content-scan-error{display:flex;align-items:center;gap:10px;margin:10px 12px;padding:9px 10px;border:1px solid #78505766;border-radius:6px;background:#38282d80;color:#d5a8b0;font-size:11px}
.content-scan-error>span{flex:1;min-width:0;overflow-wrap:anywhere}
.content-scan-truncated{margin:0;padding:8px 14px;border-top:1px solid #333b47;color:#8290a1;font-size:10px}
@media(max-width:600px){.content-scan-action,.content-scan-close{flex-basis:40px;width:40px;min-width:40px;height:44px}.content-scan-open{min-height:50px}.content-scan-pane{padding-inline:6px}}
</style>
