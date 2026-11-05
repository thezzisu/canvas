<script setup lang="ts">
import { computed, inject } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import { useI18n } from 'vue-i18n'
import UIcon from '@nuxt/ui/components/Icon.vue'
import { layoutEditingKey } from '../layout-editing'

const props = defineProps<{ id: string; kind: 'terminal' | 'note' | 'file' | 'app'; label: string; width: number; height: number; waiting?: boolean }>()
const layout = inject(layoutEditingKey, undefined)
const { viewport } = useVueFlow()
const { t } = useI18n()
const zoom = computed(() => viewport.value.zoom)
const selected = computed(() => layout?.selected.value === props.id)
const handles = computed(() => props.width * zoom.value >= 132 && props.height * zoom.value >= 132 ? ['right', 'bottom', 'bottom-right'] as const : ['bottom-right'] as const)
const icons = { terminal: 'i-lucide-square-terminal', note: 'i-lucide-sticky-note', file: 'i-lucide-file', app: 'i-lucide-globe' }
</script>

<template>
  <template v-if="layout?.active.value || waiting">
    <div class="card-layout-mask" :class="{ 'layout-selected': selected, 'layout-waiting': !layout?.active.value }" :style="{ '--layout-pixel': `${1 / zoom}px` }"
      :role="layout?.active.value ? 'button' : 'status'" :tabindex="layout?.active.value ? 0 : -1" :aria-label="t('app.layoutSelect')" :aria-pressed="selected"
      @click.stop="layout?.active.value && (layout.selected.value = id)" @keydown.enter.stop.prevent="layout?.active.value && (layout.selected.value = id)" @keydown.space.stop.prevent="layout?.active.value && (layout.selected.value = id)">
      <span class="layout-title" :title="label">{{ label }}</span>
      <UIcon :name="icons[kind]" class="layout-kind" />
    </div>
    <template v-if="layout?.active.value && selected && !layout.busy.value">
      <NodeResizeControl v-for="position in handles" :key="position" :node-id="id" :position="position" :auto-scale="false"
        :min-width="kind === 'terminal' || kind === 'app' ? 360 : 240" :min-height="kind === 'terminal' || kind === 'app' ? 220 : 160" :max-width="4000" :max-height="3000"
        class="layout-resize-control" :style="{ width: `${44 / zoom}px`, height: `${44 / zoom}px`, '--layout-icon-size': `${18 / zoom}px` }"
        :aria-label="t(position === 'right' ? 'app.layoutWidth' : position === 'bottom' ? 'app.layoutHeight' : 'app.layoutSize')"
        @resize-start="event => layout?.start(id, event.params)" @resize-end="event => layout?.end(id, event.params.width, event.params.height, event.params.x, event.params.y)">
        <span class="layout-resize-glyph"><UIcon :name="position === 'right' ? 'i-lucide-move-horizontal' : position === 'bottom' ? 'i-lucide-move-vertical' : 'i-lucide-move-diagonal-2'" /></span>
      </NodeResizeControl>
    </template>
  </template>
</template>

<style scoped>
.card-layout-mask{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:var(--terminal-transition-background,#1b1f26);border-radius:7px;touch-action:none;color:#b8c3d0;cursor:grab;outline:none;pointer-events:auto}
.card-layout-mask.layout-selected{box-shadow:inset 0 0 0 calc(2 * var(--layout-pixel)) var(--accent)}
.card-layout-mask.layout-waiting{pointer-events:none;cursor:default}
.layout-title{position:absolute;top:0;left:0;right:0;height:30px;line-height:30px;display:block;padding:0 10px;background:#252a32;color:#d3d8e1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #343a43;pointer-events:none}
.layout-kind{width:calc(32 * var(--layout-pixel));height:calc(32 * var(--layout-pixel));opacity:.6;pointer-events:none}
.vue-flow__resize-control.layout-resize-control{z-index:32;display:flex;align-items:center;justify-content:center;opacity:1;border:0;background:transparent;pointer-events:auto;touch-action:none}
.layout-resize-glyph{display:flex;align-items:center;justify-content:center;width:var(--layout-icon-size);height:var(--layout-icon-size);padding:calc(var(--layout-icon-size) / 3);box-sizing:content-box;background:var(--accent);color:#17191d;border-radius:50%;pointer-events:none}
.layout-resize-glyph>span,.layout-resize-glyph>svg{width:100%;height:100%}
</style>
