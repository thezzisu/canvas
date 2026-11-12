<script setup lang="ts">
import UIcon from '@nuxt/ui/components/Icon.vue'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UModal from '../CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { Canvas } from '../../api/types'
import type { WindowContentItem, WindowContentScan } from '../../../../shared/window-content'
import { api, apiContext, requireCurrentApi, segment, uuid } from '../../api/api'
import { openScanFile } from '../../utils/terminal/content-scan'
import { publicWebUrl } from '../../utils/terminal/terminal-links'
import { copyText } from '../../utils/clipboard'
import { presentDownload } from '../../composables/files/downloads'
import { filePreview } from '../../utils/files/file-preview'
import FileIcon from '../files/FileIcon.vue'
import { forwardSourceUrl, presentUrl } from '../../composables/terminal/urls'
import { useMobileLayout } from '../../composables/mobile-layout'

type Target = { sourceId: string; spaceId: string; windowId: string; name: string }
type FileItem = Extract<WindowContentItem, { kind: 'file' }>
type FileAction = 'download' | 'preview' | Canvas
const props = defineProps<{ target: Target | null; canvases: Canvas[] }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const touch = useMobileLayout()
const result = shallowRef<{ scan: WindowContentScan; target: Target }>()
const loading = ref(false)
const opening = ref('')
const error = shallowRef<string | Error>('')
const added = ref<string>()
const errorMessage = computed(() =>
  error.value instanceof Error ? error.value.message : error.value ? t(error.value) : '',
)
const panes = computed(
  () =>
    result.value?.scan.panes
      .filter((pane) => pane.items.length)
      .map((pane) => ({
        ...pane,
        items: pane.items.map((item) => ({
          ...item,
          previewable:
            item.kind === 'file' && !!item.path && filePreview({ filename: item.path }) !== 'file',
          displayLabel:
            item.kind === 'file'
              ? item.label.split('/').filter(Boolean).at(-1) || item.label
              : item.label,
          href: item.kind === 'link' ? publicWebUrl(item.url) : undefined,
        })),
      })) || [],
)
let scanRequest: AbortController | undefined
let fileRequest: AbortController | undefined
let retryItem: { item: FileItem; action: FileAction } | undefined

