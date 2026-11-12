<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useTitle } from '@vueuse/core'
import { RouterView, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import UApp from '@nuxt/ui/components/App.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UTheme from '@nuxt/ui/components/Theme.vue'
import { apiRevision } from './api/api'
import { useScreenWakeLock } from './composables/screen-wake-lock'
import { notificationPortal } from './composables/notifications/notification-surface'
import TrustedPreviewDialog from './components/files/TrustedPreviewDialog.vue'
import SignInView from './pages/SignInPage.vue'
import { useSessionStore } from './stores/session'
import { useShellStore } from './stores/shell'
import { useWorkspaceStore } from './stores/workspace'
import { developerMode } from './composables/developer-mode'
import { uiLocale } from './plugins/i18n'
import NoticeHost from './components/NoticeHost.vue'
import PwaUpdatePrompt from './components/PwaUpdatePrompt.vue'

const ViewportDiagnostics = defineAsyncComponent(
  () => import('./components/settings/ViewportDiagnostics.vue'),
)
const { t } = useI18n()
const route = useRoute()
const session = useSessionStore(),
  shell = useShellStore(),
  workspace = useWorkspaceStore()
useScreenWakeLock(computed(() => session.authenticated))
/** Signed in to the instance the address names, and that address is a canvas. */
const working = computed(
  () => session.authenticated && !session.unknownInstance && route.name === 'canvas',
)
useTitle(() =>
  working.value && workspace.state
    ? `${workspace.canvasName(String(route.params.canvas))} - Canvas`
    : 'Canvas',
)
// Touch layouts: 44px menu rows; text entry uses 16px so focusing a field never zooms the page.
const touchTheme = {
  dropdownMenu: { item: 'min-h-[44px] items-center' },
  contextMenu: { item: 'min-h-[44px] items-center' },
  input: { base: 'text-[16px]' },
  inputMenu: { base: 'text-[16px]' },
  inputNumber: { base: 'text-[16px]' },
}
</script>

<template>
  <UTheme :ui="shell.mobile ? touchTheme : undefined">
    <UApp
      :locale="uiLocale"
      :portal="shell.overlayRoot || false"
      :toaster="{
        portal: notificationPortal || false,
        position: 'bottom-right',
        max: 4 + shell.pinnedToasts,
        progress: false,
        ui: { viewport: 'canvas-notifications' },
      }"
    >
      <NoticeHost />
      <PwaUpdatePrompt />
      <div v-if="!session.ready" class="boot-screen">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        {{ t('common.loading') }}
      </div>
      <!-- A new session or instance starts the workspace afresh, with nothing carried over. -->
      <RouterView v-else-if="working" :key="apiRevision" />
      <SignInView v-else />
      <TrustedPreviewDialog />
      <ViewportDiagnostics
        v-if="developerMode && working"
        :settings="workspace.settings ?? null"
        :reload-blocked="shell.modalOpen"
      />
    </UApp>
  </UTheme>
</template>
