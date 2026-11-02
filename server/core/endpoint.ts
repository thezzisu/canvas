import { execFile } from 'node:child_process'

export interface CoreLocation { herdrSocket?: string; herdrSession?: string }
export function validateCoreLocation(location: CoreLocation): void {
  if (location.herdrSocket !== undefined && (!location.herdrSocket.startsWith('/') || location.herdrSocket.length > 1000 || /[:\x00-\x1f\x7f]/u.test(location.herdrSocket)))
    throw new Error('Core socket must be an absolute Unix socket path')
  if (location.herdrSession !== undefined && (!/^[a-zA-Z0-9_.-]{1,64}$/u.test(location.herdrSession) || ['.', '..'].includes(location.herdrSession)))
    throw new Error('Invalid core session name')
}

// The same resolver runs locally or through the existing authenticated SSH
// transport. It reads one named config field and never starts or changes core.
// A configuration file needs Python 3.11's TOML reader; an explicit socket does
// not. Refusing an older TOML parser is safer than guessing another endpoint.
export const discoverCorePython = String.raw`import json,os,pathlib,stat,sys
location=json.loads(sys.argv[1]);session=location.get('herdrSession') or os.environ.get('HC_SESSION','').strip() or 'default'
if session in ('.','..') or any(ord(c)<32 or c in '/\\:*?"<>|' for c in session):raise SystemExit('Invalid core session name')
home=pathlib.Path(os.environ.get('HOME') or pathlib.Path.home())
config_home=pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or home/'.config')
state_home=pathlib.Path(os.environ.get('XDG_STATE_HOME') or home/'.local/state')
chosen=location.get('herdrSocket') or os.environ.get('HC_SOCKET')
if not chosen:
 config=config_home/'herdr-core/config.toml'
 try:
  with config.open('rb') as f:
   try:import tomllib
   except ImportError:raise SystemExit('Core config discovery needs Python 3.11; supply an explicit socket path')
   try:value=tomllib.load(f)
   except (ValueError,UnicodeError):raise SystemExit('Cannot parse core config; supply an explicit socket path')
  chosen=value.get('socket')
  if chosen is not None and not isinstance(chosen,str):raise SystemExit('Invalid core config socket')
 except FileNotFoundError:pass
if not chosen:
 run=os.environ.get('XDG_RUNTIME_DIR')
 if not run:
  user_run=pathlib.Path('/run/user')/str(os.getuid())
  if user_run.is_dir():run=str(user_run)
 chosen=pathlib.Path(run)/'herdr-core'/(session+'.sock') if run else state_home/'herdr-core'/session/(session+'.sock')
path=pathlib.Path(chosen)
if not path.is_absolute() or len(str(path))>1000 or any(ord(c)<32 or ord(c)==127 or c==':' for c in str(path)):raise SystemExit('Core socket must be an absolute Unix socket path')
if len(sys.argv)<3 or sys.argv[2]!='path':
 path=path.resolve(strict=True)
 if not stat.S_ISSOCK(path.stat().st_mode):raise SystemExit('Core endpoint is not a Unix socket')
print(json.dumps({'socket':str(path)}))`

export function parseCoreSocket(text: string): string {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid core socket discovery response') }
  if (!value || typeof value !== 'object' || !('socket' in value) || typeof value.socket !== 'string') throw new Error('Invalid core socket discovery response')
  try { validateCoreLocation({ herdrSocket: value.socket }) } catch { throw new Error('Invalid core socket discovery response') }
  return value.socket
}

function discover(location: CoreLocation, environment: NodeJS.ProcessEnv, pathOnly: boolean, signal?: AbortSignal): Promise<string> {
  validateCoreLocation(location)
  if (signal?.aborted) return Promise.reject(new DOMException('Core discovery cancelled', 'AbortError'))
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', discoverCorePython, JSON.stringify(location), ...(pathOnly ? ['path'] : [])], {
      env: environment, timeout: 10000, maxBuffer: 16 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Core socket discovery failed: ${stderr.trim().slice(-500) || error.message}`)); return }
      try { resolve(parseCoreSocket(stdout)) } catch (error) { reject(error) }
    })
  })
}

/** Resolve without checking or opening an endpoint; useful for setup/testing. */
export function coreSocketPath(location: CoreLocation, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return discover(location, environment, true)
}
export function localCoreSocket(location: CoreLocation, signal?: AbortSignal): Promise<string> {
  return discover(location, process.env, false, signal)
}
