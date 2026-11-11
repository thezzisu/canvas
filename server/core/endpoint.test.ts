import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverCorePython,
  localCoreSocket,
  parseCoreSocket,
  validateCoreLocation,
  type CoreLocation,
} from './endpoint.ts'

function listen(t: test.TestContext, path: string) {
  const server = createServer((client) => client.destroy())
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return new Promise<void>((resolve) => server.listen(path, resolve))
}

test('core discovery follows explicit, environment, TOML, runtime and session endpoint precedence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cv-core-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
  }
  const run = join(env.XDG_RUNTIME_DIR, 'herdr-core'),
    configured = join(root, 'config # quote " socket.sock')
  const environment = join(root, 'environment.sock'),
    explicit = join(root, 'explicit.sock')
  await mkdir(run, { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'herdr-core'), { recursive: true })
  for (const path of [
    configured,
    environment,
    explicit,
    ...['default', 'scratch', 'from-env'].map((name) => join(run, `${name}.sock`)),
  ])
    await listen(t, path)
  // Runs the script the way the SSH transport does, with a synthetic environment.
  const discover = (location: CoreLocation, environment: Record<string, string>) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        'python3',
        ['-c', discoverCorePython, JSON.stringify(location)],
        { env: environment },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr)) : resolve(parseCoreSocket(stdout)),
      ),
    )
  assert.equal(await discover({}, env), join(run, 'default.sock'))
  assert.equal(
    await discover({ herdrSession: 'scratch' }, { ...env, HC_SESSION: 'other' }),
    join(run, 'scratch.sock'),
  )
  assert.equal(await discover({}, { ...env, HC_SESSION: 'from-env' }), join(run, 'from-env.sock'))
  await writeFile(
    join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'),
    `shell = ["sh", "-l"]\nsocket = ${JSON.stringify(configured)} # socket field only\n[unrelated]\nsocket = "/wrong.sock"\n`,
  )
  assert.equal(await discover({}, env), configured)
  assert.equal(await discover({}, { ...env, HC_SOCKET: environment }), environment)
  assert.equal(
    await discover({ herdrSocket: explicit }, { ...env, HC_SOCKET: environment }),
    explicit,
  )
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), 'socket = malformed')
  await assert.rejects(discover({}, env), /Cannot parse core config/u)
  assert.equal(
    await discover({ herdrSocket: explicit }, env),
    explicit,
    'explicit endpoints do not parse unrelated config',
  )
})

test('core discovery resolves socket aliases and rejects invalid endpoints', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cv-core-endpoint-')),
    socket = join(root, 'core.sock'),
    alias = join(root, 'alias.sock')
  t.after(() => rm(root, { recursive: true, force: true }))
  await listen(t, socket)
  await symlink(socket, alias)
  const location = { herdrSocket: alias }
  assert.equal(await localCoreSocket(location), socket)
  const regular = join(root, 'regular')
  await writeFile(regular, 'not a socket')
  await assert.rejects(localCoreSocket({ herdrSocket: regular }), /not a Unix socket/u)
  await assert.rejects(
    localCoreSocket({ herdrSocket: join(root, 'missing.sock') }),
    /discovery failed/u,
  )
  for (const bad of ['relative', '/tmp/a:b', '/tmp/a\n'])
    assert.throws(() => validateCoreLocation({ herdrSocket: bad }))
  for (const bad of ['..', '.', 'a/b', 'a b'])
    assert.throws(() => validateCoreLocation({ herdrSession: bad }))
  assert.throws(() => parseCoreSocket('{"socket":"relative"}'), /Invalid core socket/u)
})
