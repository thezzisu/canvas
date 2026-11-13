import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HerdrClientTransport } from './herdr/client.ts'
import { herdrApiRequest } from './herdr/api.ts'
import { contentCandidates } from './content-candidates.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import { gridColumns, gridText } from './test-grid.ts'
import type { FrameData } from './herdr/wire.ts'
import {
  createSpace,
  createWindow,
  renameSpace,
  renameWindow,
  closeSpace,
  closeWindow,
  listResources,
  openTerminal,
  type Source,
} from './runtimes.ts'

test('native herdr transport works with an unmodified server: split rendering, keyboard, mouse and viewport resize', async (t) => {
  const serverBinary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY
  if (!serverBinary) {
    t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'canvas-herdr-test-'))
  const shell = process.env.CANVAS_TEST_SHELL || '/bin/sh'
  const prompt = 'CANVAS_TEST_SHELL>'
  const before = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
  }
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.XDG_STATE_HOME = join(root, 'state')
  for (const flavor of ['herdr', 'herdr-dev']) {
    mkdirSync(join(root, 'config', flavor), { recursive: true })
    writeFileSync(
      join(root, 'config', flavor, 'config.toml'),
      `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\n`,
    )
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: root,
    USER: process.env.USER ?? 'test',
    SHELL: shell,
    PS1: `${prompt} `,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  }
  const session = 'canvas-test'
  const cli = (...args: string[]) =>
    execFileSync(serverBinary, ['--session', session, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
  const source: Source = {
    id: 'herdr-test',
    name: 'Herdr test',
    transport: 'local',
    herdrSocket: join(root, 'config', 'herdr', 'sessions', session, 'herdr.sock'),
    herdrSession: session,
  }
  const server = spawn(serverBinary, ['--session', session, 'server'], {
    env,
    stdio: 'ignore',
  })
  let terminal: HerdrClientTransport | undefined
  let secondTerminal: HerdrClientTransport | undefined
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined
  let secondCommand: Awaited<ReturnType<typeof openTerminal>> | undefined
  let frame: WindowMetadata | undefined
  let screen: FrameData | undefined
  let secondScreen: FrameData | undefined
  const screenText = () => (screen ? gridText(screen).join('\n') : '')
  const secondText = () => (secondScreen ? gridText(secondScreen).join('\n') : '')
  const waitFor = async (check: () => boolean | Promise<boolean>, message: string) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.fail(`${message}: ${screenText()}`)
  }
  const snapshot = () => JSON.parse(cli('api', 'snapshot')).result.snapshot
  const assertSplitGeometry = async (cols: number, rows: number) => {
    await waitFor(() => {
      if (screen?.width !== cols || screen.height !== rows) return false
      const top = gridColumns(screen)[0]!,
        bottom = gridColumns(screen)[rows - 1]!
      return (
        top.startsWith('┌') && top.endsWith('┐') && bottom.startsWith('└') && bottom.endsWith('┘')
      )
    }, 'native tab frame did not reach every edge of the native viewport')
  }
  try {
    await waitFor(
      async () => (await listResources(source)).status === 'online',
      'isolated herdr server did not start',
    )
    const created = await createSpace(source, 'Synthetic')
    let space = (await listResources(source)).spaces.find((s) => s.name === 'Synthetic')!
    assert.ok(space)
    const window = space.windows[0]!
    assert.deepEqual(created, { spaceId: space.id, windowId: window.id })
    const focusedBeforeCreation = snapshot().focused_tab_id
    const automaticTab = await createWindow(source, space.id)
    const automaticWindow = (await listResources(source)).spaces
      .find((s) => s.id === space.id)!
      .windows.find((w) => w.id === automaticTab.windowId)!
    assert.equal(automaticWindow.name, '2')
    assert.equal(automaticTab.spaceId, space.id)
    assert.equal(
      snapshot().focused_tab_id,
      focusedBeforeCreation,
      'creating a tab must not move native focus',
    )
    await closeWindow(source, automaticTab.spaceId, automaticTab.windowId)
    const inheritedCwd = join(root, 'inherited-directory')
    mkdirSync(inheritedCwd)
    const parent = await herdrApiRequest(source.herdrSocket!, 'workspace.create', {
      cwd: inheritedCwd,
      focus: false,
    })
    const parentId = (parent.tab as { workspace_id: string }).workspace_id
    const automaticSpace = await createSpace(source, '  ', parentId)
    const newSpace = (await listResources(source)).spaces.find(
      (s) => s.id === automaticSpace.spaceId,
    )!
    assert.equal(
      newSpace.name,
      'inherited-directory',
      'native workspace naming follows its inherited directory',
    )
    assert.equal(newSpace.windows[0]!.id, automaticSpace.windowId)
    assert.equal(
      snapshot().panes.find((p: { tab_id: string }) => p.tab_id === automaticSpace.windowId).cwd,
      inheritedCwd,
    )
    assert.equal(
      snapshot().focused_tab_id,
      focusedBeforeCreation,
      'creating a space must not move native focus',
    )
    await closeSpace(source, automaticSpace.spaceId)
    await closeSpace(source, parentId)
    let data = snapshot()
    const pane = data.panes.find((p: { tab_id: string }) => p.tab_id === window.id)
    cli('pane', 'split', pane.pane_id, '--direction', 'right')
    data = snapshot()
    const nativePanes = data.panes.filter((p: { tab_id: string }) => p.tab_id === window.id)
    // Unknown self-reported agents are cleared when Herdr observes an idle shell.
    // Use a recognized label to test status mapping independently of that lifecycle.
    cli(
      'pane',
      'report-agent',
      nativePanes[0].pane_id,
      '--source',
      'canvas-test',
      '--agent',
      'pi',
      '--state',
      'working',
    )
    cli(
      'pane',
      'report-agent',
      nativePanes[1].pane_id,
      '--source',
      'canvas-test',
      '--agent',
      'pi',
      '--state',
      'blocked',
    )
    const statusWindow = (await listResources(source)).spaces
      .find((s) => s.id === space.id)!
      .windows.find((w) => w.id === window.id)!
    assert.equal(statusWindow.panes.length, 2)
    assert.equal(statusWindow.panes.find((p) => p.id === nativePanes[0].pane_id)!.status, 'working')
    assert.equal(
      statusWindow.panes.find((p) => p.id === nativePanes[1].pane_id)!.status,
      'attention',
    )
    assert.equal(statusWindow.status, 'attention')

    await createWindow(source, space.id, 'Other tab')
    const other = (await listResources(source)).spaces
      .find((s) => s.id === space.id)!
      .windows.find((w) => w.name === 'Other tab')!
    cli('tab', 'focus', other.id)
    command = await openTerminal(source, space.id, window.id)
    terminal = await command.connect(90, 25)
    terminal.onFrame((value) => {
      frame = value
    })
    terminal.onScreen((value) => {
      screen = value
    })
    await waitFor(
      () => screenText().includes(prompt),
      'native herdr client produced no shell frame',
    )
    await assertSplitGeometry(90, 25)
    terminal.write("printf 'HERDR_NATIVE_%s\\n' OK\r")
    await waitFor(
      () => screenText().includes('HERDR_NATIVE_OK'),
      'native herdr client did not accept native input',
    )
    terminal.resize(112, 32)
    data = snapshot()
    assert.equal(data.panes.filter((p: { tab_id: string }) => p.tab_id === window.id).length, 2)
    await assertSplitGeometry(112, 32)
    // SGR mouse reports select each native pane; keyboard input must follow it.
    terminal.write('\x1b[<0;5;3M\x1b[<0;5;3m')
    terminal.write("printf 'LEFT_%s\\n' MOUSE\r")
    await waitFor(() => screenText().includes('LEFT_MOUSE'), 'mouse did not select the left pane')
    // Each half reserves two border columns and one native scrollbar column.
    terminal.write('printf \'LEFT_TTY_%s\\n\' "$(stty size)"\r')
    await waitFor(
      () => screenText().includes('LEFT_TTY_30 53'),
      'left pane PTY did not fill its half of the resized tab',
    )
    terminal.write('\x1b[<0;80;3M\x1b[<0;80;3m')
    terminal.write("printf 'RIGHT_%s\\n' MOUSE\r")
    await waitFor(() => screenText().includes('RIGHT_MOUSE'), 'mouse did not select the right pane')
    const leftText = () => gridColumns(screen!, 0, 56).join('\n')
    const rightText = () => gridColumns(screen!, 56, 112).join('\n')
    assert.ok(leftText().includes('LEFT_MOUSE'))
    assert.ok(!leftText().includes('RIGHT_MOUSE'))
    assert.ok(rightText().includes('RIGHT_MOUSE'))
    assert.ok(!rightText().includes('LEFT_MOUSE'))
    terminal.write('printf \'RIGHT_TTY_%s\\n\' "$(stty size)"\r')
    await waitFor(
      () => screenText().includes('RIGHT_TTY_30 53'),
      'right pane PTY did not fill its half of the resized tab',
    )
    const wrappedPath = `/tmp/${'soft-wrap-'.repeat(9)}visible.txt`
    const wrappedUrl = `https://example.test/${'long-url-'.repeat(8)}page`
    const hardWrapped = `./${'说明'.repeat(12)}.md`
    const hardLine = ` ${hardWrapped.slice(0, -1)}`
    const coloredPath = `./${'测'.repeat(19)}a(1).md` // The first displayed row fills the 53-column native pane.
    const coloredLines = `Video (\x1b[32m${coloredPath.slice(0, -1)}\x1b[0m\r\n  \x1b[32md\x1b[0m)\r\n`
    const inlinePath = '~/workspace/project/dist/2026/11/05/canvas-note-ime-video/sheet-4.png'
    const inlineLines = `Reading ${inlinePath.slice(0, 45)}\r\n${inlinePath.slice(45)}\r\n`
    const programDrawing = 'PROGRAM │─ BODY'
    const scanScript = join(root, 'scan-visible.py')
    writeFileSync(
      scanScript,
      `import sys\nsys.stdout.write(${JSON.stringify(`${'SCROLLBACK\r\n'.repeat(80)}\x1b[2J\x1b[H${wrappedPath}\r\n${wrappedUrl}\r\n${hardLine}\r\n  d\r\n${coloredLines}${inlineLines}HARD_ONE\r\nHARD_TWO\r\n${programDrawing}\r\nSCAN_DONE\r\n`)});sys.stdout.flush()\n`,
    )
    terminal.write(`python3 '${scanScript}'\r`)
    await waitFor(() => screenText().includes('SCAN_DONE'), 'native scan fixture did not print')
    const beforeScan = snapshot()
    await waitFor(async () => {
      try {
        const scanned = await terminal!.content()
        const right = scanned?.find((item) => item.id === nativePanes[1].pane_id)
        return (
          !!right?.lines.join('').includes(wrappedPath) &&
          right.lines.join('').includes(wrappedUrl) &&
          right.lines.includes('HARD_ONE') &&
          right.lines.includes('HARD_TWO') &&
          !!right.coloredText?.includes(coloredPath) &&
          contentCandidates([right]).panes.some((pane) =>
            pane.items.some((item) => item.kind === 'file' && item.path === inlinePath),
          ) &&
          contentCandidates([right]).panes.some((pane) =>
            pane.items.some(
              (item) => item.kind === 'file' && item.path?.endsWith(coloredPath.slice(1)),
            ),
          ) &&
          contentCandidates([right]).panes.some((pane) =>
            pane.items.some(
              (item) => item.kind === 'file' && item.path?.endsWith(hardWrapped.slice(1)),
            ),
          )
        )
      } catch {
        return false
      }
    }, 'native current visible read omitted fixture text or hard line breaks')
    await waitFor(() => /[▐▕]/u.test(screenText()), 'native scrollbar fixture was not visible')
    const cleanPanes = await terminal.content()
    assert(
      cleanPanes
        ?.find((item) => item.id === nativePanes[1].pane_id)
        ?.lines.includes(programDrawing),
      'program-owned box-drawing characters are preserved',
    )
    const cleanText = cleanPanes!.flatMap((item) => item.lines).join('\n')
    assert(
      !/[┌┐└┘├┤┬┴┼▐▕]/u.test(cleanText),
      'pane reads omit native frame, divider and scrollbar decoration',
    )
    assert(
      !/[│─]/u.test(cleanText.replace(programDrawing, '')),
      'only the program contributes box-drawing characters',
    )
    const afterScan = snapshot()
    assert.equal(afterScan.focused_tab_id, beforeScan.focused_tab_id)
    assert.equal(afterScan.focused_pane_id, beforeScan.focused_pane_id)
    assert.deepEqual(
      afterScan.panes
        .filter((p: { tab_id: string }) => p.tab_id === window.id)
        .map((p: { scroll: unknown }) => p.scroll),
      beforeScan.panes
        .filter((p: { tab_id: string }) => p.tab_id === window.id)
        .map((p: { scroll: unknown }) => p.scroll),
    )
    await waitFor(() => !!frame?.layout, 'pane layout marker was not published')
    const menuPoint = { column: 4, row: 3, cols: 112, rows: 32, layout: frame!.layout! }
    const target = terminal.paneContext(menuPoint)!
    assert.equal(target.paneId, nativePanes[0].pane_id)
    assert.equal(
      terminal.paneContext({ ...menuPoint, column: 0 }),
      undefined,
      'native borders are not pane content',
    )
    assert.equal(
      terminal.paneContext({ ...menuPoint, column: 54 }),
      undefined,
      'native scrollbar gutter is not pane content',
    )
    await terminal.paneAction(target, { action: 'rename', name: 'Context 中文' })
    await waitFor(
      () =>
        snapshot().panes.find((p: { pane_id: string }) => p.pane_id === target.paneId)?.label ===
        'Context 中文',
      'pane rename RPC did not apply',
    )
    await terminal.paneAction(target, { action: 'zoom' })
    await waitFor(
      () => frame?.layout !== menuPoint.layout,
      'pane zoom did not replace the layout token',
    )
    assert.equal(
      terminal.paneContext(menuPoint),
      undefined,
      'same-size zoom rejects stale hit coordinates',
    )
    await terminal.paneAction(target, { action: 'zoom' })
    await assertSplitGeometry(112, 32)
    const countBefore = snapshot().panes.filter(
      (p: { tab_id: string }) => p.tab_id === window.id,
    ).length
    await terminal.paneAction(target, { action: 'split-down' })
    await waitFor(
      () =>
        snapshot().panes.filter((p: { tab_id: string }) => p.tab_id === window.id).length ===
        countBefore + 1,
      'pane split RPC did not apply',
    )
    const createdPane = snapshot().panes.find(
      (p: { tab_id: string; pane_id: string }) =>
        p.tab_id === window.id &&
        !nativePanes.some((original: { pane_id: string }) => original.pane_id === p.pane_id),
    )
    await waitFor(
      () => !!frame?.panes.some((pane) => pane.id === createdPane.pane_id),
      'new pane has not reached the client frame',
    )
    await terminal.paneAction({ ...target, paneId: createdPane.pane_id }, { action: 'close' })
    await waitFor(
      () => !snapshot().panes.some((p: { pane_id: string }) => p.pane_id === createdPane.pane_id),
      'pane close RPC did not apply',
    )
    await assert.rejects(
      terminal.paneAction({ ...target, bootId: 'another-boot' }, { action: 'close' }),
      /Pane changed/u,
    )
    terminal.resize(70, 18)
    await assertSplitGeometry(70, 18)
    terminal.resize(112, 32)
    await assertSplitGeometry(112, 32)
    secondCommand = await openTerminal(source, space.id, other.id)
    secondTerminal = await secondCommand.connect(90, 25)
    secondTerminal.onScreen((value) => (secondScreen = value))
    await waitFor(() => secondText().includes(prompt), 'second native tab produced no shell frame')
    secondTerminal.write("printf 'SECOND_TAB_%s\\n' ONLY\r")
    await waitFor(
      () => secondText().includes('SECOND_TAB_ONLY'),
      'second native tab input did not reach its window',
    )
    terminal.write("printf 'FIRST_TAB_%s\\n' ONLY\r")
    await waitFor(
      () => screenText().includes('FIRST_TAB_ONLY'),
      'first native tab lost its pinned input target',
    )
    assert.ok(!screenText().includes('SECOND_TAB_ONLY'), 'second tab output leaked to first')
    assert.ok(!secondText().includes('FIRST_TAB_ONLY'), 'first tab output leaked to second')
    cli('tab', 'focus', other.id)
    terminal.write("printf 'PINNED_FIRST_%s\\n' AFTER_API\r")
    await waitFor(
      () => screenText().includes('PINNED_FIRST_AFTER_API'),
      'external API focus redirected the first native client',
    )
    assert.ok(!secondText().includes('PINNED_FIRST_AFTER_API'))
    cli('tab', 'focus', window.id)
    secondTerminal.write("printf 'PINNED_SECOND_%s\\n' AFTER_API\r")
    await waitFor(
      () => secondText().includes('PINNED_SECOND_AFTER_API'),
      'external API focus redirected the second native client',
    )
    assert.ok(!screenText().includes('PINNED_SECOND_AFTER_API'))
    await renameSpace(source, space.id, 'Renamed space')
    await renameWindow(source, space.id, window.id, 'Renamed tab')
    space = (await listResources(source)).spaces.find((s) => s.id === space.id)!
    assert.equal(space.name, 'Renamed space')
    assert.equal(space.windows.find((w) => w.id === window.id)!.name, 'Renamed tab')
    await closeWindow(source, space.id, other.id)
    await closeSpace(source, space.id)
    assert.ok(!(await listResources(source)).spaces.some((s) => s.id === space.id))
  } finally {
    terminal?.kill()
    secondTerminal?.kill()
    await command?.cleanup()
    await secondCommand?.cleanup()
    try {
      cli('server', 'stop')
    } catch {
      /* Already stopped. */
    }
    server.kill()
    if (before.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = before.config
    if (before.state === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = before.state
    rmSync(root, { recursive: true, force: true })
  }
})
