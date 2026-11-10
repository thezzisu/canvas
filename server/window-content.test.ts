import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contentCandidates } from './content-candidates.ts'
import { terminalCellWidth } from '../shared/terminal-unicode.ts'
import { windowContent, readWindowContent, type NativeContentPane } from './herdr/content.ts'
import type { ClientShellSnapshot, FrameData, PaneSurfaceFrame } from './herdr/wire.ts'
import { readSourceFile, regularSourceFiles } from './source-file.ts'
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

test('candidate scan ignores prose ratios and retains explicit file references beside OSC 8 targets', () => {
  const content = pane(['commit/push status/diff/log 4/5 0/100 @path/to/file @report.txt', './report.txt subdir/photo.png'], '/work')
  content.links = [
    { label: 'Manual', url: 'https://example.test/manual' },
    { label: 'Image', url: 'file:///tmp/a%20b.png' },
    { label: 'Local', url: 'file://localhost/tmp/local.txt' },
    { label: 'This source', url: 'file://source.test/tmp/source.txt' },
    { label: 'Host is link metadata', url: 'file://other.test/tmp/other.txt' },
    { label: 'Credentials', url: 'file://user:DUMMY_PASSWORD@host/tmp/private.txt' },
    { label: 'UNC', url: 'file:////host/share.txt' },
    { label: 'Invalid path', url: 'file:///tmp/a%00b.txt' },
  ]
  const items = contentCandidates([content]).panes[0]!.items
  assert.deepEqual(items.filter(item => item.kind === 'file').map(item => item.path), [
    '/tmp/a b.png', '/tmp/local.txt', '/tmp/source.txt', '/tmp/other.txt', '/work/@path/to/file', '/work/@report.txt', '/work/report.txt', '/work/subdir/photo.png',
  ])
  assert.deepEqual(items.filter(item => item.kind === 'link'), [{ id: '1', kind: 'link', label: 'Manual', url: 'https://example.test/manual' }])
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
  assert.deepEqual(panes[0], { id: 'a', name: 'Left', cwd: '/one', columns: 29, lines: ['./left.txt', 'Open'], links: [{ label: 'Open', url: 'https://example.test/original' }] })
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

test('native scan reads current visible rows without revision checks and preserves OSC 8', async () => {
  const { surface, snapshot } = nativeFrame()
  surface.panes[0]!.scroll = { max_offset_from_bottom: 90, offset_from_bottom: 25, viewport_rows: 2 }
  const calls: Record<string, unknown>[] = []
  const result = await readWindowContent(surface, snapshot, 'window', async params => {
    calls.push(params)
    return { pane_id: params.pane_id, text: params.pane_id === 'a' ? '/tmp/long-native-soft-wrapped-path.png\nHARD_ONE\nHARD_TWO' : './right.txt' }
  })
  assert.deepEqual(calls, [
    { pane_id: 'a', source: 'visible', format: 'text', strip_ansi: true },
    { pane_id: 'b', source: 'visible', format: 'text', strip_ansi: true },
  ])
  assert.deepEqual(result[0]!.lines, ['/tmp/long-native-soft-wrapped-path.png', 'HARD_ONE', 'HARD_TWO'])
  assert.deepEqual(result[0]!.links, [{ label: 'Open', url: 'https://example.test/original' }])
  assert.deepEqual(result[1]!.lines, ['./right.txt'])
})

test('current scan never reads concealed panes and isolates failed or mismatched pane responses', async () => {
  const { surface, snapshot } = nativeFrame()
  surface.frame.cells[65]!.modifier = 128
  const calls: string[] = []
  const result = await readWindowContent(surface, snapshot, 'window', async params => {
    calls.push(String(params.pane_id)); return { pane_id: 'b', text: 'right.txt' }
  })
  assert.deepEqual(calls, ['b'])
  assert.equal(result[0]!.lines[0], ' /left.txt')
  for (const read of [async () => { throw new Error('unavailable') }, async () => ({ pane_id: 'other', text: 'foreign' })]) {
    const partial = await readWindowContent(surface, snapshot, 'window', read)
    assert.equal(partial[1]!.incomplete, true)
    assert.deepEqual(partial[1]!.lines, [])
    assert.equal(partial[0]!.lines[0], ' /left.txt')
  }
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

async function fixture(t: TestContext, readFileOverride?: WindowContentOptions['readFile'], regularFiles?: WindowContentOptions['regularFiles']) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-content-'))
  await writeFile(join(root, 'report.txt'), 'fixture file\n')
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
  const service = new WindowContentService({ store, assets, regularFiles,
    content: async (selectedSource, space, window) => { assert.equal(selectedSource.id, source.id); assert.equal(space, 'space'); assert.equal(window, 'window'); return content },
    registerStaged: (assetId, sessionId) => downloads.registerStaged(assetId, sessionId),
    readFile: (source, path, signal) => { reads++; return (readFileOverride || readSourceFile)(source, path, signal) },
  })
  const app = createApp(store, { username: 'fixture', passwordHash: 'unused' }, {} as TerminalManager, {
    windowContent: service, assets, openDownload: (ticket, session) => downloads.open(ticket, session),
  })
  const call = (path: string, body: unknown = {}, session = 'first-session', signal?: AbortSignal) => app.request(`http://canvas.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'canvas.test', Origin: 'http://canvas.test', Authorization: `Bearer ${session}` }, body: JSON.stringify(body), signal,
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


test('full-width CJK path display joins a short extension tail and verifies the actual file', async t => {
  const f = await fixture(t)
  const relative = 'dist/AutoOps自动运维产品生产版功能说明_机器场景.md'
  await mkdir(join(f.root, 'dist'))
  await writeFile(join(f.root, relative), 'synthetic markdown')
  const first = `  ${relative.slice(0, -1)}`
  assert(terminalCellWidth(first) > first.length, 'fixture includes full-width Chinese cells')
  f.setContent([{ ...pane([first, '  d'], f.root), columns: terminalCellWidth(first) }])
  const scan = await f.scan()
  assert.deepEqual(scan.panes[0]!.items.filter(item => item.kind === 'file').map(item => item.path), [join(f.root, relative)])
  f.setContent([{ ...pane([first.replace('AutoOps', 'Missing'), '  d'], f.root), columns: terminalCellWidth(first) }])
  assert.deepEqual((await f.scan()).panes, [], 'a reconstructed path still requires an existing file')
})

test('unquoted tool paths join slash and hyphen wraps across multiple hard lines and verify the exact file', async t => {
  const f = await fixture(t)
  const directory = 'dist/2026/11/02/image-demo/accepted-final'
  await mkdir(join(f.root, directory), { recursive: true })
  const path = join(f.root, directory, 'official-app.png')
  await writeFile(path, 'synthetic image')
  await writeFile(join(f.root, directory, 'officialapp.png'), 'different synthetic image')
  f.setContent([{ ...pane([
    `Viewed image ${f.root}/`,
    `${directory}/official-`,
    'app.png',
  ]), columns: 150 }])
  assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [path])
  await rm(path)
  assert.deepEqual((await f.scan()).panes, [], 'missing exact hyphenated file never falls back to a different filename')
})

test('unquoted wrapped paths preserve bracketed names and do not infer a new working directory', async t => {
  const f = await fixture(t)
  const directory = 'captures(1)/set[2]/选图（最终）'
  await mkdir(join(f.root, directory), { recursive: true })
  const path = join(f.root, directory, 'official-(app)[3].png')
  await writeFile(path, 'synthetic image')
  f.setContent([pane([
    'captures(1)/', 'set[2]/', '选图（最终）/official-', '(app)[3].png',
  ], f.root)])
  assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [path])
  f.setContent([pane(['cd /unrelated', 'captures(1)/', 'set[2]/', '选图（最终）/official-', '(app)[3].png'])])
  assert.deepEqual((await f.scan()).panes, [], 'relative candidates require the native reported cwd, never a parsed cd')
})

test('unquoted continuation stops at prose, separators, bullets and independent paths', () => {
  const paths = (lines: string[], other?: string[]) => contentCandidates([
    pane(lines, '/work'), ...(other ? [pane(other, '/work', 'other')] : []),
  ]).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : []))
  for (const next of ['', '─────', '---', '- app.png', '+ app.png', '• app.png', '1. app.png', 'another image.png',
    '/elsewhere/app.png', './app.png', '../app.png', '~/app.png', '@app.png', '--flag', 'https://example.test/app.png']) {
    assert(!paths(['Viewed image /tmp/example/', next, 'app.png']).some(path => path?.startsWith('/tmp/example/') && path !== '/tmp/example/'), next)
  }
  assert(!paths(['Viewed image /tmp/example/official-'], ['app.png']).includes('/tmp/example/official-app.png'), 'pane boundaries stop wrapping')
  assert(!paths(['Output /tmp/example/file', 'app.png']).includes('/tmp/example/fileapp.png'), 'ordinary hard lines lack a wrapping cue')
  assert(!paths(['the next option -', 'app.png']).includes('/work/-app.png'), 'prose hyphens never become path prefixes')
  assert(!paths(['Viewed image /tmp/example/official-', '─────', 'app.png']).includes('/tmp/example/official-app.png'), 'a drawn separator is not silently removed')
})

test('unquoted wrap reconstruction shares the existing path size and candidate budgets', () => {
  const groups = [pane(['Viewed image /tmp/' + 'x'.repeat(8190) + '-', 'app.png'], '/work')]
  assert(!contentCandidates(groups).panes.flatMap(pane => pane.items).some(item => item.kind === 'file' && item.path && item.path.length > 8192))
  const rows = Array.from({ length: 250 }, (_, index) => [`Viewed image /tmp/item-${index}/`, 'official-', 'app.png']).flat()
  const result = contentCandidates([pane(rows)])
  assert.equal(result.truncated, true)
  assert(result.panes.flatMap(pane => pane.items).length <= 200)
})

test('an oversized initial path does not consume the budget of a later valid wrapped path', () => {
  const result = contentCandidates([pane([
    `Viewed image /tmp/${'x'.repeat(70_000)}-`, 'app.png',
    'Viewed image /tmp/valid/', 'official-', 'app.png',
  ])])
  assert(result.panes.flatMap(pane => pane.items).some(item => item.kind === 'file' && item.path === '/tmp/valid/official-app.png'))
  assert.equal(result.truncated, false)
})

test('inline parenthesized video paths survive TUI hard wraps and retain their exact filename', async t => {
  const f = await fixture(t)
  const directory = 'dist/2026/11/02/layout-preview/tutorial'
  const relative = `${directory}/示例系统_查询与统计_中文演示.mp4`
  await mkdir(join(f.root, directory), { recursive: true })
  await writeFile(join(f.root, relative), 'synthetic video bytes')
  f.setContent([pane([
    `  • 重新制作的中文教学视频（2分53秒，约7MB） (${directory}/示例系统_查询`,
    '    与统计_中文演示.mp4)',
  ], f.root)])
  const scanned = await f.scan()
  assert.deepEqual(scanned.panes[0]!.items.filter(item => item.kind === 'file').map(item => [item.path, item.label]), [[join(f.root, relative), relative]])
  await rm(join(f.root, relative))
  assert.deepEqual((await f.scan()).panes, [], 'a reconstructed missing file is never displayed')
})

test('wrapped Markdown destinations preserve interior spaces and authoritative OSC 8 labels', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  await writeFile(join(f.root, 'docs/video demo.mp4'), 'synthetic')
  await writeFile(join(f.root, 'docs/videodemo.mp4'), 'different file')
  const content = pane(['> [Video](docs/video demo.', '>   mp4)'], f.root)
  content.links = [{ label: 'Trusted title', url: `file://${f.root}/docs/video%20demo.mp4` }]
  f.setContent([content])
  assert.deepEqual((await f.scan()).panes[0]!.items.filter(item => item.kind === 'file').map(item => [item.path, item.label]), [[join(f.root, 'docs/video demo.mp4'), 'Trusted title']])
})

test('balanced half-width and full-width wrappers retain parentheses inside real filenames', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  const names = ['报告(最终).mp4', '报告（最终）.mp4', '报告(第二版（完整）).mp4']
  for (const name of names) await writeFile(join(f.root, 'docs', name), 'synthetic')
  f.setContent([pane([
    `视频（docs/${names[0]}）`,
    'Video (docs/报告（最', '  终）.mp4)',
    '[Video](docs/报告(第二版（完', '  整）).mp4)',
  ], f.root)])
  const files = (await f.scan()).panes[0]!.items.filter(item => item.kind === 'file').map(item => item.path)
  assert(names.every(name => files.includes(join(f.root, 'docs', name))))
})

test('color runs retain filename punctuation, join at pane edges and reject stale or concealed hints', async () => {
  const { surface, snapshot } = nativeFrame()
  const first = 'docs/视频（最终）(一).mp', last = '4'
  const width = terminalCellWidth(first), height = 3
  surface.frame = { width, height, cursor: null, hyperlinks: [], graphics: Buffer.alloc(0),
    cells: Array.from({ length: width * height }, () => ({ symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })) }
  surface.panes = [{ ...surface.panes[0]!, rect: { x: 0, y: 0, width, height }, inner_rect: { x: 0, y: 0, width, height } }]
  snapshot.panes = [snapshot.panes[0]!]
  const put = (row: number, offset: number, text: string, fg: number) => {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      const cell = surface.frame.cells[row * width + offset]!
      Object.assign(cell, { symbol: segment, fg }); const size = terminalCellWidth(segment)
      // Native herdr can leave continuation cells as unmarked padding.
      for (let i = 1; i < size; i++) surface.frame.cells[row * width + offset + i]!.symbol = ' '
      offset += size
    }
  }
  put(0, 0, first, 0x0200aa55); put(1, 2, last, 0x0200aa55); put(1, 3, ')', 0)
  put(2, 0, 'docs/real name(1).mp4', 0x0200aa55)
  const [pane] = windowContent(surface, snapshot, 'window')
  assert(pane!.coloredText?.includes(first + last))
  assert(pane!.coloredText?.includes(first), 'a joined hint does not replace its original exact run')
  const paths = contentCandidates([pane!]).panes[0]!.items.flatMap(item => item.kind === 'file' ? [item.path] : [])
  assert(paths.includes('/one/' + first + last))
  assert(paths.includes('/one/docs/real name(1).mp4'))
  const current = await readWindowContent(surface, snapshot, 'window', async () => ({ pane_id: 'a', text: `${first}\n  ${last})\ndocs/real name(1).mp4` }))
  assert(current[0]!.coloredText?.includes(first + last))
  const changed = await readWindowContent(surface, snapshot, 'window', async () => ({ pane_id: 'a', text: 'Current output has changed' }))
  assert.deepEqual(changed[0]!.coloredText, [])
  surface.frame.cells[0]!.modifier = 128
  assert(!windowContent(surface, snapshot, 'window')[0]!.coloredText?.includes(first + last))
})

test('same-color edge paths can span many physical rows without losing exact fragments', () => {
  const { surface, snapshot } = nativeFrame()
  const width = 16, text = `docs/${'part'.repeat(29)}.mp4`, rows = text.match(/.{1,16}/gu)!
  assert(rows.length > 5)
  surface.frame = { width, height: rows.length, cursor: null, hyperlinks: [], graphics: Buffer.alloc(0),
    cells: rows.flatMap(row => Array.from({ length: width }, (_, x) => ({ symbol: row[x] || ' ', fg: row[x] ? 0x0200aa55 : 0,
      bg: 0, modifier: 0, skip: false, hyperlink: null }))) }
  surface.panes = [{ ...surface.panes[0]!, rect: { x: 0, y: 0, width, height: rows.length }, inner_rect: { x: 0, y: 0, width, height: rows.length } }]
  snapshot.panes = [snapshot.panes[0]!]
  const [pane] = windowContent(surface, snapshot, 'window')
  assert(pane!.coloredText?.includes(text))
  assert(pane!.coloredText?.includes(rows[0]!))
  assert(contentCandidates([pane!]).panes[0]!.items.some(item => item.kind === 'file' && item.path === '/one/' + text))
})

test('parenthesized wrap reconstruction stops at pane, paragraph, new-item and size boundaries', () => {
  const paths = (lines: string[], nextPane?: string[]) => contentCandidates([
    pane(lines, '/work'), ...(nextPane ? [pane(nextPane, '/work', 'other')] : []),
  ]).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : []))
  for (const lines of [
    ['Video (docs/long', '', 'name.mp4)'],
    ['Video (docs/long', '- name.mp4)'],
    ['Video (docs/long', '> ', 'name.mp4)'],
    ['Video (docs/long', 'name.mp4'],
  ]) assert(!paths(lines).some(path => path?.startsWith('/work/docs/long')))
  assert(!paths(['Video (docs/long'], ['name.mp4)']).some(path => path?.startsWith('/work/docs/long')))
  assert(!paths([`Video (docs/${'a'.repeat(8190)}`, 'x.mp4)']).some(path => path && path.length > 8192))
  assert(!paths(['An explanation (ordinary text', 'with a filename.mp4)']).includes('/work/ordinary textwith a filename.mp4'))
})

