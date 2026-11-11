<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { VueFlow } from '@vue-flow/core'
import UButton from '@nuxt/ui/components/Button.vue'
import UEmpty from '@nuxt/ui/components/Empty.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import FileNode from '../files/FileNode.vue'
import { noteColor, statusColor } from '../lib/status'
import NoteNode from '../notes/NoteNode.vue'
import { contentFontReady } from '../settings/content-font'
import TerminalNode from '../terminal/TerminalNode.vue'
import { useBackgroundUrl } from '../workspace/backgrounds'
import { needsAttention } from '../workspace/canvas-status'
import { editSource } from '../workspace/dialogs'
import CanvasFileDrop from './CanvasFileDrop.vue'
import CanvasMiniMap from './CanvasMiniMap.vue'
import CanvasToolbar from './CanvasToolbar.vue'
import GroupNode from './GroupNode.vue'
import OverviewCreateNode from './OverviewCreateNode.vue'
import { useCanvasScene } from './scene/scene'
import type { Node } from '@vue-flow/core'

// The graph itself: cards on a pannable surface, with its minimap, toolbar and empty states.
const { t } = useI18n()
const scene = useCanvasScene()
const { workspace, shell, view, camera, graph, layout, paging, focus, morph } = scene
const { nodes, getViewport } = scene.flow
const navigation = camera.navigation
const fileDrop = useTemplateRef('fileDrop')
defineExpose({ fileDrop })

/** System canvases share one background; each custom canvas has its own. */
const background = computed(() =>
  scene.custom.value ? scene.canvas.value?.background : workspace.overviewBackground,
)
const { url: backgroundUrl, material } = useBackgroundUrl(() => background.value?.url, {
  material: true,
})
/** What a terminal shows before its first frame: the wallpaper as seen through the canvas. */
const terminalMaterial = computed(() => {
  const tint = `rgb(27 31 38 / ${1 - (background.value?.opacity ?? 0)})`
  return {
    '--terminal-transition-background': material.value
      ? `linear-gradient(${tint}, ${tint}), url("${material.value}") center / cover #1b1f26`
      : '#1b1f26',
  }
})
const status = computed(() =>
  workspace.pending ||
  (!contentFontReady.value && (nodes.value.length || focus.maximized.value)) ||
  (!nodes.value.length && workspace.undiscoveredSources.length)
    ? workspace.loadFailure
      ? 'failed'
      : 'loading'
    : undefined,
)
/** Why there is nothing to show, and the one thing to do about it. */
const empty = computed(() => {
  if (status.value || nodes.value.length) return
  if (scene.kind.value === 'working-set')
    return { icon: 'i-lucide-history', title: t('app.noWindows') }
  if (scene.custom.value)
    return {
      icon: 'i-lucide-layout-dashboard',
      title: t('app.emptyCanvas'),
      action: {
        label: t('app.addWindows'),
        icon: 'i-lucide-layers',
        onClick: () => scene.cards.addToCanvas(),
      },
    }
  if (workspace.allWindows.length && view.filtered)
    return {
      icon: 'i-lucide-list-filter',
      title: t('app.noMatchingWindows'),
      action: {
        label: t('app.clearFilters'),
        color: 'neutral' as const,
        variant: 'subtle' as const,
        onClick: view.clearFilters,
      },
    }
  return workspace.sources.length
    ? {
        icon: 'i-lucide-server',
        title: t('app.noWindows'),
        action: {
          label: t('app.connections'),
          icon: 'i-lucide-server',
          onClick: () => {
            shell.connectionsOpen = true
          },
        },
      }
    : {
        icon: 'i-lucide-server',
        title: t('app.noConnections'),
        action: {
          label: t('app.addConnection'),
          icon: 'i-lucide-plus',
          onClick: () => void editSource(),
        },
      }
})
const pageId = (node: Node) => `${node.data.sourceId}/${node.data.windowId}`
function minimapClass(node: Node) {
  if (node.type === 'terminal')
    return [
      'minimap-card minimap-window',
      node.data.statusFresh && needsAttention(node.data.status) && 'minimap-pulse',
      paging.active.value && paging.current.value?.id === pageId(node) && 'minimap-current',
    ]
      .filter(Boolean)
      .join(' ')
  return node.type === 'note' || node.type === 'file' ? 'minimap-card' : 'minimap-decoration'
}
function minimapColor(node: Node) {
  if (node.type === 'terminal') return statusColor(node.data.status)
  if (node.type === 'note') return noteColor(node.data.color)
  return node.type === 'file' ? '#8796b3' : 'transparent'
}
</script>

