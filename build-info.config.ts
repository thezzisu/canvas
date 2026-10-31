import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from './shared/build-info.ts'

/** Read once at build time; emitted artifacts need neither Git nor the source checkout. */
export function readBuildInfo(root = fileURLToPath(new URL('.', import.meta.url))): BuildInfo {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  let revision: string | null = null, dirty = false
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* Source archives have a package version without a Git revision. */ }
  return { version, revision, dirty }
}

export function serverBuildModule(info: BuildInfo): string {
  return `export const buildInfo = Object.freeze(${JSON.stringify(info)});\n`
}