test('long explicitly wrapped paths are bounded by path size rather than a four-line cutoff', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  const name = `${'long-'.repeat(28)}演示（完整）.mp4`
  await writeFile(join(f.root, 'docs', name), 'synthetic')
  const chunks = name.match(/.{1,12}/gu)!
  assert(chunks.length > 5)
  f.setContent([pane([`Video (docs/${chunks[0]}`, ...chunks.slice(1, -1).map(chunk => `  ${chunk}`), `  ${chunks.at(-1)})`], f.root)])
  assert((await f.scan()).panes[0]!.items.some(item => item.kind === 'file' && item.path === join(f.root, 'docs', name)))
  const directory = 'docs/one/two/three/four/five/six'
  await mkdir(join(f.root, directory), { recursive: true })
  await writeFile(join(f.root, directory, 'report.mp4'), 'synthetic')
  f.setContent([pane(['Video（docs/one/', ' two/three', ' /four/', ' five/', ' six/', ' report.mp4）'], f.root)])
  assert((await f.scan()).panes[0]!.items.some(item => item.kind === 'file' && item.path === join(f.root, directory, 'report.mp4')))
  const bounded = contentCandidates([pane(Array.from({ length: 250 }, () => 'Video (docs/' + 'a'.repeat(8000)), f.root)])
  assert(bounded.truncated)
  assert(bounded.panes.flatMap(pane => pane.items).length <= 200)
})

