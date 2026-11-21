// The canvas helper on a source, and the bridge it uses to open files in Canvas.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { ensureSocketTunnel } from './ssh-tunnels.ts'
import { join } from 'node:path'
import type { Source } from './state.ts'
import {
  COMMAND_TIMEOUT,
  commandEnvironment,
  runRemoteShell,
  runRemoteShellWithInput,
  shellQuote,
  validateSource,
} from './source-command.ts'
import { tunnelRequest } from './source-connections.ts'
import { nativeSocketForSource } from './runtimes.ts'

interface OpenBridgeRecord {
  version: 1
  nativeSocket: string
  socket: string
  secret: string
}

const bridgeRegistryPython = String.raw`import hashlib,json,os,pathlib,secrets,stat,sys
os.umask(0o077)
record=json.loads(sys.stdin.buffer.read())
base=pathlib.Path.home()/'.local/state/canvas/bridges'
base.mkdir(mode=0o700,parents=True,exist_ok=True)
info=base.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077: raise SystemExit('Canvas bridge registry directory is not private')
key=hashlib.sha256((record['nativeSocket']+'\0'+record['secret']).encode()).hexdigest()
target=base/(key+'.json')
body=(json.dumps(record,separators=(',',':'))+'\n').encode()
if sys.argv[1]=='remove':
 try: info=target.lstat()
 except FileNotFoundError: info=None
 if info is not None:
  if not stat.S_ISREG(info.st_mode) or target.is_symlink(): raise SystemExit('Canvas bridge registry changed; leaving it untouched')
  if target.read_bytes()!=body: raise SystemExit('Canvas bridge registry changed; leaving it untouched')
  target.unlink()
 print(str(target)); raise SystemExit(0)
try: info=target.lstat()
except FileNotFoundError: info=None
if info is not None:
 if not stat.S_ISREG(info.st_mode) or target.is_symlink(): raise SystemExit('Canvas bridge registry key collision')
 if target.read_bytes()==body: print(str(target)); raise SystemExit(0)
 raise SystemExit('Canvas bridge registry key collision')
temporary=base/('.'+key+'.'+secrets.token_hex(8)+'.tmp')
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
 with os.fdopen(fd,'wb') as handle:
  handle.write(body);handle.flush();os.fsync(handle.fileno())
 os.link(temporary,target)
finally:
 temporary.unlink(missing_ok=True)
directory=os.open(base,os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
print(str(target))`

function validateBridgeRecord(record: OpenBridgeRecord): void {
  if (
    record.version !== 1 ||
    !record.nativeSocket.startsWith('/') ||
    !record.socket.startsWith('/') ||
    /[:\x00-\x1f\x7f]/u.test(record.nativeSocket + record.socket) ||
    record.secret.length < 32 ||
    record.secret.length > 256 ||
    /[^A-Za-z0-9_-]/u.test(record.secret)
  )
    throw new Error('Invalid Canvas bridge registry record')
}

export async function writeRemoteBridgeRegistry(
  source: Source,
  record: OpenBridgeRecord,
): Promise<() => Promise<void>> {
  validateSource(source)
  if (source.transport !== 'ssh') throw new Error('Remote bridge registry requires an SSH source')
  validateBridgeRecord(record)
  const expected = JSON.stringify(record)
  const python = `python3 -c ${shellQuote(bridgeRegistryPython)}`
  await runRemoteShellWithInput(source, `${python} write`, expected)
  let cleaned = false
  return async () => {
    if (cleaned) return
    await runRemoteShellWithInput(source, `${python} remove`, expected)
    cleaned = true
  }
}

