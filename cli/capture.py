#!/usr/bin/env python3
"""Run an explicit command and attach its loopback Web UI to this terminal."""

import argparse
import http.client
import json
import os
from pathlib import Path
import runpy
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit


class CaptureError(Exception):
    pass


def send(connection, value):
    connection.sendall((json.dumps(value, separators=(",", ":")) + "\n").encode())


def line(connection, timeout=30):
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) <= 32768:
        wait = deadline - time.monotonic()
        if wait <= 0 or not select.select([connection], [], [], wait)[0]:
            raise CaptureError("capture bridge timed out")
        part = connection.recv(1)
        if not part:
            raise CaptureError("capture bridge closed")
        if part == b"\n":
            try:
                value = json.loads(data)
                if isinstance(value, dict):
                    return value
            except (ValueError, UnicodeError):
                pass
            raise CaptureError("invalid capture response")
        data.extend(part)
    raise CaptureError("capture response is too large")


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.15):
            return True
    except OSError:
        return False


def descendants(parent):
    """Resolve only process IDs and parents, never process environments."""
    parents = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            value = (entry / "stat").read_text()
            parents[int(entry.name)] = int(value[value.rfind(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            continue
    owned = {parent}
    changed = True
    while changed:
        next_owned = {pid for pid, ppid in parents.items() if ppid in owned}
        changed = not next_owned.issubset(owned)
        owned.update(next_owned)
    return owned


def owned_listeners(parent):
    """Only the launched command's listeners may become capture targets."""
    owned = set()
    for pid in descendants(parent):
        try:
            for descriptor in (Path("/proc") / str(pid) / "fd").iterdir():
                try:
                    owned.add(os.readlink(descriptor))
                except OSError:
                    pass
        except OSError:
            continue
    ports = set()
    for table in ["tcp", "tcp6"]:
        try:
            rows = (Path("/proc/net") / table).read_text().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) <= 9:
                continue
            address, port_hex = fields[1].rsplit(":", 1)
            reaches_loopback = address in ("0100007F", "00000000") if table == "tcp" else address in ("0" * 32, "0000000000000000FFFF00000100007F")
            if reaches_loopback and fields[3] == "0A" and "socket:[" + fields[9] + "]" in owned:
                ports.add(int(port_hex, 16))
    return ports


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def expand(value, environment):
    """Expand named variables only. Never invoke a shell or evaluate syntax."""
    def replace(match):
        if match.group() == "$$":
            return "$"
        name = match[1] or match[2]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise CaptureError("only $NAME and ${NAME} placeholders are supported in --env values")
        if name not in environment:
            raise CaptureError("undefined child environment variable: " + name)
        return environment[name]
    return re.sub(r"\$\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", replace, value)


def probe_http(port, path, public, deadline):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=max(0.01, min(0.35, deadline - time.monotonic())))
    try:
        connection.request("GET", path, headers={"Host": public.netloc, "X-Forwarded-Prefix": public.path.rstrip("/"), "Connection": "close"})
        return connection.getresponse().status
    except (OSError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def probe_command(command, environment, port, deadline):
    probe = subprocess.Popen(command, shell=True, env={**environment, "PORT": str(port), "CANVAS_CAPTURE_PORT": str(port)},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        return probe.wait(timeout=max(0.01, min(1, deadline - time.monotonic()))) == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        # A probe is temporary, including any children of its explicit shell.
        try:
            os.killpg(probe.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            probe.wait(timeout=1)
        except subprocess.TimeoutExpired:
            raise CaptureError("readiness probe did not stop") from None


def bootstrap_file(filename, public_url, port):
    if not filename:
        return None
    try:
        fd = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 32768:
            raise CaptureError("capture bootstrap file must be a private regular file owned by this account")
        with os.fdopen(fd, "rb") as stream:
            fd = None
            try:
                value = json.load(stream)
            except (ValueError, UnicodeError):
                return False
    finally:
        if fd is not None:
            os.close(fd)
    url = value.get("launchUrl", value.get("url")) if isinstance(value, dict) else None
    if not isinstance(url, str) or len(url) > 16384 or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise CaptureError("invalid application bootstrap URL")
    try:
        parsed, public = urlsplit(url), urlsplit(public_url)
        is_public = (parsed.scheme, parsed.netloc) == (public.scheme, public.netloc) and parsed.path.startswith(public.path)
        is_loopback = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1") and (parsed.port or 80) == port
        if parsed.username or parsed.password or not (is_public or is_loopback):
            raise ValueError()
    except ValueError:
        raise CaptureError("application bootstrap URL does not match this capture") from None
    return url


def terminate(child):
    if getattr(child, "_canvas_terminated", False):
        return
    child._canvas_terminated = True
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait(timeout=5)
        return
    # A shell/npm wrapper can exit before its server. Wait for the owned group,
    # not just its leader; zombies have exited and need no further signal.
    def group_running():
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                value = (entry / "stat").read_text()
                fields = value[value.rfind(")") + 2:].split()
                if int(fields[2]) == child.pid and fields[0] != "Z":
                    return True
            except (OSError, ValueError, IndexError):
                continue
        return False
    deadline = time.monotonic() + 5
    while group_running() and time.monotonic() < deadline:
        time.sleep(0.05)
    if group_running():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(prog="canvas capture", description=__doc__, epilog=
        "PORT and CANVAS_CAPTURE_PORT are provided to the command. Command arguments are passed unchanged. "
        "Use -c 'python3 -m http.server \"$PORT\"' for explicit shell expansion. "
        "Only --env values expand named variables; $$ means a literal $. Options must precede the command.")
    parser.add_argument("--port", type=int, help="use this loopback port instead of automatic detection")
    parser.add_argument("--title", help="application title shown on the terminal")
    parser.add_argument("--bootstrap-file", "--ready-file", dest="bootstrap_file", help="private auth/bootstrap JSON containing launchUrl or url (not a readiness probe)")
    parser.add_argument("--ready", choices=["http", "tcp"], default="http", help="HTTP response (default) or TCP listener readiness")
    parser.add_argument("--probe", help="HTTP path that must return 2xx before capture, e.g. /health")
    parser.add_argument("--probe-command", help="explicit shell readiness command; exit 0 means ready, with PORT set to the detected listener")
    parser.add_argument("--env", action="append", default=[], metavar="NAME=VALUE", help="child-only environment override; named variables expand after PORT injection")
    parser.add_argument("-c", "--shell", help="run this explicit shell script instead of a command")
    parser.add_argument("--timeout", type=float, default=120, help="startup deadline in seconds")
    parser.add_argument("--runtime", choices=["core", "tui"], help="explicit identity for nested terminal environments")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.shell is not None:
        if command or not args.shell.strip():
            parser.error("--shell requires a script and cannot be combined with a command")
        command = ["/bin/sh", "-c", args.shell]
    if not command:
        parser.error("a command is required")
    if args.port is not None and not 1 <= args.port <= 65535 or not 0 < args.timeout <= 600:
        parser.error("port must be 1–65535 and timeout must be 0–600 seconds")
    if args.probe and (not args.probe.startswith("/") or any(ord(c) <= 32 or ord(c) == 127 for c in args.probe)):
        parser.error("--probe requires an HTTP path without whitespace, e.g. /health")
    if args.ready == "tcp" and (args.probe is not None or args.probe_command is not None) or args.probe is not None and args.probe_command is not None:
        parser.error("choose one of --ready tcp, --probe or --probe-command")
    overrides = []
    for value in args.env:
        name, separator, value = value.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            parser.error("--env requires NAME=VALUE")
        overrides.append((name, value))
    if not sys.platform.startswith("linux"):
        raise CaptureError("this capture preview requires Linux listener ownership checks")
    if args.port is not None and port_open(args.port):
        raise CaptureError("capture port is already in use; the command was not started")
    candidate = args.port or available_port()

    # Load the shipped helper definitions without invoking its executable entry.
    helper = runpy.run_path(str(Path(__file__).with_name("canvas")))
    helper["terminal_identity"].__globals__["selected_runtime"] = args.runtime
    try:
        native_socket, pane = helper["terminal_identity"]()
        entries = helper["registry_entries"](native_socket)
    except helper["CanvasError"] as error:
        raise CaptureError(str(error)) from None
    if not entries:
        raise CaptureError("no Canvas bridge for this terminal")
    entry = entries[0]
    child = None
    requested_signal = [None]
    def interrupted(number, _frame):
        requested_signal[0] = number
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, number)
            except ProcessLookupError:
                pass
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(entry["socket"])
            send(connection, {"version": 1, "secret": entry["secret"], "nativeSocket": native_socket, "paneId": pane,
                              "kind": "capture", "port": args.port or 0, "title": (args.title or Path(command[0]).name)[:120]})
            response = line(connection)
            public_url = response.get("publicUrl")
            if response.get("ok") is not True or response.get("state") != "prepared" or not isinstance(public_url, str):
                raise CaptureError("Canvas could not prepare this terminal capture")
            public = urlsplit(public_url)
            if public.scheme not in ("http", "https") or not public.netloc or public.username or public.password:
                raise CaptureError("invalid capture public URL")
            environment = dict(os.environ)
            environment["CANVAS_CAPTURE_PUBLIC_URL"] = public_url
            environment["CANVAS_CAPTURE_HOST"] = public.netloc
            environment["PORT"] = environment["CANVAS_CAPTURE_PORT"] = str(candidate)
            for name, value in overrides:
                environment[name] = expand(value, environment)
            child = subprocess.Popen(command, env=environment, start_new_session=True)
            deadline = time.monotonic() + args.timeout
            ready_url = False
            selected_port = None
            while child.poll() is None and not requested_signal[0]:
                if select.select([connection], [], [], 0)[0]:
                    value = line(connection, 1)
                    if value.get("action") == "stop":
                        terminate(child)
                        return 0
                    raise CaptureError("capture bridge rejected startup")
                ports = owned_listeners(child.pid)
                preferred = args.port or (candidate if candidate in ports else None)
                ports = {preferred} & ports if preferred else ports
                statuses = {}
                if not preferred and len(ports) > 1:
                    if args.ready == "tcp" or args.probe_command or len(ports) > 32:
                        raise CaptureError("command opened multiple loopback ports; select one with --port")
                    statuses = {port: probe_http(port, args.probe or "/", public, deadline) for port in sorted(ports)}
                    ports = {port for port, status in statuses.items() if status is not None}
                    if len(ports) > 1:
                        raise CaptureError("command opened multiple HTTP ports; select one with --port")
                if len(ports) == 1:
                    selected_port = next(iter(ports))
                    if args.probe_command:
                        ready = probe_command(args.probe_command, environment, selected_port, deadline)
                    elif args.ready == "tcp":
                        ready = port_open(selected_port)
                    else:
                        status = statuses.get(selected_port) or probe_http(selected_port, args.probe or "/", public, deadline)
                        ready = status is not None and (200 <= status < 300 if args.probe else 200 <= status < 500)
                    if ready and time.monotonic() < deadline and selected_port in owned_listeners(child.pid):
                        ready_url = bootstrap_file(args.bootstrap_file, public_url, selected_port)
                        if ready_url is not False:
                            break
                if time.monotonic() >= deadline:
                    raise CaptureError("command did not expose a ready owned loopback service before the startup deadline")
                time.sleep(0.1)
            if child.poll() is not None or requested_signal[0]:
                return child.returncode if child.returncode is not None and child.returncode >= 0 else 128 + (requested_signal[0] or -child.returncode)
            send(connection, {"action": "ready", "port": selected_port, **({"bootstrapUrl": ready_url} if ready_url else {})})
            response = line(connection)
            if response.get("ok") is not True or response.get("state") != "ready":
                raise CaptureError("Canvas could not display this captured application")
            print("canvas: Web view ready; return to this terminal without stopping, or stop the captured command.", file=sys.stderr)
            while child.poll() is None and not requested_signal[0]:
                if select.select([connection], [], [], 0.2)[0]:
                    response = line(connection, 1)
                    if response.get("action") == "stop":
                        terminate(child)
                        return 0
                    raise CaptureError("capture bridge closed the application view")
            result = child.wait(timeout=5)
            return result if result >= 0 else 128 - result
    finally:
        if child is not None:
            terminate(child)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (CaptureError, OSError, ValueError, subprocess.SubprocessError) as error:
        # Never include ready-file contents or credential-bearing URLs.
        print("canvas: " + str(error), file=sys.stderr)
        sys.exit(1)