test('at-prefixed references use the literal filename first and never strip authoritative links', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  for (const name of ['docs/file.md', '@report.md', 'report.md', 'README', 'docs/a b(1).md']) await writeFile(join(f.root, name), 'synthetic')
  f.setContent([pane(['@docs/file.md @report.md @README "@docs/a b(1).md" @missing.md user@example.test'], f.root)])
  const scan = await f.scan()
  const files = scan.panes[0]!.items.flatMap(item => item.kind === 'file' ? [item.path] : [])
  assert(files.includes(join(f.root, 'docs/file.md')))
  assert(files.includes(join(f.root, '@report.md')))
  assert(!files.includes(join(f.root, 'report.md')), 'a real leading @ is preserved')
  assert(files.includes(join(f.root, 'README')))
  assert(files.includes(join(f.root, 'docs/a b(1).md')))
  const linked = pane([], f.root)
  linked.links = [{ label: 'Exact missing link', url: `file://${f.root}/@docs/file.md` }]
  f.setContent([linked])
  assert.deepEqual((await f.scan()).panes, [], 'OSC 8 targets never gain reference fallback')
  assert(!Object.hasOwn(scan, 'references'), 'fallback bookkeeping stays server-internal')
})

test('Markdown display decoration is removed from wrapped paths without consuming another filename', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  for (const name of ['引用说明.md', '加粗说明.md', 'list.md']) await writeFile(join(f.root, 'docs', name), 'synthetic')
  const quoted = '> - `docs/引用说明.m'
  const bold = '> **docs/加粗说明.m'
  f.setContent([
    { ...pane([quoted, '>   d`'], f.root, 'quote'), columns: terminalCellWidth(quoted) },
    { ...pane([bold, '> d**'], f.root, 'bold'), columns: terminalCellWidth(bold) },
    pane(['> 1. `docs/list.md`'], f.root, 'list'),
  ])
  const scan = await f.scan()
  assert.deepEqual(scan.panes.map(group => group.items.filter(item => item.kind === 'file').map(item => item.path)), [
    [join(f.root, 'docs/引用说明.md')], [join(f.root, 'docs/加粗说明.md')], [join(f.root, 'docs/list.md')],
  ])
})

