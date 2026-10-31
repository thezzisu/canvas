import { constants, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { hashPassword } from './auth.ts'

export interface Account { username: string; passwordHash: string }
export const accountUsername = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/u)
export const accountPassword = z.string().min(8).max(1024)
const accountFile = z.object({ username: accountUsername, passwordHash: z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/u), initialPassword: z.string().optional() })

/** One account file; only first-run random credentials retain a recoverable password. */
export class AccountStore {
  readonly path: string
  readonly account: Account

  constructor(directory: string, environment: { CANVAS_INIT_USERNAME?: string; CANVAS_INIT_PASSWORD?: string } = process.env,
    log: (message: string) => void = console.log) {
    directory = resolve(directory)
    this.path = join(directory, 'auth.json')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    let saved: z.infer<typeof accountFile>
    try { saved = this.read() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const username = accountUsername.parse(environment.CANVAS_INIT_USERNAME ?? 'canvas')
      const password = accountPassword.parse(environment.CANVAS_INIT_PASSWORD ?? randomBytes(24).toString('base64url'))
      saved = { username, passwordHash: hashPassword(password), ...(environment.CANVAS_INIT_PASSWORD === undefined ? { initialPassword: password } : {}) }
      try {
        this.write(saved, true)
        log(`Canvas account: ${username}`)
        log(`Account configuration: ${this.path}`)
        if (saved.initialPassword) log(`View initialPassword: cat -- '${this.path.replaceAll("'", "'\\''")}'`)
        else log('Initial password supplied by CANVAS_INIT_PASSWORD.')
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
        saved = this.read()
      }
    }
    this.account = { username: saved.username, passwordHash: saved.passwordHash }
  }

  update(username: string, password?: string): void {
    const next: Account = { username: accountUsername.parse(username),
      passwordHash: password === undefined ? this.account.passwordHash : hashPassword(accountPassword.parse(password)) }
    this.write(next)
    Object.assign(this.account, next)
  }

  private read() {
    const file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return accountFile.parse(JSON.parse(readFileSync(file, 'utf8'))) }
    finally { closeSync(file) }
  }

  private write(value: Account & { initialPassword?: string }, create = false) {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = openSync(temporary, 'wx', 0o600)
    try {
      try { writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); fsyncSync(file) }
      finally { closeSync(file) }
      if (create) linkSync(temporary, this.path)
      else renameSync(temporary, this.path)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}
