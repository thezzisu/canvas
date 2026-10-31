#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildInfo } from '../server/build-info.ts'

const help = `Usage: canvas [serve | open <path-or-url> | version]

  serve       Start Canvas (default)
  open        Open a file, directory or URL from a connected herdr pane
  version     Print the installed version
  --help      Show this help
`
const [command = 'serve', ...args] = process.argv.slice(2)
if (['--help', '-h', 'help'].includes(command) || command === 'serve' && args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
  process.stdout.write(help)
} else if (['version', '--version', '-v'].includes(command) && !args.length) {
  console.log(buildInfo.version)
} else if (command === 'serve' && !args.length) {
  await import('../server/main.ts')
} else if (command === 'open' && args.length) {
  const child = spawn('python3', [fileURLToPath(new URL('./canvas', import.meta.url)), 'open', ...args], {
    stdio: 'inherit', env: { ...process.env, CANVAS_HELPER_DIRECT: '1' },
  })
  child.once('error', () => { console.error('canvas: Python 3 is required for open'); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1) })
} else {
  console.error(`canvas: ${command === 'open' ? 'open requires a file, directory or URL' : 'unknown command or arguments'}`)
  process.stderr.write(help)
  process.exitCode = 2
}