function cancelRequests() {
  scanRequest?.abort()
  scanRequest = undefined
  fileRequest?.abort()
  fileRequest = undefined
  loading.value = false
  opening.value = ''
}
async function scan() {
  const target = props.target
  if (!target) return
  cancelRequests()
  result.value = undefined
  error.value = ''
  retryItem = undefined
  const current = (scanRequest = new AbortController())
  loading.value = true
  try {
    const snapshot = await api<WindowContentScan>(
      `/api/sources/${segment(target.sourceId)}/spaces/${segment(target.spaceId)}/windows/${segment(target.windowId)}/scan`,
      { method: 'POST', body: '{}', signal: current.signal },
    )
    if (scanRequest !== current || current.signal.aborted || props.target !== target) return
    result.value = { scan: snapshot, target }
  } catch (reason) {
    if (scanRequest === current && !current.signal.aborted && props.target === target)
      error.value = reason instanceof Error ? reason : 'panels.scan.failed'
  } finally {
    if (scanRequest === current) {
      scanRequest = undefined
      loading.value = false
    }
  }
}
function close(open = false) {
  if (open) return
  cancelRequests()
  emit('close')
}
async function openFile(item: FileItem, action: FileAction = 'download') {
  const snapshot = result.value
  if (!snapshot || !item.path || opening.value || loading.value || props.target !== snapshot.target)
    return
  const canvas = typeof action === 'string' ? undefined : action
  const context = apiContext()
  const current = (fileRequest = new AbortController())
  opening.value = item.id
  error.value = ''
  retryItem = undefined
  const anchor = canvas?.nodes.find(
    (node) =>
      node.type === 'terminal' &&
      node.sourceId === snapshot.target.sourceId &&
      node.windowId === snapshot.target.windowId,
  )
  const destination = !canvas
    ? {}
    : anchor
      ? { canvasId: canvas.id, anchorId: anchor.id }
      : {
          canvasId: canvas.id,
          position: {
            x: Math.min(
              1e7,
              canvas.nodes.length
                ? Math.max(...canvas.nodes.map((node) => node.x + node.width)) + 24
                : 80,
            ),
            y: 80,
          },
        }
  try {
    const file = await openScanFile(snapshot.scan.id, item.id, destination, context, current.signal)
    if (
      fileRequest !== current ||
      current.signal.aborted ||
      result.value !== snapshot ||
      props.target !== snapshot.target
    )
      return
    if (canvas) added.value = item.id
    else await presentDownload(file, action === 'download')
  } catch (reason) {
    if (!current.signal.aborted && result.value === snapshot && props.target === snapshot.target) {
      error.value = reason instanceof Error ? reason : 'panels.scan.openFailed'
      retryItem = { item, action }
    }
  } finally {
    if (fileRequest === current) {
      fileRequest = undefined
      opening.value = ''
    }
  }
}
function retry() {
  if (retryItem) void openFile(retryItem.item, retryItem.action)
  else void scan()
}
function destinations(item: FileItem): DropdownMenuItem[] {
  return props.canvases.map((canvas) => ({
    label: canvas.name,
    onSelect: () => {
      void openFile(item, canvas)
    },
  }))
}
async function openLink(item: Extract<WindowContentItem, { kind: 'link' }>) {
  const snapshot = result.value,
    context = apiContext()
  if (!snapshot || opening.value || props.target !== snapshot.target) return
  const current = (fileRequest = new AbortController())
  opening.value = item.id
  error.value = ''
  try {
    const opened = await forwardSourceUrl(
      snapshot.target.sourceId,
      item.url,
      context,
      current.signal,
    )
    if (current.signal.aborted || result.value !== snapshot || props.target !== snapshot.target)
      return
    fileRequest = undefined
    opening.value = ''
    emit('close')
    await nextTick()
    requireCurrentApi(context)
    presentUrl({ id: uuid(), ...opened })
  } catch (reason) {
    if (!current.signal.aborted && result.value === snapshot)
      error.value = reason instanceof Error ? reason : 'panels.scan.openFailed'
  } finally {
    if (fileRequest === current) {
      fileRequest = undefined
      opening.value = ''
    }
  }
}
function copy(item: WindowContentItem) {
  void copyText(item.kind === 'link' ? item.url : item.path || item.label)
}
const modalContent = {
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
  onEscapeKeyDown: (event: Event) => event.stopPropagation(),
}
watch(
  () => props.target,
  (target) => {
    cancelRequests()
    result.value = undefined
    error.value = ''
    added.value = undefined
    retryItem = undefined
    if (target) void scan()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  cancelRequests()
})
</script>

