import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contentCandidates } from './content-candidates.ts'
import { windowContent, readWindowContent, type NativeContentPane } from './herdr/content.ts'
import type { ClientShellSnapshot, FrameData, PaneSurfaceFrame } from './herdr/wire.ts'
import { readSourceFile } from './source-file.ts'
import { WindowContentService, type WindowContentOptions } from './window-content.ts'
import { OpenDownloadService } from './open-download.ts'
import { Store, type Canvas, type Source } from './state.ts'
import { AssetStore } from './assets.ts'
import { createApp } from './app.ts'
import type { TerminalManager } from './terminals.ts'
import type { WindowContentScan, WindowContentOpen } from '../shared/window-content.ts'

function pane(lines: string[], cwd?: string, id = 'pane'): NativeContentPane {
  return { id, name: id, ...(cwd ? { cwd } : {}), lines, links: [] }
}

test('candidate scan preserves pane cwd, quoted spaces, Unicode, OSC 8 and literal shell characters', () => {
  const first = pane([
    'saved ./out.png and "some dir/图像.png" and `report one.txt`',
    'escaped\\ file.txt ../parent.pdf /tmp/absolute.png,',
    '"/tmp/literal $(command).txt" "file name;still.txt"',
    'https://example.test/docs?q=1#part and (https://example.test/a(b)).',
    './out.png',
  ], '/work/one', 'a')
  first.links = [{ label: 'Documentation', url: 'https://example.test/docs?q=1#part' },
    { label: 'hidden', url: 'javascript:alert(1)' }, { label: 'data', url: 'data:text/plain,no' }]
  const scan = contentCandidates([first, pane(['./out.png', '~/picture.png'], '/work/two', 'b'), pane(['relative.txt', '/tmp/ok.txt'])])
  assert.equal(scan.truncated, false)
  const paths = scan.panes.map(group => group.items.filter(item => item.kind === 'file').map(item => item.path))
  assert.deepEqual(paths, [
    ['/work/one/some dir/图像.png', '/work/one/report one.txt', '/work/one/out.png', '/work/one/escaped file.txt', '/work/parent.pdf', '/tmp/absolute.png', '/tmp/literal $(command).txt', '/work/one/file name;still.txt'],
    ['/work/two/out.png', '~/picture.png'], [null, '/tmp/ok.txt'],
  ])
  const links = scan.panes.flatMap(group => group.items).filter(item => item.kind === 'link')
  assert.equal(links.length, 2)
  assert.equal(links[0]!.label, 'Documentation')
  assert.equal(links[1]!.url, 'https://example.test/a(b)')
  assert.equal(new Set(scan.panes.flatMap(group => group.items.map(item => item.id))).size,
    scan.panes.flatMap(group => group.items).length)
})

test('candidate scan bounds results and never guesses joins between supplied lines or panes', () => {
  const scan = contentCandidates([pane(['/tmp/long', 'file.png'], '/a'), pane(['./part', 'two.txt'], '/b')])
  assert(!scan.panes.flatMap(group => group.items).some(item => item.kind === 'file' && item.path?.includes('longfile')))
  assert.deepEqual(scan.panes[1]!.items.filter(item => item.kind === 'file').map(item => item.path), ['/b/part', '/b/two.txt'])
  const limited = contentCandidates([pane(Array.from({ length: 205 }, (_, i) => `/tmp/${i}.txt`))])
  assert.equal(limited.truncated, true)
  assert.equal(limited.panes[0]!.items.length, 200)
})

