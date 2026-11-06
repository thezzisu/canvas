import { computed, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { t } from './i18n'
import { isMarkdownFile } from './markdown'
import { textCapabilities } from './code-preview-language'

type View = Record<'rendered' | 'wrap' | 'formatted' | 'highlighted', Ref<boolean>>
/** The toolbar and its menu use the same native action items and conditions. */
export function useTextPreviewActions(filename: MaybeRefOrGetter<string>, view: View, options: {
  sourcePreview?: MaybeRefOrGetter<boolean | undefined>; busy?: MaybeRefOrGetter<boolean>; hideSite?: MaybeRefOrGetter<boolean>; preview(): void
}) {
  return computed<DropdownMenuItem[]>(() => {
    const name = toValue(filename), capabilities = textCapabilities(name), markup = isMarkdownFile(name) || capabilities.html
    const toggle = (slot: string, icon: string, model: Ref<boolean>): DropdownMenuItem => ({ slot,
      label: t(`panels.preview.${slot}`), icon, type: 'checkbox', checked: model.value, onUpdateChecked: value => { model.value = value } })
    return [
      ...(markup ? [{ slot: 'source', label: t('panels.preview.source'), title: t(view.rendered.value ? 'panels.preview.source' : 'panels.preview.rendered'), icon: 'i-lucide-code', type: 'checkbox' as const,
        checked: !view.rendered.value, onUpdateChecked: (value: boolean) => { view.rendered.value = !value } }] : []),
      ...(!markup || !view.rendered.value ? [
        ...(capabilities.format ? [toggle('format', 'i-lucide-list-tree', view.formatted)] : []),
        ...(capabilities.highlight ? [toggle('highlight', 'i-lucide-palette', view.highlighted)] : []),
        toggle('wrap', 'i-lucide-wrap-text', view.wrap),
      ] : []),
      ...(!toValue(options.hideSite) && (capabilities.html || markup) ? [{ slot: 'site', label: t('panels.preview.site'), icon: 'i-lucide-square-arrow-out-up-right',
        title: t(toValue(options.sourcePreview) ? 'panels.preview.site' : 'panels.preview.noSource'), disabled: !toValue(options.sourcePreview) || toValue(options.busy),
        loading: !!toValue(options.busy), onSelect: options.preview }] : []),
    ]
  })
}
