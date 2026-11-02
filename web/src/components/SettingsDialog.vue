<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import USlider from '@nuxt/ui/components/Slider.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import type { ContentFontSettings, GlobalSettings } from '../../../shared/settings'
import { FONT_CATALOG, buildFontPresentation, ensureContentFont } from '../fonts'
import { write } from '../api'
import { inputMode, useMobileLayout } from '../mobile-layout'
import { uiScale, uiZoom } from '../ui-scale'
import { cutoutPosition, cutoutWidth, type CutoutPosition } from '../display-cutout'
import { developerMode, viewportFit, interactiveWidget, viewportReloadRequired } from '../developer-mode'
import { keepScreenAwake, retryScreenWakeLock, screenWakeLockState, screenWakeLockUnavailable } from '../screen-wake-lock'
import { notificationSoundEnabled, notificationSystemEnabled, notificationSoundSupported, systemNotificationSupported,
  systemNotificationPermission, systemNotificationRequesting, notificationSettingsError, setNotificationSound,
  setSystemNotifications, refreshNotificationPermission, testNotificationSound, testSystemNotification } from '../notification-settings'
import Icon from './Icon.vue'
import LanguageSelect from './LanguageSelect.vue'
import PwaControls from './PwaControls.vue'
import { frontendBuild } from '../build-info'
import { buildLabel } from '../../../shared/build-info'
import { copyText } from '../clipboard'

const { t, n } = useI18n()

const props = defineProps<{ open: boolean; settings: GlobalSettings; portal?: HTMLElement; hasDisplayCutout?: boolean }>()
const emit = defineEmits<{ close: []; saved: [settings: GlobalSettings]; error: [message: string] }>()
const mobile = useMobileLayout()
const fullVersionLabel = buildLabel(frontendBuild)
const versionFeedback = ref<'copied' | 'failed'>()
let copyTimer: ReturnType<typeof setTimeout> | undefined
let copyAttempt = 0
function clearVersionFeedback() { copyAttempt++; clearTimeout(copyTimer); versionFeedback.value = undefined }
function copyVersion() {
  const attempt = ++copyAttempt
  const feedback = (value: 'copied' | 'failed') => {
    if (disposed || attempt !== copyAttempt || !props.open) return
    versionFeedback.value = value
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { versionFeedback.value = undefined }, 1800)
  }
  if (copyText(JSON.stringify(frontendBuild, null, 2), () => feedback('failed'))) feedback('copied')
}
watch(() => props.open, clearVersionFeedback)
watch(() => props.open, open => { if (open) refreshNotificationPermission() }, { immediate: true })
const systemNotificationStatus = computed(() => !systemNotificationSupported.value
  ? window.isSecureContext ? 'common.unsupportedBrowser' : 'common.httpsRequired'
  : systemNotificationRequesting.value ? 'settings.requesting'
  : systemNotificationPermission.value === 'denied' ? 'settings.notificationPermissionDenied' : '')
