interface Entry { controller: AbortController; url?: string; pending?: Promise<string> }

/** Original image bytes live only for the current signed-in instance. */
export class BackgroundCache {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly load: (path: string, signal: AbortSignal) => Promise<Blob>,
    private readonly urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) {}

  peek(path: string) { return this.entries.get(path)?.url }
  get(path: string): Promise<string> {
    const existing = this.entries.get(path)
    if (existing) return existing.pending!
    const entry: Entry = { controller: new AbortController() }
    this.entries.set(path, entry)
    entry.pending = Promise.resolve().then(() => this.load(path, entry.controller.signal)).then(blob => {
      if (this.entries.get(path) !== entry) throw new DOMException('Background discarded', 'AbortError')
      return entry.url = this.urls.createObjectURL(blob)
    }).catch(error => {
      if (this.entries.get(path) === entry) this.entries.delete(path)
      throw error
    })
    return entry.pending
  }
  retain(paths: Iterable<string>) {
    const retained = new Set(paths)
    for (const [path, entry] of this.entries) if (!retained.has(path)) {
      this.entries.delete(path); entry.controller.abort()
      if (entry.url) this.urls.revokeObjectURL(entry.url)
    }
  }
  clear() { this.retain([]) }
}
