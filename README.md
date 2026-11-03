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

For verified Herdr TUI 0.9.3/0.9.5, both sockets belong to the same server:
`herdr.sock` speaks the newline JSON API, while `herdr-client.sock` speaks
the binary native-client protocol used by the official TUI. Canvas implements
that client protocol itself and starts no TUI client process. Its current
adapter also uses the JSON API for resource discovery, operations and native
text reads, so it connects to both listeners. One configured API socket path
derives the client-protocol path automatically; the JSON listener cannot be
upgraded into a terminal attach stream. Core exposes its API and attach streams
through one framed socket.

Choose **Herdr TUI** for existing 0.9.x sessions, or **Herdr Core / App** for
herdr-core 0.1.17 and the shared layouts used by herdr-app 0.1.12. Core connects
directly to the selected running Unix socket; the desktop app can be closed.
Canvas reads and edits that core's shared Spaces, Tabs and terminal splits.
Ungrouped core terminals appear under Terminals. Existing TUI connections retain
their protocol and identities. Selecting another runtime does not migrate sessions.

Core discovery follows `HC_SOCKET`, its configuration and runtime directories;
an explicit socket path overrides discovery. Reading a Core TOML configuration
requires Python 3.11+, while explicit paths work with Python 3.8+. Use a separate
Canvas SSH connection for each remote core. Machines relayed through another
core are not implicitly treated as files or terminals on that core's host.

Core persists terminal status, turns and labels in its server registry. OSC
7501 is the source of status updates; programs that do not report it remain
unreported. Core completion reads use the shared `herdr.seen` labels, including
changes from the desktop app. View focus and pane zoom remain local to Canvas.
When a core restart reuses the live holder, terminal facts survive with the
running program. A replacement shell has no old program status even though its
terminal address, turn and labels can survive. Old TUI session saves persist
layout, cwd, names and agent resume information, but do not persist the live
agent status or completion sequences. Canvas retains its own TUI read records
only while the native boot identity still matches. Neither event stream is a
durable event log; reconnecting takes a fresh snapshot.
If a slow connection causes core to replace queued output with a repaint that
skips completed turns, Canvas keeps the completion unread until reconnecting;
terminal input and output continue. Core's stream has no turn identifier for
that replacement paint, so Canvas cannot safely acknowledge unseen results.
Terminal panes are rendered in Canvas; desktop mods have an unavailable-content
placeholder. Core 0.1.17 omits historical OSC 8 link targets from initial paints;
live links and visible filesystem paths remain available to the scanner. Terminal
graphics depend on Canvas's renderer and do not reproduce every GPUI feature.

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

Canvas installs a Python helper at `~/.local/bin/canvas` only when the destination
has no `canvas` command. Keep that directory in PATH. Existing commands and files
are left untouched. The helper forwards to this npm package when it finds its CLI
later on PATH; otherwise it provides `open` using Python alone. Installing npm
into the same prefix as an existing helper can produce npm's `EEXIST` error.
Choose a separate prefix or explicitly remove your own verified helper before
installation; Canvas never forces replacement of another executable.

Files are copied into Canvas storage. The overview previews supported files;
custom canvases retain downloadable file cards. Markdown supports rendered/source
views and wrapping; each card remembers its reading position locally. Temporary
overview files expire after one hour or a server restart.

Paste or drop files and images into a terminal to upload them to that machine's
`~/.local/share/canvas/inbox`. Canvas inserts a quoted path without Enter. Directory
opens offer VS Code Remote SSH. Loopback URLs refer to the terminal's machine;
forwarded applications must support the provided subpath.

## Capture a terminal application (experimental)

On Linux, the npm CLI can start a trusted Web application inside a connected,
single-pane terminal and show its UI in that same Canvas card:

```sh
canvas capture --port 5173 --title "My app" -- npm run dev -- --host 127.0.0.1 --port 5173
```

Capture works through the selected Canvas instance's existing public address,
including its reverse-proxy prefix. One public domain and port can serve Canvas
and its captured apps; no additional public listener, application domain or
capture-specific public-base setting is needed. For example, an instance at
`https://workbench.example/canvas/` hosts an app beneath
`/canvas/api/capture/<id>/`. The proxy strips `/canvas` and sends
`X-Forwarded-Prefix: /canvas` for both HTTP and WebSocket requests, as it does for
the ordinary Canvas API. Its private upstream Host need not be public.
When that Host differs from the browser origin, configure the existing
`CANVAS_ALLOWED_ORIGINS` as for ordinary Canvas connections.

The authenticated browser supplies its selected instance base to its terminal
connection. Canvas validates that mount and uses it only for app presentation;
forwarding still targets the source machine's declared loopback port. Independent
frontends and multiple instances keep their own addresses. This mode is for
explicitly trusted applications. Same-origin app scripts can read and change the
Canvas DOM and local storage, including the signed-in Canvas bearer token, and can
act with that account's access to connected machines. A malicious captured app
can take over the Canvas session. Cookie paths and iframe navigation restrictions
do not isolate it. Use capture only for commands and applications you trust.

Application authentication cookies are held in this capture's temporary server
cookie jar and supplied to its upstream HTTP/WebSocket requests. No application
cookie is installed in the browser, and incoming browser cookies and Canvas
authorization are never forwarded to the app. This works with an ingress that
clears Cookie headers. Revocation clears the jar. Apps that require JavaScript
to read or write `document.cookie` need a separate adapter; this mode supports
server-managed cookie authentication such as DeepSeek Harness.
The capture URL grants temporary access to that authenticated application session;
keep it private and do not share it or write it to logs.

Capture rejects an occupied port before starting the command, then waits for
that command's loopback listener. The app must support the generated subpath;
`CANVAS_CAPTURE_PUBLIC_URL` and `CANVAS_CAPTURE_HOST` are passed to the command
for its public-URL configuration. There is no generic HTML/JavaScript rewriting.
Applications with a private login bootstrap can use `--ready-file /private/ready.json`;
the command writes a private JSON file containing `launchUrl` (or `url`) before
the iframe opens. Do not print login URLs or store this file in your project.

The terminal remains connected. **Return to terminal** leaves the app running;
**Open app** returns to it; **Stop app** stops this capture's owned process group.
Command exit, bridge loss, logout or connection changes revoke the proxy. Capture
is temporary: browser refresh and other devices do not replay the app view.
The first prototype requires a single pane at registration and does not support
later pane-layout changes. The Python-only helper installed on SSH hosts does
not yet include capture; the npm CLI must be available on the command's machine.
This does not replace the existing file/URL preview or the `canvas serve` backend
command.

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