test('path reconstruction preserves real spaces and OSC 8 targets instead of compacting filenames', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  for (const name of ['real name.md', 'realname.md', 'linked name.md', 'linkedname.md']) await writeFile(join(f.root, 'docs', name), 'synthetic')
  const first = '> `docs/real name.m'
  const content = { ...pane([first, '> d`'], f.root), columns: terminalCellWidth(first), links: [
    { label: 'Linked file', url: `file://${f.root}/docs/linked%20name.md` },
  ] }
  f.setContent([content])
  const scan = await f.scan()
  assert.deepEqual(scan.panes[0]!.items.filter(item => item.kind === 'file').map(item => item.path), [
    join(f.root, 'docs/linked name.md'), join(f.root, 'docs/real name.md'),
  ])
})

test('width-based continuation remains bounded by pane, distinct filenames and scan capacity', () => {
  const first = 'docs/report.m'
  const paths = (groups: NativeContentPane[]) => contentCandidates(groups).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : []))
  assert(!paths([{ ...pane([first, 'd'], '/work'), columns: 80 }]).includes('/work/docs/report.md'), 'short hard lines never join')
  assert(!paths([{ ...pane([first.padEnd(80, ' '), 'd'], '/work'), columns: 80 }]).includes('/work/docs/report.md'), 'cell padding is not content reaching the edge')
  assert(!paths([{ ...pane([first], '/work', 'left'), columns: terminalCellWidth(first) }, pane(['d'], '/work', 'right')]).includes('/work/docs/report.md'), 'panes never join')
  assert(!paths([{ ...pane([first, 'other.md'], '/work'), columns: terminalCellWidth(first) }]).includes('/work/docs/report.mother.md'), 'another complete filename is not a continuation')
  const overlong = 'd'.repeat(33)
  assert(!paths([{ ...pane([first, overlong], '/work'), columns: terminalCellWidth(first) }]).includes(`/work/${first}${overlong}`), 'continuation length is bounded')
  const capped = contentCandidates([{ ...pane([...Array.from({ length: 200 }, (_, i) => `/tmp/${i}.md`), first, 'd'], '/work'), columns: terminalCellWidth(first) }])
  assert.equal(capped.panes.flatMap(group => group.items).length, 200)
  assert.equal(capped.truncated, true)
})

