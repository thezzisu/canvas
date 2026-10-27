# Canvas

A single-account workspace for all your herdr and tmux windows. The overview
arranges machines, spaces and windows automatically. Create additional canvases
to keep selected windows together in a draggable, zoomable workspace.

Canvas renders native clients through PTYs. Existing pane layouts, terminal
applications and mouse interactions are handled by herdr/tmux.

## Run

Requires Node.js 24+, a POSIX host, and tmux and/or the Canvas herdr fork.
The first release is verified on Linux.

```sh
npm ci
npm run build
npm run setup
npm start
```

Open `http://127.0.0.1:3010`. Setup creates the only account; there is no
registration or role system. The password is stored as a salted scrypt hash.

`CANVAS_DATA_DIR` selects the private runtime directory (default
`~/.local/share/canvas`). `CANVAS_HOST` and `CANVAS_PORT` select the listener;
the default listener is loopback. For remote access use an SSH tunnel or a TLS
reverse proxy with WebSocket support. Behind TLS termination, set
`CANVAS_SECURE_COOKIE=1` and preserve the original Host header. The browser and
API must share an origin.
Protect this account as you would your SSH session: terminal access can run
commands with the Canvas process's local and remote permissions.

## Connect a machine

Add a source from the connections panel:

- **tmux / local:** use the default server or specify a tmux socket name or absolute path.
- **herdr / local:** select a named session and the fork's executable path.
- **SSH:** use an SSH config alias, `user@host`, or `ssh://user@host:port`.
  The selected provider executable must exist on the destination. Key-based
  authentication and verified host keys are required. Optional identity and
  known-hosts file paths are resolved on the Canvas server.

Herdr needs the custom client's `tab attach <id> --bare` capability. The fork's
server protocol remains compatible with the v0.9.3 generation-1 endpoint; point
the source's binary field at the built fork, without replacing your installed
herdr executable. See `thezzisu/herdr`, branch `canvas-bare`.

## Window behavior

- The first canvas is the live overview. Spaces run vertically, windows horizontally,
  with sources grouped by machine.
- Add a window to another canvas to create a reference, not another terminal.
- Drag a card's header to move it. Resize a card to resize its native window.
  Zooming the canvas only changes the visual scale.
- The focused view controls input and terminal size; other views share its output.
- Removing a card only removes that reference. Closing a native window ends its
  processes and requires an explicit confirmation.
- tmux uses a temporary `__canvas_` session linked to the selected window. The
  status line and prefix navigation are disabled in this bare view. Pane mouse
  interaction and application shortcuts work normally; use Canvas or tmux CLI
  for window operations. Auxiliary sessions are filtered out of the overview.
- Reconnecting replays the retained terminal screen. Existing programs stay in
  the provider when Canvas disconnects. Dead window references remain visible
  so they can be removed or replaced deliberately.

## Development

Run `npm run server` and `npm run dev` in separate terminals. Vite proxies the
API and WebSocket to port 3010. Run `npm run typecheck`, `npm test`, and
`npm run build` before shipping. Native tests use isolated synthetic sockets. Set `CANVAS_TEST_HERDR_BINARY` to
the fork executable to include its real PTY integration test.

Canvas's free-layout interaction was informed by SecFlow's canvas. The application
is independent of SecFlow's workspace, authentication and task systems.
