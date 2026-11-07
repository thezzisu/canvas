import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CaptureLease } from './capture.ts'
import { CaptureService } from './capture.ts'
import { normalizeCapturePublicBase } from './capture-address.ts'
import { sourcePythonCommand } from './runtimes.ts'
import { sourceConnectionKey, type FileOrigin, type Source, type Store } from './state.ts'

export class SourcePreviewError extends Error {
  constructor(readonly code: 'source-preview-unavailable' | 'source-preview-start-failed') {
    super(code === 'source-preview-unavailable' ? 'Original source is unavailable; open the file again from its source' : 'Could not start the original preview')
  }
}
interface Preview {
  origin: FileOrigin
  session: string
  child: ChildProcessWithoutNullStreams
  lease?: CaptureLease
  ready: Promise<{ id: string; url: string }>
  ended: Promise<void>
  stop(): void
}

/** Browser previews own a small source-side static server, independent of any shell. */
export class SourcePreviewService {
  private previews = new Map<string, Preview>()
  private closing = new Set<Promise<void>>()
  private closed = false
  private readonly script: string
  constructor(private readonly store: Store, private readonly captures: CaptureService, helper: string,
    private readonly idleTtlMs = 30 * 60_000) {
    this.script = `import sys\nscope = {"__name__": "canvas_preview"}\nexec(${JSON.stringify(helper)}, scope)\nscope["serve_file_preview"](sys.argv[1])`
    store.on('sessions', this.prune); store.on('change', this.prune)
  }
  private source(origin: FileOrigin, session: string): Source {
    const source = this.store.get<Source>('source', origin.sourceId)
    if (this.closed || !this.store.hasSession(session) || !source || sourceConnectionKey(source) !== origin.sourceKey)
      throw new SourcePreviewError('source-preview-unavailable')
    return source
  }
  private prune = () => {
    for (const preview of this.previews.values()) {
      try { this.source(preview.origin, preview.session) }
      catch { preview.stop() }
    }
  }
  async open(origin: FileOrigin | undefined, session: string, publicBase: string): Promise<{ id: string; url: string }> {
    if (!origin || !/\.(?:html?|md|markdown|mdown|mkdn?|mdx)$/iu.test(origin.path)) throw new SourcePreviewError('source-preview-unavailable')
    const source = this.source(origin, session), base = normalizeCapturePublicBase(publicBase)
    const key = JSON.stringify([session, origin.sourceKey, origin.path, base])
    const existing = this.previews.get(key)
    if (existing) {
      const result = await existing.ready
      await existing.lease!.ready(result.url)
      return result
    }
    if (this.previews.size >= 32) throw new SourcePreviewError('source-preview-start-failed')
    const command = sourcePythonCommand(source, this.script, [origin.path])
    const child = spawn(command.file, command.args, { env: command.env, stdio: ['pipe', 'pipe', 'pipe'] })
    // Drain transport diagnostics without exposing host paths or SSH details to the browser.
    child.stderr.resume(); child.stdin.on('error', () => {})
    let stopped = false
    const preview: Preview = { origin, session, child, ready: undefined!, ended: undefined!, stop: () => {
      if (stopped) return
      stopped = true
      this.previews.delete(key)
      preview.lease?.close()
      child.stdin.end()
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000); kill.unref()
      this.closing.add(preview.ended)
      void preview.ended.finally(() => { clearTimeout(kill); this.closing.delete(preview.ended) })
    } }
    preview.ended = new Promise(resolve => child.once('close', () => { preview.stop(); resolve() }))
    this.previews.set(key, preview)
    preview.ready = (async () => {
      try {
        const { port, path } = await new Promise<{ port: number; path: string }>((resolve, reject) => {
          let pending = ''
          const failed = () => { cleanup(); reject(new SourcePreviewError('source-preview-start-failed')) }
          const timer = setTimeout(failed, 15_000); timer.unref()
          const data = (chunk: Buffer) => {
            pending += chunk.toString('utf8')
            if (pending.length > 16_384) return failed()
            const newline = pending.indexOf('\n')
            if (newline < 0) return
            try {
              const value = JSON.parse(pending.slice(0, newline))
              if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
                || typeof value.path !== 'string' || !/^\/(?:[A-Za-z0-9_.~-]|%[A-Fa-f0-9]{2})+$/u.test(value.path)) return failed()
              cleanup(); resolve(value)
            } catch { failed() }
          }
          const cleanup = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('error', failed); child.off('close', failed) }
          child.stdout.on('data', data); child.once('error', failed); child.once('close', failed)
        })
        child.stdout.resume()
        if (stopped) throw new SourcePreviewError('source-preview-unavailable')
        this.source(origin, session)
        preview.lease = this.captures.prepareCapture(source, { publicBase: base, port, session,
          preview: 'static',
          idleTtlMs: this.idleTtlMs, onStop: preview.stop, onEnded: preview.stop })
        const ready = await preview.lease.ready(`http://127.0.0.1:${port}${path}`)
        return { id: ready.id, url: ready.url }
      } catch (error) {
        preview.stop()
        if (error instanceof SourcePreviewError) throw error
        throw new SourcePreviewError('source-preview-start-failed')
      }
    })()
    return preview.ready
  }
  async close(): Promise<void> {
    this.closed = true
    this.store.off('sessions', this.prune); this.store.off('change', this.prune)
    const previews = [...this.previews.values()]
    for (const preview of previews) preview.stop()
    await Promise.all(this.closing)
  }
}