test('HTTP scans authenticate, verify regular file metadata and do not read bytes or fetch links', async t => {
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
  assert.equal(opened.temporary, true); assert.equal('preview' in opened, false); assert.equal(f.reads(), 1)
  assert.equal(opened.sourcePreview, true)
  const stagedId = f.downloads.stagedAssetId(opened.id, 'first-session'); assert(stagedId)
  assert.equal(f.assets.origin(stagedId, true)?.path, join(f.root, 'report.txt'))
  const download = await f.app.request(`http://canvas.test${opened.url}`, { headers: { Authorization: 'Bearer first-session' } })
  assert.equal(await download.text(), 'original\n')
  assert.equal((await f.app.request(`http://canvas.test${opened.url}`, { headers: { Authorization: 'Bearer other-session' } })).status, 404)
})

test('HTTP window text authenticates and returns only pane text without file probing or stale partial output', async t => {
  let probes = 0
  const f = await fixture(t, undefined, async () => { probes++; return new Map() })
  const endpoint = `/api/sources/${f.source.id}/spaces/space/windows/window/text`
  const read = (session = 'first-session') => f.app.request(`http://canvas.test${endpoint}`, { headers: { Authorization: `Bearer ${session}` } })
  assert.equal((await read('missing')).status, 401)
  f.setContent([pane(['  program │─ text', '', ''], '/work', 'a'), pane(['second pane'], '/other', 'b')])
  const response = await read()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { text: '  program │─ text\n\nsecond pane' })
  assert.equal(probes, 0); assert.equal(f.reads(), 0)
  f.setContent([{ ...pane(['partial']), incomplete: true }])
  assert.equal((await read()).status, 503)
  f.setContent(undefined)
  assert.equal((await read()).status, 400)
  assert.equal((await f.app.request(`http://canvas.test${endpoint.replace(f.source.id, randomUUID())}`, { headers: { Authorization: 'Bearer first-session' } })).status, 404)
})

test('window text rejects logout and changed source identity while its native read is pending', async t => {
  const f = await fixture(t)
  const loggedOut = f.service.read(f.source, 'space', 'window', 'first-session')
  f.store.removeSession('first-session')
  await assert.rejects(loggedOut, /Please sign in/u)
  const changed = f.service.read(f.source, 'space', 'window', 'other-session')
  f.store.put('source', { ...f.source, herdrSession: 'different' })
  await assert.rejects(changed, /Connection changed/u)
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
  const responseFile = await f.app.request(`http://canvas.test${opened.url}`, { headers: { Authorization: 'Bearer other-session' } })
  assert.equal(await responseFile.text(), 'card content')
  assert.equal(await readFile(join(f.root, 'files', opened.id), 'utf8'), 'card content')
})

