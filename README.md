<p align="center">
  <img src="https://raw.githubusercontent.com/thezzisu/canvas/main/web/public/icons/canvas.svg" width="88" height="88" alt="Canvas">
</p>

<h1 align="center">Canvas</h1>

<p align="center">A browser workspace for local and SSH-connected <a href="https://github.com/herdrdev/herdr">herdr</a> windows.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@thezzisu/canvas"><img src="https://img.shields.io/npm/v/@thezzisu/canvas?color=edac79" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@thezzisu/canvas"><img src="https://img.shields.io/node/v/@thezzisu/canvas" alt="Node.js version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/thezzisu/canvas" alt="License"></a>
</p>

Canvas shows every herdr window from your machines on one zoomable surface.
Browse them in the overview, or arrange terminals, notes and files on your own
canvases. Canvas speaks the herdr protocols directly; herdr keeps owning panes,
layouts and processes.

## Features

- **Overview** of all windows, grouped by connection and Space, with agent-status
  filters, a minimap and one-window-at-a-time paging.
- **Custom canvases** with draggable terminal references, notes and files,
  synchronized between browsers.
- **Native terminals** rendered with xterm.js, including mouse, clipboard,
  bracketed paste and pane actions.
- **Files and links** from the terminal: `canvas open` previews files, opens
  directories in VS Code Remote SSH and forwards loopback URLs.
- **Uploads** by pasting or dropping files into a terminal.
- **Mobile** read-only previews, fullscreen terminals and an auxiliary keyboard.
- **PWA**, notifications, English and Simplified Chinese.

## Quick start

Requirements: Node.js 24+ on a POSIX host (Linux is tested). Connected machines
need an existing herdr session and Python 3.8+. SSH connections use key
authentication, verified host keys and OpenSSH Unix-socket forwarding.

```sh
npm install --global @thezzisu/canvas
canvas serve
```

Open <http://127.0.0.1:3010>. The first start creates the account `canvas` with
a random password and prints the path of the private file holding it
(`initialPassword`). Change the credentials from the account menu after signing in.
For unattended setup, provide `CANVAS_INIT_USERNAME` and `CANVAS_INIT_PASSWORD`
through your supervisor's secret configuration; they apply only when no account exists.

`canvas --help` lists all commands.

## Connections

Add local or SSH connections from the sidebar. SSH accepts an alias,
`user@host` or `ssh://user@host:port`. Select the herdr session, or give an
absolute socket path.

| Runtime          | Supports                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| Herdr TUI        | herdr 0.9.x sessions                                                                 |
| Herdr Core / App | herdr-core 0.1.17 and herdr-app 0.1.12 layouts (config discovery needs Python 3.11+) |

No TUI or desktop app process needs to stay open. Configure a separate SSH
connection for each remote core.

## Terminal commands

Run these inside a connected herdr pane while its Canvas tab is open. Canvas
installs a small Python helper at `~/.local/bin/canvas` on each connected
machine; keep that directory in `PATH`.

```sh
canvas open ./report.pdf                # preview or download a file
canvas open ./project                   # open a directory in VS Code Remote SSH
canvas open http://localhost:5173/      # open a loopback URL of that machine
canvas preview ./site                   # serve a static site in the card
canvas capture npm run dev              # show a trusted web app in the card (experimental)
```

Pasted or dropped files are uploaded to `~/.local/share/canvas/inbox` on the
terminal's machine and inserted as quoted paths, without pressing Enter. Mixed
text and images can be inserted as Markdown instead.

`capture` injects `PORT` / `CANVAS_CAPTURE_PORT` and waits for an HTTP response;
see `canvas capture --help` for ports, probes and environment options. Captured
apps must support the forwarded subpath.

> [!WARNING]
> Captured applications share the backend origin. Their scripts can reach the
> Canvas page and its session, so capture only code you trust.

## Configuration

| Variable                 | Default                    | Purpose                                     |
| ------------------------ | -------------------------- | ------------------------------------------- |
| `CANVAS_DATA_DIR`        | `~/.local/share/canvas`    | Account, database and files                 |
| `CANVAS_HOST`            | `127.0.0.1`                | Listen address, or a comma-separated list   |
| `CANVAS_PORT`            | `3010`                     | Listen port                                 |
| `CANVAS_ALLOWED_ORIGINS` | Same origin                | Allowed frontend origins                    |
| `CANVAS_INIT_USERNAME`   | `canvas`                   | First-start username                        |
| `CANVAS_INIT_PASSWORD`   | Random                     | First-start password, at least 8 characters |
| `CANVAS_PUBLIC_SSH_HOST` | Listen address or hostname | SSH host advertised for local VS Code links |
| `CANVAS_PUBLIC_SSH_PORT` | `22`                       | SSH port advertised for local VS Code links |

## Deployment

- An account grants terminal access to every connected machine. Expose Canvas
  only behind TLS, with WebSocket support and unbuffered uploads and SSE.
- A subpath proxy must strip its prefix and send `X-Forwarded-Prefix` and
  `X-Forwarded-Proto`. Preserve the public `Host`, or overwrite `X-Forwarded-Host`
  with it, so captured apps and redirects use the current viewer's endpoint.
- Back up the whole data directory, including the SQLite database and `files/`.
- The frontend can be hosted separately: build it with
  `VITE_CANVAS_BUILTIN_SERVER=false npm run build:web` and add servers by URL.
  HTTPS enables installation as a PWA.

## Development

```sh
npm ci
npm run server:dev   # backend on 127.0.0.1:3010
npm run dev          # frontend with hot reload
```

Run `npm run check` and `npm run build` before submitting.
Native integration tests use isolated sockets and run when
`CANVAS_TEST_HERDR_SERVER_BINARY` or `CANVAS_TEST_CORE_BINARY` points to an
official herdr or herdr-core executable.

## License

[Apache-2.0](LICENSE)
