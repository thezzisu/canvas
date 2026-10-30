import { execFile, spawn } from 'node:child_process'
import { sourcePythonCommand } from './providers.ts'
import { withoutFileLocation } from './content-candidates.ts'
import type { Source } from './state.ts'

const readFilePython = String.raw`import json,os,stat,sys
path=sys.argv[1]
if path.startswith('~/'): path=os.path.join(os.path.expanduser('~'),path[2:])
if not os.path.isabs(path): raise SystemExit('An absolute file path is required')
try:
 fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK)
 info=os.fstat(fd)
 if not stat.S_ISREG(info.st_mode):
  os.close(fd);raise SystemExit('Choose a regular file')
 with os.fdopen(fd,'rb') as file:
  sys.stdout.buffer.write((json.dumps({'filename':os.path.basename(path),'size':info.st_size},ensure_ascii=True)+'\n').encode('ascii'))
  sys.stdout.buffer.flush()
  remaining=info.st_size
  while remaining:
   chunk=file.read(min(65536,remaining))
   if not chunk: raise SystemExit('The file changed while reading')
   sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush();remaining-=len(chunk)
except FileNotFoundError: raise SystemExit('File not found')
except PermissionError: raise SystemExit('Cannot read this file')
except OSError: raise SystemExit('Could not read this file')
`

export interface SourceFile {
  filename: string
  size: number
  chunks: AsyncIterable<Uint8Array>
  close(): Promise<void>
}

const statFilesPython = String.raw`import json,os,stat,sys
paths=json.load(sys.stdin)
valid=[]
for index,choices in enumerate(paths):
 for choice,path in enumerate(choices):
  try:
   resolved=os.path.join(os.path.expanduser('~'),path[2:]) if path.startswith('~/') else path
   info=os.stat(resolved)
   if os.path.isabs(resolved) and stat.S_ISREG(info.st_mode): valid.append([index,choice])
   break
  except FileNotFoundError: continue
  except OSError: break
print(json.dumps(valid))`

/** A single bounded metadata check; no candidate file is opened or read. */
export function regularSourceFiles(source: Source, paths: string[], signal: AbortSignal): Promise<Map<string, string>> {
  signal.throwIfAborted()
  if (paths.length > 200 || paths.some(path => !(path.startsWith('/') || path.startsWith('~/'))
      || path.length > 8192 || /[\x00-\x1f\x7f-\x9f]/u.test(path))) throw new Error('Invalid file candidates')
  const command = sourcePythonCommand(source, statFilesPython, [])
  const candidates = paths.map(path => {
    const bare = withoutFileLocation(path)
    return path === bare ? [path] : [path, bare]
  })
  return new Promise((resolve, reject) => {
    const child = execFile(command.file, command.args, { env: command.env, signal, timeout: 5000,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error(signal.aborted ? 'Scan cancelled' : 'Could not check source files')); return }
      try {
        const indexes: unknown = JSON.parse(stdout)
        if (!Array.isArray(indexes) || indexes.some(value => !Array.isArray(value) || value.length !== 2
            || !Number.isInteger(value[0]) || !Number.isInteger(value[1]) || !candidates[value[0]]?.[value[1]]))
          throw new Error('Invalid file check response')
        resolve(new Map(indexes.map(([index, choice]) => [paths[index]!, candidates[index]![choice]!])))
      } catch { reject(new Error('Invalid file check response')) }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(candidates))
  })
}

/** One user-selected file over the configured source transport; no shell expansion. */
export async function readSourceFile(source: Source, path: string, signal: AbortSignal): Promise<SourceFile> {
  if (!(path.startsWith('/') || path.startsWith('~/')) || path.length > 8192 || /[\x00-\x1f\x7f-\x9f]/u.test(path))
    throw new Error('Invalid file path')
  signal.throwIfAborted()
  const command = sourcePythonCommand(source, readFilePython, [path])
  const child = spawn(command.file, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', ended = false, failure: Error | undefined
  let timer: ReturnType<typeof setTimeout>, killing: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (ended) return
    child.kill('SIGTERM')
    if (!killing) { killing = setTimeout(() => child.kill('SIGKILL'), 2000); killing.unref() }
  }
  const fail = (error: Error) => { failure ||= error; stop() }
  const renew = () => {
    clearTimeout(timer)
    if (ended) return
    timer = setTimeout(() => fail(new Error('File read timed out')), 60_000)
    timer.unref()
  }
  const abort = () => fail(new Error('File transfer cancelled'))
  signal.addEventListener('abort', abort, { once: true })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1200) })
  const done = new Promise<void>(resolve => {
    child.once('error', () => { failure ||= new Error('Cannot connect to the source') })
    child.once('close', code => {
      ended = true; clearTimeout(timer); clearTimeout(killing); signal.removeEventListener('abort', abort)
      if (code !== 0) failure ||= new Error(stderr.trim() || 'Could not read this file')
      resolve()
    })
  })
  renew()
  const close = async () => { clearTimeout(timer); stop(); child.stdout.destroy(); await done }
  const reader = child.stdout[Symbol.asyncIterator]()
  let header = Buffer.alloc(0), remainder = Buffer.alloc(0)
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.next()
      if (chunk.done) { await done; throw failure || new Error('Invalid file response') }
      renew()
      const bytes = Buffer.from(chunk.value), end = bytes.indexOf(10)
      header = Buffer.concat([header, end < 0 ? bytes : bytes.subarray(0, end)])
      if (header.length > 8192) throw new Error('Invalid file response')
      if (end >= 0) { remainder = bytes.subarray(end + 1); break }
    }
    const metadata: unknown = JSON.parse(header.toString())
    if (!metadata || typeof metadata !== 'object' || !('filename' in metadata) || typeof metadata.filename !== 'string'
        || !('size' in metadata) || !Number.isSafeInteger(metadata.size) || (metadata.size as number) < 0)
      throw new Error('Invalid file response')
    const filename = metadata.filename, size = metadata.size as number
    async function* chunks() {
      let received = 0
      try {
        if (remainder.length) {
          signal.throwIfAborted(); received += remainder.length
          if (received > size) throw new Error('File size changed while reading')
          yield remainder
        }
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.next()
          if (chunk.done) break
          renew()
          received += chunk.value.length
          if (received > size) throw new Error('File size changed while reading')
          yield chunk.value
        }
        await done
        signal.throwIfAborted()
        if (failure) throw failure
        if (received !== size) throw new Error('Incomplete file response')
      } finally { await close() }
    }
    return { filename, size, chunks: chunks(), close }
  } catch (error) { await close(); throw failure || error }
}
