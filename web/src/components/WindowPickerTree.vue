<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UCheckbox from '@nuxt/ui/components/Checkbox.vue'
import type { Source, SourceResource } from '../types'
import { pickerChecked, pickerGroups, updatePickerSelection } from '../window-picker'
import { statusColor } from '../status'
import Icon from './Icon.vue'

const props = defineProps<{ resources: SourceResource[]; sources: Source[]; query: string; selected: string[]; existing: Set<string> }>()
const emit = defineEmits<{ 'update:selected': [value: string[]] }>()
const { t, n } = useI18n()
const groups = computed(() => pickerGroups(props.sources, props.resources, props.query, props.existing))
const selected = computed(() => new Set(props.selected))
const collapsed = ref(new Set<string>())
const expanded = (key: string) => !!props.query.trim() || !collapsed.value.has(key)
function toggleGroup(key: string) {
  if (props.query.trim()) return
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  collapsed.value = next
}
function toggle(keys: string[], checked: boolean | 'indeterminate') { emit('update:selected', updatePickerSelection(props.selected, keys, checked === true)) }
const checkboxUi = { root: 'picker-checkbox', base: 'picker-checkbox-base' }
</script>

<template>
  <div class="window-picker-tree">
    <details v-for="source in groups" :key="source.id" class="picker-source" :open="expanded(source.id)">
      <summary class="picker-group-row picker-source-row" @click.prevent="toggleGroup(source.id)">
        <Icon class="picker-disclosure" name="chevron" :size="12" />
        <span @click.stop @keydown.stop><UCheckbox :model-value="pickerChecked(source.eligible, selected)" :disabled="!source.eligible.length" :aria-label="t('windowPicker.selectGroup', { name: source.name })" :ui="checkboxUi" @update:model-value="toggle(source.eligible, $event)" /></span>
        <Icon name="server" :size="14" /><strong :title="source.name">{{ source.name }}</strong><span class="picker-count">{{ n(source.spaces.reduce((count, space) => count + space.windows.length, 0)) }}</span>
      </summary>
      <details v-for="space in source.spaces" :key="space.id" class="picker-space" :open="expanded(`${source.id}/${space.id}`)">
        <summary class="picker-group-row picker-space-row" @click.prevent="toggleGroup(`${source.id}/${space.id}`)">
          <Icon class="picker-disclosure" name="chevron" :size="12" />
          <span @click.stop @keydown.stop><UCheckbox :model-value="pickerChecked(space.eligible, selected)" :disabled="!space.eligible.length" :aria-label="t('windowPicker.selectGroup', { name: space.name })" :ui="checkboxUi" @update:model-value="toggle(space.eligible, $event)" /></span>
          <Icon name="layers" :size="13" /><strong :title="space.name">{{ space.name }}</strong><span class="picker-count">{{ n(space.windows.length) }}</span>
        </summary>
        <label v-for="window in space.windows" :key="window.key" class="picker-window-row" :class="{ added: window.added }">
          <UCheckbox :model-value="!window.added && selected.has(window.key)" :disabled="window.added" :aria-label="window.name" :ui="checkboxUi" @update:model-value="toggle([window.key], $event)" />
          <span class="program-dot" :style="{ '--program-color': statusColor(window.status) }" />
          <span class="picker-window-name" :title="window.name">{{ window.name }}</span><span v-if="window.added" class="picker-added">{{ t('windowPicker.added') }}</span>
        </label>
      </details>
    </details>
    <p v-if="!groups.length" class="picker-empty">{{ t('windowPicker.empty') }}</p>
  </div>
</template>

<style>
.window-picker-tree{margin-top:12px;max-height:min(420px,calc(var(--mobile-height,var(--ui-viewport-height)) / 2));min-height:100px;overflow:auto;overscroll-behavior:contain;border:1px solid #343b47;border-radius:7px;background:#191e25;scrollbar-width:thin}
.window-picker-tree .picker-source,.window-picker-tree .picker-space,.window-picker-tree .picker-window-row{margin:0}
.picker-source+.picker-source{border-top:1px solid #303844}
.picker-group-row{list-style:none;display:flex;align-items:center;gap:8px;min-height:38px;padding:5px 10px;color:#a6b2c3;cursor:pointer;user-select:none}
.picker-group-row::-webkit-details-marker{display:none}.picker-group-row>svg{flex:none;color:#7e8ea3}
.picker-group-row strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500}
.picker-group-row:focus-visible{outline:1px solid #b99a81;outline-offset:-2px;border-radius:4px}
.picker-source[open]>.picker-group-row>.picker-disclosure,.picker-space[open]>.picker-group-row>.picker-disclosure{transform:rotate(90deg)}
.picker-source-row{background:#ffffff02}.picker-space-row{padding-left:25px;color:#939fb0;min-height:34px}
.picker-count{margin-left:auto;color:#6f7f94;font-size:10px;font-variant-numeric:tabular-nums;flex:none}
.picker-window-row{display:flex;align-items:center;gap:9px;min-height:34px;margin:0;padding:6px 12px 6px 62px;color:#b9c3d2;cursor:pointer}
.picker-window-row:hover:not(.added){background:#ffffff04}.picker-window-row.added{color:#68778b;cursor:default}
.picker-window-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.picker-added{flex:none;color:#728296;font-size:10px}.picker-checkbox{display:flex;align-items:center;flex:none}
.picker-checkbox-base{width:15px;height:15px;border-radius:3px;padding:0;gap:0}.picker-checkbox-base:disabled{cursor:default}.picker-empty{padding:28px 16px;text-align:center;color:#7d8a9d;font-size:12px}
@media(pointer:coarse){.picker-group-row,.picker-window-row{min-height:42px}.picker-window-name,.picker-group-row strong{font-size:12px}.picker-checkbox-base{width:18px;height:18px}}
</style>
