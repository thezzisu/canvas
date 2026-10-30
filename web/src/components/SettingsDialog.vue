<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import type { ContentFontSettings, GlobalSettings } from '../../../shared/settings'
import { FONT_CATALOG, buildFontPresentation, ensureContentFont } from '../fonts'
import { write } from '../api'
import { useMobileLayout } from '../mobile-layout'
import { cutoutPosition, cutoutWidth, type CutoutPosition } from '../display-cutout'
import { developerMode, viewportFit, interactiveWidget } from '../developer-mode'
import { keepScreenAwake, retryScreenWakeLock, screenWakeLockState, screenWakeLockUnavailable } from '../screen-wake-lock'
import Icon from './Icon.vue'

const props = defineProps<{ open: boolean; settings: GlobalSettings; portal?: HTMLElement; hasDisplayCutout?: boolean }>()
const emit = defineEmits<{ close: []; saved: [settings: GlobalSettings]; error: [message: string] }>()
const mobile = useMobileLayout()
const viewportFits = [
  { value: 'cover', label: 'cover · 延伸至边缘（默认）' },
  { value: 'contain', label: 'contain · 保留安全区' },
]
const interactiveWidgets = [
  { value: 'resizes-content', label: 'resizes-content · 整页缩小（默认）' },
  { value: 'resizes-visual', label: 'resizes-visual · 仅可视区域缩小' },
]
const viewportSelectUi = { content: 'settings-select-menu', item: 'settings-select-item' }
const cutoutPositions: Array<{ value: CutoutPosition; label: string }> = [
  { value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' },
]
const cutoutMaximum = computed(() => Math.max(0, Math.min(240, Math.min(window.screen.width, window.screen.height) - (cutoutPosition.value === 'center' ? 264 : 220))))
const displayedCutoutWidth = computed({
  get: () => Math.min(cutoutWidth.value, cutoutMaximum.value),
  set: (width: number) => { cutoutWidth.value = width },
})
const clone = (value: ContentFontSettings): ContentFontSettings => ({ ...value, stack: value.stack.map(entry => ({ ...entry })) })
const normalized = (value: ContentFontSettings): ContentFontSettings => ({
  stack: value.stack.map(entry => ({ family: entry.family.trim() })),
  ligatures: value.ligatures,
})
const draft = reactive(clone(props.settings.contentFont))
const signature = (value: ContentFontSettings) => JSON.stringify(normalized(value))
const persisted = ref(clone(props.settings.contentFont))
const families = [...FONT_CATALOG.map(font => font.family), 'monospace']
const entryIds = ref(draft.stack.map((_, index) => index))
let nextEntryId = entryIds.value.length
const saving = ref(false)
const loading = ref(false)
const fontError = ref('')
const preview = ref<{ family: string; features: string }>()
let revision = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let writes: Promise<void> = Promise.resolve()
const config = computed(() => normalized(draft))
const invalid = computed(() => !draft.stack.length || draft.stack.some(entry => !entry.family.trim()))
const canReload = computed(() => !loading.value && !saving.value && signature(config.value) === signature(persisted.value))
function reloadPage() { if (canReload.value) window.location.reload() }
const previewStyle = computed(() => preview.value ? { fontFamily: preview.value.family, fontFeatureSettings: preview.value.features } : {})
const previewText = '中文对齐  ABCD  012345\n天地玄黄  ABCD  012345\nconst x = a !== b && c => d;\n\ue0b0 \ue0b2 \uf07c  ~/canvas'

function setDraft(value: ContentFontSettings) {
  if (signature(config.value) === signature(value)) return
  const remaining = draft.stack.map((entry, index) => ({ entry, id: entryIds.value[index]! }))
  const entries = value.stack.map(entry => {
    const index = remaining.findIndex(item => item.entry.family.trim().toLowerCase() === entry.family.trim().toLowerCase())
    const existing = index < 0 ? undefined : remaining.splice(index, 1)[0]
    if (!existing) return { entry: { ...entry }, id: nextEntryId++ }
    existing.entry.family = entry.family
    return existing
  })
  draft.stack = entries.map(item => item.entry)
  draft.ligatures = value.ligatures
  entryIds.value = entries.map(item => item.id)
}
function failed(reason: unknown, current: number, changed: boolean) {
  if (disposed || current !== revision) return
  fontError.value = reason instanceof Error ? reason.message : '字体设置失败'
  if (!props.open && changed) emit('error', fontError.value)
}
async function saveFont(value: ContentFontSettings, current: number) {
  if (disposed || current !== revision || signature(value) === signature(persisted.value)) return
  saving.value = true
  try {
    const settings = await write<GlobalSettings>('/api/settings', 'PATCH', { contentFont: value })
    if (disposed) return
    persisted.value = clone(settings.contentFont)
    if (current === revision) setDraft(settings.contentFont)
    emit('saved', settings)
  } catch (reason) { failed(reason, current, true) }
  finally { saving.value = false }
}
async function applyFont(value: ContentFontSettings, current: number) {
  if (disposed || current !== revision || invalid.value) return
  try {
    await ensureContentFont(value)
    if (disposed || current !== revision) return
    preview.value = buildFontPresentation(value)
    writes = writes.then(() => saveFont(value, current))
  } catch (reason) { failed(reason, current, signature(value) !== signature(persisted.value)) }
  finally { if (!disposed && current === revision) loading.value = false }
}
function scheduleFont(value: ContentFontSettings) {
  const current = ++revision
  clearTimeout(timer)
  fontError.value = ''
  if (invalid.value) { loading.value = false; return }
  loading.value = true
  timer = setTimeout(() => {
    timer = undefined
    void applyFont(clone(value), current)
  }, 180)
}
function retryPreview() { scheduleFont(config.value) }
watch(config, scheduleFont, { immediate: true })
watch(() => props.settings.contentFont, value => {
  const pristine = signature(config.value) === signature(persisted.value)
  persisted.value = clone(value)
  if (pristine && !saving.value) setDraft(value)
})
function setFamily(index: number, family: string) {
  const entry = draft.stack[index]
  if (entry) entry.family = family
}
function addFont() {
  if (draft.stack.length >= 12) return
  draft.stack.push({ family: '' })
  entryIds.value.push(nextEntryId++)
}
function moveFont(index: number, direction: number) {
  const next = index + direction
  if (next < 0 || next >= draft.stack.length) return
  const [value] = draft.stack.splice(index, 1)
  const [id] = entryIds.value.splice(index, 1)
  draft.stack.splice(next, 0, value!)
  entryIds.value.splice(next, 0, id!)
}
function removeFont(index: number) {
  if (draft.stack.length === 1) return
  draft.stack.splice(index, 1)
  entryIds.value.splice(index, 1)
}
function close(open = false) {
  if (open) return
  if (invalid.value) {
    clearTimeout(timer)
    timer = undefined
    setDraft(persisted.value)
  } else if (timer) {
    clearTimeout(timer)
    timer = undefined
    void applyFont(clone(config.value), revision)
  }
  emit('close')
}
onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer) })
</script>

