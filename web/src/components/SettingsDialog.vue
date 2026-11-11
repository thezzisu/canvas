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
import {
  developerMode,
  viewportFit,
  interactiveWidget,
  viewportReloadRequired,
} from '../developer-mode'
import {
  keepScreenAwake,
  retryScreenWakeLock,
  screenWakeLockState,
  screenWakeLockUnavailable,
} from '../screen-wake-lock'
import {
  notificationSoundEnabled,
  notificationSystemEnabled,
  notificationSoundSupported,
  systemNotificationSupported,
  systemNotificationPermission,
  systemNotificationRequesting,
  notificationSettingsError,
  setNotificationSound,
  setSystemNotifications,
  refreshNotificationPermission,
  testNotificationSound,
  testSystemNotification,
} from '../notification-settings'
import LanguageSelect from './LanguageSelect.vue'
import PwaControls from './PwaControls.vue'
import { frontendBuild } from '../build-info'
import { buildLabel } from '../../../shared/build-info'
import { copyText } from '../clipboard'

const { t, n } = useI18n()

const props = defineProps<{ open: boolean; settings: GlobalSettings; hasDisplayCutout?: boolean }>()
const emit = defineEmits<{
  close: []
  saved: [settings: GlobalSettings]
  error: [message: string]
}>()
const mobile = useMobileLayout()
const fullVersionLabel = buildLabel(frontendBuild)
function copyVersion() {
  void copyText(JSON.stringify(frontendBuild, null, 2))
}
watch(
  () => props.open,
  (open) => {
    if (open) refreshNotificationPermission()
  },
  { immediate: true },
)
const systemNotificationStatus = computed(() =>
  !systemNotificationSupported.value
    ? window.isSecureContext
      ? 'common.unsupportedBrowser'
      : 'common.httpsRequired'
    : systemNotificationRequesting.value
      ? 'settings.requesting'
      : systemNotificationPermission.value === 'denied'
        ? 'settings.notificationPermissionDenied'
        : '',
)
let disposed = false
const testingNotification = ref<'sound' | 'system'>()
let notificationTestRevision = 0
watch(
  () => props.open,
  () => {
    notificationTestRevision++
    testingNotification.value = undefined
  },
)
async function testNotification(kind: 'sound' | 'system') {
  if (testingNotification.value || systemNotificationRequesting.value) return
  const revision = ++notificationTestRevision
  testingNotification.value = kind
  const valid = () => !disposed && props.open && revision === notificationTestRevision
  try {
    if (kind === 'sound') await testNotificationSound(valid)
    else
      await testSystemNotification(
        t('settings.notificationTestTitle'),
        t('settings.notificationTestBody'),
        valid,
      )
  } finally {
    if (valid()) testingNotification.value = undefined
  }
}
const viewportFits = ['cover', 'contain']
const interactiveWidgets = ['resizes-content', 'resizes-visual', 'overlays-content']
const inputModes = computed(() => [
  { value: 'auto', label: t('settings.inputAuto') },
  { value: 'touch', label: t('settings.inputTouch') },
  { value: 'keyboard', label: t('settings.inputKeyboard') },
])
const uiScales = [75, 90, 100, 110, 125, 150].map((value) => ({ value, label: `${value}%` }))
const cutoutPositions = computed<Array<{ value: CutoutPosition; label: string }>>(() => [
  { value: 'left', label: t('settings.left') },
  { value: 'center', label: t('settings.center') },
  { value: 'right', label: t('settings.right') },
])
const cutoutMaximum = computed(() =>
  Math.max(
    0,
    Math.min(240, Math.min(window.screen.width, window.screen.height) - 176 * uiZoom.value),
  ),
)
const displayedCutoutWidth = computed({
  get: () => Math.max(0, Math.min(cutoutWidth.value, cutoutMaximum.value)),
  set: (width: number) => {
    cutoutWidth.value = width
  },
})
const fontEditor = useContentFontEditor(
  () => props.settings,
  () => props.open,
  {
    saved: (value) => emit('saved', value),
    error: (message) => emit('error', message),
  },
)
const canReload = computed(() => fontEditor.canReload)
function reloadPage() {
  if (canReload.value) window.location.reload()
}
const subdialog = ref<'terminal' | 'font'>()
// One row layout for every setting; status text sits under the label.
const field = {
  root: 'items-center gap-4',
  labelWrapper: 'justify-start',
  description: 'text-xs',
  error: 'mt-0.5 text-xs',
}
const separator = { root: 'my-1', label: 'text-xs text-muted font-normal' }
const wakeStatus = computed(
  () =>
    screenWakeLockUnavailable.value ||
    (!keepScreenAwake.value
      ? undefined
      : screenWakeLockState.value === 'active'
        ? t('settings.active')
        : screenWakeLockState.value === 'pending'
          ? t('settings.requesting')
          : screenWakeLockState.value === 'denied'
            ? t('settings.wakeDenied')
            : screenWakeLockState.value === 'released'
              ? t('settings.wakePaused')
              : undefined),
)
const wakeRetry = computed(
  () =>
    !screenWakeLockUnavailable.value &&
    keepScreenAwake.value &&
    (screenWakeLockState.value === 'denied' || screenWakeLockState.value === 'released'),
)
// Notification failures belong to the row whose action failed; status text is announced.
const soundError = computed(
  () => notificationSettingsError.value === 'settings.notificationSoundFailed',
)
const soundStatus = computed(() =>
  soundError.value
    ? t(notificationSettingsError.value)
    : notificationSoundSupported.value
      ? undefined
      : t('common.unsupportedBrowser'),
)
const systemError = computed(() => !!notificationSettingsError.value && !soundError.value)
const systemStatus = computed(() =>
  systemError.value
    ? t(notificationSettingsError.value)
    : systemNotificationStatus.value
      ? t(systemNotificationStatus.value)
      : undefined,
)
function close(open = false) {
  if (open) return
  fontEditor.settle()
  subdialog.value = undefined
  emit('close')
}
onBeforeUnmount(() => {
  disposed = true
  fontEditor.dispose()
})
defineExpose({ close })
</script>