const testingNotification = ref<'sound' | 'system'>()
let notificationTestRevision = 0
watch(() => props.open, () => { notificationTestRevision++; testingNotification.value = undefined })
async function testNotification(kind: 'sound' | 'system') {
  if (testingNotification.value || systemNotificationRequesting.value) return
  const revision = ++notificationTestRevision
  testingNotification.value = kind
  const valid = () => !disposed && props.open && revision === notificationTestRevision
  try {
    if (kind === 'sound') await testNotificationSound(valid)
    else await testSystemNotification(t('settings.notificationTestTitle'), t('settings.notificationTestBody'), valid)
  } finally { if (valid()) testingNotification.value = undefined }
}
const viewportFits = ['cover', 'contain']
const interactiveWidgets = ['resizes-content', 'resizes-visual', 'overlays-content']
const viewportSelectUi = { content: 'settings-select-menu', item: 'settings-select-item' }
const inputModes = computed(() => [
  { value: 'auto', label: t('settings.inputAuto') },
  { value: 'touch', label: t('settings.inputTouch') },
  { value: 'keyboard', label: t('settings.inputKeyboard') },
])
const uiScales = [75, 90, 100, 110, 125, 150].map(value => ({ value, label: `${value}%` }))
const cutoutPositions = computed<Array<{ value: CutoutPosition; label: string }>>(() => [
  { value: 'left', label: t('settings.left') }, { value: 'center', label: t('settings.center') }, { value: 'right', label: t('settings.right') },
])
const cutoutMaximum = computed(() => Math.max(0, Math.min(240, Math.min(window.screen.width, window.screen.height) - 176 * uiZoom.value)))
const displayedCutoutWidth = computed({
  get: () => Math.max(0, Math.min(cutoutWidth.value, cutoutMaximum.value)),
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
  fontError.value = reason instanceof Error ? reason : 'settings.fontFailed'
  if (!props.open && changed) emit('error', fontErrorMessage.value)
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
onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer); clearVersionFeedback() })
defineExpose({ close })
</script>