test('scan download stays temporary while an explicit destination adds a file note without a terminal anchor', async t => {
  const f = await fixture(t)
  const target = f.store.put<Canvas>('canvas', { id: randomUUID(), name: 'Empty canvas', nodes: [] })
  const scan = await f.scan(), file = scan.panes[0]!.items.find(item => item.kind === 'file')!
  const route = `/api/content-scans/${scan.id}/items/${file.id}/open`
  const download = await (await f.call(route, {})).json() as WindowContentOpen
  assert(download.temporary)
  assert.equal(f.store.get<Canvas>('canvas', f.canvas.id)!.nodes.length, 1)
  assert.equal(f.store.get<Canvas>('canvas', target.id)!.nodes.length, 0)
  const added = await f.call(route, { canvasId: target.id, position: { x: -60.25, y: 120 } })
  assert.equal(added.status, 200)
  assert.equal((await added.json() as WindowContentOpen).temporary, false)
  const card = f.store.get<Canvas>('canvas', target.id)!.nodes[0]!
  assert.equal(card.type, 'file'); assert.equal(card.x, -60.25); assert.equal(card.y, 120)
  assert.equal((await f.call(route, { position: { x: 1, y: 2 } })).status, 400)
  assert.equal((await f.call(route, { canvasId: 'overview', position: { x: 1, y: 2 } })).status, 400)
})

test('changed source identity and logout invalidate captured file actions', async t => {
  const f = await fixture(t)
  const scan = await f.scan(), file = scan.panes[0]!.items.find(item => item.kind === 'file')!
  f.store.put('source', { ...f.source, name: 'Renamed' })
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

test('one metadata scan drops missing paths, directories, devices and FIFOs without reading bytes', async t => {
  const f = await fixture(t), fifo = join(f.root, 'pipe'), name = join(f.root, 'literal "quotes" $(nothing) 中文.bin')
  execFileSync('mkfifo', [fifo]); await writeFile(name, 'literal file')
  const paths = [join(f.root, 'report.txt'), f.root, fifo, '/dev/null', join(f.root, 'missing.txt'), name]
  assert.deepEqual(await regularSourceFiles(f.source, paths, new AbortController().signal), new Map([[paths[0], paths[0]], [name, name]]))
  const content = pane(['commit/push status/diff/log 4/5 0/100 @path/to/file', './report.txt /dev/null ./missing.txt', `"${f.root}" "${fifo}"`], f.root)
  content.links = [{ label: 'Exact file', url: `file://${encodeURI(name).replaceAll('"', '%22')}` }]
  f.setContent([content])
  const scan = await f.scan()
  assert.deepEqual(scan.panes[0]!.items.filter(item => item.kind === 'file').map(item => item.path), [name, paths[0]])
  assert.equal(f.reads(), 0)
  const aborted = new AbortController(); aborted.abort()
  assert.throws(() => regularSourceFiles(f.source, paths, aborted.signal))
})

test('OSC 8 file hostnames are metadata and paths are checked on the selected SSH source', async t => {
  let checked = false
  const f = await fixture(t, undefined, async (source, paths, signal) => {
    assert.equal(source.transport, 'ssh'); assert.equal(source.target, 'configured-alias')
    checked = true
    return regularSourceFiles({ ...source, transport: 'local' }, paths, signal)
  })
  f.store.put('source', { ...f.source, transport: 'ssh', target: 'configured-alias' })
  const content = pane([], f.root)
  content.links = [
    { label: 'Machine hostname', url: `file://actual-remote-host${f.root}/report.txt#L123` },
    { label: 'Missing file', url: `file://another-host${f.root}/not-present.txt` },
    { label: 'Device', url: 'file://actual-remote-host/dev/null' },
  ]
  f.setContent([content])
  const scan = await f.scan()
  assert(checked)
  assert.deepEqual(scan.panes[0]!.items.map(item => item.kind === 'file' && item.path), [join(f.root, 'report.txt')])
})

test('file locations fall back only when the exact path is absent and deduplicate matched files', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'column.ts'), 'fixture code')
  await writeFile(join(f.root, 'literal.txt'), 'base')
  await writeFile(join(f.root, 'literal.txt:12'), 'literal colon filename')
  await writeFile(join(f.root, 'literal.txt#L7'), 'literal hash filename')
  f.setContent([pane(['report.txt:123 report.txt#L123 report.txt', 'column.ts:12:45',
    'literal.txt:12 literal.txt#L7 missing.txt:20'], f.root)])
  const scan = await f.scan()
  assert.deepEqual(scan.panes[0]!.items.map(item => item.kind === 'file' && item.path), [
    join(f.root, 'report.txt'), join(f.root, 'column.ts'), join(f.root, 'literal.txt:12'), join(f.root, 'literal.txt#L7'),
  ])
  const item = scan.panes[0]!.items.find(item => item.kind === 'file' && item.path === join(f.root, 'column.ts'))!
  const opened = await f.call(`/api/content-scans/${scan.id}/items/${item.id}/open`)
  assert.equal(opened.status, 200)
  const metadata = await opened.json() as WindowContentOpen
  assert.equal(metadata.filename, 'column.ts')
})

test('unavailable metadata returns available links with a partial-result flag', async t => {
  const f = await fixture(t, undefined, async () => { throw new Error('Source unavailable') })
  const scan = await f.scan()
  assert.equal(scan.incomplete, true)
  assert.deepEqual(scan.panes[0]!.items.map(item => item.kind), ['link'])
})

