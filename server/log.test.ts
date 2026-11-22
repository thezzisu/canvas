import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const run = promisify(execFile)

/** Runs `body` in a server process of its own, with the environment and flags given. */
async function server(body: string, env: Record<string, string> = {}, flags: string[] = []) {
  const script = `import { log, warn, announceLogging, watchEventLoop } from './server/log.ts';\n${body}`
  const { stdout, stderr } = await run(
    process.execPath,
    [...flags, '--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: sourceRoot, env: { PATH: process.env.PATH || '/usr/bin:/bin', ...env } },
  )
  return { stdout, stderr }
}
const lines = (stderr: string) =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)

test('detail is written only for the categories NODE_DEBUG names, in the shared line format', async () => {
  const body = `announceLogging();
log('link', 'socket', { state: 'open' });
log('source', 'probe', { state: 'ok' });`
  const off = await server(body)
  assert.equal(off.stderr, '')
  const link = await server(body, { NODE_DEBUG: 'canvas:link' })
  assert.match(link.stderr, /^Canvas diagnostics: canvas:link\n/u)
  const written = lines(link.stderr)
  assert.equal(written.length, 1)
  const [line] = written
  assert.deepEqual(Object.keys(line!), ['t', 'm', 's', 'e', 'state'])
  assert.equal(line!.e, 'socket')
  const all = await server(body, { NODE_DEBUG: 'canvas:*' })
  assert.match(all.stderr, /^Canvas diagnostics: canvas:link, canvas:source\n/u)
  assert.deepEqual(
    lines(all.stderr).map((line) => line.e),
    ['socket', 'probe'],
  )
  // A misspelt category turns nothing on, and no diagnostics line says otherwise.
  assert.equal((await server(body, { NODE_DEBUG: 'canvas:lnk' })).stderr, '')
})

test('problems are CanvasWarnings, shown by default and silenced by disabling that type', async () => {
  const body = `process.on('warning', (w) => console.log(w.name + ' ' + w.code));
warn('CANVAS_TUNNEL', 'socket', { state: 'close' });`
  const shown = await server(body)
  assert.equal(shown.stdout.trim(), 'CanvasWarning CANVAS_TUNNEL')
  assert.match(
    shown.stderr,
    /\[CANVAS_TUNNEL\] CanvasWarning: \{"t":.*"e":"socket","state":"close"\}/u,
  )
  const silenced = await server(body, {}, ['--disable-warning=CanvasWarning'])
  // The warning is still raised for whoever listens; only its printing stops.
  assert.equal(silenced.stdout.trim(), 'CanvasWarning CANVAS_TUNNEL')
  assert.equal(silenced.stderr, '')
})

test('an event loop held for a quarter second or more is a warning', async () => {
  const { stdout } =
    await server(`process.on('warning', (w) => console.log(w.code + ' ' + JSON.parse(w.message).ms));
const watch = watchEventLoop();
await new Promise((resolve) => setTimeout(resolve, 150));
const end = performance.now() + 400;
while (performance.now() < end);
await new Promise((resolve) => setTimeout(resolve, 150));
watch[Symbol.dispose]();`)
  const [code, ms] = stdout.trim().split(' ')
  assert.equal(code, 'CANVAS_EVENT_LOOP')
  assert(Number(ms) >= 250, stdout)
})