<template>
  <UModal
    v-if="open"
    :open="true"
    :title="t('common.settings')"
    :close="{ 'aria-label': t('settings.close') }"
    :ui="{ content: 'settings-modal [--dialog-width:28rem]', footer: 'justify-between' }"
    @update:open="close"
  >
    <template #body>
      <!-- Every row is a horizontal UFormField: label (and status) left, control right.
           USeparator is the only divider between sections. -->
      <section class="settings-section">
        <UFormField :label="t('common.language')" orientation="horizontal" :ui="field"
          ><LanguageSelect
        /></UFormField>
        <UFormField :label="t('settings.inputMode')" orientation="horizontal" :ui="field"
          ><USelect
            v-model="inputMode"
            :items="inputModes"
            color="neutral"
            class="w-36"
            :aria-label="t('settings.inputMode')"
        /></UFormField>
        <UFormField :label="t('settings.uiScale')" orientation="horizontal" :ui="field"
          ><USelect
            v-model="uiScale"
            :items="uiScales"
            color="neutral"
            class="w-36"
            :aria-label="t('settings.uiScale')"
        /></UFormField>
        <UFormField
          :label="t('terminal.settings.defaults')"
          :description="t('settings.thisBrowser')"
          orientation="horizontal"
          :ui="field"
          ><UButton color="neutral" variant="outline" size="sm" @click="subdialog = 'terminal'">{{
            t('common.open')
          }}</UButton></UFormField
        >
        <UFormField :label="t('settings.contentFont')" orientation="horizontal" :ui="field"
          ><UButton color="neutral" variant="outline" size="sm" @click="subdialog = 'font'">{{
            t('common.open')
          }}</UButton></UFormField
        >
      </section>
      <template v-if="mobile && hasDisplayCutout">
        <USeparator
          :label="`${t('settings.cutout')} · ${t('settings.thisBrowser')}`"
          :ui="separator"
        />
        <section class="settings-section" :aria-label="t('settings.cutout')">
          <UFormField :label="t('settings.position')" orientation="horizontal" :ui="field"
            ><UTabs
              v-model="cutoutPosition"
              :items="cutoutPositions"
              :content="false"
              color="neutral"
              variant="pill"
              size="sm"
              :aria-label="t('settings.position')"
          /></UFormField>
          <UFormField :label="t('settings.width')" :hint="`${n(displayedCutoutWidth)} px`">
            <USlider
              v-model="displayedCutoutWidth"
              class="w-full"
              :min="0"
              :max="cutoutMaximum"
              :step="1"
              size="sm"
              :disabled="cutoutMaximum === 0"
              :aria-label="t('settings.width')"
              :aria-valuetext="`${n(displayedCutoutWidth)} px`"
            />
          </UFormField>
        </section>
      </template>
      <USeparator
        :label="`${t('settings.notifications')} · ${t('settings.thisBrowser')}`"
        :ui="separator"
      />
      <section class="settings-section" :aria-label="t('settings.notifications')">
        <UFormField
          :label="t('settings.notificationSound')"
          orientation="horizontal"
          :ui="field"
          class="notification-setting-row"
        >
          <template v-if="soundStatus" #description
            ><span :role="soundError ? 'alert' : 'status'" :class="{ 'text-error': soundError }">{{
              soundStatus
            }}</span></template
          >
          <div class="settings-controls">
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              :loading="testingNotification === 'sound'"
              :disabled="
                !notificationSoundSupported || !!testingNotification || systemNotificationRequesting
              "
              :aria-label="t('settings.testSound')"
              @click="testNotification('sound')"
              >{{ t('settings.test') }}</UButton
            >
            <USwitch
              :model-value="notificationSoundEnabled"
              :disabled="!notificationSoundSupported"
              :aria-label="t('settings.notificationSound')"
              @update:model-value="setNotificationSound"
            />
          </div>
        </UFormField>
        <UFormField
          :label="t('settings.systemNotifications')"
          orientation="horizontal"
          :ui="field"
          class="notification-setting-row"
        >
          <template v-if="systemStatus" #description
            ><span
              :role="systemError ? 'alert' : 'status'"
              :class="{ 'text-error': systemError }"
              >{{ systemStatus }}</span
            ></template
          >
          <div class="settings-controls">
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              :loading="testingNotification === 'system'"
              :disabled="
                !systemNotificationSupported ||
                systemNotificationPermission === 'denied' ||
                systemNotificationRequesting ||
                !!testingNotification
              "
              :aria-label="t('settings.testSystemNotification')"
              @click="testNotification('system')"
              >{{ t('settings.test') }}</UButton
            >
            <USwitch
              :model-value="
                systemNotificationSupported &&
                notificationSystemEnabled &&
                systemNotificationPermission === 'granted'
              "
              :disabled="!systemNotificationSupported || systemNotificationRequesting"
              :aria-label="t('settings.systemNotifications')"
              @update:model-value="setSystemNotifications"
            />
          </div>
        </UFormField>
      </section>
      <USeparator :ui="separator" />
      <section class="settings-section">
        <UFormField :label="t('settings.keepAwake')" orientation="horizontal" :ui="field">
          <template v-if="wakeStatus" #description
            ><span role="status">{{ wakeStatus }}</span></template
          >
          <div class="settings-controls">
            <UButton
              v-if="wakeRetry"
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('settings.retryWake')"
              @click="retryScreenWakeLock"
              >{{ t('common.retry') }}</UButton
            >
            <USwitch
              :model-value="!screenWakeLockUnavailable && keepScreenAwake"
              :disabled="!!screenWakeLockUnavailable"
              :aria-label="t('settings.keepAwake')"
              @update:model-value="keepScreenAwake = $event"
            />
          </div>
        </UFormField>
        <PwaControls :can-reload="canReload" :field="field" />
      </section>
      <USeparator :ui="separator" />
      <section class="settings-section">
        <UFormField :label="t('settings.developerMode')" orientation="horizontal" :ui="field">
          <USwitch v-model="developerMode" :aria-label="t('settings.developerMode')" />
        </UFormField>
        <template v-if="developerMode">
          <UFormField
            label="viewport-fit"
            orientation="horizontal"
            :ui="{ ...field, label: 'font-mono font-normal text-muted' }"
            ><USelect
              v-model="viewportFit"
              :items="viewportFits"
              color="neutral"
              class="w-36"
              aria-label="viewport-fit"
          /></UFormField>
          <UFormField
            label="interactive-widget"
            orientation="horizontal"
            :ui="{ ...field, label: 'font-mono font-normal text-muted' }"
            ><USelect
              v-model="interactiveWidget"
              :items="interactiveWidgets"
              color="neutral"
              class="w-36"
              aria-label="interactive-widget"
          /></UFormField>
        </template>
        <UFormField
          v-if="developerMode || viewportReloadRequired"
          :label="t('settings.reload')"
          orientation="horizontal"
          :ui="field"
        >
          <template v-if="viewportReloadRequired" #description
            ><span role="status">{{ t('settings.reloadRequired') }}</span></template
          >
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="!canReload"
            :title="canReload ? undefined : t('settings.finishFont')"
            @click="reloadPage"
            >{{ t('settings.reload') }}</UButton
          >
        </UFormField>
      </section>
    </template>
    <template #footer>
      <UButton
        type="button"
        color="neutral"
        variant="link"
        class="settings-version"
        :title="`${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`"
        :aria-label="`${t('settings.copyFrontendVersion')}: ${fullVersionLabel}`"
        @click="copyVersion"
      >
        <span class="settings-version-number">{{ frontendBuild.version }}</span
        ><span
          v-if="frontendBuild.revision || frontendBuild.dirty"
          class="settings-version-revision"
          >{{
            `${frontendBuild.revision ? `· ${frontendBuild.revision.slice(0, 7)}` : ''}${frontendBuild.dirty ? ' *' : ''}`
          }}</span
        >
      </UButton>
      <UButton color="neutral" variant="outline" class="settings-done" @click="close()">{{
        t('common.done')
      }}</UButton>
    </template>
  </UModal>
  <TerminalSettingsDialog
    :open="open && subdialog === 'terminal'"
    defaults-mode
    @close="subdialog = undefined"
  />
  <UModal
    v-if="open && subdialog === 'font'"
    :open="true"
    :title="t('settings.contentFont')"
    :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: '[--dialog-width:28rem]' }"
    @update:open="
      (value) => {
        if (!value) {
          fontEditor.settle()
          subdialog = undefined
        }
      }
    "
  >
    <template #body><ContentFontSettings :editor="fontEditor" /></template>
  </UModal>
</template>

<style scoped>
.settings-section {
  display: grid;
  gap: 12px;
  padding-block: 14px;
}
.settings-section:first-child {
  padding-top: 0;
}
.settings-section:last-child {
  padding-bottom: 0;
}
.settings-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-version {
  flex: 1;
  min-width: 0;
  justify-content: flex-start;
  gap: 5px;
  padding: 0;
  font-size: 10px;
  font-weight: 400;
  white-space: nowrap;
}
.settings-version-number {
  flex: none;
}
.settings-version-revision {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
