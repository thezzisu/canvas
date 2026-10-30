import type { Source, SourceResource, WindowResource } from './types'

export interface PickerWindow extends WindowResource { key: string; added: boolean }
export interface PickerSpace { id: string; name: string; windows: PickerWindow[]; eligible: string[] }
export interface PickerSource { id: string; name: string; spaces: PickerSpace[]; eligible: string[] }

export function pickerGroups(sources: readonly Source[], resources: readonly SourceResource[], query: string, existing: ReadonlySet<string>): PickerSource[] {
  const search = query.trim().toLocaleLowerCase()
  return sources.flatMap(source => {
    const resource = resources.find(item => item.id === source.id)
    const spaces = (resource?.spaces || []).flatMap(space => {
      const windows = space.windows.filter(window => `${source.name} ${space.name} ${window.name}`.toLocaleLowerCase().includes(search))
        .map(window => ({ ...window, key: `${source.id}/${space.id}/${window.id}`, added: existing.has(`${source.id}/${window.id}`) }))
      return windows.length ? [{ id: space.id, name: space.name, windows, eligible: windows.filter(window => !window.added).map(window => window.key) }] : []
    })
    return spaces.length ? [{ id: source.id, name: source.name, spaces, eligible: spaces.flatMap(space => space.eligible) }] : []
  })
}
export function pickerChecked(keys: readonly string[], selected: ReadonlySet<string>): boolean | 'indeterminate' {
  const count = keys.filter(key => selected.has(key)).length
  return count === 0 ? false : count === keys.length ? true : 'indeterminate'
}
export function updatePickerSelection(selected: readonly string[], keys: readonly string[], checked: boolean): string[] {
  const next = new Set(selected)
  for (const key of keys) if (checked) next.add(key); else next.delete(key)
  return [...next]
}
