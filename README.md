# Canvas

A single-account workspace for all your herdr and tmux windows. The overview
arranges machines, spaces and windows automatically. Create additional canvases
to keep selected windows and notes together in a draggable, zoomable workspace.

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
reverse proxy with WebSocket and unbuffered server-sent event support. Behind TLS termination, set
`CANVAS_SECURE_COOKIE=1` and preserve the original Host header. The browser and
API must share an origin.
Protect this account as you would your SSH session: terminal access can run
commands with the Canvas process's local and remote permissions.

## Connect a machine

Add a source from the connections panel:

- **tmux / local:** use the default server or specify a tmux socket name or absolute path.
- **herdr / local:** select a named session and the fork's executable path.
- **SSH:** use an SSH config alias, `user@host`, or `ssh://user@host:port`.
  With no executable override, Canvas checks PATH and common user install
  directories for the ordinary provider executable on the destination. Explicit
  executable paths take precedence. Key-based
  authentication and verified host keys are required. Optional identity and
  known-hosts file paths are resolved on the Canvas server.

Herdr uses the unmodified upstream server and a small client-only fork for
`tab attach <id> --bare`. For a local source, select the fork client in the
executable field. For SSH sources, set `CANVAS_HERDR_BINARY` to that client on
the Canvas server (defaults to `herdr` on PATH). Canvas forwards the remote
API and client Unix sockets over SSH, then runs the bare client locally. The
source's executable field still refers to the ordinary remote herdr CLI used
for discovery and resource operations. Remote machines need no fork or server
changes. See `thezzisu/herdr`, branch `canvas-bare`.

Tmux attach passes native file descriptors, so it cannot use a byte-only SSH
socket tunnel. Canvas runs the remote stock tmux client through an SSH PTY.
No custom remote tmux installation is required.

## Download a file

Run `canvas open <path>` in a connected terminal. Canvas copies the file from
that machine to server storage for the browser tab controlling the native window.
The path is read on the terminal's host; the Canvas server never
opens a path supplied by terminal output. Regular files, Unicode names and
large files are supported. Python 3 is required on the terminal host. Canvas
installs its helper at `~/.local/bin/canvas` when that source first connects,
without replacing a different existing `canvas` command. Keep `~/.local/bin`
in the terminal's PATH.

Click the terminal or maximize it to choose the receiving tab. Opening a passive
viewer does not claim downloads, and closing the controlling tab does not hand
them to another viewer. An agent can run the helper without echoing its output.

The terminal progress bar measures bytes copied to Canvas. The command succeeds
after the full file is committed on the server; browser download speed or
cancellation does not affect it. There is no confirmation or notification UI.
If no browser can receive the file, the command exits nonzero immediately with
`canvas: no browser attached to this window`. Ctrl+C cancels an unfinished copy.

In Overview, completion starts a native browser download. Its staged file remains
available to that login session for one hour and is cleared when Canvas restarts.
In a custom canvas, completion adds a file card beside its originating window.
Images, PDFs and text have previews; every card has a download button. Cards can
be moved, resized and downloaded again from another browser, even after the
terminal disconnects or Canvas restarts. Removing the last card removes the
stored file. Include both
the database and the `files` directory when backing up `CANVAS_DATA_DIR`.

Multiple canvases and browser tabs on one Canvas Server share the same native
window controller; only its current controller receives the download. SSH
sources use a private reverse Unix-socket forward and an owner-only registry.
If separate Canvas Server instances register the same native terminal, the
helper refuses the ambiguous request instead of sending the file to multiple
browsers. No custom herdr server or global SSH configuration is required.

## Window behavior

- The first canvas is the live overview. Spaces run vertically, windows horizontally,
  with sources grouped by machine.
- Two-finger scrolling pans the canvas in either direction; pinching zooms around
  the pointer. Scrolling reaches a terminal only when it has input focus and
  mouse reporting enabled. Note text keeps its own scrolling.
- The fullscreen button hides the sidebar and header for the entire canvas.
  Exit with the same button or Escape to restore the previous view. This changes
  only the canvas presentation; terminal dimensions stay unchanged.
- Add a window to another canvas to create a reference, not another terminal.
- A card has one title: the native window name. Its status dot opens pane
  details; source context is available in the title tooltip.
- Cards follow the attached client's aspect ratio. Width determines the display
  scale and height follows, keeping every pane visible without distortion.
- Each native window has one backend PTY and one shared card size across all
  canvases and browsers. Card positions and canvas zoom remain local to each
  canvas; Overview follows the shared card size without resize handles.
- Overview has no card resize handles. Switching canvases and zooming preserve
  the attached client's viewport without reconnecting it. tmux views follow
  native dimensions; herdr uses its ordinary native attach rules.
- Drag a custom canvas card's header to move it; explicitly resizing the card
  changes its native window's dimensions.
- Focus fills the viewport by resizing the attached PTY at normal font size.
  Each native window has one maximum-size view. Its other references show
  “已最大化” and pause terminal rendering. Maximizing another reference takes
  over; the previous view returns to its canvas. Leaving focus restores the
  client's viewport and resumes other references from the latest full screen.
  Different native windows can be maximized independently.
- tmux follows external native dimensions and restores the original window size
  only while Canvas still owns its geometry. Herdr's unmodified server decides
  which native client controls pane sizes. Canvas does not override that decision
  or claim atomic native restoration: external resize may leave Canvas's client
  viewport unchanged until native interaction transfers control. Initial attach
  can resize native tabs according to herdr's existing rules.
- Explicitly focusing a terminal claims input. Merely opening another viewer
  preserves input ownership; all references share the same native screen.
- Removing a card only removes that reference. Closing a native window ends its
  processes and requires an explicit confirmation.
- tmux uses a temporary `__canvas_` session linked to the selected window. The
  status line and prefix navigation are disabled in this bare view. Pane mouse
  interaction and application shortcuts work normally; use Canvas or tmux CLI
  for window operations. Auxiliary sessions are filtered out of the overview.
- Reconnecting replays the retained terminal screen. Existing programs stay in
  the provider when Canvas disconnects. Dead window references remain visible
  so they can be removed or replaced deliberately.

## Notes

Custom canvases support plaintext notes with a title, five colors, drag, resize
and collapse. Notes save automatically and synchronize across browsers; layout
and content edits are saved independently. The grid button toggles position
snapping. Overview keeps its automatic window layout and does not accept notes.

## Canvas backgrounds

Overview is the first item in the canvas list; its name and layout are fixed.
Every canvas, including Overview, can have an independent background: open canvas settings, choose Background image,
upload a PNG/JPEG/WebP, and adjust opacity. Preview and Cancel do not alter the
saved canvas. Images are stored on the server, require authentication, and remain
independent when switching or reloading canvases. Photo uploads have no application
file-size or pixel-count limit. Images retain their resolution and are normalized
to WebP without embedded metadata; panoramas exceeding WebP's dimensions use PNG.
Backgrounds, connections, canvas names, window references and saved positions
synchronize across authenticated browsers. Logging out ends only that login
session's connections.

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
`npm run build` before shipping. Native tests use isolated synthetic sockets.
Set `CANVAS_TEST_HERDR_BINARY` to the bare client and
`CANVAS_TEST_HERDR_SERVER_BINARY` to a separate, unmodified upstream server
executable for herdr compatibility tests.

Canvas's free-layout interaction was informed by SecFlow's canvas. The application
is independent of SecFlow's workspace, authentication and task systems.
