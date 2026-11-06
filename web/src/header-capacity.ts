/** The CSS action region owns available space; the menu and restore stay reachable. */
export function headerShortcuts(width: number, shortcuts: readonly string[], removable: boolean, priority: readonly string[] = shortcuts) {
  const count = Math.max(0, Math.floor((Number.isFinite(width) ? width : 0) / 44) - 2)
  const ordered = [...(removable ? ['remove'] : []), ...priority.filter(key => shortcuts.includes(key)), ...shortcuts.filter(key => !priority.includes(key)), 'add']
  return new Set(ordered.slice(0, count))
}
