<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { segment, write } from '../../api/api'
import { notify } from '../../composables/notify'
import { useCanvasScene } from '../../composables/canvas/scene/scene'

// Floating camera controls. They yield to a terminal they overlap while it has focus.
const { t } = useI18n()
const scene = useCanvasScene()
const { workspace, shell, camera, paging } = scene
const fullscreen = camera.navigation.fullscreen
const size = computed(() => (shell.mobile ? 'lg' : 'sm'))
const fitLabel = computed(() =>
  t(
    paging.active.value
      ? 'app.centerWindow'
      : camera.fitsCard.value
        ? 'app.fitWindow'
        : 'app.fitCanvas',
  ),
)
const fitIcon = computed(() =>
  paging.active.value
    ? 'i-lucide-locate-fixed'
    : camera.fitsCard.value
      ? 'i-lucide-focus'
      : 'i-lucide-scan',
)
async function toggleSnap() {
  const canvas = scene.canvas.value
  if (!canvas) return
  try {
    await write(`/api/canvases/${segment(canvas.id)}`, 'PATCH', { snapToGrid: !canvas.snapToGrid })
    await workspace.sync()
  } catch (reason) {
    notify.error(reason)
  }
}
/** Stock toolbar buttons; a switched-on mode is shown filled. */
const control = (pressed?: boolean) => ({
  color: 'neutral' as const,
  variant: pressed ? ('soft' as const) : ('ghost' as const),
  size: size.value,
  square: true,
  'aria-pressed': pressed,
})
</script>

<template>
  <div
    :ref="(element) => (camera.toolbar.value = element as HTMLElement)"
    class="canvas-toolbar"
    role="toolbar"
    :aria-label="t('app.navigation')"
    :data-terminal-overlap="camera.toolbarOverlap.value"
    :data-touch="shell.mobile || undefined"
  >
    <UButton
      v-if="fullscreen"
      v-bind="control()"
      icon="i-lucide-menu"
      :title="t('app.openCanvasList')"
      :aria-label="t('app.openCanvasList')"
      aria-controls="canvas-sidebar"
      :aria-expanded="shell.sidebarOpen"
      @click="shell.sidebarOpen = !shell.sidebarOpen"
    />
    <UButton
      v-bind="control(fullscreen)"
      :icon="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
      :title="t(fullscreen ? 'app.exitFullscreen' : 'app.fullscreen')"
      :aria-label="t(fullscreen ? 'app.exitFullscreen' : 'app.fullscreen')"
      @click="camera.navigation.toggleFullscreen"
    />
    <UButton
      v-if="scene.kind.value === 'overview'"
      v-bind="control(paging.overviewPaged.value)"
      icon="i-lucide-gallery-horizontal"
      :title="t('app.pagedBrowsing')"
      :aria-label="t('app.pagedBrowsing')"
      @click="paging.toggle"
    />
    <UButton
      v-if="scene.custom.value"
      v-bind="control(!!scene.canvas.value?.snapToGrid)"
      icon="i-lucide-magnet"
      :title="t('app.snapToGrid')"
      :aria-label="t('app.snapToGrid')"
      @click="toggleSnap"
    />
    <template v-if="paging.active.value">
      <UButton
        v-for="item in paging.directions.value"
        :key="item.direction"
        v-bind="control()"
        :icon="item.icon"
        :title="item.label"
        :aria-label="item.label"
        :disabled="!paging.neighbor(item.direction)"
        @pointerdown.prevent
        @click="paging.move(item.direction)"
      />
    </template>
    <UButton
      v-if="!paging.active.value"
      v-bind="control()"
      icon="i-lucide-zoom-out"
      :title="t('app.zoomOut')"
      :aria-label="t('app.zoomOut')"
      @click="camera.zoomOut"
    />
    <UButton
      v-bind="control()"
      class="canvas-fit"
      :icon="fitIcon"
      :disabled="!scene.graph.nodes.value.length"
      data-preserve-content-focus
      :title="fitLabel"
      :aria-label="fitLabel"
      @pointerdown.prevent
      @click="camera.fit"
    />
    <UButton
      v-if="!paging.active.value"
      v-bind="control()"
      icon="i-lucide-zoom-in"
      :title="t('app.zoomIn')"
      :aria-label="t('app.zoomIn')"
      @click="camera.zoomIn"
    />
  </div>
</template>

<style scoped>
.canvas-toolbar {
  position: absolute;
  left: 27px;
  bottom: 25px;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 54px);
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-elevated);
  box-shadow: 0 4px 13px #0003;
  /* The graph surface cancels the interface scale; its controls take it back. */
  zoom: var(--ui-zoom);
}
.canvas-toolbar[data-touch] {
  left: max(10px, var(--ui-safe-left));
  bottom: max(10px, var(--ui-safe-bottom));
  max-width: calc(100% - 20px);
}
</style>