<template>
  <UModal :open="open" :title="t('common.settings')" :portal="portal || false" :close="{ 'aria-label': t('settings.close') }"
    :ui="{ content: 'settings-modal', overlay: 'settings-overlay', header: 'settings-header', body: 'settings-body', footer: 'settings-footer', title: 'settings-title', close: 'settings-close' }" @update:open="close">
    <template #body>
      <div class="settings-preferences">
        <div class="settings-preference-row"><span>{{ t('common.language') }}</span><LanguageSelect :portal="portal" /></div>
        <div class="settings-preference-row"><label for="input-mode">{{ t('settings.inputMode') }}</label><USelect id="input-mode" v-model="inputMode" :items="inputModes" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" :aria-label="t('settings.inputMode')" /></div>
        <div class="settings-preference-row"><label for="ui-scale">{{ t('settings.uiScale') }}</label><USelect id="ui-scale" v-model="uiScale" :items="uiScales" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" :aria-label="t('settings.uiScale')" /></div>
      </div>
      <section v-if="mobile && hasDisplayCutout" class="cutout-settings" :aria-label="t('settings.cutout')">
        <div class="cutout-heading"><span>{{ t('settings.cutout') }}</span><small>{{ t('settings.thisBrowser') }}</small></div>
        <div class="cutout-row"><span id="cutout-position-label">{{ t('settings.position') }}</span><div class="cutout-positions" role="group" aria-labelledby="cutout-position-label"><UButton v-for="position in cutoutPositions" :key="position.value" type="button" color="neutral" :variant="cutoutPosition === position.value ? 'solid' : 'outline'" :aria-pressed="cutoutPosition === position.value" @click="cutoutPosition = position.value">{{ position.label }}</UButton></div></div>
        <div class="cutout-width-label"><span id="cutout-width-label">{{ t('settings.width') }}</span><output>{{ n(displayedCutoutWidth) }} px</output></div>
        <USlider id="cutout-width" v-model="displayedCutoutWidth" class="cutout-width" :min="0" :max="cutoutMaximum" :step="1" size="sm" :disabled="cutoutMaximum === 0" aria-labelledby="cutout-width-label" :aria-valuetext="`${n(displayedCutoutWidth)} px`" />
      </section>
      <form class="font-settings" @submit.prevent>
        <div class="font-stack-heading"><span>{{ t('settings.contentFont') }}</span><UButton type="button" color="neutral" variant="ghost" size="xs" class="font-add" :disabled="draft.stack.length >= 12" :aria-label="t('settings.addFont')" @click="addFont"><Icon name="plus" :size="13" /> {{ t('settings.add') }}</UButton></div>
        <ol class="font-stack" :aria-label="t('settings.fontOrder')">
          <li v-for="(entry, index) in draft.stack" :key="entryIds[index]" class="font-stack-entry">
            <div class="font-stack-row">
              <span class="font-order" :title="t(index === 0 ? 'settings.primaryFont' : 'settings.fallbackFont')">{{ n(index + 1) }}</span>
              <UInputMenu :model-value="entry.family" mode="autocomplete" :items="families" :portal="portal || false" :open-on-focus="false" size="sm" class="font-family-input" :aria-label="t('settings.font', { index: n(index + 1) })" :title="entry.family" :placeholder="t('settings.fontPlaceholder')" :maxlength="100"
                :ui="{ content: 'font-select-menu', item: 'font-select-item', viewport: 'font-select-viewport', trailing: 'font-family-trailing' }" @update:model-value="setFamily(index, $event)"><template #empty><span class="font-local-hint">{{ t('settings.localFont') }}</span></template></UInputMenu>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === 0" :aria-label="t('settings.moveFontUp', { index: n(index + 1) })" @click="moveFont(index, -1)"><Icon name="down" :size="13" class="font-up" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === draft.stack.length - 1" :aria-label="t('settings.moveFontDown', { index: n(index + 1) })" @click="moveFont(index, 1)"><Icon name="down" :size="13" /></UButton>
              <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="draft.stack.length === 1" :aria-label="t('settings.deleteFont', { index: n(index + 1) })" @click="removeFont(index)"><Icon name="close" :size="13" /></UButton>
            </div>
          </li>
        </ol>
        <div class="font-options"><USwitch v-model="draft.ligatures" :label="t('settings.ligatures')" :aria-label="t('settings.ligatures')" size="sm" class="settings-switch" /><span class="font-stack-hint">{{ t('settings.fallbackOrder') }}</span></div>
        <div class="font-preview-wrap">
          <div class="font-preview-heading"><span>{{ t('settings.preview') }}</span><span v-if="loading || saving" class="font-loading" role="status"><span class="spinner" />{{ t(saving ? 'settings.applying' : 'settings.loadingFont') }}</span></div>
          <pre class="font-preview" :style="previewStyle" :aria-busy="loading" :aria-label="t('settings.fontPreview')">{{ previewText }}</pre>
        </div>
        <div v-if="fontError" class="font-error" role="alert"><span>{{ fontErrorMessage }}</span><UButton type="button" color="neutral" variant="link" size="xs" :aria-label="t('settings.retryFont')" @click="retryPreview">{{ t('common.retry') }}</UButton></div>
      </form>
      <section class="notification-settings" :aria-label="t('settings.notifications')">
        <div class="notification-settings-heading"><span>{{ t('settings.notifications') }}</span><small>{{ t('settings.thisBrowser') }}</small></div>
        <div class="notification-setting-row">
          <USwitch :model-value="notificationSoundEnabled" :disabled="!notificationSoundSupported" :label="t('settings.notificationSound')" :aria-label="t('settings.notificationSound')" size="sm" class="settings-switch" @update:model-value="setNotificationSound" />
          <UButton type="button" color="neutral" variant="soft" size="xs" :loading="testingNotification === 'sound'" :disabled="!notificationSoundSupported || !!testingNotification || systemNotificationRequesting" :aria-label="t('settings.testSound')" @click="testNotification('sound')">{{ t('settings.test') }}</UButton>
          <small v-if="!notificationSoundSupported">{{ t('common.unsupportedBrowser') }}</small>
        </div>
        <div class="notification-setting-row">
          <USwitch :model-value="systemNotificationSupported && notificationSystemEnabled && systemNotificationPermission === 'granted'" :disabled="!systemNotificationSupported || systemNotificationRequesting" :label="t('settings.systemNotifications')" :aria-label="t('settings.systemNotifications')" size="sm" class="settings-switch" @update:model-value="setSystemNotifications" />
          <UButton type="button" color="neutral" variant="soft" size="xs" :loading="testingNotification === 'system'" :disabled="!systemNotificationSupported || systemNotificationPermission === 'denied' || systemNotificationRequesting || !!testingNotification" :aria-label="t('settings.testSystemNotification')" @click="testNotification('system')">{{ t('settings.test') }}</UButton>
          <small v-if="systemNotificationStatus" role="status">{{ t(systemNotificationStatus) }}</small>
        </div>
        <small v-if="notificationSettingsError" class="notification-settings-error" role="alert">{{ t(notificationSettingsError) }}</small>
      </section>
      <div class="wake-lock-setting">
        <USwitch :model-value="!screenWakeLockUnavailable && keepScreenAwake" :disabled="!!screenWakeLockUnavailable" :label="t('settings.keepAwake')" :aria-label="t('settings.keepAwake')" size="sm" class="settings-switch" @update:model-value="keepScreenAwake = $event" />
        <small v-if="screenWakeLockUnavailable">{{ screenWakeLockUnavailable }}</small>
        <template v-else-if="keepScreenAwake">
          <small v-if="screenWakeLockState === 'active'" role="status">{{ t('settings.active') }}</small>
          <small v-else-if="screenWakeLockState === 'pending'" role="status">{{ t('settings.requesting') }}</small>
          <template v-else-if="screenWakeLockState === 'denied' || screenWakeLockState === 'released'"><small role="status">{{ t(screenWakeLockState === 'denied' ? 'settings.wakeDenied' : 'settings.wakePaused') }}</small><UButton type="button" color="neutral" variant="link" size="xs" :aria-label="t('settings.retryWake')" @click="retryScreenWakeLock">{{ t('common.retry') }}</UButton></template>
        </template>
      </div>
      <PwaControls :can-reload="canReload" />
      <div class="developer-setting">
        <USwitch v-model="developerMode" :label="t('settings.developerMode')" :aria-label="t('settings.developerMode')" size="sm" class="settings-switch" />
        <section v-if="developerMode" class="viewport-experiments" :aria-label="t('settings.developerAdvanced')">
          <div class="viewport-experiment-heading"><span>{{ t('settings.developerAdvanced') }}</span><small>{{ t('settings.thisBrowser') }}</small></div>
          <div class="viewport-experiment-field">
            <label for="viewport-fit"><code>viewport-fit</code></label>
            <USelect id="viewport-fit" v-model="viewportFit" :items="viewportFits" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" aria-label="viewport-fit" />
          </div>
          <div class="viewport-experiment-field">
            <label for="interactive-widget"><code>interactive-widget</code></label>
            <USelect id="interactive-widget" v-model="interactiveWidget" :items="interactiveWidgets" :portal="portal || false" :ui="viewportSelectUi" color="neutral" size="sm" class="settings-select" aria-label="interactive-widget" />
          </div>
        </section>
        <div v-if="developerMode || viewportReloadRequired" class="viewport-reload-row">
          <span v-if="viewportReloadRequired" role="status">{{ t('settings.reloadRequired') }}</span>
          <UButton type="button" color="neutral" variant="outline" size="sm" class="viewport-reload" :disabled="!canReload" :title="canReload ? undefined : t('settings.finishFont')" @click="reloadPage">{{ t('settings.reload') }}</UButton>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="settings-footer-actions">
        <UButton type="button" color="neutral" variant="link" class="settings-version" :class="{ 'copy-failed': versionFeedback === 'failed' }"
          :title="versionFeedback ? t(`terminal.clipboard.${versionFeedback}`) : `${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`"
          :aria-label="`${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`" @click="copyVersion">
          <span class="settings-version-number">{{ frontendBuild.version }}</span><span v-if="versionFeedback || frontendBuild.revision || frontendBuild.dirty" class="settings-version-revision">{{ versionFeedback ? t(`terminal.clipboard.${versionFeedback}`) : `${frontendBuild.revision ? `· ${frontendBuild.revision.slice(0, 7)}` : ''}${frontendBuild.dirty ? ' *' : ''}` }}</span>
        </UButton>
        <span class="sr-only" role="status">{{ versionFeedback ? t(`terminal.clipboard.${versionFeedback}`) : '' }}</span>
        <UButton color="neutral" variant="outline" class="font-done" @click="close()">{{ t('common.done') }}</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.settings-preferences{display:grid;gap:12px;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid #343b46}
.settings-preference-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0;color:#c4cbd6;font-size:12px}
.settings-preference-row>span,.settings-preference-row>label{flex:1 1 auto;min-width:min-content;white-space:normal;margin:0}
.settings-preference-row :deep(.settings-select){width:150px;max-width:66%;min-width:0;flex:0 1 auto}
.settings-footer-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;width:100%}
.settings-version{flex:1;min-width:0;justify-content:flex-start;gap:5px;padding:0;height:32px;color:#7d899a;font-size:10px;font-weight:400;white-space:nowrap;text-decoration:none}
.settings-version:hover{color:#b7c2d0}.settings-version.copy-failed{color:#dfaaa5}
.settings-version-number{flex:none}.settings-version-revision{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.settings-footer-actions>.font-done{flex:none}
.font-done{height:32px;min-width:62px;padding:0 12px;border:1px solid #485262;border-radius:6px;font-size:11px;font-weight:500;color:#c3cdd9;background:#2a323e}
.font-done:hover{background:#343e4b}
.mobile-layout .font-done,.mobile-layout .settings-version{height:40px}
.cutout-settings{container-type:inline-size;display:grid;gap:12px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #343b46}
.cutout-heading,.cutout-row,.cutout-width-label{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#c4cbd6;font-size:12px}
.cutout-heading{font-weight:500}
.cutout-heading small{font-size:11px;font-weight:400;color:#8793a4}
.cutout-positions{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;width:164px}
.cutout-positions button{min-height:44px;justify-content:center}
.cutout-width-label output{color:#929fb0;font-variant-numeric:tabular-nums}
.cutout-width{width:100%;min-height:44px;margin:0}
.developer-setting{margin-top:18px;padding-top:16px;border-top:1px solid #343b46}
.wake-lock-setting{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid #343b46}
.wake-lock-setting>small{margin-left:auto;color:#8793a4;font-size:11px}
.wake-lock-setting+.developer-setting{margin-top:14px;padding-top:0;border-top:0}
.notification-settings{display:grid;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid #343b46}
.notification-settings-heading,.notification-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;color:#c4cbd6;font-size:12px}
.notification-settings-heading{font-weight:500}.notification-settings-heading small,.notification-setting-row>small{font-size:11px;font-weight:400;color:#8793a4}
.notification-setting-row{display:grid;grid-template-columns:minmax(0,1fr) auto;row-gap:4px}.notification-setting-row>small{grid-column:1/-1}
.notification-settings-error{color:#dfaaa5;font-size:11px}
.viewport-experiments{display:grid;gap:12px;margin-top:10px;padding:14px 0 0;border-top:1px solid #343b46}
.viewport-experiment-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;color:#c4cbd6;font-size:12px;font-weight:500}
.viewport-experiment-heading small{white-space:nowrap}.viewport-experiment-heading small,.viewport-experiment-field code{font-size:11px;font-weight:400;color:#8793a4}
.viewport-experiment-field{display:grid;gap:7px;min-width:0}
.viewport-experiment-field label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;font-size:11px}
.viewport-reload-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:12px}
.viewport-reload-row>span{color:#ac9988;font-size:11px}
.viewport-reload{justify-self:start;min-height:34px;padding:0 10px;border:1px solid #485262;border-radius:6px;font-size:11px;color:#c3cdd9;background:#2a323e}
.viewport-reload:hover{background:#343e4b}
.mobile-layout .viewport-reload{min-height:44px}
</style>
