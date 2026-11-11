import { computed, reactive, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ContentFontSettings, GlobalSettings } from '../../../shared/settings'
import {
  FONT_CATALOG,
  buildFontPresentation,
  ensureContentFont,
  measureTerminalCell,
} from './fonts'
import { api, apiContext, requireCurrentApi } from '../api/api'

/**
 * Content font draft owned by the settings dialog, which stays mounted while closed:
 * leaving the font editor or the dialog settles pending work instead of abandoning it.
 */
export function useContentFontEditor(
  settings: () => GlobalSettings,
  open: Ref<boolean> | (() => boolean),
  events: { saved(settings: GlobalSettings): void; error(message: string): void },
) {
  const { t } = useI18n()
  const props = {
    get settings() {
      return settings()
    },
    get open() {
      return typeof open === 'function' ? open() : open.value
    },
  }
  const clone = (value: ContentFontSettings): ContentFontSettings => ({
    ...value,
    stack: value.stack.map((entry) => ({ ...entry })),
  })
  const normalized = (value: ContentFontSettings): ContentFontSettings => ({
    stack: value.stack.map((entry) => ({ family: entry.family.trim() })),
    ligatures: value.ligatures,
  })
  const draft = reactive(clone(props.settings.contentFont))
  const signature = (value: ContentFontSettings) => JSON.stringify(normalized(value))
  const persisted = ref(clone(props.settings.contentFont))
  const families = [...FONT_CATALOG.map((font) => font.family), 'monospace']
  const entryIds = ref(draft.stack.map((_, index) => index))
  let nextEntryId = entryIds.value.length
  const saving = ref(false)
  const loading = ref(false)
  const fontError = ref<string | Error>('')
  const fontErrorMessage = computed(() =>
    fontError.value instanceof Error
      ? fontError.value.message
      : fontError.value
        ? t(fontError.value)
        : '',
  )
  const preview = ref<{ family: string; features: string }>()
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()
  const config = computed(() => normalized(draft))
  const invalid = computed(
    () => !draft.stack.length || draft.stack.some((entry) => !entry.family.trim()),
  )
  const canReload = computed(
    () => !loading.value && !saving.value && signature(config.value) === signature(persisted.value),
  )
  const previewStyle = computed(() =>
    preview.value
      ? { fontFamily: preview.value.family, fontFeatureSettings: preview.value.features }
      : {},
  )
  const previewText =
    '中文对齐  ABCD  012345\n天地玄黄  ABCD  012345\nconst x = a !== b && c => d;\n\ue0b0 \ue0b2 \uf07c  ~/canvas'

  function setDraft(value: ContentFontSettings) {
    if (signature(config.value) === signature(value)) return
    const remaining = draft.stack.map((entry, index) => ({ entry, id: entryIds.value[index]! }))
    const entries = value.stack.map((entry) => {
      const index = remaining.findIndex(
        (item) => item.entry.family.trim().toLowerCase() === entry.family.trim().toLowerCase(),
      )
      const existing = index < 0 ? undefined : remaining.splice(index, 1)[0]
      if (!existing) return { entry: { ...entry }, id: nextEntryId++ }
      existing.entry.family = entry.family
      return existing
    })
    draft.stack = entries.map((item) => item.entry)
    draft.ligatures = value.ligatures
    entryIds.value = entries.map((item) => item.id)
  }
  function failed(reason: unknown, current: number, changed: boolean) {
    if (disposed || current !== revision) return
    fontError.value = reason instanceof Error ? reason : 'settings.fontFailed'
    if (!props.open && changed) events.error(fontErrorMessage.value)
  }
  async function saveFont(value: ContentFontSettings, current: number) {
    if (disposed || current !== revision || signature(value) === signature(persisted.value)) return
    const context = apiContext()
    saving.value = true
    try {
      const terminalCell = await measureTerminalCell(value)
      if (disposed || current !== revision) return
      requireCurrentApi(context)
      const settings = await api<GlobalSettings>(
        '/api/settings',
        { method: 'PATCH', body: JSON.stringify({ contentFont: value, terminalCell }) },
        context,
      )
      if (disposed) return
      persisted.value = clone(settings.contentFont)
      if (current === revision) setDraft(settings.contentFont)
      events.saved(settings)
    } catch (reason) {
      failed(reason, current, true)
    } finally {
      saving.value = false
    }
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
    } catch (reason) {
      failed(reason, current, signature(value) !== signature(persisted.value))
    } finally {
      if (!disposed && current === revision) loading.value = false
    }
  }
  function scheduleFont(value: ContentFontSettings) {
    const current = ++revision
    clearTimeout(timer)
    fontError.value = ''
    if (invalid.value) {
      loading.value = false
      return
    }
    loading.value = true
    timer = setTimeout(() => {
      timer = undefined
      void applyFont(clone(value), current)
    }, 180)
  }
  function retryPreview() {
    scheduleFont(config.value)
  }
  watch(config, scheduleFont, { immediate: true })
  watch(
    () => props.settings.contentFont,
    (value) => {
      const pristine = signature(config.value) === signature(persisted.value)
      persisted.value = clone(value)
      if (pristine && !saving.value) setDraft(value)
    },
  )
  function setFamily(index: number, family: string) {
    const entry = draft.stack[index]
    if (entry) entry.family = family
  }
  function setLigatures(value: boolean) {
    draft.ligatures = value
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
  function dispose() {
    disposed = true
    revision++
    clearTimeout(timer)
  }
  // One reactive view so templates read refs without unwrapping by hand.
  return reactive({
    draft,
    entryIds,
    families,
    saving,
    loading,
    fontError,
    fontErrorMessage,
    previewStyle,
    previewText,
    canReload,
    setFamily,
    setLigatures,
    addFont,
    moveFont,
    removeFont,
    retryPreview,
    settle,
    dispose,
  })
}