function nativeFrame(): { surface: PaneSurfaceFrame; snapshot: ClientShellSnapshot } {
  const frame: FrameData = { width: 64, height: 3, cells: Array.from({ length: 192 }, () => ({ symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })),
    cursor: null, hyperlinks: ['https://example.test/original'], graphics: Buffer.alloc(0) }
  const text = (x: number, y: number, value: string, hyperlink: number | null = null) => {
    for (const [i, symbol] of [...value].entries()) frame.cells[y * 64 + x + i] = { ...frame.cells[y * 64 + x + i]!, symbol, hyperlink }
  }
  text(0, 0, '/outside.txt'); text(1, 1, './left.txt'); text(34, 1, './right.txt'); text(1, 2, 'Open', 0)
  const panes = ['a', 'b'].map((id, i) => ({ pane_id: id, content_revision: 1,
    rect: { x: i * 33, y: 0, width: 31, height: 3 }, inner_rect: { x: 1 + i * 33, y: 1, width: 29, height: 2 },
    scrollbar_rect: null, scroll: null, focused: !i, mouse_reporting: false, sgr_pixel_mouse: false, alternate_screen_active: false, pixel_width: 0, pixel_height: 0 }))
  const surface: PaneSurfaceFrame = { boot_id: 'boot', projection_revision: 1, surface_revision: 1, frame, panes, splits: [], popup: null }
  const snapshot: ClientShellSnapshot = { boot_id: 'boot', revision: 1, focused_workspace_id: 'space', focused_tab_id: 'window', focused_pane_id: 'a',
    tabs: [{ tab_id: 'window', workspace_id: 'space', focused: true }],
    panes: [{ pane_id: 'a', tab_id: 'window', workspace_id: 'space', focused: true, right_click_passthrough: false, cwd: '/one', label: 'Left' },
      { pane_id: 'b', tab_id: 'window', workspace_id: 'space', focused: false, right_click_passthrough: false, cwd: 'not/absolute', label: 'Right' },
      { pane_id: 'hidden', tab_id: 'other-window', workspace_id: 'space', focused: false, right_click_passthrough: false, cwd: '/hidden' }] }
  return { surface, snapshot }
}

test('native snapshot scan reads pane inner rectangles and their OSC 8 targets only', () => {
  const { surface, snapshot } = nativeFrame()
  const panes = windowContent(surface, snapshot, 'window')
  assert.equal(panes.length, 2)
  assert.deepEqual(panes[0], { id: 'a', name: 'Left', cwd: '/one', lines: ['./left.txt', 'Open'], links: [{ label: 'Open', url: 'https://example.test/original' }] })
  assert.equal(panes[1]!.cwd, undefined)
  assert(!JSON.stringify(panes).includes('/outside.txt'))
  assert(!JSON.stringify(panes).includes('/hidden'))
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 29; x++) surface.frame.cells[y * 64 + x]!.modifier = 128
  const concealed = windowContent(surface, snapshot, 'window')[0]!
  assert.deepEqual(concealed.lines, ['', ''])
  assert.deepEqual(concealed.links, [])
})

test('native popup scan does not reveal underlying pane content or inherit its cwd', async () => {
  const { surface, snapshot } = nativeFrame()
  surface.frame.height = 10
  surface.frame.cells.push(...Array.from({ length: 64 * 7 }, () => ({ symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })))
  surface.popup = { terminal_id: 'popup', title: 'Choose file', width: { Cells: 20 }, height: { Cells: 1 },
    frame: { width: 20, height: 1, cells: Array.from({ length: 20 }, (_, i) => ({ symbol: '/tmp/popup.txt'[i] || ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })),
      cursor: null, hyperlinks: [], graphics: Buffer.alloc(0) }, mouse_reporting: false, sgr_pixel_mouse: false, pixel_width: 0, pixel_height: 0 }
  const panes = windowContent(surface, snapshot, 'window')
  assert.equal(panes.length, 1)
  assert.equal(panes[0]!.id, 'popup')
  assert.equal(panes[0]!.cwd, undefined)
  assert(!JSON.stringify(panes).includes('left.txt'))
  const result = await readWindowContent(surface, snapshot, 'window', async () => { assert.fail('popup scan must not read underlying panes') })
  assert.deepEqual(result, panes)
})