test('source replacement, logout and request cancellation abort an ongoing metadata scan', async t => {
  for (const cause of ['source', 'logout', 'request'] as const) await t.test(cause, async t => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const f = await fixture(t, undefined, async (_source, _paths, signal) => {
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
      return new Map()
    })
    const controller = new AbortController()
    const pending = f.service.scan(f.source, 'space', 'window', 'first-session', controller.signal)
    await ready
    if (cause === 'source') f.store.put('source', { ...f.source, herdrSession: 'replacement' })
    else if (cause === 'logout') f.store.removeSession('first-session')
    else controller.abort()
    await assert.rejects(pending)
  })
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

test('inline tool paths reconstruct arbitrary measured hard wraps and keep special filename characters', async t => {
  const f = await fixture(t), relative = 'dist/2026/11/05/canvas-note-ime-video/sheet-4.png'
  await mkdir(join(f.root, 'dist/2026/11/05/canvas-note-ime-video'), { recursive: true })
  await writeFile(join(f.root, relative), 'synthetic image')
  for (const [prefix, end] of [['Reading ', 'canvas-note-ime'], ['└ ', 'canvas-note-ime-vide']] as const) {
    const first = prefix + join(f.root, 'dist/2026/11/05', end)
    f.setContent([{ ...pane([first, relative.slice(relative.indexOf(end) + end.length)], f.root), columns: terminalCellWidth(first) }])
    assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, relative)])
  }
  const relativeLong = 'docs/' + 'piece'.repeat(12) + '(最终)[1].png'
  await mkdir(join(f.root, 'docs')); await writeFile(join(f.root, relativeLong), 'synthetic')
  const start = '@docs/' + 'piece'.repeat(3), columns = start.length
  const rest = relativeLong.slice(start.length - 1).match(new RegExp(`.{1,${columns}}`, 'gu'))!
  f.setContent([{ ...pane([start, ...rest], f.root), columns }])
  assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, relativeLong)])
})

test('hard-wrap whitespace has at most two interpretations and ambiguous existing files are not guessed', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'docs'))
  await writeFile(join(f.root, 'docs/real name.png'), 'spaced')
  f.setContent([pane(['Image (docs/real', ' name.png)'], f.root)])
  assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, 'docs/real name.png')])
  await writeFile(join(f.root, 'docs/realname.png'), 'unspaced')
  assert.deepEqual((await f.scan()).panes, [], 'two existing interpretations do not select an arbitrary file')
  const candidate = contentCandidates([pane(['Image (docs/long', ' part', ' name.png)'], f.root)])
  assert([...candidate.fileChoices.values()].every(choice => choice.paths.length <= 2 && choice.references.length <= 2))
  const authoritative = pane(['Image (docs/real', ' name.png)'], f.root)
  authoritative.links = [{ label: 'Exact image', url: `file://${f.root}/docs/real%20name.png` }]
  f.setContent([authoritative])
  assert.deepEqual((await f.scan()).panes.flatMap(pane => pane.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, 'docs/real name.png')])
})

test('colored inline paths share token extraction instead of requiring a path-only color run', () => {
  const path = '~/workspace/project/dist/2026/11/05/canvas-note-ime-video/sheet-4.png'
  const content = { ...pane(['Reading ' + path.slice(0, -20), path.slice(-20)]), coloredText: ['Reading ' + path] }
  assert(contentCandidates([content]).panes.flatMap(pane => pane.items).some(item => item.kind === 'file' && item.path === path))
})

test('application-indented code paths join unfinished fragments without reaching the pane edge', async t => {
  const f = await fixture(t), directory = join(f.root, 'pkuandroid-lite-client')
  await mkdir(directory)
  const path = join(directory, 'pkuandroid-v3.0.1-lite.apk')
  await writeFile(path, 'synthetic package')
  const split = path.indexOf('pkuandroid-lite-client') + 'pkuan'.length
  for (const [prefix, indent] of [['    ', '    '], ['  adb install -r ', '                 '], ['  Reading ', '  ']]) {
    const first = prefix + path.slice(0, split)
    for (const margin of [2, 12, 40]) {
      f.setContent([{ ...pane([first, indent + path.slice(split)], f.root), columns: terminalCellWidth(first) + margin }])
      assert.deepEqual((await f.scan()).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [path])
    }
  }
})

test('versioned filename fragments join a visible suffix in indented displays and stable table cells', async t => {
  const f = await fixture(t)
  for (const extension of ['apk', 'zip', 'pdf']) {
    const name = `pkuandroid-v3.0.1-lite.${extension}`, path = join(f.root, name)
    await writeFile(path, 'synthetic file')
    for (const lines of [
      ['    pkuandroid-v3.0.1', `    -lite.${extension}`],
      ['│ 文件 │ pkuandroid-v3.0.1       │', `│      │ ${`-lite.${extension}`.padEnd(24)}│`],
      ['| file | pkuandroid-v3.0.1       |', `|      | ${`-lite.${extension}`.padEnd(24)}|`],
      ['file │ pkuandroid-v3.0.1', `     │ -lite.${extension}`],
      ['file │ 交付物路径: pkuandroid-v3.0.1', `     │ -lite.${extension}`],
      ['file │ 交付物路径: pkuandroid-v3.0.1', `     │ -lite.${extension} (2.1 MB, ready)`],
    ]) {
      f.setContent([{ ...pane(lines, f.root), columns: 120 }])
      assert.deepEqual((await f.scan()).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [path])
    }
  }
  f.setContent([{ ...pane(['    missing-v3.0.1', '    -lite.apk'], f.root), columns: 120 }])
  assert.deepEqual((await f.scan()).panes, [], 'reconstruction never bypasses source file validation')
  const parenthesized = 'package-v1.2.3-lite(1).apk'
  await writeFile(join(f.root, parenthesized), 'synthetic file')
  f.setContent([{ ...pane(['file │ package-v1.2.3', '     │ -lite(1).apk (2.1 MB)'], f.root), columns: 120 }])
  assert.deepEqual((await f.scan()).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, parenthesized)], 'parentheses inside the filename remain literal')
})

