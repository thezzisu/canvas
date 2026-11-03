# Canvas

A browser workspace for local and SSH-connected herdr windows. Use the overview
or arrange terminals, notes and files on zoomable canvases.

## Install and run

Canvas requires Node.js 24+ on a POSIX host. Linux is tested; native Windows is
outside this release. Connected machines need an existing herdr session and
Python 3.8+. SSH
connections also require OpenSSH with Unix-socket forwarding and verified host
keys. Production npm dependencies are JavaScript-only; the package includes the
frontend and fonts.

```sh
npm install --global @thezzisu/canvas
canvas serve
```

`canvas` without arguments also starts the server. Open <http://127.0.0.1:3010>.
On first start, Canvas creates one account named `canvas` and a random password.
The terminal prints the account file path and a command to inspect it; the
password is the `initialPassword` field in that private file. Passwords are not
printed in startup logs. Open the username in the sidebar to change account
credentials after signing in; this removes the stored initial password.

For unattended first start, set `CANVAS_INIT_USERNAME` and
`CANVAS_INIT_PASSWORD` through your process supervisor's secret configuration.
They apply only when no account exists. A supplied password is stored only as a
hash. `canvas version` prints the installed version; `canvas --help` lists commands.

## Connections and canvases

Add local or SSH connections from the sidebar. Local paths refer to the Canvas
server's machine. SSH accepts an alias, `user@host`, or `ssh://user@host:port` and
uses key authentication. Select the existing herdr session; an absolute API socket
path can override discovery. Canvas connects directly to herdr sockets.

Choose **Herdr TUI** for 0.9.x sessions, or **Herdr Core / App** for
herdr-core 0.1.17 and herdr-app 0.1.12 layouts. Canvas implements both clients;
no TUI or desktop app process needs to remain open. TUI uses its API and native
client sockets. Core uses one framed socket and shares Spaces, Tabs, splits and
completion-read labels with the desktop app. Ungrouped terminals appear under
Terminals; desktop mods are not rendered.

Core discovery uses `HC_SOCKET`, its configuration and runtime directories.
An explicit socket path overrides discovery. Reading Core TOML requires
Python 3.11+; explicit paths work with Python 3.8+. Configure a separate Canvas
SSH connection for each remote core; relay hosts are not treated as local files.

Core status comes from program-reported OSC 7501; unreported programs stay
unknown. Completion reads use native `turn` and `herdr.seen` labels. TUI reads
remain bound to the server boot identity. Reconnection refreshes native state;
replacement shells do not inherit old program status. Core initial paints omit
historical OSC 8 links; live links and visible paths can still be scanned. If Core
skips a completion's output under backpressure, Canvas keeps it unread until a
new connection provides a complete paint.

The overview groups windows by connection and Space. Agent-state filters, native
or status ordering, a minimap and optional one-window-at-a-time navigation help
find active work. Custom canvases contain draggable terminal references, notes
and files. Layouts, note content, wallpapers and global font settings synchronize
between browsers.

References to one native window share its size. Maximizing temporarily resizes
that window; other views pause until it is restored. Removing a card keeps the
native window running. Closing a native window ends its processes.

Inside nested TUI/Core terminals, `canvas open --runtime core <path>` or
`canvas open --runtime tui <path>` selects the originating identity explicitly.
When both identity pairs are inherited, the helper refuses an ambiguous route.

On mobile, cards remain read-only until tapped into fullscreen. The auxiliary
keyboard provides modifiers, navigation, clipboard and file upload. Desktop
cards remain directly interactive. Settings include language, content fonts,
keep-awake and display-cutout preferences.

## Open files and links

Run these commands inside a connected herdr pane while its receiving Canvas tab
is active:

```sh
canvas open ./report.pdf
canvas open ./project
canvas open http://localhost:5173/
```

Canvas silently installs its single-file Python helper at `~/.local/bin/canvas`
and refreshes marked Canvas helpers when their content differs. Keep that directory
in PATH. Unrelated commands, user links and npm installations remain untouched.
The helper handles `open` and `capture` itself, or delegates to a matching Canvas
npm helper later on PATH. An older npm installation does not prevent installing
the standalone helper when its destination is available. Installing npm into the
same prefix as a helper requires an explicit ownership handoff; Canvas never
forces replacement of another executable.

Files are copied into Canvas storage. The overview previews supported files;
custom canvases retain downloadable file cards. Markdown supports rendered/source
views and wrapping; each card remembers its reading position locally. Temporary
overview files expire after one hour or a server restart.

Paste or drop files and images into a terminal to upload them to that machine's
`~/.local/share/canvas/inbox`. Canvas inserts a quoted path without Enter. Directory
opens offer VS Code Remote SSH. Loopback URLs refer to the terminal's machine;
forwarded applications must support the provided subpath.