<template>
  <UModal
    v-if="target"
    :open="true"
    :transition="false"
    :title="t('panels.scan.title')"
    :description="target.name"
    :content="modalContent"
    :ui="{
      content: 'content-scan-modal [--dialog-width:620px]',
      wrapper: 'min-w-0 flex-1',
      description: 'truncate',
      close: 'static',
      body: 'p-0 sm:p-0',
    }"
    @update:open="close"
  >
    <template #actions
      ><UButton
        color="neutral"
        variant="ghost"
        square
        icon="i-lucide-refresh-cw"
        :disabled="loading || !!opening"
        :aria-label="t('panels.scan.refresh')"
        :title="t('panels.scan.refresh')"
        @click="scan"
    /></template>
    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="errorMessage"
        :actions="[
          {
            label: t('common.retry'),
            color: 'neutral',
            variant: 'outline',
            disabled: loading || !!opening,
            onClick: retry,
          },
        ]"
        role="alert"
        class="m-3 [overflow-wrap:anywhere]"
      />
      <div
        v-if="loading"
        class="flex min-h-32 items-center justify-center gap-2 text-sm text-muted"
        role="status"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="spinner size-3.5 shrink-0 motion-safe:animate-spin"
        />{{ t('common.loading') }}
      </div>
      <section
        v-for="pane in panes"
        :key="pane.id"
        class="content-scan-pane border-default p-2 not-first:border-t"
        :data-scan-pane="pane.id"
      >
        <header class="flex min-w-0 items-center gap-3 px-1.5 pt-1 pb-1.5 text-xs text-muted">
          <strong class="max-w-[45%] flex-none truncate font-medium text-toned">{{
            pane.name || t('terminal.pane', { name: pane.id.split(':').at(-1) || pane.id })
          }}</strong
          ><span v-if="pane.cwd" class="content-scan-mono min-w-0 truncate" :title="pane.cwd">{{
            pane.cwd
          }}</span>
        </header>
        <div
          v-for="item in pane.items"
          :key="item.id"
          class="content-scan-item grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-0.5"
          :data-scan-item="item.id"
          :data-item-kind="item.kind"
          :aria-busy="opening === item.id"
        >
          <div
            v-if="item.kind === 'file'"
            class="flex min-w-0 items-center gap-2 px-2 py-1.5"
            :title="item.path || item.label"
          >
            <UIcon
              v-if="opening === item.id"
              name="i-lucide-loader-circle"
              class="size-4 shrink-0 motion-safe:animate-spin"
            /><FileIcon v-else class="shrink-0" :name="item.displayLabel" :size="16" />
            <span class="min-w-0 flex-1"
              ><span class="content-scan-mono block truncate text-sm text-highlighted">{{
                item.displayLabel
              }}</span
              ><span
                v-if="item.path !== item.displayLabel"
                class="block truncate text-xs text-muted"
                >{{ item.path || t('panels.scan.unresolved') }}</span
              ></span
            >
          </div>
          <UButton
            v-else
            color="neutral"
            variant="ghost"
            icon="i-lucide-globe"
            class="content-scan-open min-w-0 justify-start gap-2 px-2 text-left font-normal"
            :href="item.href"
            :target="item.href ? '_blank' : undefined"
            :rel="item.href ? 'noopener noreferrer' : undefined"
            :loading="opening === item.id"
            :disabled="!item.href && !!opening"
            :title="item.url"
            @click="item.href ? undefined : openLink(item)"
          >
            <span class="min-w-0 flex-1"
              ><span class="content-scan-mono block truncate text-sm text-highlighted">{{
                item.href ? item.label : item.displayLabel
              }}</span
              ><span
                v-if="!item.href || item.url !== item.label"
                class="block truncate text-xs text-muted"
                >{{ item.href ? item.url : t('urls.open') }}</span
              ></span
            >
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            square
            icon="i-lucide-copy"
            :size="touch ? 'xl' : 'md'"
            :class="touch ? 'min-h-[44px] min-w-[44px] justify-center' : ''"
            :aria-label="t(item.kind === 'file' ? 'panels.scan.copyPath' : 'panels.scan.copyLink')"
            :title="t(item.kind === 'file' ? 'panels.scan.copyPath' : 'panels.scan.copyLink')"
            @click="copy(item)"
          />
          <div
            v-if="item.kind === 'file' && item.path"
            class="col-span-full flex flex-wrap gap-1 pb-1.5 ps-7"
          >
            <UButton
              v-if="item.previewable"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-eye"
              :label="t('panels.scan.preview')"
              :disabled="!!opening"
              @click="openFile(item, 'preview')"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-download"
              :label="t('panels.file.download')"
              :disabled="!!opening"
              @click="openFile(item)"
            />
            <UDropdownMenu
              :items="destinations(item)"
              :content="{ side: 'bottom', align: 'start' }"
              :ui="{ content: 'max-w-[280px]' }"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                :icon="added === item.id ? 'i-lucide-check' : 'i-lucide-plus'"
                trailing-icon="i-lucide-chevron-down"
                :label="t(added === item.id ? 'panels.scan.added' : 'panels.scan.addNote')"
                :disabled="!!opening || !canvases.length"
              />
            </UDropdownMenu>
          </div>
        </div>
      </section>
      <p
        v-if="result?.scan.truncated"
        class="m-0 border-t border-default px-3.5 py-2 text-xs text-muted"
      >
        {{ t('panels.scan.truncated') }}
      </p>
      <p
        v-if="result?.scan.incomplete"
        class="m-0 border-t border-default px-3.5 py-2 text-xs text-muted"
      >
        {{ t('panels.scan.incomplete') }}
      </p>
      <span class="sr-only" role="status">{{ opening ? t('panels.scan.staging') : '' }}</span>
    </template>
  </UModal>
</template>

<style scoped>
.content-scan-mono {
  font-family: var(--content-font-family, monospace);
}
</style>
