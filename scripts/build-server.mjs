import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
for (const directory of ['server', 'shared', 'cli'])
  await rm(new URL(`../dist/${directory}`, import.meta.url), { recursive: true, force: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'], {
  cwd: root, stdio: 'inherit',
})
await mkdir(new URL('../dist/cli', import.meta.url), { recursive: true })
await copyFile(new URL('../cli/canvas', import.meta.url), new URL('../dist/cli/canvas', import.meta.url))
