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
  With no executable override, Canvas looks for its dedicated herdr client at
  `~/.local/share/canvas/bin/herdr`, then checks PATH and common user install
  directories. Explicit executable paths take precedence. The selected provider
  executable must exist on the destination. Key-based
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
- A card has one title: the native window name. Its status dot opens pane
  details; source context is available in the title tooltip.
- Cards follow the native terminal's aspect ratio. Width determines the display
  scale and height follows, keeping every pane visible without distortion.
- Drag a card's header to move it. Resize a card to resize its native window.
  Switching canvases, entering focus view and zooming only change the visual
  scale; they never resize the native terminal.
- Explicitly focusing a terminal claims input. Only an explicit card resize
  changes native dimensions; all references share that same screen.
- Removing a card only removes that reference. Closing a native window ends its
  processes and requires an explicit confirmation.
- tmux uses a temporary `__canvas_` session linked to the selected window. The
  status line and prefix navigation are disabled in this bare view. Pane mouse
  interaction and application shortcuts work normally; use Canvas or tmux CLI
  for window operations. Auxiliary sessions are filtered out of the overview.
- Reconnecting replays the retained terminal screen. Existing programs stay in
  the provider when Canvas disconnects. Dead window references remain visible
  so they can be removed or replaced deliberately.

## Canvas backgrounds

Overview is the first item in the canvas list and is read-only. Other canvases
can have independent backgrounds: open canvas settings, choose Background image,
upload a PNG/JPEG/WebP, and adjust opacity. Preview and Cancel do not alter the
saved canvas. Images are stored on the server, require authentication, and remain
independent when switching or reloading canvases. Uploads are limited to 8 MiB
and 16 megapixels and are normalized to WebP without embedded metadata.

## Program status

Each window shows the highest-priority pane state: error, attention, working,
done, idle, then unknown. Pane indicators retain the native pane ID and show
individual states. Unknown stays neutral; Canvas never infers an agent state
from a prompt, title or output text.

Herdr uses its native `agent_status`; `blocked` means attention and `done` means
completed work that has not yet been seen. tmux exposes OSC 9;4 progress through
`pane_pb_state` on versions that support it: normal/indeterminate mean working,
paused means attention, and error means error. Hidden progress is unknown.

Opened tmux windows also accept passive
[OSC 7501 reports](https://www.superlogical.com/rex/docs/build/program-status).
Canvas observes the existing bare-window helper with a control client that does
not contribute dimensions or send terminal input. It does not attach to original
sessions, replace `pipe-pane`, or install persistent hooks. Reports are scoped to
the native pane; child records, clear, full reset and OSC 133 prompt lifetime are
handled independently for each pane. After a valid OSC 7501 report, OSC 9;4 is
ignored for that pane until a full terminal reset.

Only reports emitted after the window opens are available; reconnecting or
restarting Canvas loses this in-memory status history. Capability queries (`?`)
are not answered, so programs that require negotiation must be configured to
emit reports directly. This is passive report display, not full OSC 7501
terminal capability negotiation.

## Development

Run `npm run server` and `npm run dev` in separate terminals. Vite proxies the
API and WebSocket to port 3010. Run `npm run typecheck`, `npm test`, and
`npm run build` before shipping. Native tests use isolated synthetic sockets. Set `CANVAS_TEST_HERDR_BINARY` to
the fork executable to include its real PTY integration test.

Canvas's free-layout interaction was informed by SecFlow's canvas. The application
is independent of SecFlow's workspace, authentication and task systems.