<template>
  <UModal :open="open" title="设置" :portal="portal || false" :close="{ 'aria-label': '关闭设置' }"
    :ui="{ content: 'settings-modal', overlay: 'settings-overlay', header: 'settings-header', body: 'settings-body', footer: 'settings-footer', title: 'settings-title', close: 'settings-close' }" @update:open="close">
    <template #body>
      <section v-if="mobile && hasDisplayCutout" class="cutout-settings" aria-label="顶部避让">
        <div class="cutout-heading"><span>顶部避让</span><small>仅此浏览器</small></div>
        <div class="cutout-row"><span id="cutout-position-label">位置</span><div class="cutout-positions" role="group" aria-labelledby="cutout-position-label"><UButton v-for="position in cutoutPositions" :key="position.value" type="button" color="neutral" :variant="cutoutPosition === position.value ? 'solid' : 'outline'" :aria-pressed="cutoutPosition === position.value" @click="cutoutPosition = position.value">{{ position.label }}</UButton></div></div>
        <div class="cutout-width-label"><label for="cutout-width">宽度</label><output for="cutout-width">{{ displayedCutoutWidth }} px</output></div>
        <input id="cutout-width" v-model.number="displayedCutoutWidth" class="cutout-width" type="range" min="0" :max="cutoutMaximum" step="1" :aria-valuetext="`${displayedCutoutWidth} px`" />
      </section>
      <form class="font-settings" @submit.prevent>
        <div class="font-stack-heading"><span>内容字体</span><UButton type="button" color="neutral" variant="ghost" size="xs" class="font-add" :disabled="draft.stack.length >= 12" aria-label="添加字体" @click="addFont"><Icon name="plus" :size="13" />添加</UButton></div>
        <ol class="font-stack" aria-label="字体顺序">
          <li v-for="(entry, index) in draft.stack" :key="entryIds[index]" class="font-stack-entry">
            <div class="font-stack-row">
              <span class="font-order" :title="index === 0 ? '主字体' : '回退字体'">{{ index + 1 }}</span>
              <UInputMenu :model-value="entry.family" mode="autocomplete" :items="families" :portal="portal || false" :open-on-focus="false" size="sm" class="font-family-input" :aria-label="`字体 ${index + 1}`" :title="entry.family" placeholder="选择或输入字体名称" :maxlength="100"
                :ui="{ content: 'font-select-menu', item: 'font-select-item', viewport: 'font-select-viewport', trailing: 'font-family-trailing' }" @update:model-value="setFamily(index, $event)"><template #empty><span class="font-local-hint">使用本机字体</span></template></UInputMenu>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === 0" :aria-label="`上移字体 ${index + 1}`" @click="moveFont(index, -1)"><Icon name="down" :size="13" class="font-up" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === draft.stack.length - 1" :aria-label="`下移字体 ${index + 1}`" @click="moveFont(index, 1)"><Icon name="down" :size="13" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="draft.stack.length === 1" :aria-label="`删除字体 ${index + 1}`" @click="removeFont(index)"><Icon name="close" :size="13" /></UButton>
            </div>
          </li>
        </ol>
        <div class="font-options"><USwitch v-model="draft.ligatures" label="连字" aria-label="连字" size="sm" class="settings-switch" /><span class="font-stack-hint">从上到下依次回退</span></div>
        <div class="font-preview-wrap">
          <div class="font-preview-heading"><span>预览</span><span v-if="loading || saving" class="font-loading" role="status"><span class="spinner" />{{ saving ? '应用中…' : '加载字体' }}</span></div>
          <pre class="font-preview" :style="previewStyle" :aria-busy="loading" aria-label="字体预览">{{ previewText }}</pre>
        </div>
        <div v-if="fontError" class="font-error" role="alert"><span>{{ fontError }}</span><UButton type="button" color="neutral" variant="link" size="xs" aria-label="重试字体设置" @click="retryPreview">重试</UButton></div>
      </form>
      <div class="wake-lock-setting">
        <USwitch :model-value="!screenWakeLockUnavailable && keepScreenAwake" :disabled="!!screenWakeLockUnavailable" label="保持屏幕常亮" aria-label="保持屏幕常亮" size="sm" class="settings-switch" @update:model-value="keepScreenAwake = $event" />
        <small v-if="screenWakeLockUnavailable">{{ screenWakeLockUnavailable }}</small>
        <template v-else-if="keepScreenAwake">
          <small v-if="screenWakeLockState === 'active'" role="status">已开启</small>
          <small v-else-if="screenWakeLockState === 'pending'" role="status">请求中…</small>
          <template v-else-if="screenWakeLockState === 'denied' || screenWakeLockState === 'released'"><small role="status">{{ screenWakeLockState === 'denied' ? '未能保持常亮' : '常亮已暂停' }}</small><UButton type="button" color="neutral" variant="link" size="xs" aria-label="重试常亮" @click="retryScreenWakeLock">重试</UButton></template>
        </template>
      </div>
      <div class="developer-setting">
        <USwitch v-model="developerMode" label="开发者模式" aria-label="开发者模式" size="sm" class="settings-switch" />
        <section v-if="developerMode" class="viewport-experiments" aria-label="视口测试">
          <div class="viewport-experiment-heading"><span>视口测试</span><small>仅此浏览器</small></div>
          <div class="viewport-experiment-field">
            <label for="viewport-fit">屏幕边缘 <code>viewport-fit</code></label>
            <USelect id="viewport-fit" v-model="viewportFit" :items="viewportFits" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" aria-label="屏幕边缘" />
          </div>
          <div class="viewport-experiment-field">
            <label for="interactive-widget">键盘视口 <code>interactive-widget</code></label>
            <USelect id="interactive-widget" v-model="interactiveWidget" :items="interactiveWidgets" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" aria-label="键盘视口" />
          </div>
          <p class="viewport-experiment-hint">立即设置；关闭开发者模式恢复默认。对比测试前可重新加载，再进入全屏并打开键盘。</p>
          <UButton type="button" color="neutral" variant="outline" size="sm" class="viewport-reload" :disabled="!canReload" :title="canReload ? undefined : '先完成字体设置'" @click="reloadPage">重新加载页面</UButton>
        </section>
      </div>
    </template>
    <template #footer><UButton color="neutral" variant="outline" class="font-done" @click="close()">完成</UButton></template>
  </UModal>
