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

The overview groups windows by connection and Space. Agent-state filters, native
or status ordering, a minimap and optional one-window-at-a-time navigation help
find active work. Custom canvases contain draggable terminal references, notes
and files. Layouts, note content, wallpapers and global font settings synchronize
between browsers.

References to one native window share its size. Maximizing temporarily resizes
that window; other views pause until it is restored. Removing a card keeps the
native window running. Closing a native window ends its processes.

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

## License

[Apache License 2.0](LICENSE).