## Capture a terminal application (experimental)

The npm CLI can run a trusted Web application in a connected single-pane terminal
and display it in that Canvas card:

```sh
canvas capture npm start
canvas capture -c 'python3 -m http.server "$PORT" --bind 127.0.0.1'
canvas capture --env APP_PORT='$PORT' node app.js
canvas capture --port 5173 npm run dev -- --port 5173
```

Canvas assigns a candidate port and injects `PORT` / `CANVAS_CAPTURE_PORT`.
The command must listen there; use `--port` for applications with a fixed port.
Occupied explicit ports fail before startup. Port selection is not a reservation
for the child and readiness does not prove listener ownership; the command must
honor this contract. Canvas does not discover other listeners or parse stdout.
Ordinary arguments pass unchanged; `-c` explicitly enables shell expansion.
`--env` expands named variables only in the child environment.

Default readiness accepts HTTP 200–499 and waits through startup errors.
Use `--probe /health` for a 2xx health endpoint, `--ready tcp` for a listener,
or `--probe-command '…'` for a bounded command returning zero. `--timeout`
bounds startup. Apps with a private login URL can write `launchUrl` or `url`
to a private `--bootstrap-file`; this is optional authentication bootstrap.

Apps must support the forwarded subpath. `CANVAS_CAPTURE_PUBLIC_URL` and
`CANVAS_CAPTURE_HOST` supply it before startup. HTTP/WebSocket traffic uses
the selected instance's existing proxy prefix; there is no HTML/JavaScript
rewriting. Server-managed application cookies stay in a per-capture memory jar,
so an ingress may strip browser cookies. Apps requiring `document.cookie`
need their own adapter.

**Capture runs explicitly trusted code.** Its iframe shares the backend origin;
on a same-origin Canvas frontend, app scripts can access Canvas DOM, stored
tokens and account permissions. This is not an isolation boundary. The capture
URL grants temporary access to the application session; keep it and bootstrap
files private.

Return/Open switches between terminal and application without stopping it.
Maximize/restore remounts the embedded page; keep application drafts in the app's
own storage. The selected terminal/app view survives that transition.
Stop terminates the launched process group; command exit, bridge loss, logout
or connection changes revoke access. Capture is temporary and single-pane;
refresh, other devices and later pane-layout changes do not restore the app.
The standalone Python helper supports capture without Node.js. POSIX process
groups are required; native Windows is outside this release.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CANVAS_DATA_DIR` | `~/.local/share/canvas` | Account, database and files |
| `CANVAS_HOST` | `127.0.0.1` | Listen address or comma-separated addresses |
| `CANVAS_PORT` | `3010` | Listen port |
| `CANVAS_ALLOWED_ORIGINS` | Same origin | Allowed frontend origins |
| `CANVAS_INIT_USERNAME` | `canvas` | First-start username |
| `CANVAS_INIT_PASSWORD` | Random | First-start password, at least 8 characters |
| `CANVAS_PUBLIC_SSH_HOST` | Listen address or hostname | Local source's VS Code SSH host |
| `CANVAS_PUBLIC_SSH_PORT` | `22` | Local source's VS Code SSH port |

For remote access, use TLS with WebSocket support and unbuffered uploads/SSE.
A subpath proxy must strip its prefix and send `X-Forwarded-Prefix`. Authentication
uses Bearer tokens; account access grants terminal access to connected machines.
Back up the complete data directory, including SQLite and `files/`. Terminal inbox
files remain on their source machines.

The frontend can run independently and connect to named Canvas instances. Build
it with `VITE_CANVAS_BUILTIN_SERVER=false npm run build:web` to require an explicit
server URL. The default package discovers its same-origin server. HTTPS enables
PWA installation; updates wait for an explicit reload. The app shell and icons
are precached; public fonts are cached when used.

Share an instance from the account dialog's QR button. Scan it on the connection
screen or in Add instance with a camera (HTTPS) or an image to fill the server and
username, then enter your password to sign in. Scanning keeps the current frontend
and preserves the display name of an instance already in your list.

## Development

```sh
npm ci
npm run build
npm start
```

For live development, run `npm run server:dev` and `npm run dev` separately.
Before submitting, run `npm run typecheck`, `npm test` and `npm run build`.
Tests use isolated fixtures; `CANVAS_TEST_HERDR_SERVER_BINARY` selects an official
herdr executable for native integration tests.
`CANVAS_TEST_CORE_BINARY` selects an official herdr-core executable for private
Core and loopback SSH integration tests. These fixtures use separate state and
sockets and never attach to the account's normal sessions.

## License

[Apache License 2.0](LICENSE).
