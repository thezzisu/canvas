import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readBuildInfo, serverBuildModule } from '../build-info.config.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const buildInfo = readBuildInfo(root)
for (const directory of ['server', 'shared', 'cli'])
  await rm(new URL(`../dist/${directory}`, import.meta.url), { recursive: true, force: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'], {
  cwd: root, stdio: 'inherit',
})
await writeFile(new URL('../dist/server/build-info.js', import.meta.url), serverBuildModule(buildInfo))
await mkdir(new URL('../dist/cli', import.meta.url), { recursive: true })
await copyFile(new URL('../cli/canvas', import.meta.url), new URL('../dist/cli/canvas', import.meta.url))
