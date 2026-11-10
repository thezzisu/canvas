/** Text or at least one attachment capsule; whitespace alone is empty. */
export const composerHasContent = (content: string) => !!content.trim() || content.includes('￼')

/** Filenames of the distinct attachments a draft delivers, in order. */
export function sentFiles(content: string, attachments: readonly { id: string; filename: string }[]) {
  const ids = [...new Set([...content.matchAll(/￼([\da-f-]{36})￼/giu)].map(match => match[1]!.toLowerCase()))]
  return ids.map(id => attachments.find(asset => asset.id === id)?.filename ?? '')
}