test('native formatted scan reads exact visible absolute rows and preserves hard breaks and OSC 8', async () => {
  const { surface, snapshot } = nativeFrame()
  surface.panes[0]!.scroll = { max_offset_from_bottom: 90, offset_from_bottom: 25, viewport_rows: 2 }
  const calls: Record<string, unknown>[] = []
  const result = await readWindowContent(surface, snapshot, 'window', async params => {
    calls.push(params)
    return { pane_id: params.pane_id, text: params.pane_id === 'a' ? '/tmp/long-native-soft-wrapped-path.png\nHARD_ONE\nHARD_TWO' : './right.txt' }
  })
  assert.deepEqual(calls, [
    { pane_id: 'a', content_revision: 1, anchor: { row: 65, col: 0 }, cursor: { row: 66, col: 28 } },
    { pane_id: 'b', content_revision: 1, anchor: { row: 0, col: 0 }, cursor: { row: 1, col: 28 } },
  ])
  assert.deepEqual(result[0]!.lines, ['/tmp/long-native-soft-wrapped-path.png', 'HARD_ONE', 'HARD_TWO'])
  assert.deepEqual(result[0]!.links, [{ label: 'Open', url: 'https://example.test/original' }])
  assert.deepEqual(result[1]!.lines, ['./right.txt'])
})

test('formatted scan never reads concealed panes and rejects stale or mismatched responses', async () => {
  const { surface, snapshot } = nativeFrame()
  surface.frame.cells[65]!.modifier = 128
  const calls: string[] = []
  const result = await readWindowContent(surface, snapshot, 'window', async params => {
    calls.push(String(params.pane_id)); return { pane_id: 'b', text: 'right.txt' }
  })
  assert.deepEqual(calls, ['b'])
  assert.equal(result[0]!.lines[0], ' /left.txt')
  await assert.rejects(readWindowContent(surface, snapshot, 'window', async () => { throw new Error('stale_content') }), /scan again/)
  await assert.rejects(readWindowContent(surface, snapshot, 'window', async () => ({ pane_id: 'other', text: 'foreign' })), /Invalid window content/)
})

test('native content paths prefer the foreground process directory and validate shell fallback', () => {
  const { surface, snapshot } = nativeFrame(), metadata = snapshot.panes[0]!
  metadata.foreground_cwd = '/agent/work'
  assert.equal(windowContent(surface, snapshot, 'window')[0]!.cwd, '/agent/work')
  metadata.foreground_cwd = 'relative'
  assert.equal(windowContent(surface, snapshot, 'window')[0]!.cwd, '/one')
  metadata.foreground_cwd = '/bad\npath'; metadata.cwd = null
  assert.equal(windowContent(surface, snapshot, 'window')[0]!.cwd, undefined)
})

