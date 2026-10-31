import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountStore } from './account.ts'
import { verifyPassword } from './auth.ts'
import { createApp } from './app.ts'
import { Store } from './state.ts'
import type { TerminalManager } from './terminals.ts'

function directory(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-account-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('first serve creates a private recoverable random password without logging its value', t => {
  const root = directory(t), logs: string[] = []
  const accounts = new AccountStore(root, {}, value => logs.push(value))
  const saved = JSON.parse(readFileSync(accounts.path, 'utf8'))
  assert.equal(accounts.account.username, 'canvas')
  assert.match(saved.initialPassword, /^[A-Za-z0-9_-]{32}$/u)
  assert(verifyPassword(saved.initialPassword, accounts.account.passwordHash))
  assert.equal(statSync(accounts.path).mode & 0o777, 0o600)
  assert(logs.some(value => value.includes(accounts.path)))
  assert(logs.some(value => value.includes('initialPassword')))
  assert(!logs.join('\n').includes(saved.initialPassword))
  assert.deepEqual(readdirSync(root), ['auth.json'])
  const restarted = new AccountStore(root, { CANVAS_INIT_USERNAME: '', CANVAS_INIT_PASSWORD: '' }, () => assert.fail('existing accounts do not initialize again'))
  assert.deepEqual(restarted.account, accounts.account)
})

test('initial environment credentials apply once and account changes persist without an initial secret', t => {
  const root = directory(t)
  const accounts = new AccountStore(root, { CANVAS_INIT_USERNAME: ' operator ', CANVAS_INIT_PASSWORD: 'fixture-initial-password' }, () => {})
  assert.equal(accounts.account.username, 'operator')
  assert(!('initialPassword' in JSON.parse(readFileSync(accounts.path, 'utf8'))))
  const reference = accounts.account
  accounts.update('renamed', 'fixture-changed-password')
  assert.equal(accounts.account, reference, 'the running app keeps the live account reference')
  assert(verifyPassword('fixture-changed-password', reference.passwordHash))
  assert(!verifyPassword('fixture-initial-password', reference.passwordHash))
  const restarted = new AccountStore(root, { CANVAS_INIT_USERNAME: 'ignored', CANVAS_INIT_PASSWORD: 'fixture-ignored-password' }, () => {})
  assert.deepEqual(restarted.account, reference)
  const bytes = readFileSync(accounts.path, 'utf8')
  assert(!bytes.includes('fixture-changed-password'))
  assert.equal(statSync(accounts.path).mode & 0o777, 0o600)
})

test('invalid initialization or existing malformed account fails without overwriting credentials', t => {
  const root = directory(t)
  assert.throws(() => new AccountStore(root, { CANVAS_INIT_PASSWORD: 'short' }, () => {}))
  assert.deepEqual(readdirSync(root), [])
  writeFileSync(join(root, 'auth.json'), 'malformed', { mode: 0o600 })
  assert.throws(() => new AccountStore(root, {}, () => {}))
  assert.equal(readFileSync(join(root, 'auth.json'), 'utf8'), 'malformed')
})

test('account changes require the current password, keep the caller and revoke peer sessions on password change', async t => {
  const root = directory(t), accounts = new AccountStore(root, {}, () => {})
  const initial = JSON.parse(readFileSync(accounts.path, 'utf8')).initialPassword
  const store = new Store(join(root, 'state.db')); t.after(() => store.close())
  store.addSession('caller'); store.addSession('peer')
  const app = createApp(store, accounts.account, {} as TerminalManager, { updateAccount: (username, password) => accounts.update(username, password) })
  const call = (path: string, method: string, body?: unknown, token = 'caller') => app.request(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const snapshot = readFileSync(accounts.path, 'utf8')
  assert.equal((await call('/api/account', 'PATCH', { username: 'renamed', currentPassword: initial }, '')).status, 401)
  assert.equal((await call('/api/account', 'PATCH', { username: 'renamed', currentPassword: 'wrong-password' })).status, 403)
  assert.equal(readFileSync(accounts.path, 'utf8'), snapshot)
  assert(store.hasSession('caller') && store.hasSession('peer'))
  let notifications = 0; store.on('account', () => notifications++)
  const rename = await call('/api/account', 'PATCH', { username: 'renamed', currentPassword: initial })
  assert.equal(rename.status, 200); assert.deepEqual(await rename.json(), { username: 'renamed' })
  assert(store.hasSession('peer'), 'a name change does not disconnect other devices')
  assert(!('initialPassword' in JSON.parse(readFileSync(accounts.path, 'utf8'))))
  const changed = await call('/api/account', 'PATCH', { username: 'renamed', currentPassword: initial, password: 'fixture-new-password' })
  assert.equal(changed.status, 200)
  assert(store.hasSession('caller')); assert(!store.hasSession('peer')); assert.equal(notifications, 2)
  const session = await (await call('/api/session', 'GET')).json()
  assert.equal(session.username, 'renamed'); assert.equal(session.authenticated, true)
  assert(!('passwordHash' in session) && !('initialPassword' in session))
  assert.equal((await call('/api/login', 'POST', { username: 'renamed', password: initial }, '')).status, 401)
  assert.equal((await call('/api/login', 'POST', { username: 'renamed', password: 'fixture-new-password' }, '')).status, 200)
})