<template>
  <div
    :ref="(element) => (navigation.surface.value = element as HTMLElement)"
    :inert="scene.menus.create.value || layout.busy.value || undefined"
    class="graph-wrap"
    :class="[
      {
        'has-background': background,
        paged: paging.active.value,
        'layout-editing': layout.editing.value,
      },
      morph.state.value && `canvas-morph-${morph.state.value.phase}`,
    ]"
    :style="[
      terminalMaterial,
      morph.state.value && { '--canvas-morph-shift': `${morph.state.value.shift}px` },
    ]"
    :data-page-window="paging.active.value ? paging.current.value?.id : undefined"
    @focusout.capture="camera.preserveFitTarget"
    @mousedown.capture="camera.guardMiddleDrag"
    @wheel.capture="navigation.wheel"
    @touchstart.capture="navigation.touchStart"
    @touchmove.capture="navigation.touchMove"
    @touchend.capture="navigation.touchEnd"
    @touchcancel.capture="navigation.touchCancel"
    @click.capture="navigation.click"
  >
    <CanvasFileDrop
      v-if="!layout.editing.value"
      ref="fileDrop"
      :canvas-id="scene.canvas.value?.id"
      :canvas-name="scene.canvas.value?.name"
      :get-viewport="getViewport"
    />
    <img
      v-if="background && backgroundUrl"
      class="canvas-background"
      :src="backgroundUrl"
      :style="{ opacity: background.opacity }"
      alt=""
      aria-hidden="true"
    />
    <span id="canvas-card-select-help" hidden>{{ t('app.cardSelectHelp') }}</span>
    <span id="canvas-card-move-help" hidden>{{ t('app.cardMoveHelp') }}</span>
    <div
      v-if="layout.editing.value"
      class="layout-edit-bar"
      role="toolbar"
      :aria-label="t('app.layoutEdit')"
    >
      <span class="me-auto text-sm">{{ t('app.layoutEdit') }}</span>
      <span v-if="layout.error.value" class="max-w-[45%] text-xs text-error" role="alert">
        {{ layout.error.value }}
      </span>
      <UButton
        color="neutral"
        variant="outline"
        size="xl"
        :disabled="layout.busy.value"
        @click="layout.discard"
      >
        {{ t('common.cancel') }}
      </UButton>
      <UButton size="xl" :loading="layout.busy.value" @click="layout.apply">
        {{ t('app.layoutApply') }}
      </UButton>
    </div>
    <div class="canvas-layout-layer absolute inset-0">
      <!-- A maximized card takes the terminal views with it, so the graph steps aside. -->
      <VueFlow
        v-if="contentFontReady && nodes.length && !focus.maximized.value"
        :key="graph.key.value"
        :style="{ '--card-resize-hit': `${8 / Math.min(getViewport().zoom, 1)}px` }"
        :snap-to-grid="false"
        :apply-default="false"
        :min-zoom="0.08"
        :max-zoom="2"
        :nodes-connectable="false"
        :nodes-draggable="scene.custom.value && (!shell.mobile || layout.editing.value)"
        :elements-selectable="!shell.mobile"
        :zoom-on-double-click="false"
        :zoom-on-scroll="false"
        :zoom-on-pinch="false"
        :pan-on-scroll="false"
        :delete-key-code="null"
        :selection-key-code="null"
        :pan-on-drag="!shell.mobile && !paging.active.value"
        :pan-activation-key-code="paging.active.value ? null : 'Space'"
        :prevent-scrolling="true"
        @pane-click="layout.selected.value = ''"
        @node-drag-start="layout.dragStart"
        @node-drag="layout.snapDrag"
        @node-drag-stop="layout.dragStop"
        @move-end="camera.save"
        @init="camera.restore"
        @nodes-initialized="camera.nodesInitialized"
        @nodes-change="layout.change"
      >
        <template #node-terminal="nodeProps"><TerminalNode v-bind="nodeProps" /></template>
        <template #node-note="nodeProps"><NoteNode v-bind="nodeProps" /></template>
        <template #node-file="nodeProps"><FileNode v-bind="nodeProps" /></template>
        <template #node-group="nodeProps"><GroupNode v-bind="nodeProps" /></template>
        <template #node-create="nodeProps"><OverviewCreateNode v-bind="nodeProps" /></template>
        <CanvasMiniMap
          v-if="view.minimap"
          :ref="(element) => (camera.minimap.value = element as { $el: HTMLElement })"
          :data-terminal-overlap="camera.minimapOverlap.value"
          :aria-label="t('app.windowNavigation')"
          :width="shell.mobile ? 96 : 150"
          :height="shell.mobile ? 64 : 98"
          :position="shell.mobile ? 'top-right' : 'bottom-right'"
          :node-class-name="minimapClass"
          :node-color="minimapColor"
          :node-stroke-width="0"
          mask-color="rgba(17,19,23,.7)"
          :pannable="!paging.active.value"
          :zoomable="!shell.mobile && !paging.active.value"
          @node-click="camera.showFromMinimap"
        />
      </VueFlow>
      <div
        v-if="status"
        class="absolute inset-0 flex items-center justify-center gap-3 text-sm text-muted"
        :class="{ 'flex-col': status === 'failed' }"
        role="status"
      >
        <template v-if="status === 'failed'">
          <span
            :title="
              workspace.loadFailure instanceof Error ? workspace.loadFailure.message : undefined
            "
          >
            {{ t('app.loadFailed') }}
          </span>
          <UButton color="neutral" variant="subtle" @click="workspace.load">
            {{ t('common.retry') }}
          </UButton>
        </template>
        <template v-else>
          <UIcon name="i-lucide-loader-circle" class="size-3.5 shrink-0 motion-safe:animate-spin" />
          {{ t('common.loading') }}
        </template>
      </div>
      <UEmpty
        v-else-if="empty"
        class="empty-state absolute inset-0"
        variant="naked"
        :icon="empty.icon"
        :title="empty.title"
        :actions="empty.action ? [empty.action] : undefined"
      />
    </div>
    <UButton
      v-if="navigation.fullscreen.value && !view.navigation && !focus.terminal.value"
      class="absolute left-[max(10px,var(--ui-safe-left))] top-[max(10px,var(--ui-safe-top))] z-[5]"
      icon="i-lucide-minimize"
      color="neutral"
      variant="subtle"
      size="xl"
      :title="t('app.exitFullscreen')"
      :aria-label="t('app.exitFullscreen')"
      @click="navigation.exitFullscreen"
    />
    <CanvasToolbar
      v-if="!workspace.pending && view.navigation && !focus.terminal.value && !layout.editing.value"
    />
  </div>
</template>

<style scoped>
.layout-edit-bar {
  position: absolute;
  inset: auto 12px 12px;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-elevated);
  zoom: var(--ui-zoom);
}
</style>
