<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import type { ContentFontSettings, GlobalSettings } from '../../../shared/settings'
import { FONT_CATALOG, buildFontPresentation, ensureContentFont, measureTerminalCell } from '../fonts'
import { api, apiContext, requireCurrentApi } from '../api'
import Icon from './Icon.vue'

// The content font editor applies changes live; leaving it settles pending work.
const { t, n } = useI18n()
const props = defineProps<{ settings: GlobalSettings; open: boolean }>()
const emit = defineEmits<{ saved: [settings: GlobalSettings]; error: [message: string]; busy: [value: boolean] }>()
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
const fontError = ref<string | Error>('')
const fontErrorMessage = computed(() => fontError.value instanceof Error ? fontError.value.message : fontError.value ? t(fontError.value) : '')
const preview = ref<{ family: string; features: string }>()
let revision = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let writes: Promise<void> = Promise.resolve()
const config = computed(() => normalized(draft))
const invalid = computed(() => !draft.stack.length || draft.stack.some(entry => !entry.family.trim()))
const canReload = computed(() => !loading.value && !saving.value && signature(config.value) === signature(persisted.value))
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
  fontError.value = reason instanceof Error ? reason : 'settings.fontFailed'
  if (!props.open && changed) emit('error', fontErrorMessage.value)
}
async function saveFont(value: ContentFontSettings, current: number) {
  if (disposed || current !== revision || signature(value) === signature(persisted.value)) return
  const context = apiContext()
  saving.value = true
  try {
    const terminalCell = await measureTerminalCell(value)
    if (disposed || current !== revision) return
    requireCurrentApi(context)
    const settings = await api<GlobalSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify({ contentFont: value, terminalCell }) }, context)
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
    await ensureContentFont(value, () => {
      if (!disposed && current === revision) preview.value = buildFontPresentation(value)
    })
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
watch(canReload, value => emit('busy', !value), { immediate: true })
/** Leaving the editor restores an invalid draft or applies a pending change. */
function settle() {
  if (invalid.value) {
    clearTimeout(timer)
    timer = undefined
    setDraft(persisted.value)
  } else if (timer) {
    clearTimeout(timer)
    timer = undefined
    void applyFont(clone(config.value), revision)
  }
}
onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer) })
defineExpose({ settle })
</script>

<template>
  <form class="font-settings" @submit.prevent>
    <div class="font-stack-heading"><span>{{ t('settings.contentFont') }}</span><UButton type="button" color="neutral" variant="ghost" size="xs" class="font-add" :disabled="draft.stack.length >= 12" :aria-label="t('settings.addFont')" @click="addFont"><Icon name="plus" :size="13" /> {{ t('settings.add') }}</UButton></div>
    <ol class="font-stack" :aria-label="t('settings.fontOrder')">
      <li v-for="(entry, index) in draft.stack" :key="entryIds[index]" class="font-stack-entry">
        <div class="font-stack-row">
          <span class="font-order" :title="t(index === 0 ? 'settings.primaryFont' : 'settings.fallbackFont')">{{ n(index + 1) }}</span>
          <UInputMenu :model-value="entry.family" mode="autocomplete" :items="families" :open-on-focus="false" size="sm" class="font-family-input" :aria-label="t('settings.font', { index: n(index + 1) })" :title="entry.family" :placeholder="t('settings.fontPlaceholder')" :maxlength="100"
            :ui="{ content: 'font-select-menu', item: 'font-select-item', viewport: 'font-select-viewport', trailing: 'font-family-trailing' }" @update:model-value="setFamily(index, $event)"><template #empty><span class="font-local-hint">{{ t('settings.localFont') }}</span></template></UInputMenu>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === 0" :aria-label="t('settings.moveFontUp', { index: n(index + 1) })" @click="moveFont(index, -1)"><Icon name="down" :size="13" class="font-up" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === draft.stack.length - 1" :aria-label="t('settings.moveFontDown', { index: n(index + 1) })" @click="moveFont(index, 1)"><Icon name="down" :size="13" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="draft.stack.length === 1" :aria-label="t('settings.deleteFont', { index: n(index + 1) })" @click="removeFont(index)"><Icon name="close" :size="13" /></UButton>
        </div>
      </li>
    </ol>
    <div class="font-options"><USwitch v-model="draft.ligatures" :label="t('settings.ligatures')" :aria-label="t('settings.ligatures')" size="sm" /><span class="font-stack-hint">{{ t('settings.fallbackOrder') }}</span></div>
    <div class="font-preview-wrap">
      <div class="font-preview-heading"><span>{{ t('settings.preview') }}</span><span v-if="loading || saving" class="font-loading" role="status"><span class="spinner" />{{ t(saving ? 'settings.applying' : 'settings.loadingFont') }}</span></div>
      <pre class="font-preview" :style="previewStyle" :aria-busy="loading" :aria-label="t('settings.fontPreview')">{{ previewText }}</pre>
    </div>
    <div v-if="fontError" class="font-error" role="alert"><span>{{ fontErrorMessage }}</span><UButton type="button" color="neutral" variant="link" size="xs" :aria-label="t('settings.retryFont')" @click="retryPreview">{{ t('common.retry') }}</UButton></div>
  </form>
</template>
