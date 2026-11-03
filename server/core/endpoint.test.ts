import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coreSocketPath, localCoreSocket, parseCoreSocket, validateCoreLocation } from './endpoint.ts'

test('core discovery follows explicit, environment, TOML, runtime and session endpoint precedence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cv-core-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run') }
  await mkdir(join(env.XDG_CONFIG_HOME, 'herdr-core'), { recursive: true })
  assert.equal(await coreSocketPath({}, env), join(env.XDG_RUNTIME_DIR, 'herdr-core/default.sock'))
  assert.equal(await coreSocketPath({ herdrSession: 'scratch' }, { ...env, HC_SESSION: 'other' }), join(env.XDG_RUNTIME_DIR, 'herdr-core/scratch.sock'))
  assert.equal(await coreSocketPath({}, { ...env, HC_SESSION: 'from-env' }), join(env.XDG_RUNTIME_DIR, 'herdr-core/from-env.sock'))
  const configured = join(root, 'config # quote " socket.sock')
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), `shell = ["sh", "-l"]\nsocket = ${JSON.stringify(configured)} # socket field only\n[unrelated]\nsocket = "/wrong.sock"\n`)
  assert.equal(await coreSocketPath({}, env), configured)
  assert.equal(await coreSocketPath({}, { ...env, HC_SOCKET: '/environment.sock' }), '/environment.sock')
  assert.equal(await coreSocketPath({ herdrSocket: '/explicit.sock' }, { ...env, HC_SOCKET: '/environment.sock' }), '/explicit.sock')
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), 'socket = malformed')
  await assert.rejects(coreSocketPath({}, env), /Cannot parse core config/u)
  assert.equal(await coreSocketPath({ herdrSocket: '/explicit.sock' }, env), '/explicit.sock', 'explicit endpoints do not parse unrelated config')
})

test('core discovery resolves socket aliases and rejects invalid endpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cv-core-endpoint-')), socket = join(root, 'core.sock'), alias = join(root, 'alias.sock')
  const server = createServer(client => client.destroy())
  await new Promise<void>(resolve => server.listen(socket, resolve)); await symlink(socket, alias)
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const location = { herdrSocket: alias }
  assert.equal(await localCoreSocket(location), socket)
  const regular = join(root, 'regular'); await writeFile(regular, 'not a socket')
  await assert.rejects(localCoreSocket({ herdrSocket: regular }), /not a Unix socket/u)
  await assert.rejects(localCoreSocket({ herdrSocket: join(root, 'missing.sock') }), /discovery failed/u)
  for (const bad of ['relative', '/tmp/a:b', '/tmp/a\n']) assert.throws(() => validateCoreLocation({ herdrSocket: bad }))
  for (const bad of ['..', '.', 'a/b', 'a b']) assert.throws(() => validateCoreLocation({ herdrSession: bad }))
  assert.throws(() => parseCoreSocket('{"socket":"relative"}'), /Invalid core socket/u)
})