// Match the shipped helper bytes; never execute or replace unrelated commands.
const helperInstallPython = String.raw`import hashlib,json,os,pathlib,secrets,shutil,stat,sys
os.umask(0o077)
expected=sys.argv[1]
payload=sys.stdin.buffer.read(8*1024*1024+1)
if not payload or len(payload)>8*1024*1024 or hashlib.sha256(payload).hexdigest()!=expected: raise SystemExit('Canvas helper checksum mismatch')
marker=b'#!/usr/bin/env python3\n# @thezzisu/canvas managed helper\n'
uid=os.getuid()
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
refusal='Canvas helper path is unsafe; leaving it untouched'
home=os.environ.get('HOME')
if not home or not os.path.isabs(home): raise SystemExit('HOME is required to install the Canvas helper')
target=os.path.join(home,'.local','bin','canvas')
found=shutil.which('canvas')
if found and os.path.abspath(found)!=target:
 try:
  resolved=pathlib.Path(found).resolve(strict=True)
  package=resolved.parent.parent.parent/'package.json'
  if resolved.name!='main.js' or resolved.parent.name!='cli' or resolved.parent.parent.name!='dist' or package.stat().st_size>65536: raise SystemExit(0)
  metadata=json.loads(package.read_text())
  if metadata.get('name')!='@thezzisu/canvas' or metadata.get('bin',{}).get('canvas')!='dist/cli/main.js': raise SystemExit(0)
  bundled=resolved.with_name('canvas')
  if bundled.is_file() and bundled.stat().st_size<=8*1024*1024 and hashlib.sha256(bundled.read_bytes()).hexdigest()==expected: raise SystemExit(0)
 except (OSError,ValueError,TypeError,AttributeError,RuntimeError): raise SystemExit(0)
def directory(parent,name):
 try: os.mkdir(name,0o700,dir_fd=parent)
 except FileExistsError: pass
 fd=os.open(name,flags|os.O_DIRECTORY,dir_fd=parent)
 info=os.fstat(fd)
 if info.st_uid!=uid or not stat.S_ISDIR(info.st_mode) or info.st_mode&0o002: raise SystemExit(refusal)
 return fd
root=os.open(home,flags|os.O_DIRECTORY)
info=os.fstat(root)
if info.st_uid!=uid or info.st_mode&0o002: raise SystemExit(refusal)
bin=directory(directory(root,'.local'),'bin')
previous=None
try:
 info=os.stat('canvas',dir_fd=bin,follow_symlinks=False)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_size>8*1024*1024: raise SystemExit(0)
 with os.fdopen(os.open('canvas',flags,dir_fd=bin),'rb') as current:
  before=os.fstat(current.fileno())
  if (before.st_dev,before.st_ino)!=(info.st_dev,info.st_ino): raise SystemExit(0)
  existing=current.read(8*1024*1024+1)
 if hashlib.sha256(existing).hexdigest()==expected: raise SystemExit(0)
 if not existing.startswith(marker): raise SystemExit(0)
 previous=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)
except FileNotFoundError: pass
name='.canvas.'+secrets.token_hex(16)+'.tmp'
fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755,dir_fd=bin)
try:
 with os.fdopen(fd,'wb') as stream:
  stream.write(payload);stream.flush();os.fchmod(stream.fileno(),0o755);os.fsync(stream.fileno())
 if previous:
  info=os.stat('canvas',dir_fd=bin,follow_symlinks=False)
  if not stat.S_ISREG(info.st_mode) or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)!=previous: raise SystemExit(0)
  os.replace(name,'canvas',src_dir_fd=bin,dst_dir_fd=bin)
 else:
  try: os.link(name,'canvas',src_dir_fd=bin,dst_dir_fd=bin,follow_symlinks=False)
  except FileExistsError: pass
 os.fsync(bin)
finally:
 try: os.unlink(name,dir_fd=bin)
 except FileNotFoundError: pass`

async function installLocalHelper(bytes: Buffer, expectedHash: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', ['-c', helperInstallPython, expectedHash], {
      env: commandEnvironment(),
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT)
    timer.unref()
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf8')).slice(-1200)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.once('error', () => {})
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || 'Canvas helper installation failed'))
    })
    child.stdin.end(bytes)
  })
}

export async function installCanvasHelper(source: Source, helperBytes: Buffer): Promise<void> {
  validateSource(source)
  if (
    !Buffer.isBuffer(helperBytes) ||
    helperBytes.length === 0 ||
    helperBytes.length > 8 * 1024 * 1024
  )
    throw new Error('Canvas helper size is invalid')
  const expectedHash = createHash('sha256').update(helperBytes).digest('hex')
  if (source.transport === 'local') return await installLocalHelper(helperBytes, expectedHash)
  const command = `python3 -c ${shellQuote(helperInstallPython)} ${expectedHash}`
  await runRemoteShellWithInput(source, command, helperBytes)
}

export async function prepareOpenBridge(
  source: Source,
  localUnixSocket: string,
): Promise<{ nativeSocket: string; remoteSocket?: string; cleanup(): Promise<void> }> {
  validateSource(source)
  if (!localUnixSocket.startsWith('/') || /[:\x00-\x1f\x7f]/u.test(localUnixSocket))
    throw new Error('Local bridge socket path is invalid')
  const nativeSocket = await nativeSocketForSource(source)
  if (source.transport !== 'ssh') return { nativeSocket, cleanup: async () => {} }

  const prefix = createHash('sha256').update(source.id).digest('hex').slice(0, 12)
  const remoteDirectory = `/tmp/canvas-bridge-${prefix}-${randomUUID().replaceAll('-', '')}`
  const remoteSocket = join(remoteDirectory, 'open.sock')
  await runRemoteShell(source, `umask 077 && mkdir -m 700 -- ${shellQuote(remoteDirectory)}`)
  const cleanupRemote = async () => {
    await runRemoteShell(source, `rmdir -- ${shellQuote(remoteDirectory)}`)
  }
  try {
    const tunnel = await ensureSocketTunnel(
      tunnelRequest(
        source,
        {},
        { 'open.sock': { remotePath: remoteSocket, localPath: localUnixSocket } },
        cleanupRemote,
        `${source.id}:canvas-open`,
      ),
    )
    try {
      await runRemoteShell(
        source,
        `i=0; while [ "$i" -lt 400 ]; do if [ -S ${shellQuote(remoteSocket)} ]; then exit 0; fi; i=$((i+1)); sleep 0.025; done; exit 1`,
      )
    } catch (error) {
      await tunnel.close()
      throw error
    }
    let cleaned = false
    return {
      nativeSocket,
      remoteSocket: tunnel.remoteSockets['open.sock'],
      async cleanup() {
        if (cleaned) return
        cleaned = true
        await tunnel.close()
      },
    }
  } catch (error) {
    await cleanupRemote().catch(() => {})
    throw error
  }
}

/** Minimal named environment for runtime commands; never forwards server secrets. */
