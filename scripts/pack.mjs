import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
export const isLicenseFile = name => name.split('/').some(part => /^licen[cs]es?$/i.test(part))
  || /^(?:licen[cs]e|copying|copyright|notice|(?:.*[-_])?ofl)(?:\.(?:md|txt))?$/i.test(path.posix.basename(name))

/** Package existing build output without modifying the checkout or its licenses. */
export async function packRelease({ source = root, destination = process.cwd() } = {}) {
  destination = path.resolve(destination)
  const stage = await mkdtemp(path.join(tmpdir(), 'canvas-pack-'))
  try {
    // Missing build/license output must fail before creating an archive.
    await readFile(path.join(source, 'dist/web/.vite/license.md'))
    await cp(path.join(source, 'dist'), path.join(stage, 'dist'), { recursive: true })
    for (const name of ['README.md', 'package.json']) await cp(path.join(source, name), path.join(stage, name))
    const licenses = []
    async function collect(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await collect(file)
        else if (entry.isFile() && isLicenseFile(path.relative(stage, file).split(path.sep).join('/'))) {
          licenses.push({ name: path.relative(stage, file), bytes: await readFile(file) })
          await rm(file)
        }
      }
    }
    await collect(path.join(stage, 'dist'))
    const combined = [await readFile(path.join(source, 'LICENSE'))]
    for (const license of licenses) combined.push(Buffer.from(`\n\n----- ${license.name} -----\n\n`), license.bytes)
    await writeFile(path.join(stage, 'LICENSE'), Buffer.concat(combined))
    const userconfig = path.join(stage, '.npm-user'), globalconfig = path.join(stage, '.npm-global')
    await writeFile(userconfig, ''); await writeFile(globalconfig, '')
    await mkdir(destination, { recursive: true })
    const result = spawnSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', destination,
      '--userconfig', userconfig, '--globalconfig', globalconfig], { cwd: stage, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed')
    const packs = JSON.parse(result.stdout)
    const notices = packs[0].files.filter(file => isLicenseFile(file.path)).map(file => file.path)
    if (notices.length !== 1 || notices[0] !== 'LICENSE') throw new Error(`Expected one top-level LICENSE: ${notices.join(', ')}`)
    return packs
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'pack-destination': { type: 'string' } } })
  try { process.stdout.write(JSON.stringify(await packRelease({ destination: values['pack-destination'] })) + '\n') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
