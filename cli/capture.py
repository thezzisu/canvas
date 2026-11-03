#!/usr/bin/env python3
"""Run an explicit command and attach its loopback Web UI to this terminal."""

import argparse
import json
import os
from pathlib import Path
import runpy
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


def owns_listener(parent, port):
    """A port becoming reachable must not capture a different local service."""
    inodes = set()
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
            reaches_loopback = address in ("0100007F", "00000000") if table == "tcp" else address == "0" * 32
            if reaches_loopback and fields[3] == "0A" and int(port_hex, 16) == port:
                inodes.add("socket:[" + fields[9] + "]")
    if not inodes:
        return False
    for pid in descendants(parent):
        try:
            for descriptor in (Path("/proc") / str(pid) / "fd").iterdir():
                try:
                    if os.readlink(descriptor) in inodes:
                        return True
                except OSError:
                    pass
        except OSError:
            continue
    return False


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
            raise CaptureError("capture ready file must be a private regular file owned by this account")
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
        raise CaptureError("invalid application ready URL")
    try:
        parsed, public = urlsplit(url), urlsplit(public_url)
        is_public = (parsed.scheme, parsed.netloc) == (public.scheme, public.netloc) and parsed.path.startswith(public.path)
        is_loopback = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1") and (parsed.port or 80) == port
        if parsed.username or parsed.password or not (is_public or is_loopback):
            raise ValueError()
    except ValueError:
        raise CaptureError("application ready URL does not match this capture") from None
    return url


def terminate(child):
    if getattr(child, "_canvas_terminated", False):
        return
    child._canvas_terminated = True
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(prog="canvas capture", description=__doc__)
    parser.add_argument("--port", type=int, required=True, help="the command's loopback HTTP port")
    parser.add_argument("--title", help="application title shown on the terminal")
    parser.add_argument("--ready-file", help="private JSON file containing the application's launchUrl or url")
    parser.add_argument("--timeout", type=float, default=120, help="startup deadline in seconds")
    parser.add_argument("--runtime", choices=["core", "tui"], help="explicit identity for nested terminal environments")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")
    if not 1 <= args.port <= 65535 or not 0 < args.timeout <= 600:
        parser.error("port must be 1–65535 and timeout must be 0–600 seconds")
    if not sys.platform.startswith("linux"):
        raise CaptureError("this capture preview requires Linux listener ownership checks")
    if port_open(args.port):
        raise CaptureError("capture port is already in use; the command was not started")

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
                              "kind": "capture", "port": args.port, "title": (args.title or Path(command[0]).name)[:120]})
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
            child = subprocess.Popen(command, env=environment, start_new_session=True)
            deadline = time.monotonic() + args.timeout
            ready_url = False
            while child.poll() is None and not requested_signal[0]:
                if select.select([connection], [], [], 0)[0]:
                    value = line(connection, 1)
                    if value.get("action") == "stop":
                        terminate(child)
                        return 0
                    raise CaptureError("capture bridge rejected startup")
                if port_open(args.port) and owns_listener(child.pid, args.port):
                    ready_url = bootstrap_file(args.ready_file, public_url, args.port)
                    if ready_url is not False:
                        break
                if time.monotonic() >= deadline:
                    raise CaptureError("command did not open its declared loopback port before the startup deadline")
                time.sleep(0.1)
            if child.poll() is not None or requested_signal[0]:
                return child.returncode if child.returncode is not None and child.returncode >= 0 else 128 + (requested_signal[0] or -child.returncode)
            send(connection, {"action": "ready", **({"bootstrapUrl": ready_url} if ready_url else {})})
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
