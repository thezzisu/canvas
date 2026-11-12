<script setup lang="ts">
import { useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UModal from '../components/CanvasModal.vue'
import CanvasHeader from '../components/canvas/CanvasHeader.vue'
import CanvasStage from '../components/canvas/CanvasStage.vue'
import { createCanvasScene } from '../composables/canvas/scene/scene'
import DownloadPreviewDialog from '../components/files/DownloadPreviewDialog.vue'
import FileNode from '../components/files/FileNode.vue'
import AccountDialog from '../components/instances/AccountDialog.vue'
import { activeInstance } from '../composables/instances/instances'
import { useDisplayCutout } from '../composables/display-cutout'
import { notify } from '../composables/notify'
import NoteNode from '../components/notes/NoteNode.vue'
import NotificationCenter from '../components/notifications/NotificationCenter.vue'
import NotificationHost from '../components/notifications/NotificationHost.vue'
import {
  appliedContentFont,
  contentFontReady,
  contentFontStyle,
} from '../composables/settings/content-font'
import CutoutPreview from '../components/settings/CutoutPreview.vue'
import SettingsDialog from '../components/settings/SettingsDialog.vue'
import { capturedApp } from '../composables/terminal/capture'
import DirectoryDialog from '../components/terminal/DirectoryDialog.vue'
import RichPasteDialog from '../components/terminal/RichPasteDialog.vue'
import TerminalNode from '../components/terminal/TerminalNode.vue'
import { terminalReadFocus } from '../composables/terminal/terminals'
import UrlDialog from '../components/terminal/UrlDialog.vue'
import WindowContentDialog from '../components/terminal/WindowContentDialog.vue'
import BackgroundDialog from '../components/workspace/BackgroundDialog.vue'
import ConnectionsPanel from '../components/workspace/ConnectionsPanel.vue'
import WorkspaceSidebar from '../components/workspace/WorkspaceSidebar.vue'

// One signed-in workspace: the sidebar, and the canvas the address names.
const { t } = useI18n()
const scene = createCanvasScene()
const { workspace, session, shell, focus, layout, morph, graph } = scene
const { hasSafeTop } = useDisplayCutout()
const stage = useTemplateRef('stage')
watch(
  () => shell.backgroundCanvas && workspace.state,
  () => {
    // A peer deleted the canvas whose background is being edited.
    const editing = shell.backgroundCanvas
    if (
      editing &&
      editing.id !== 'overview' &&
      !workspace.canvases.some((canvas) => canvas.id === editing.id)
    )
      shell.backgroundCanvas = null
  },
)
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'canvas-fullscreen': shell.fullscreen,
      'mobile-layout': shell.mobile,
      'sidebar-drawer': shell.sidebarDrawer,
      'has-display-cutout': hasSafeTop,
      'cutout-preview-active': shell.settingsOpen && shell.mobile && hasSafeTop,
    }"
    :style="[shell.viewportStyle, contentFontStyle]"
    :data-content-font="appliedContentFont"
  >
    <NotificationCenter
      v-if="workspace.state"
      :key="workspace.state.instanceId"
      :instance-id="activeInstance.id"
      :backend-id="workspace.state.instanceId"
      :resources="workspace.rawResources"
      :display-resources="workspace.resources"
      :focus="terminalReadFocus"
      :refresh="() => workspace.refresh(true)"
      :actions-available="scene.reveal.available.value"
      @open="scene.reveal.open"
      @go="scene.reveal.goToNotification"
    />
    <NotificationHost :portal="shell.overlayRoot" />
    <CanvasHeader :file-drop="stage?.fileDrop ?? undefined" />
    <WorkspaceSidebar />
    <main
      class="workspace"
      :inert="(contentFontReady && shell.cardMaximized) || undefined"
      :aria-hidden="(contentFontReady && shell.cardMaximized) || undefined"
    >
      <CanvasStage ref="stage" />
    </main>
    <ConnectionsPanel />
    <div
      v-if="contentFontReady && focus.maximized.value"
      :ref="(element) => (focus.overlay.value = element as HTMLElement)"
      class="focus-overlay"
      :class="[
        { 'card-focus-overlay': focus.card.value },
        morph.state.value && `canvas-morph-${morph.state.value.phase}`,
      ]"
      :style="morph.state.value && { '--canvas-morph-shift': `${morph.state.value.shift}px` }"
    >
      <TerminalNode
        v-if="focus.terminal.value"
        :id="focus.terminal.value.id"
        :key="focus.terminal.value.id"
        :data="{ ...graph.terminalData(focus.terminal.value), focus: true }"
      />
      <NoteNode
        v-else-if="focus.card.value?.type === 'note'"
        :id="focus.card.value.id"
        :key="focus.card.value.id"
        :selected="false"
        :data="graph.noteData(focus.card.value, true)"
      />
      <FileNode
        v-else-if="focus.card.value?.type === 'file'"
        :id="focus.card.value.id"
        :key="`file:${focus.card.value.id}`"
        :selected="false"
        :data="graph.fileData(focus.card.value, true)"
      />
    </div>
    <BackgroundDialog
      v-if="shell.backgroundCanvas"
      :canvas="shell.backgroundCanvas"
      @close="shell.backgroundCanvas = null"
      @saved="workspace.sync().catch(notify.error)"
    />
    <RichPasteDialog />
    <DirectoryDialog />
    <UrlDialog />
    <DownloadPreviewDialog />
    <WindowContentDialog
      :target="shell.scanTarget"
      :canvases="workspace.canvases"
      @close="shell.scanTarget = null"
    />
    <SettingsDialog
      v-if="workspace.settings"
      :ref="
        (dialog) =>
          (scene.dialogs.settingsDialog.value = dialog as InstanceType<typeof SettingsDialog>)
      "
      :open="shell.settingsOpen"
      :settings="workspace.settings"
      :has-display-cutout="hasSafeTop"
      @close="shell.settingsOpen = false"
      @saved="workspace.sync().catch(notify.error)"
      @error="notify.error"
    />
    <AccountDialog
      :open="shell.accountOpen"
      :username="session.username"
      @close="shell.accountOpen = false"
      @saved="(name) => (session.username = name)"
    />
    <UModal
      v-if="layout.exitOpen.value"
      :open="true"
      :title="t('app.layoutUnsaved')"
      :description="t('app.layoutLeave')"
      :dismissible="!layout.busy.value"
      :close="{ disabled: layout.busy.value }"
      :ui="{ content: '[--dialog-width:28rem]', footer: 'flex-wrap' }"
      @update:open="(open) => open || layout.chooseExit('stay')"
    >
      <template v-if="layout.error.value" #body>
        <UAlert
          color="error"
          variant="subtle"
          :title="layout.error.value"
          role="alert"
          class="[overflow-wrap:anywhere]"
        />
      </template>
      <template #footer>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="layout.busy.value"
          @click="layout.chooseExit('stay')"
        >
          {{ t('app.layoutStay') }}
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="layout.busy.value"
          @click="layout.chooseExit('discard')"
        >
          {{ t('app.layoutDiscard') }}
        </UButton>
        <UButton :loading="layout.busy.value" @click="layout.chooseExit('apply')">
          {{ t('app.layoutApply') }}
        </UButton>
      </template>
    </UModal>
    <!-- One portal root for every overlay: a single layer above the shell, stacked by open order. -->
    <div :ref="shell.adoptOverlayRoot" class="overlay-root" />
    <!-- The same layer, later in the document: the cutout preview paints above dialogs. -->
    <div v-if="shell.settingsOpen && shell.mobile && hasSafeTop" class="overlay-root">
      <CutoutPreview
        :overview="!scene.custom.value"
        :captured="
          !!focus.terminal.value &&
          !!capturedApp(focus.terminal.value.sourceId, focus.terminal.value.windowId)?.visible
        "
      />
    </div>
  </div>
</template>