async function fixture(t: TestContext, readFileOverride?: WindowContentOptions['readFile']) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-content-'))
  const store = new Store(join(root, 'canvas.db')), assets = new AssetStore(root, store)
  const source: Source = { id: randomUUID(), name: 'Fixture', transport: 'local' }
  store.put('source', source); store.addSession('first-session'); store.addSession('other-session')
  const canvas = store.put<Canvas>('canvas', { id: randomUUID(), name: 'Files', nodes: [{
    id: 'anchor', type: 'terminal', sourceId: source.id, spaceId: 'space', windowId: 'window', x: 10, y: 20, width: 480, height: 302,
  }] })
  const downloads = new OpenDownloadService({ createUpload: input => assets.begin(input), readTemporary: id => assets.readTemporary(id),
    prepare: async () => { throw new Error('No bridge may be created by scanning') }, resources: async () => { throw new Error('No remote scan requests') }, recipient: async () => undefined })
  let content: NativeContentPane[] | undefined = [pane(['./report.txt', 'https://example.test/download'], root)]
  let reads = 0
  const service = new WindowContentService({ store, assets,
    content: async (selectedSource, space, window) => { assert.equal(selectedSource.id, source.id); assert.equal(space, 'space'); assert.equal(window, 'window'); return content },
    registerStaged: (assetId, sessionId) => downloads.registerStaged(assetId, sessionId),
    readFile: (source, path, signal) => { reads++; return (readFileOverride || readSourceFile)(source, path, signal) },
  })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, {
    windowContent: service, assets, openDownload: (ticket, session) => downloads.open(ticket, session),
  })
  const call = (path: string, body: unknown = {}, session = 'first-session', signal?: AbortSignal) => app.request(`http://canvas.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'canvas.test', Origin: 'http://canvas.test', Cookie: `canvas_session=${session}` }, body: JSON.stringify(body), signal,
  })
  const scan = async () => {
    const response = await call(`/api/sources/${source.id}/spaces/space/windows/window/scan`)
    assert.equal(response.status, 200)
    return await response.json() as WindowContentScan
  }
  t.after(async () => { service.close(); await downloads.closeAll(); await assets.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store, source, canvas, assets, downloads, service, app, call, scan, reads: () => reads,
    setContent: (value: NativeContentPane[] | undefined) => { content = value } }
}

test('HTTP scans authenticate, freeze candidates and do not read files or fetch links', async t => {
  const f = await fixture(t)
  const endpoint = `/api/sources/${f.source.id}/spaces/space/windows/window/scan`
  assert.equal((await f.call(endpoint, {}, 'missing')).status, 401)
  const scan = await f.scan()
  assert.equal(f.reads(), 0)
  const link = scan.panes[0]!.items.find(item => item.kind === 'link')!
  assert.equal((await f.call(`/api/content-scans/${scan.id}/items/${link.id}/open`)).status, 404)
  assert.equal(f.reads(), 0)
  const file = scan.panes[0]!.items.find(item => item.kind === 'file')!
  await writeFile(join(f.root, 'report.txt'), 'original\n')
  f.setContent([pane(['/changed/file.txt'], '/elsewhere')])
  assert.equal((await f.call(`/api/content-scans/${scan.id}/items/${file.id}/open`, {}, 'other-session')).status, 404)
  assert.equal((await f.call(`/api/content-scans/${scan.id}/items/${file.id}/open`, { path: '/arbitrary' })).status, 400)
  assert.equal(f.reads(), 0)
  const response = await f.call(`/api/content-scans/${scan.id}/items/${file.id}/open`)
  assert.equal(response.status, 200)
  const opened = await response.json() as WindowContentOpen
  assert.equal(opened.temporary, true); assert.equal(opened.preview, 'text'); assert.equal(f.reads(), 1)
  const download = await f.app.request(`http://canvas.test${opened.url}`, { headers: { Cookie: 'canvas_session=first-session' } })
  assert.equal(await download.text(), 'original\n')
  assert.equal((await f.app.request(`http://canvas.test${opened.url}`, { headers: { Cookie: 'canvas_session=other-session' } })).status, 404)
})

test('custom-canvas opens add a persistent file beside the captured native window', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'report.txt'), 'card content')
  const scan = await f.scan(), file = scan.panes[0]!.items.find(item => item.kind === 'file')!
  const response = await f.call(`/api/content-scans/${scan.id}/items/${file.id}/open`, { canvasId: f.canvas.id, anchorId: 'anchor' })
  assert.equal(response.status, 200)
  const opened = await response.json() as WindowContentOpen
  assert.equal(opened.temporary, false)
  const canvas = f.store.get<Canvas>('canvas', f.canvas.id)!, added = canvas.nodes.find(node => node.type === 'file')!
  assert(added && added.x > canvas.nodes[0]!.x)
  const responseFile = await f.app.request(`http://canvas.test${opened.url}`, { headers: { Cookie: 'canvas_session=other-session' } })
  assert.equal(await responseFile.text(), 'card content')
  assert.equal(await readFile(join(f.root, 'files', opened.id), 'utf8'), 'card content')
})

