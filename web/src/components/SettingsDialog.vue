<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import type { ContentFontSettings, GlobalSettings } from '../../../shared/settings'
import { FONT_CATALOG, buildFontPresentation, ensureContentFont } from '../fonts'
import { write } from '../api'
import Icon from './Icon.vue'

const props = defineProps<{ settings: GlobalSettings; portal?: HTMLElement }>()
const emit = defineEmits<{ close: []; saved: [settings: GlobalSettings] }>()
const clone = (value: ContentFontSettings): ContentFontSettings => ({ ...value, stack: value.stack.map(entry => ({ ...entry })) })
const normalized = (value: ContentFontSettings): ContentFontSettings => ({
  stack: value.stack.map(entry => ({ family: entry.family.trim() })),
  ligatures: value.ligatures,
})
const draft = reactive(clone(props.settings.contentFont))
const original = JSON.stringify(normalized(props.settings.contentFont))
const families = [...FONT_CATALOG.map(font => font.family), 'monospace']
const entryIds = ref(draft.stack.map((_, index) => index))
let nextEntryId = entryIds.value.length
const saving = ref(false)
const loading = ref(false)
const error = ref('')
const fontError = ref('')
const preview = ref<{ family: string; features: string }>()
let previewRevision = 0
let disposed = false
let previewTimer: ReturnType<typeof setTimeout> | undefined
const config = computed(() => normalized(draft))
const changed = computed(() => JSON.stringify(config.value) !== original)
const invalid = computed(() => !draft.stack.length || draft.stack.some(entry => !entry.family.trim()))
const previewStyle = computed(() => preview.value ? { fontFamily: preview.value.family, fontFeatureSettings: preview.value.features } : {})
const previewText = '中文对齐  ABCD  012345\n天地玄黄  ABCD  012345\nconst x = a !== b && c => d;\n\ue0b0 \ue0b2 \uf07c  ~/canvas'

async function loadPreview(value: ContentFontSettings, revision: number) {
  try {
    await ensureContentFont(value)
    if (disposed || revision !== previewRevision) return
    preview.value = buildFontPresentation(value)
  } catch (reason) {
    if (!disposed && revision === previewRevision) fontError.value = reason instanceof Error ? reason.message : '字体加载失败'
  } finally { if (!disposed && revision === previewRevision) loading.value = false }
}
function retryPreview() {
  clearTimeout(previewTimer)
  fontError.value = ''; loading.value = true
  void loadPreview(clone(config.value), ++previewRevision)
}
watch(config, value => {
  const revision = ++previewRevision
  clearTimeout(previewTimer)
  fontError.value = ''
  if (invalid.value) { loading.value = false; return }
  loading.value = true
  previewTimer = setTimeout(() => { void loadPreview(clone(value), revision) }, 180)
}, { immediate: true })
function setFamily(index: number, family: string) {
  const entry = draft.stack[index]
  if (!entry || saving.value) return
  entry.family = family
}
function addFont() {
  if (saving.value || draft.stack.length >= 12) return
  draft.stack.push({ family: '' })
  entryIds.value.push(nextEntryId++)
}
function moveFont(index: number, direction: number) {
  const next = index + direction
  if (saving.value || next < 0 || next >= draft.stack.length) return
  const [value] = draft.stack.splice(index, 1)
  const [id] = entryIds.value.splice(index, 1)
  draft.stack.splice(next, 0, value!)
  entryIds.value.splice(next, 0, id!)
}
function removeFont(index: number) {
  if (saving.value || draft.stack.length === 1) return
  draft.stack.splice(index, 1)
  entryIds.value.splice(index, 1)
}
function close(open = false) { if (!open && !saving.value) emit('close') }
async function save() {
  if (saving.value || loading.value || invalid.value || !changed.value || fontError.value) return
  saving.value = true; error.value = ''
  try {
    const value = clone(config.value)
    await ensureContentFont(value)
    const settings = await write<GlobalSettings>('/api/settings', 'PATCH', { contentFont: value })
    emit('saved', settings)
    emit('close')
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
onBeforeUnmount(() => { disposed = true; previewRevision++; clearTimeout(previewTimer) })
</script>

<template>
  <UModal :open="true" title="设置" :portal="portal || false" :dismissible="!saving" :close="{ 'aria-label': '关闭设置', disabled: saving }"
    :ui="{ content: 'settings-modal', overlay: 'settings-overlay', header: 'settings-header', body: 'settings-body', footer: 'settings-footer', title: 'settings-title', close: 'settings-close' }" @update:open="close">
    <template #body>
      <form id="content-font-form" class="font-settings" @submit.prevent="save">
        <div class="font-stack-heading"><span>内容字体</span><UButton type="button" color="neutral" variant="ghost" size="xs" class="font-add" :disabled="saving || draft.stack.length >= 12" aria-label="添加字体" @click="addFont"><Icon name="plus" :size="13" />添加</UButton></div>
        <ol class="font-stack" aria-label="字体顺序">
          <li v-for="(entry, index) in draft.stack" :key="entryIds[index]" class="font-stack-entry">
            <div class="font-stack-row">
              <span class="font-order" :title="index === 0 ? '主字体' : '回退字体'">{{ index + 1 }}</span>
              <UInputMenu :model-value="entry.family" mode="autocomplete" :items="families" :portal="portal || false" :disabled="saving" :open-on-focus="false" size="sm" class="font-family-input" :aria-label="`字体 ${index + 1}`" :title="entry.family" placeholder="选择或输入字体名称" :maxlength="100"
                :ui="{ content: 'font-select-menu', item: 'font-select-item', viewport: 'font-select-viewport', trailing: 'font-family-trailing' }" @update:model-value="setFamily(index, $event)"><template #empty><span class="font-local-hint">使用本机字体</span></template></UInputMenu>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="saving || index === 0" :aria-label="`上移字体 ${index + 1}`" @click="moveFont(index, -1)"><Icon name="down" :size="13" class="font-up" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="saving || index === draft.stack.length - 1" :aria-label="`下移字体 ${index + 1}`" @click="moveFont(index, 1)"><Icon name="down" :size="13" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="saving || draft.stack.length === 1" :aria-label="`删除字体 ${index + 1}`" @click="removeFont(index)"><Icon name="close" :size="13" /></UButton>
            </div>
          </li>
        </ol>
        <div class="font-options"><USwitch v-model="draft.ligatures" :disabled="saving" label="连字" aria-label="连字" size="sm" class="font-switch" /><span class="font-stack-hint">从上到下依次回退</span></div>
        <div class="font-preview-wrap">
          <div class="font-preview-heading"><span>预览</span><span v-if="loading" class="font-loading" role="status"><span class="spinner" />加载字体</span></div>
          <pre class="font-preview" :style="previewStyle" :aria-busy="loading" aria-label="字体预览">{{ previewText }}</pre>
        </div>
        <div v-if="fontError || error" class="font-error" role="alert"><span>{{ fontError || error }}</span><UButton v-if="fontError" type="button" color="neutral" variant="link" size="xs" aria-label="重新加载字体" @click="retryPreview">重试</UButton></div>
      </form>
    </template>
    <template #footer><UButton color="neutral" variant="outline" class="font-cancel" :disabled="saving" @click="close()">取消</UButton><UButton type="submit" form="content-font-form" class="font-save" :disabled="saving || loading || invalid || !changed || !!fontError"><span v-if="saving" class="spinner" />{{ saving ? '保存中…' : '保存' }}</UButton></template>
  </UModal>
</template>
