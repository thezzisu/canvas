#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildInfo } from '../server/build-info.ts'

const help = `Usage: canvas [serve | open [--preview] <path-or-url> | preview [directory] | capture [options] <command> | version]

  serve       Start Canvas (default)
  open        Open a file, directory or URL from a connected herdr pane
  preview     Serve a directory and preview its static website in this terminal
  capture     Run a command and show its loopback Web UI in this terminal
  version     Print the installed version
  --help      Show this help

open uses the caller's HERDR_SOCKET_PATH and HERDR_PANE_ID for TUI,
or HC_TERMINAL_SOCKET and HC_TERMINAL_ID for Core.
Daemon callers must supply the originating pane's values per invocation.

Preview examples:
  canvas preview ./site
  canvas open --preview ./site/page.html
  canvas open --preview --preview-root ./project ./project/docs/readme.md

Capture examples:
  canvas capture npm start
  canvas capture -c 'python3 -m http.server "$PORT"'
Use canvas capture --help for ports, environment and readiness options.
`
const [command = 'serve', ...args] = process.argv.slice(2)
if (['--help', '-h', 'help'].includes(command) || command === 'serve' && args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
  process.stdout.write(help)
} else if (['version', '--version', '-v'].includes(command) && !args.length) {
  console.log(buildInfo.version)
} else if (command === 'serve' && !args.length) {
  await import('../server/main.ts')
} else if (command === 'preview' || (command === 'open' || command === 'capture') && args.length) {
  const child = spawn('python3', [fileURLToPath(new URL('./canvas', import.meta.url)), command, ...args], {
    stdio: 'inherit', env: { ...process.env, CANVAS_HELPER_DIRECT: '1' },
  })
  child.once('error', () => { console.error(`canvas: Python 3 is required for ${command}`); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1) })
} else {
  console.error(`canvas: ${command === 'open' ? 'open requires a file, directory or URL' : 'unknown command or arguments'}`)
  process.stderr.write(help)
  process.exitCode = 2
}