test('changed source identity and logout invalidate captured file actions', async t => {
  const f = await fixture(t)
  const scan = await f.scan(), file = scan.panes[0]!.items.find(item => item.kind === 'file')!
  f.store.put('source', { ...f.source, name: 'Renamed' })
  assert.equal(f.reads(), 0)
  f.store.put('source', { ...f.source, herdrSession: 'different' })
  assert.equal((await f.call(`/api/content-scans/${scan.id}/items/${file.id}/open`)).status, 404)
  assert.equal(f.reads(), 0)
  const next = await f.scan()
  f.store.removeSession('first-session')
  f.store.addSession('first-session')
  assert.equal((await f.call(`/api/content-scans/${next.id}/items/${next.panes[0]!.items[0]!.id}/open`)).status, 404)
})

test('source file reader streams exact binary bytes and treats names literally', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(256 * 1024 + 37)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  const path = join(f.root, 'literal "quotes" $(nothing) 中文.bin')
  await writeFile(path, bytes)
  const file = await readSourceFile(f.source, path, new AbortController().signal)
  const chunks: Buffer[] = []
  for await (const chunk of file.chunks) { assert(chunk.byteLength <= 64 * 1024); chunks.push(Buffer.from(chunk)) }
  assert.equal(file.filename, 'literal "quotes" $(nothing) 中文.bin')
  assert.equal(file.size, bytes.length)
  assert.deepEqual(Buffer.concat(chunks), bytes)
  await file.close()
})

test('source file reader rejects directories and FIFOs without waiting for writers', async t => {
  const f = await fixture(t), fifo = join(f.root, 'pipe')
  execFileSync('mkfifo', [fifo])
  await assert.rejects(readSourceFile(f.source, f.root, new AbortController().signal), /regular file/)
  await assert.rejects(readSourceFile(f.source, fifo, new AbortController().signal), /regular file/)
})

test('cancelling a selected-file transfer removes staged partials and never adds a card', async t => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await fixture(t, async (_source, _path, signal) => ({ filename: 'report.txt', size: 20,
    chunks: (async function* () {
      yield Buffer.from('partial')
      started()
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      signal.throwIfAborted()
    })(), close: async () => {},
  }))
  const scan = await f.scan(), controller = new AbortController()
  const pending = f.service.open(scan.id, scan.panes[0]!.items[0]!.id, 'first-session', { canvasId: f.canvas.id, anchorId: 'anchor' }, controller.signal)
  await ready; controller.abort()
  await assert.rejects(pending)
  assert.deepEqual(await readdir(join(f.root, 'tmp')), ['staged'])
  assert.deepEqual(await readdir(join(f.root, 'tmp', 'staged')), [])
  assert.equal(f.store.get<Canvas>('canvas', f.canvas.id)!.nodes.length, 1)
})

test('cancellation before asset commit also removes the partial file', async t => {
  const f = await fixture(t), upload = await f.assets.begin({ filename: 'pending.txt', size: 3 })
  await upload.write(Buffer.from('abc'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(upload.complete({ sourceId: f.source.id, windowId: 'window' }, controller.signal))
  assert.deepEqual(await readdir(join(f.root, 'tmp')), ['staged'])
  assert.deepEqual(await readdir(join(f.root, 'tmp', 'staged')), [])
})

test('logout or source replacement cancels an active pull and cleans partials', async t => {
  for (const cause of ['logout', 'source'] as const) await t.test(cause, async t => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const f = await fixture(t, async (_source, _path, signal) => ({ filename: 'report.txt', size: 20,
      chunks: (async function* () {
        yield Buffer.from('partial'); started()
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
        signal.throwIfAborted()
      })(), close: async () => {},
    }))
    const scan = await f.scan()
    const pending = f.service.open(scan.id, scan.panes[0]!.items[0]!.id, 'first-session', {}, new AbortController().signal)
    await ready
    if (cause === 'logout') f.store.removeSession('first-session')
    else f.store.put('source', { ...f.source, herdrSession: 'replacement' })
    await assert.rejects(pending)
    assert.deepEqual(await readdir(join(f.root, 'tmp')), ['staged'])
    assert.deepEqual(await readdir(join(f.root, 'tmp', 'staged')), [])
  })
})
