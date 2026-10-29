import { test } from "node:test";
import assert from "node:assert/strict";
import { directoryPath, vscodeDirectoryUri } from "./editor-links.ts";

function decodeAuthority(uri: string) {
  const url = new URL(uri);
  const authority = url.pathname.split("/")[1]!;
  return JSON.parse(Buffer.from(authority.slice("ssh-remote+".length), "hex").toString());
}

test("VS Code links encode literal host, user and port without an SSH alias", () => {
  const uri = vscodeDirectoryUri({ hostName: "192.0.2.10", user: "dev", port: 2222 }, "/workspace/dev/project");
  assert.match(uri, /^vscode:\/\/vscode-remote\/ssh-remote\+[a-f\d]+\/workspace\/dev\/project$/u);
  assert.deepEqual(decodeAuthority(uri), { hostName: "192.0.2.10", user: "dev", port: 2222 });
});

test("VS Code links preserve Unicode, spaces and URI delimiters in absolute folder paths", () => {
  const path = "/workspace/开发/项目 #?/100% 'final'";
  const uri = vscodeDirectoryUri({ hostName: "server.example", user: "dev" }, path);
  const url = new URL(uri);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(decodeURIComponent(url.pathname.slice(url.pathname.indexOf("/", 1))), path);
  assert(!uri.includes(" "));
  assert(!uri.includes("'"));
});

test("IPv6 editor destinations use an unbracketed address in the JSON authority", () => {
  for (const hostName of ["2001:db8::10", "[2001:db8::10]"]) {
    const uri = vscodeDirectoryUri({ hostName, user: "dev", port: 22 }, "/");
    assert.deepEqual(decodeAuthority(uri), { hostName: "2001:db8::10", user: "dev", port: 22 });
    assert(uri.endsWith("/"));
  }
});

test("only nonsecret connection fields can enter an editor URI", () => {
  const uri = vscodeDirectoryUri({ hostName: "host.example", user: "dev", port: 22,
    privateKey: "/fixture/private-key", secret: "fixture-token" } as never, "/project");
  assert.deepEqual(decodeAuthority(uri), { hostName: "host.example", user: "dev", port: 22 });
  assert(!uri.includes("private-key"));
});

test("editor links reject invalid hosts, users, ports and nonabsolute paths", () => {
  for (const hostName of ["", "-option", "host name", "host/path", "user@host", "host:2222"])
    assert.throws(() => vscodeDirectoryUri({ hostName }, "/project"));
  for (const user of ["", "-option", "user name", "user@host"])
    assert.throws(() => vscodeDirectoryUri({ hostName: "host", user }, "/project"));
  for (const port of [0, 65536, 1.5, NaN])
    assert.throws(() => vscodeDirectoryUri({ hostName: "host", port }, "/project"));
  for (const path of ["project", "../project", "/tmp/\ncontrol", "/tmp/\0bad", "/tmp/\ud800bad"])
    assert.throws(() => directoryPath(path));
  assert.equal(directoryPath("/workspace/dev/../project//"), "/workspace/project/");
});
