<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import USlider from '@nuxt/ui/components/Slider.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import USeparator from '@nuxt/ui/components/Separator.vue'
import TerminalSettingsDialog from './TerminalSettingsDialog.vue'
import ContentFontSettings from './ContentFontSettings.vue'
import { useContentFontEditor } from '../content-font-editor'
import type { GlobalSettings } from '../../../shared/settings'
import { inputMode, useMobileLayout } from '../mobile-layout'
import { uiScale, uiZoom } from '../ui-scale'
import { cutoutPosition, cutoutWidth, type CutoutPosition } from '../display-cutout'
import { developerMode, viewportFit, interactiveWidget, viewportReloadRequired } from '../developer-mode'
import { keepScreenAwake, retryScreenWakeLock, screenWakeLockState, screenWakeLockUnavailable } from '../screen-wake-lock'
import { notificationSoundEnabled, notificationSystemEnabled, notificationSoundSupported, systemNotificationSupported,
  systemNotificationPermission, systemNotificationRequesting, notificationSettingsError, setNotificationSound,
  setSystemNotifications, refreshNotificationPermission, testNotificationSound, testSystemNotification } from '../notification-settings'
import LanguageSelect from './LanguageSelect.vue'
import PwaControls from './PwaControls.vue'
import { frontendBuild } from '../build-info'
import { buildLabel } from '../../../shared/build-info'
import { copyText } from '../clipboard'

const { t, n } = useI18n()

const props = defineProps<{ open: boolean; settings: GlobalSettings; hasDisplayCutout?: boolean }>()
const emit = defineEmits<{ close: []; saved: [settings: GlobalSettings]; error: [message: string] }>()
const mobile = useMobileLayout()
const fullVersionLabel = buildLabel(frontendBuild)
function copyVersion() { void copyText(JSON.stringify(frontendBuild, null, 2)) }
watch(() => props.open, open => { if (open) refreshNotificationPermission() }, { immediate: true })
const systemNotificationStatus = computed(() => !systemNotificationSupported.value
  ? window.isSecureContext ? 'common.unsupportedBrowser' : 'common.httpsRequired'
  : systemNotificationRequesting.value ? 'settings.requesting'
  : systemNotificationPermission.value === 'denied' ? 'settings.notificationPermissionDenied' : '')
let disposed = false
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
const fontEditor = useContentFontEditor(() => props.settings, () => props.open, {
  saved: value => emit('saved', value), error: message => emit('error', message) })
const canReload = computed(() => fontEditor.canReload)
function reloadPage() { if (canReload.value) window.location.reload() }
const subdialog = ref<'terminal' | 'font'>()
function close(open = false) {
  if (open) return
  fontEditor.settle()
  subdialog.value = undefined
  emit('close')
}
onBeforeUnmount(() => { disposed = true; fontEditor.dispose() })
defineExpose({ close })
</script>

