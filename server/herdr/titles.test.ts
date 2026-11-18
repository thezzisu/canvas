import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { MouseArea } from '../../shared/terminal-mouse.ts'
import type { HerdrClientTransport } from './client.ts'
import {
  closeRuntimeConnections,
  createSpace,
  listResources,
  openTerminal,
  type Source,
} from '../runtimes.ts'

test('an open window shows each title herdr publishes without waiting for a redraw, and where its programs take the mouse', async (t) => {
  const serverBinary = process.env.CANVAS_TEST_HERDR_SERVER_BINARY
  if (!serverBinary) {
    t.skip('Set CANVAS_TEST_HERDR_SERVER_BINARY to an unmodified upstream server')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'canvas-herdr-titles-'))
  const shell = process.env.CANVAS_TEST_SHELL || '/bin/sh'
  const before = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME }
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.XDG_STATE_HOME = join(root, 'state')
  mkdirSync(join(root, 'config', 'herdr'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'herdr', 'config.toml'),
    `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\n`,
  )
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    SHELL: shell,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  }
  const session = 'canvas-titles'
  const cli = (...args: string[]) =>
    execFileSync(serverBinary, ['--session', session, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
  const source: Source = {
    id: 'herdr-titles',
    name: 'Herdr titles',
    transport: 'local',
    herdrSocket: join(root, 'config', 'herdr', 'sessions', session, 'herdr.sock'),
    herdrSession: session,
  }
  const server = spawn(serverBinary, ['--session', session, 'server'], { env, stdio: 'ignore' })
  let terminal: HerdrClientTransport | undefined
  let command: Awaited<ReturnType<typeof openTerminal>> | undefined
  const waitFor = async (check: () => boolean | Promise<boolean>, message: string, ms = 4500) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail(message)
  }
  try {
    await waitFor(
      async () => (await listResources(source)).status === 'online',
      'isolated herdr server did not start',
    )
    const { spaceId, windowId } = await createSpace(source, 'Titles')
    const panes = () =>
      JSON.parse(cli('api', 'snapshot'))
        .result.snapshot.panes.filter((pane: { tab_id: string }) => pane.tab_id === windowId)
        .map((pane: { pane_id: string }) => pane.pane_id) as string[]
    cli('pane', 'split', panes()[0]!, '--direction', 'right')
    const [agent, plain] = panes() as [string, string]
    // A working agent: herdr redraws nothing for it while only its title changes.
    cli(
      'pane',
      'report-agent',
      agent,
      '--source',
      'canvas-test',
      '--agent',
      'pi',
      '--state',
      'working',
    )
    command = await openTerminal(source, spaceId, windowId)
    terminal = await command.connect(120, 30)
    let metadata: WindowMetadata | undefined,
      mouse = [] as readonly MouseArea[]
    terminal.onMetadata((value) => (metadata = value))
    terminal.onScreen((_, areas) => (mouse = areas))
    const title = (paneId: string) =>
      metadata?.panes.find((pane) => pane.id === paneId)?.terminalTitle
    await waitFor(() => title(agent) !== undefined, 'the window has no titles from the API')
    for (const [paneId, text] of [
      [agent, 'Agent title'],
      [plain, 'Shell title'],
      [agent, '● ⠋ kept as published'],
    ] as const) {
      cli('pane', 'run', paneId, `printf '\\033]2;%s\\007' '${text}'`)
      const started = Date.now()
      await waitFor(() => title(paneId) === text, `${text} did not reach the open window`)
      // herdr batches its events about every 100 ms; the 2 s poll is not involved.
      assert.ok(Date.now() - started < 1500, `${text} took ${Date.now() - started} ms`)
    }
    assert.equal(mouse.length, 0, 'shells do not take the mouse')
    cli('pane', 'run', plain, "printf '\\033[?1000h\\033[?1006h'; sleep 30")
    await waitFor(
      () => mouse.length === 1,
      'a program that reports the mouse is not reported to Canvas',
    )
    const [area] = mouse
    assert.equal(area!.reports, true)
    assert.ok(
      area!.x > 0 && area!.width > 0 && area!.height > 0,
      'the right-hand pane, inside its frame',
    )
  } finally {
    terminal?.kill()
    await command?.cleanup()
    await closeRuntimeConnections(source.id)
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