</template>

<style scoped>
.font-done{height:32px;min-width:62px;padding:0 12px;border:1px solid #485262;border-radius:6px;font-size:11px;font-weight:500;color:#c3cdd9;background:#2a323e}
.font-done:hover{background:#343e4b}
.mobile-layout .font-done{height:40px}
.cutout-settings{container-type:inline-size;display:grid;gap:12px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #343b46}
.cutout-heading,.cutout-row,.cutout-width-label{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#c4cbd6;font-size:12px}
.cutout-heading{font-weight:500}
.cutout-heading small{font-size:11px;font-weight:400;color:#8793a4}
.cutout-positions{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;width:164px}
.cutout-positions button{min-height:44px;justify-content:center}
.cutout-width-label output{color:#929fb0;font-variant-numeric:tabular-nums}
.cutout-width{display:block;width:100%;height:28px;margin:0;accent-color:var(--accent);cursor:pointer}
.developer-setting{margin-top:18px;padding-top:16px;border-top:1px solid #343b46}
.wake-lock-setting{display:flex;align-items:center;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid #343b46}
.wake-lock-setting>small{margin-left:auto;color:#8793a4;font-size:11px}
.wake-lock-setting+.developer-setting{margin-top:14px;padding-top:0;border-top:0}
.viewport-experiments{display:grid;gap:12px;margin-top:10px;padding:14px 0 0;border-top:1px solid #343b46}
.viewport-experiment-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#c4cbd6;font-size:12px;font-weight:500}
.viewport-experiment-heading small,.viewport-experiment-field code{font-size:11px;font-weight:400;color:#8793a4}
.viewport-experiment-field{display:grid;gap:7px;min-width:0}
.viewport-experiment-field label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;font-size:11px}
.viewport-experiment-hint{font-size:11px;line-height:1.7;color:#8793a4}
.viewport-reload{justify-self:start;min-height:34px;padding:0 10px;border:1px solid #485262;border-radius:6px;font-size:11px;color:#c3cdd9;background:#2a323e}
.viewport-reload:hover{background:#343e4b}
.mobile-layout .viewport-reload{min-height:44px}
</style>