<template>
  <UModal v-if="open" :open="true" :title="t('common.settings')" :close="{ 'aria-label': t('settings.close') }"
    :ui="{ content: 'settings-modal', overlay: 'settings-overlay', header: 'settings-header', body: 'settings-body', footer: 'settings-footer', title: 'settings-title', close: 'settings-close' }" @update:open="close">
    <template #body>
      <!-- Sections own only their content; USeparator is the single divider between them. -->
      <section class="settings-section">
        <UFormField :label="t('common.language')" orientation="horizontal" class="settings-field"><LanguageSelect /></UFormField>
        <UFormField :label="t('settings.inputMode')" orientation="horizontal" class="settings-field"><USelect v-model="inputMode" :items="inputModes" color="neutral" size="sm" class="w-36" /></UFormField>
        <UFormField :label="t('settings.uiScale')" orientation="horizontal" class="settings-field"><USelect v-model="uiScale" :items="uiScales" color="neutral" size="sm" class="w-36" /></UFormField>
        <UFormField :label="t('terminal.settings.defaults')" :hint="t('settings.thisBrowser')" orientation="horizontal" class="settings-field"><UButton color="neutral" variant="outline" size="sm" @click="subdialog = 'terminal'">{{ t('common.open') }}</UButton></UFormField>
        <UFormField :label="t('settings.contentFont')" orientation="horizontal" class="settings-field"><UButton color="neutral" variant="outline" size="sm" @click="subdialog = 'font'">{{ t('common.open') }}</UButton></UFormField>
      </section>
      <template v-if="mobile && hasDisplayCutout">
        <USeparator :label="`${t('settings.cutout')} · ${t('settings.thisBrowser')}`" />
        <section class="settings-section" :aria-label="t('settings.cutout')">
          <UFormField :label="t('settings.position')" orientation="horizontal" class="settings-field"><UTabs v-model="cutoutPosition" :items="cutoutPositions" :content="false" color="neutral" variant="pill" size="sm" :aria-label="t('settings.position')" /></UFormField>
          <UFormField :label="t('settings.width')" :hint="`${n(displayedCutoutWidth)} px`" class="settings-field">
            <USlider v-model="displayedCutoutWidth" class="w-full" :min="0" :max="cutoutMaximum" :step="1" size="sm" :disabled="cutoutMaximum === 0" :aria-label="t('settings.width')" :aria-valuetext="`${n(displayedCutoutWidth)} px`" />
          </UFormField>
        </section>
      </template>
      <USeparator :label="`${t('settings.notifications')} · ${t('settings.thisBrowser')}`" />
      <section class="settings-section" :aria-label="t('settings.notifications')">
        <div class="notification-setting-row">
          <USwitch :model-value="notificationSoundEnabled" :disabled="!notificationSoundSupported" :label="t('settings.notificationSound')" :aria-label="t('settings.notificationSound')" size="sm" @update:model-value="setNotificationSound" />
          <UButton type="button" color="neutral" variant="soft" size="xs" :loading="testingNotification === 'sound'" :disabled="!notificationSoundSupported || !!testingNotification || systemNotificationRequesting" :aria-label="t('settings.testSound')" @click="testNotification('sound')">{{ t('settings.test') }}</UButton>
          <small v-if="!notificationSoundSupported">{{ t('common.unsupportedBrowser') }}</small>
        </div>
        <div class="notification-setting-row">
          <USwitch :model-value="systemNotificationSupported && notificationSystemEnabled && systemNotificationPermission === 'granted'" :disabled="!systemNotificationSupported || systemNotificationRequesting" :label="t('settings.systemNotifications')" :aria-label="t('settings.systemNotifications')" size="sm" @update:model-value="setSystemNotifications" />
          <UButton type="button" color="neutral" variant="soft" size="xs" :loading="testingNotification === 'system'" :disabled="!systemNotificationSupported || systemNotificationPermission === 'denied' || systemNotificationRequesting || !!testingNotification" :aria-label="t('settings.testSystemNotification')" @click="testNotification('system')">{{ t('settings.test') }}</UButton>
          <small v-if="systemNotificationStatus" role="status">{{ t(systemNotificationStatus) }}</small>
        </div>
        <small v-if="notificationSettingsError" class="text-error text-xs" role="alert">{{ t(notificationSettingsError) }}</small>
      </section>
      <USeparator />
      <section class="settings-section">
        <div class="settings-switch-row">
          <USwitch :model-value="!screenWakeLockUnavailable && keepScreenAwake" :disabled="!!screenWakeLockUnavailable" :label="t('settings.keepAwake')" :aria-label="t('settings.keepAwake')" size="sm" @update:model-value="keepScreenAwake = $event" />
        <small v-if="screenWakeLockUnavailable">{{ screenWakeLockUnavailable }}</small>
        <template v-else-if="keepScreenAwake">
          <small v-if="screenWakeLockState === 'active'" role="status">{{ t('settings.active') }}</small>
          <small v-else-if="screenWakeLockState === 'pending'" role="status">{{ t('settings.requesting') }}</small>
          <template v-else-if="screenWakeLockState === 'denied' || screenWakeLockState === 'released'"><small role="status">{{ t(screenWakeLockState === 'denied' ? 'settings.wakeDenied' : 'settings.wakePaused') }}</small><UButton type="button" color="neutral" variant="link" size="xs" :aria-label="t('settings.retryWake')" @click="retryScreenWakeLock">{{ t('common.retry') }}</UButton></template>
        </template>
        </div>
        <PwaControls :can-reload="canReload" />
      </section>
      <USeparator />
      <section class="settings-section">
        <USwitch v-model="developerMode" :label="t('settings.developerMode')" :aria-label="t('settings.developerMode')" size="sm" />
        <section v-if="developerMode" class="viewport-experiments" :aria-label="t('settings.developerAdvanced')">
          <div class="viewport-experiment-heading"><span>{{ t('settings.developerAdvanced') }}</span><small>{{ t('settings.thisBrowser') }}</small></div>
          <div class="viewport-experiment-field">
            <label for="viewport-fit"><code>viewport-fit</code></label>
            <USelect id="viewport-fit" v-model="viewportFit" :items="viewportFits" color="neutral" size="sm" aria-label="viewport-fit" />
          </div>
          <div class="viewport-experiment-field">
            <label for="interactive-widget"><code>interactive-widget</code></label>
            <USelect id="interactive-widget" v-model="interactiveWidget" :items="interactiveWidgets" color="neutral" size="sm" aria-label="interactive-widget" />
          </div>
        </section>
        <div v-if="developerMode || viewportReloadRequired" class="viewport-reload-row">
          <span v-if="viewportReloadRequired" role="status">{{ t('settings.reloadRequired') }}</span>
          <UButton type="button" color="neutral" variant="outline" size="sm" :disabled="!canReload" :title="canReload ? undefined : t('settings.finishFont')" @click="reloadPage">{{ t('settings.reload') }}</UButton>
        </div>
      </section>
    </template>
    <template #footer>
      <div class="settings-footer-actions">
        <UButton type="button" color="neutral" variant="link" class="settings-version"
          :title="`${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`"
          :aria-label="`${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`" @click="copyVersion">
          <span class="settings-version-number">{{ frontendBuild.version }}</span><span v-if="frontendBuild.revision || frontendBuild.dirty" class="settings-version-revision">{{ `${frontendBuild.revision ? `· ${frontendBuild.revision.slice(0, 7)}` : ''}${frontendBuild.dirty ? ' *' : ''}` }}</span>
        </UButton>
        <UButton color="neutral" variant="outline" @click="close()">{{ t('common.done') }}</UButton>
      </div>
    </template>
  </UModal>
  <TerminalSettingsDialog :open="open && subdialog === 'terminal'" defaults-mode @close="subdialog = undefined" />
  <UModal v-if="open && subdialog === 'font'" :open="true" :title="t('settings.contentFont')" :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'terminal-settings-dialog' }" @update:open="value => { if (!value) { fontEditor.settle(); subdialog = undefined } }">
    <template #body><ContentFontSettings :editor="fontEditor" /></template>
  </UModal>
</template>

<style scoped>
.settings-section{display:grid;gap:12px;padding-block:14px}
.settings-section:first-child{padding-top:0}.settings-section:last-child{padding-bottom:0}
.settings-field{gap:16px;justify-content:space-between}
.settings-switch-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.settings-switch-row>small{margin-left:auto;color:var(--ui-text-muted);font-size:11px}
.notification-setting-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;row-gap:4px;column-gap:12px}
.notification-setting-row>small{grid-column:1/-1;color:var(--ui-text-muted);font-size:11px}
.viewport-experiments{display:grid;gap:12px}
.viewport-experiment-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:12px;font-weight:500}
.viewport-experiment-heading small,.viewport-experiment-field code{font-size:11px;font-weight:400;color:var(--ui-text-muted)}
.viewport-experiment-field{display:grid;gap:7px;min-width:0}
.viewport-experiment-field label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;font-size:11px}
.viewport-reload-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.viewport-reload-row>span{color:var(--ui-warning);font-size:11px}
.settings-footer-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;width:100%}
.settings-version{flex:1;min-width:0;justify-content:flex-start;gap:5px;padding:0;font-size:10px;font-weight:400;white-space:nowrap}
.settings-version-number{flex:none}.settings-version-revision{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
