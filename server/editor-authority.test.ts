import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function isolated(t: TestContext, body: string, config: { destination?: string; portOption?: string; output?: string } = {}, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-editor-authority-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const wrapper = join(bin, "ssh");
  await writeFile(join(root, "ssh-fixture.json"), JSON.stringify(config));
  await writeFile(wrapper, `#!/usr/bin/python3
import json,pathlib,sys
root=pathlib.Path(__file__).parent.parent
fixture=json.loads((root/'ssh-fixture.json').read_text())
args=sys.argv[1:]
assert args[0]=='-G'
assert '--' in args and args.index('--')==len(args)-2
assert args[-1]==fixture['destination']
if fixture.get('portOption'):
 assert args[args.index('-p')+1]==fixture['portOption']
else:
 assert '-p' not in args
(root/'ssh-arguments.json').write_text(json.dumps(args))
print(fixture['output'])
`);
  await chmod(wrapper, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { editorAuthority } from './server/providers.ts';
import { vscodeDirectoryUri } from './server/editor-links.ts';
const root = process.env.CANVAS_AUTHORITY_TEST_ROOT;
const source = { id: 'fixture', name: 'Fixture', transport: 'ssh' };
${body}
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: sourceRoot,
      env: { PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`, LANG: "C.UTF-8", CANVAS_AUTHORITY_TEST_ROOT: root, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("editor authority fixture timed out")); }, 10_000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output || `editor authority fixture exited ${code}`)); });
  });
}

test("literal SSH targets resolve their username and port through the source's scoped SSH options", async t => {
  await isolated(t, `
const actual = await editorAuthority({ ...source, target: 'ssh://alice@host.example:2201',
  sshIdentityFile: '/fixture/private key', sshKnownHostsFile: '/fixture/known hosts' });
assert.deepEqual(actual, { hostName: 'host.example', user: 'alice', port: 2201 });
const args = JSON.parse(await readFile(join(root, 'ssh-arguments.json'), 'utf8'));
assert(args.includes('/fixture/private key'));
assert(args.includes('UserKnownHostsFile="/fixture/known hosts"'));
const uri = vscodeDirectoryUri(actual, '/workspace');
const encoded = new URL(uri).pathname.split('/')[1].slice('ssh-remote+'.length);
assert.deepEqual(JSON.parse(Buffer.from(encoded, 'hex').toString()), actual);
assert(!JSON.stringify(actual).includes('fixture-token'));
assert(!Buffer.from(encoded, 'hex').toString().includes('identityfile'));
`, {
    destination: "alice@host.example", portOption: "2201",
    output: "hostname host.example\nuser alice\nport 2201\nidentityfile /fixture/secret-key\nproxycommand fixture-token\nidentityagent /fixture/private-agent",
  });
});

test("literal IPv6 targets use their SSH port and return an unbracketed URI hostname", async t => {
  await isolated(t, `
const actual = await editorAuthority({ ...source, target: 'ssh://dev@[2001:db8::20]:2222' });
assert.deepEqual(actual, { hostName: '2001:db8::20', user: 'dev', port: 2222 });
`, { destination: "dev@[2001:db8::20]", portOption: "2222", output: "hostname [2001:db8::20]\nuser dev\nport 2222" });
});

test("existing SSH aliases expand server-side defaults without exposing other config fields", async t => {
  await isolated(t, `
const actual = await editorAuthority({ ...source, target: 'workstation-alias' });
assert.deepEqual(actual, { hostName: 'workstation.example', user: 'remote-user', port: 2022 });
assert.deepEqual(Object.keys(actual).sort(), ['hostName', 'port', 'user']);
`, { destination: "workstation-alias", output: "host workstation-alias\nhostname workstation.example\nuser remote-user\nport 2022\nidentityfile /fixture/do-not-expose\nproxyjump fixture-bastion" });
});

test("missing or invalid effective SSH address fields reject rather than constructing an ambiguous URI", async t => {
  for (const output of ["hostname host\nuser dev", "hostname host\nuser dev\nport 70000", "hostname host\nport 22"]) {
    await isolated(t, `
await assert.rejects(editorAuthority({ ...source, target: 'bad-alias' }), /could not be resolved/);
`, { destination: "bad-alias", output });
  }
});

test("local sources advertise the Canvas machine instead of a browser-local filesystem", async t => {
  for (const [env, expected] of [
    [{ CANVAS_HOST: "192.0.2.40" }, "192.0.2.40"],
    [{ CANVAS_HOST: "2001:db8::40" }, "2001:db8::40"],
    [{ CANVAS_HOST: "127.0.0.1" }, undefined],
    [{ CANVAS_HOST: "0.0.0.0" }, undefined],
    [{ CANVAS_HOST: "::" }, undefined],
    [{ CANVAS_HOST: "192.0.2.40", CANVAS_PUBLIC_SSH_HOST: "public.example", CANVAS_PUBLIC_SSH_PORT: "2022" }, "public.example"],
  ] as const) {
    await isolated(t, `
const actual = await editorAuthority({ ...source, transport: 'local' });
assert.deepEqual(actual, { hostName: ${expected ? JSON.stringify(expected) : "hostname()"},
  user: userInfo().username, port: ${"CANVAS_PUBLIC_SSH_PORT" in env ? 2022 : 22} });
assert.equal(await readFile(join(root, 'ssh-arguments.json')).then(() => true, () => false), false);
`, {}, env);
  }
});
