export interface BrowserFiles { files: File[]; error?: 'folders' | 'unreadable' }

export function hasFileTransfer(data: DataTransfer | null): boolean {
  return !!data && (data.files.length > 0 || [...data.items].some(item => item.kind === 'file') || [...data.types].includes('Files'))
}

/** Inspect a selection as a whole; never silently upload a readable subset. */
export function readFileTransfer(data: DataTransfer | null): BrowserFiles {
  if (!data) return { files: [] }
  try {
    const items = [...data.items].filter(item => item.kind === 'file')
    if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) return { files: [], error: 'folders' }
    const files = data.files.length ? [...data.files] : items.map(item => item.getAsFile())
    if (files.some(file => file?.webkitRelativePath)) return { files: [], error: 'folders' }
    if (files.some(file => !file) || items.length > files.length || !files.length && hasFileTransfer(data))
      return { files: [], error: 'unreadable' }
    return { files: files.map(file => file!.name ? file! : new File([file!],
      file!.type === 'image/png' ? 'clipboard.png' : 'clipboard', { type: file!.type })) }
  } catch { return { files: [], error: 'unreadable' } }
}
