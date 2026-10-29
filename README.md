# Canvas

A browser workspace for local and SSH-connected herdr and tmux windows. Use the
automatic overview to see your machines, or arrange terminals, notes and files on
custom, zoomable canvases.

Status: in development.

## Quick start

Requires Node.js 24+, a POSIX host, and tmux or herdr. Linux is the tested platform.
File transfers also require Python 3 on each connected machine.

```sh
npm ci
npm run build
npm run setup
npm start
```

Open <http://127.0.0.1:3010> and sign in with the account created during setup.
Canvas uses one shared account.

## Connections

Add connections from the sidebar. Local connections use the Canvas server's
machine. SSH accepts an alias, `user@host`, or `ssh://user@host:port` and requires
key authentication and verified host keys. Identity and known-hosts paths refer
to files on the Canvas server.

- **tmux:** use the default server or specify a socket name or absolute path.
- **herdr:** choose a session on the machine running the official herdr server.
  Canvas connects through its native sockets. Advanced settings accept an absolute
  API socket path for custom installations.

Remote herdr uses SSH-forwarded server sockets with Canvas's built-in client.
Remote tmux uses the installed tmux client through an SSH PTY.

## Using Canvas

- **Overview:** machines are grouped together, spaces run vertically, and windows
  run horizontally. The layout follows native window sizes.
- **Custom canvases:** add windows from the overview, arrange cards, and add notes
  or files. Every canvas supports its own background image.
- **Windows:** references share one native terminal and one card size. Maximizing
  a window resizes its PTY to the available area; its other views show “已最大化”.
  Removing a card keeps the native window running. Closing a window ends its
  processes after confirmation.
- **Navigation:** scroll to pan, pinch to zoom, or use fullscreen for the canvas.
  On mobile, tap a terminal preview to interact in fullscreen; the auxiliary
  keyboard provides modifiers, navigation keys, clipboard and upload actions.
- **Status:** window colors summarize pane activity. Click the status indicator
  for pane details. herdr supplies agent status; tmux supports OSC 9;4 and
  [OSC 7501](https://mitchellh.com/writing/program-status-osc7501) reports.
- **Fonts:** global settings provide an ordered font list and a ligature switch.
  Maple Mono NF CN is the default; Maple Mono Normal NF CN, Cascadia Code PL and
  locally installed fonts use the same controls.

Saved layouts, notes, backgrounds and global settings synchronize across browsers.
Native pane layouts and terminal interaction follow herdr/tmux behavior.

## Files and clipboard

```sh
canvas open ./report.pdf
canvas open ./project
```

Canvas installs the helper at `~/.local/bin/canvas` on each connected machine;
keep that directory in your PATH. Focus a terminal in the receiving browser tab
before running the command. Agents can use it through their shell tools.

For files, progress measures the copy into Canvas server storage, and the command
finishes when that copy completes. The overview previews images, PDFs and text
with a download button; other types download directly. Image previews support
page fullscreen, zoom and pan. Custom canvases retain files as downloadable cards.
Overview files expire after one hour or a server restart.

Paste or drop images, screenshots and files onto a terminal to upload them to
`~/.local/share/canvas/inbox` on that machine. Canvas prefixes each filename with
a random identifier and inserts shell-quoted absolute paths into the original
window. Press Enter when ready. Selecting terminal text copies it to the clipboard.

For directories, `canvas open` offers a VS Code Remote SSH link. The desktop needs
VS Code, its Remote SSH extension and SSH access to the source machine.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CANVAS_DATA_DIR` | `~/.local/share/canvas` | Account, database and stored files |
| `CANVAS_HOST` | `127.0.0.1` | Listen address |
| `CANVAS_PORT` | `3010` | Listen port |
| `CANVAS_SECURE_COOKIE` | unset | Set to `1` behind TLS termination |
| `CANVAS_PUBLIC_SSH_HOST` | Listen address or hostname | Advertised VS Code SSH host for local connections |
| `CANVAS_PUBLIC_SSH_PORT` | `22` | Advertised VS Code SSH port for local connections |

For remote access, use an SSH tunnel or a TLS reverse proxy supporting WebSockets
and unbuffered server-sent events. Preserve the Host header and serve the UI and
API from the same origin. Account access grants terminal access to connected machines.

Back up the complete data directory, including the SQLite database and `files/`.
Uploaded terminal files remain in each source machine's managed inbox.

## Development

Run `npm run server` and `npm run dev` in separate terminals. Before submitting:

```sh
npm run typecheck
npm test
npm run build
```

Native tests use isolated sessions. For herdr tests, set
`CANVAS_TEST_HERDR_SERVER_BINARY` to the official server executable.

## License

[Apache License 2.0](LICENSE). Bundled fonts retain their
[upstream licenses](web/public/fonts/README.md).
