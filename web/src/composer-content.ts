/** Text or at least one attachment capsule; whitespace alone is empty. */
export const composerHasContent = (content: string) => !!content.trim() || content.includes('\uFFFC')

/** Filenames of the distinct attachments a draft delivers, in order. */
export function sentFiles(content: string, attachments: readonly { id: string; filename: string }[]) {
  const ids = [...new Set([...content.matchAll(/\uFFFC([\da-f-]{36})\uFFFC/giu)].map(match => match[1]!.toLowerCase()))]
  return ids.map(id => attachments.find(asset => asset.id === id)?.filename ?? '')
}