test('layout continuation does not merge independent files, records, panes or changed indentation', async t => {
  const f = await fixture(t)
  for (const name of ['report.md', 'other.md', 'report.mdother.md', 'report.md-lite.apk', 'version-v3.0.1-lite.apk', 'shortname.apk'])
    await writeFile(join(f.root, name), 'synthetic file')
  const paths = (groups: NativeContentPane[]) => contentCandidates(groups).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : []))
  for (const first of ['report.md', 'report.md,', 'report.md:3']) {
    assert(!paths([pane([`  ${first}`, '  -lite.apk'], f.root)]).includes(join(f.root, 'report.md-lite.apk')))
  }
  assert(!paths([pane(['  report.md', '  other.md'], f.root)]).includes(join(f.root, 'report.mdother.md')))
  for (const lines of [['  short', '  name.apk'], ['file │ short', '     │ name.apk'], ['│ file │ /tmp/short        │', '│      │ name.apk          │']])
    assert(!paths([pane(lines, f.root)]).some(path => path?.endsWith('/shortname.apk')), JSON.stringify(lines))
  for (const following of ['  - lite.apk', '  --lite.apk', '  ./lite.apk', '  ../lite.apk', '  /tmp/lite.apk', '   -lite.apk', '', '  words here'])
    assert(!paths([pane(['  version-v3.0.1', following], f.root)]).includes(join(f.root, 'version-v3.0.1-lite.apk')), following)
  assert(!paths([pane(['  version-v3.0.1'], f.root), pane(['  -lite.apk'], f.root, 'other')]).includes(join(f.root, 'version-v3.0.1-lite.apk')))
  const top = '│ file │ version-v3.0.1     │', continuation = '│      │ -lite.apk          │'
  for (const lines of [
    [top, continuation.replace('│      │', '│ next │')],
    [top, continuation.replace('│      │', '│ 文文 │')],
    [top, ' ' + continuation],
    [top, '├──────┼────────────────────┤', continuation],
    [top, '', continuation],
    [top, continuation.replace('          │', '           │')],
  ]) assert(!paths([{ ...pane(lines, f.root), columns: 120 }]).includes(join(f.root, 'version-v3.0.1-lite.apk')), JSON.stringify(lines))
  f.setContent([{ ...pane(['  report.md', '  other.md'], f.root), columns: 120 }])
  assert.deepEqual((await f.scan()).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, 'report.md'), join(f.root, 'other.md')])
})

test('layout wraps preserve two whitespace interpretations and share the bounded scan budget', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'version-v3.0.1-lite.apk'), 'compact')
  await writeFile(join(f.root, 'version-v3.0.1  -lite.apk'), 'spaced')
  f.setContent([{ ...pane(['  version-v3.0.1', '  -lite.apk'], f.root), columns: 120 }])
  assert.deepEqual((await f.scan()).panes, [], 'multiple existing whitespace interpretations remain ambiguous')
  f.setContent([{ ...pane(['  version-v3.0.1', '  -lite.apk (2.1 MB)'], f.root), columns: 120 }])
  assert.deepEqual((await f.scan()).panes, [], 'a trailing annotation does not discard the literal boundary whitespace interpretation')
  await rm(join(f.root, 'version-v3.0.1-lite.apk'))
  assert.deepEqual((await f.scan()).panes.flatMap(group => group.items.flatMap(item => item.kind === 'file' ? [item.path] : [])), [join(f.root, 'version-v3.0.1  -lite.apk')])
  const rows = Array.from({ length: 250 }, (_, index) => [`│ file │ version${index.toString().padStart(3, '0')}.1 │`, '│      │ -lite.apk    │']).flat()
  const candidates = contentCandidates([{ ...pane(rows, f.root), columns: 120 }])
  assert(candidates.truncated)
  assert(candidates.panes.flatMap(group => group.items).length <= 200)
  assert([...candidates.fileChoices.values()].every(choice => choice.paths.length <= 2 && choice.references.length <= 2))
  const oversized = contentCandidates([pane([`│ file │ /tmp/${'x'.repeat(9000)} │`, '│      │ -lite.apk │'], f.root)])
  assert(!oversized.panes.flatMap(group => group.items).some(item => item.kind === 'file' && (item.path?.length || 0) > 8192))
})


test('path seed discovery shares the reconstruction budget on delimiter-heavy text', () => {
  const result = contentCandidates([pane(['('.repeat(8000) + 'word', 'Later (/tmp/unreached/', 'file.png)'])])
  assert.equal(result.truncated, true)
  assert(!result.panes.flatMap(pane => pane.items).some(item => item.kind === 'file' && item.path === '/tmp/unreached/file.png'))
})
