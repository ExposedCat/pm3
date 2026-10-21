#!/usr/bin/env python3
"""End-to-end checks of pm3 against real podman and the test-projects fixtures.

Runs in isolation: its own database, daemon socket, API port and work directory, so a pm3
daemon already running on the machine is not touched. Containers and images created by the
fixtures are removed at the end.

Usage: scripts/e2e.py [--keep]   (build first: cargo build --release)
"""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "target", "release", "pm3")
OLD_BIN = os.path.join(ROOT, "dist", "pm3")
WORK = "/tmp/pm3-e2e-suite"
API = "127.0.0.1:46398"
ENV = {
    **os.environ,
    "PM3_DATABASE_PATH": f"{WORK}/pm3.sqlite",
    "PM3_DAEMON_SOCKET": f"{WORK}/daemon.sock",
    "PM3_API_ADDRESS": API,
}
FIXTURES = ["healthy", "degraded", "unhealthy", "safe", "logger"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

results = []


def plain(text):
    return ANSI.sub("", text)


def check(name, condition, detail=""):
    results.append((name, bool(condition)))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + ("" if condition else f"\n       {detail}"), flush=True)
    return condition


def section(title):
    print(f"\n=== {title}", flush=True)


def pm3(*args, input=None, timeout=600, env=None, binary=BIN):
    started = time.time()
    process = subprocess.run(
        [binary, *args],
        cwd=ROOT,
        env={**ENV, **(env or {})},
        input=input,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    process.elapsed = time.time() - started
    process.out = plain(process.stdout)
    process.err = plain(process.stderr).strip()
    return process


def describe(process):
    return f"exit={process.returncode} stdout={process.out[-600:]!r} stderr={process.err[-600:]!r}"


def expect_ok(name, process, *needles):
    missing = [needle for needle in needles if needle not in process.out]
    return check(name, process.returncode == 0 and not missing, f"missing={missing} {describe(process)}")


def expect_fail(name, process, message):
    return check(name, process.returncode != 0 and message in process.err, describe(process))


def containers(project):
    output = subprocess.run(
        ["podman", "ps", "-a", "--format", "json", "--filter", f"label=io.podman.compose.project={project}"],
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(output or "[]")


def running(project):
    return sorted(
        container["Labels"].get("io.podman.compose.service", "")
        for container in containers(project)
        if container["State"] == "running"
    )


def wait_until(condition, timeout, interval=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(interval)
    return condition()


def state(name, detailed=False):
    args = ["list", "-d"] if detailed else ["list"]
    for line in pm3(*args).out.splitlines()[1:]:
        fields = line.split()
        if fields and fields[0] == name:
            return " ".join(fields[1:])
    return None


def api(method, path, body=None, timeout=300):
    request = urllib.request.Request(f"http://{API}{path}", method=method, data=body)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), json.loads(error.read() or b"{}")


def leftover_log_processes():
    output = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
    return [line for line in output.splitlines() if line.startswith("podman logs") or " podman logs " in line]


class Terminal:
    """Runs pm3 in a pseudo-terminal and reconstructs the rows it draws."""

    ROW = re.compile(r"\x1b\[(\d+);1H\x1b\[2K(.*?)(?=\x1b\[\d+;1H|\x1b\[\?2026l|$)", re.S)

    def __init__(self, args, rows=14, columns=100, env=None):
        self.buffer = b""
        self.rows = {}
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(ROOT)
            os.execve(BIN, [BIN, *args], {**ENV, **(env or {})})
        self.resize(rows, columns)

    def resize(self, rows, columns):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(self.fd, 1 << 20)
                except OSError:
                    return
                if not chunk:
                    return
                self.buffer += chunk
                # Every frame redraws all rows; start over at each frame so stale rows vanish.
                for frame_index, frame in enumerate(chunk.decode("utf8", "replace").split("\x1b[?2026h")):
                    if frame_index > 0:
                        self.rows = {}
                    for row, content in self.ROW.findall(frame):
                        self.rows[int(row)] = content

    def screen(self):
        return [plain(self.rows[row]) for row in sorted(self.rows)]

    def raw_row(self, row):
        return self.rows.get(row, "")

    def status(self):
        return plain(self.rows[max(self.rows)]) if self.rows else ""

    def press(self, keys, wait=0.5):
        os.write(self.fd, keys.encode())
        self.pump(wait)

    def wait_exit(self, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
            self.pump(0.1)
        os.kill(self.pid, signal.SIGKILL)
        return None


def phase_cli():
    section("CLI basics")
    help_text = pm3("help")
    check("help exits 0 and lists commands", help_text.returncode == 0 and "pm3 logs" in help_text.out)
    check("help documents --flat", "[-f|--flat]" in help_text.out)
    if os.path.exists(OLD_BIN):
        old = subprocess.run([OLD_BIN, "help"], capture_output=True, text=True).stdout
        new_lines = [line for line in help_text.stdout.splitlines() if "pm3 logs" not in line]
        old_lines = [line.rstrip() for line in old.splitlines() if "pm3 logs" not in line]
        width_free = lambda lines: [re.sub(r"\s{2,}", "  ", line) for line in lines]
        check("help matches the Deno build apart from logs", width_free(new_lines) == width_free(old_lines))
    check("no arguments shows help", pm3().out == help_text.out)
    expect_fail("unknown command fails", pm3("bogus"), "Unknown command: bogus")
    expect_fail("show is not a command", pm3("show", "x"), "Unknown command: show")
    expect_fail("bulk command on empty registry", pm3("start", "-y"), "No projects registered.")
    check("empty list prints the header", pm3("list").out.strip() == "NAME  STATE")


def phase_registry():
    section("Registry: create, list, view, enable/disable")
    for fixture in FIXTURES:
        expect_ok(f"create {fixture}", pm3("create", f"./test-projects/{fixture}"), f"Created {fixture}")
    created = pm3("create", "test-projects/logger/../logger", "--name=logger-args", "--", "-f", "compose.yaml")
    expect_ok("create with --name= and compose args", created, "with compose arguments `-f compose.yaml`")
    view = pm3("view", "logger-args").out
    check("workdir is absolute and normalized", f"Workdir: {ROOT}/test-projects/logger\n" in view, view)
    check("view shows creation args", "Creation args: -f compose.yaml" in view, view)
    expect_ok("remove helper project", pm3("rm", "logger-args"))

    expect_fail("duplicate names are rejected", pm3("create", "/elsewhere", "--name", "logger"), "Project logger already exists")
    expect_fail("--git requires a repository", pm3("create", "/tmp", "--name", "nogit", "--git"), "Project is not a git repository: nogit")
    check("failed --git create stores nothing", state("nogit") is None)
    expect_fail("--git with --local is rejected", pm3("create", "/tmp", "-g", "-l"), "Cannot use --git with --local for create")
    expect_fail("unknown create option", pm3("create", "/tmp", "--compose", "x"), "Unknown option for create: --compose")
    expect_ok("create a project with a missing directory", pm3("create", "/nonexistent/pm3/app", "--name", "broken", "--", "-f", "compose.yaml"))
    expect_ok("create a project without a compose file", pm3("create", WORK + "/empty", "--name", "nocompose"))

    listing = pm3("list")
    check("list shows missing directories as invalid", state("broken") == "invalid", listing.out)
    check("list shows missing compose files as invalid", state("nocompose") == "invalid", listing.out)
    check("list shows stopped projects as down", state("logger") == "down", listing.out)
    check("list is fast", listing.elapsed < 1.0, f"{listing.elapsed:.2f}s")
    detailed = pm3("list", "-d").out.splitlines()
    check("detailed list has all columns", detailed[0].split() == ["NAME", "STATE", "STARTUP", "CREATED", "PORTS"], detailed[0])

    broken = pm3("view", "broken").out
    check("view explains invalid projects", "broken - invalid" in broken and "Working directory not found: /nonexistent/pm3/app" in broken, broken)
    logger = pm3("view", "logger").out
    check("view lists services of a stopped project", all(f"● {service} - down" in logger for service in ["blue", "green", "red"]), logger)
    expect_fail("view of an unknown project", pm3("view", "nope"), "Project not found: nope")

    aborted = pm3("enable", input="n\n")
    check("bulk commands ask before running", aborted.returncode == 0 and "Aborted" in aborted.out and "on 7 projects? [Y/n]" in aborted.out, describe(aborted))
    check("declining changes nothing", "enabled" not in pm3("list", "-d").out)
    expect_ok("confirming applies to every project", pm3("enable", input="y\n"), "Enabled logger", "Enabled safe")
    expect_ok("--yes skips the question", pm3("disable", "-y"), "Disabled logger")
    expect_ok("named enable", pm3("enable", "healthy"), "Enabled healthy")
    check("startup column reflects enable", state("healthy", True).split()[1] == "enabled" and state("logger", True).split()[1] == "disabled")
    expect_ok("named disable", pm3("disable", "healthy"), "Disabled healthy")


def phase_lifecycle():
    section("Lifecycle: start, stop, restart, detach, arguments, verbose")
    started = pm3("start", "logger")
    expect_ok("start", started, "Started logger/red", "Started logger/blue", "Started logger/green")
    check("all services run", running("logger") == ["blue", "green", "red"], running("logger"))
    check("list shows up", state("logger") == "up")
    check("detailed list shows durations", re.match(r"up \(<1m\) disabled <1m", state("logger", True) or ""), state("logger", True))

    again = pm3("start", "logger")
    expect_ok("starting a running project is idempotent", again, "Started logger/red")

    stopped = pm3("stop", "logger", "--", "-t", "1")
    expect_ok("stop passes down arguments", stopped, "Stopped logger/red")
    check("stop with -t 1 is quick", stopped.elapsed < 15, f"{stopped.elapsed:.1f}s")
    check("stopped project has no running containers", running("logger") == [])

    expect_ok("start passes up arguments", pm3("start", "logger", "--", "red"))
    check("only the requested service runs", running("logger") == ["red"], running("logger"))
    pm3("stop", "logger", "--", "-t", "1")

    detached = pm3("start", "logger", "-d")
    check("detached start returns immediately", detached.returncode == 0 and detached.elapsed < 3 and detached.out == "", describe(detached))
    check("detached start completes in the background", wait_until(lambda: running("logger") == ["blue", "green", "red"], 60), running("logger"))

    restarted = pm3("restart", "logger", "--no-build")
    expect_ok("restart --no-build", restarted, "Stopped logger/red", "Started logger/red")
    check("restart without build skips building", "Building" not in restarted.out)
    expect_fail("restart rejects compose arguments", pm3("restart", "logger", "--", "-t", "1"), "Unknown option for restart: --")

    verbose = pm3("-v", "stop", "logger", "--", "-t", "1")
    check("verbose mode shows podman-compose output", verbose.returncode == 0 and "logger_red_1" in verbose.stdout + verbose.stderr, describe(verbose))

    expect_ok("enable --now starts", pm3("enable", "logger", "--now"), "Enabled logger", "Started logger/red")
    expect_ok("disable --now stops", pm3("disable", "logger", "--now"), "Disabled logger", "Stopped logger/red")
    check("disable --now left nothing running", running("logger") == [])


def phase_health():
    section("Health tracking and x-pm3 policies")
    healthy = pm3("start", "healthy")
    expect_ok("start waits for health", healthy, "Checking health", "Healthy", "Started healthy/main")
    check("healthy project is up", state("healthy") == "up", state("healthy"))

    rebuilt = pm3("start", "healthy", "--build")
    expect_ok("start --build on a running project", rebuilt, "Started healthy/main")
    expect_ok("start --no-cache rebuilds", pm3("start", "healthy", "-c"), "Started healthy/main")

    unhealthy = pm3("start", "unhealthy")
    expect_fail("an unhealthy dependency aborts the startup", unhealthy, "Required services permanently unstartable: main")
    check("the aborted startup is rolled back", "Stopped unhealthy/main" in unhealthy.out and running("unhealthy") == [], describe(unhealthy))

    safe = pm3("start", "safe")
    expect_ok("partial startup is fine when required services run", safe, "Started safe/prebuilt", "Unhealthy")
    view = pm3("view", "safe").out
    check("view shows the blocked service", "● main - down" in view and "● prebuilt - up" in view, view)
    pm3("stop", "safe")

    expect_ok("register the short-name fixture", pm3("create", "./test-projects/registry-selection"))
    failed = pm3("start", "registry-selection")
    expect_fail("short image names can't be resolved without a terminal", failed, "Failed to pull compose image library/hello-world:latest")
    pm3("rm", "registry-selection", "-f")

    section("Interrupting a startup")
    process = subprocess.Popen([BIN, "start", "unhealthy"], cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(3)
    process.send_signal(signal.SIGINT)
    out, err = process.communicate(timeout=120)
    check("interrupted startup reports Interrupted", process.returncode == 1 and "Interrupted" in err, f"{process.returncode} {err!r} {plain(out)[-300:]!r}")
    check("interrupted startup is rolled back", running("unhealthy") == [], running("unhealthy"))


def phase_git():
    section("Git pulls")
    subprocess.run(["./test-projects/git/setup.sh"], cwd=ROOT, capture_output=True, check=True)
    generated = "test-projects/git/generated"
    for name, directory in [("git-same", "no-changes"), ("git-pulled", "pulled-commits"), ("git-failed", "failed-pull")]:
        expect_ok(f"create {name} with --git", pm3("create", f"{generated}/{directory}", "--name", name, "--git"))
    expect_ok("no new commits", pm3("start", "git-same"), "Synced git\n    No changes")
    expect_ok("pulled commits are counted", pm3("start", "git-pulled"), "Synced git\n    Pulled 2 commits")
    logs = pm3("logs", "git-pulled", "-s", "start", "-o", "-f", "-r").out
    check("the pulled revision is running", "remote change 2" in logs, logs)
    failed = pm3("start", "git-failed")
    expect_fail("a diverged repository fails the start", failed, "Not possible to fast-forward")
    check("the failed pull is summarized", "Failed to sync git\n    Failed to pull (fatal: Not possible to fast-forward, aborting.)" in failed.out, failed.out)
    check("nothing starts after a failed pull", running("failed-pull") == [])

    expect_ok("--local skips the pull", pm3("start", "git-failed", "--local"), "Started git-failed/main")
    expect_ok("git off", pm3("git", "off", "git-failed"), "Git pulling disabled for git-failed")
    expect_ok("restart without git", pm3("restart", "git-failed", "-b"), "Started git-failed/main")
    expect_ok("git on", pm3("git", "yes", "git-failed"), "Git pulling enabled for git-failed")
    expect_fail("--git forces a pull", pm3("restart", "git-failed", "--git", "-b"), "Not possible to fast-forward")
    expect_fail("git on validates the repository", pm3("git", "on", "nocompose"), "Project is not a git repository: nocompose")
    expect_fail("invalid git mode", pm3("git", "maybe"), "Invalid git mode: maybe")

    section("Bulk lifecycle with Git")
    subprocess.run(["./test-projects/git/setup.sh"], cwd=ROOT, capture_output=True, check=True)
    bulk = {"PM3_DATABASE_PATH": f"{WORK}/bulk.sqlite", "PM3_DAEMON_SOCKET": f"{WORK}/none.sock"}
    pm3("create", f"{generated}/no-changes", "--name", "a", "--git", env=bulk)
    pm3("create", f"{generated}/pulled-commits", "--name", "b", "--git", env=bulk)
    pm3("create", "./test-projects/logger", "--name", "c", env=bulk)
    result = pm3("start", "-y", env=bulk)
    pulls = result.out.find("Pulled 2 commits")
    first_start = result.out.find("Starting ")
    check("bulk start pulls every Git project first", result.returncode == 0 and 0 <= pulls < first_start, describe(result))
    pm3("stop", "-y", "--", "-t", "1", env=bulk)
    pm3("create", f"{generated}/failed-pull", "--name", "d", "--git", env=bulk)
    result = pm3("start", "-y", env=bulk)
    check("a failed bulk pull starts nothing", result.returncode != 0 and "Starting " not in result.out, describe(result))
    for name in ["git-same", "git-pulled", "git-failed"]:
        pm3("stop", name, "--", "-t", "1")


def phase_logs():
    section("Logs: flat output")
    pm3("start", "logger")
    time.sleep(5)
    raw = pm3("logs", "logger", "-l", "3", "-o", "-f", "-r").out.splitlines()
    services = [line.split(" | ")[0] for line in raw]
    stamps = [line.split(" | ")[1] for line in raw]
    counts = {service: services.count(service) for service in set(services)}
    check("--lines per service, raw lines prefixed by service", set(counts) == {"red", "blue", "green"} and counts["red"] == 3 and max(counts.values()) == 3, raw)
    check("history is merged chronologically", stamps == sorted(stamps), stamps)
    columns = pm3("logs", "logger", "red", "blue", "-l", "2", "-o", "-f").out.splitlines()
    check("column header lists the selected services", columns[0].replace(" ", "").startswith("red|blue"), columns[:2])
    single = pm3("logs", "logger", "red", "-s", "start", "-o", "-f", "-r").stdout.splitlines()
    check("one service prints bare lines", single and " | " not in plain(single[0]), single[:2])
    check("--once without a range prints only the header", len(pm3("logs", "logger", "-o", "-f").out.strip().splitlines()) == 2)

    process = subprocess.Popen([BIN, "logs", "logger", "-f", "-r"], cwd=ROOT, env=ENV, stdout=subprocess.PIPE, text=True)
    time.sleep(3.5)
    process.send_signal(signal.SIGINT)
    followed = plain(process.communicate(timeout=10)[0]).splitlines()
    check("follow streams new lines and stops on interrupt", process.returncode == 0 and len(followed) >= 2, f"{process.returncode} {followed}")
    process = subprocess.Popen([BIN, "logs", "logger", "red", "-l", "2", "-f", "-r"], cwd=ROOT, env=ENV, stdout=subprocess.PIPE, text=True)
    time.sleep(3.5)
    process.send_signal(signal.SIGINT)
    history_follow = plain(process.communicate(timeout=10)[0]).splitlines()
    check("--lines then follow", len(history_follow) >= 4, history_follow)

    started = time.time()
    head = subprocess.run(f"'{BIN}' logs logger -f -r | head -1", shell=True, cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=30)
    check("follow exits when the reader closes the pipe", head.stdout.strip() and time.time() - started < 10)
    time.sleep(1)
    check("no podman logs processes are left", not leftover_log_processes(), leftover_log_processes())

    expect_fail("unknown service", pm3("logs", "logger", "nope", "-f"), "No compose containers found for service: nope")
    expect_fail("project without containers", pm3("logs", "degraded", "-f"), "No compose containers found for project: degraded")
    expect_fail("project without compose file", pm3("logs", "nocompose", "-f"), "Compose file not found for project: nocompose")

    section("Logs: several containers per service")
    scaled = pm3("start", "logger", "--", "--scale", "red=2")
    replicas = [container for container in containers("logger") if container["Labels"].get("io.podman.compose.service") == "red" and container["State"] == "running"]
    if check("compose scaling works", scaled.returncode == 0 and len(replicas) == 2, f"{describe(scaled)} replicas={len(replicas)}"):
        time.sleep(3)
        lines = pm3("logs", "logger", "red", "-l", "2", "-o", "-f", "-r").out.splitlines()
        check("--lines applies to the service across replicas", len(lines) == 2, lines)
        check("replica lines carry the container name", all(re.match(r"logger_red_\d ", line) for line in lines), lines)
    pm3("stop", "logger", "--", "-t", "1")
    pm3("start", "logger")

    section("Logs: multiple projects")
    multi = {"PM3_DATABASE_PATH": f"{WORK}/multi.sqlite", "PM3_DAEMON_SOCKET": f"{WORK}/none.sock"}
    pm3("create", "./test-projects/logger", env=multi)
    pm3("create", "./test-projects/healthy", env=multi)
    lines = pm3("logs", "-y", "-s", "start", "-o", "-f", "-r", env=multi).out.splitlines()
    labels = {line.split(" | ")[0] for line in lines if " | " in line}
    check("labels include the project name", {"logger/red", "healthy/main"} <= labels, labels)

    section("Logs: flat output re-layout on resize")
    terminal = Terminal(["logs", "logger", "red", "blue", "-f"], rows=20, columns=60)
    terminal.pump(3)
    narrow = plain(terminal.buffer.decode("utf8", "replace")).splitlines()[0]
    terminal.resize(20, 100)
    os.kill(terminal.pid, signal.SIGWINCH)
    terminal.pump(2)
    after = terminal.buffer.decode("utf8", "replace").split("\x1b[H\x1b[2J\x1b[3J")
    check("resize clears and redraws", len(after) > 1)
    if len(after) > 1:
        wide = plain(after[-1]).splitlines()[0]
        check("redrawn header uses the new width", len(narrow) < 65 and 90 < len(wide) <= 100, (len(narrow), len(wide)))
    os.kill(terminal.pid, signal.SIGINT)
    terminal.wait_exit()

    section("Logs: pager")
    terminal = Terminal(["logs", "logger", "-s", "start"], rows=14, columns=110)
    terminal.pump(3)
    check("pager uses the alternate screen", b"\x1b[?1049h" in terminal.buffer)
    check("pager starts live at the newest line", "● live" in terminal.status() and "columns" in terminal.status(), terminal.status())
    header = terminal.screen()[0].replace(" ", "")
    check("pager numbered column header", header.startswith("[1]red|[2]blue|[3]green"), header)
    terminal.press("kkk")
    check("scrolling up pauses following", "paused" in terminal.status(), terminal.status())
    terminal.pump(3)
    check("paused view counts new lines", re.search(r"paused \+\d+ new", terminal.status()), terminal.status())
    terminal.press("G", 1.0)
    check("G resumes following", "● live" in terminal.status(), terminal.status())
    terminal.press("r")
    check("r switches to one line per entry", "lines" in terminal.status() and " | " in terminal.screen()[1], terminal.screen()[:3])
    terminal.press("g")
    check("g jumps to the first line", re.search(r"│ 1-\d+/", terminal.status()), terminal.status())
    terminal.press("j")
    check("j scrolls down a line", re.search(r"│ 2-\d+/", terminal.status()) and "paused" in terminal.status(), terminal.status())
    terminal.press(" ")
    check("space pages down", "paused" in terminal.status() or "live" in terminal.status())
    terminal.press("lll")
    terminal.press("^")
    terminal.press("G", 1.0)
    terminal.press("2", 1.0)
    screen = terminal.screen()
    check("2 shows only the second service", "blue" in terminal.status() and "[0] all" in screen[0], [screen[0], terminal.status()])
    check("filtered view has no columns or prefixes", all(" | " not in row for row in screen[1:-1]) and any(row.strip() for row in screen[1:-1]), screen)
    terminal.press("0")
    check("0 returns to all services", "lines" in terminal.status() and " | " in terminal.screen()[-2], terminal.screen()[-2:])
    target_minute = time.strftime("%H:%M", time.gmtime(time.time() - 1))
    terminal.press(f"/{target_minute}", 0.3)
    check("search prompt", terminal.status().startswith(f"/{target_minute}"), terminal.status())
    terminal.press("\r", 1.0)
    reversed_rows = [terminal.raw_row(row) for row in sorted(terminal.rows) if "\x1b[7m" in terminal.raw_row(row) and row != max(terminal.rows)]
    check("search highlights the match", reversed_rows, terminal.screen())
    check("search pauses on the match", "paused" in terminal.status(), terminal.status())
    terminal.press("/no-such-text-anywhere\r")
    check("missing text is reported", "Not found: no-such-text-anywhere" in terminal.status(), terminal.status())
    terminal.press("?")
    check("? shows key help", any("scroll by line" in row for row in terminal.screen()), terminal.screen())
    terminal.press("?")
    terminal.resize(10, 70)
    terminal.pump(1)
    check("pager adapts to resizes", len(terminal.status()) == 70 and max(terminal.rows) == 10, (len(terminal.status()), max(terminal.rows)))
    terminal.press("q")
    code = terminal.wait_exit()
    check("q quits cleanly and restores the screen", code == 0 and b"\x1b[?1049l" in terminal.buffer, code)
    time.sleep(1.5)
    check("quitting stops podman logs", not leftover_log_processes(), leftover_log_processes())

    terminal = Terminal(["logs", "logger", "-s", "start", "-o", "-r"], rows=12, columns=100)
    terminal.pump(4)
    check("--once pager reaches the end of history", " end " in terminal.status() and "lines" in terminal.status(), terminal.status())
    terminal.press("\x03")
    check("Ctrl-C quits the pager", terminal.wait_exit() == 0)
    spool = os.path.expanduser("~/.cache/pm3")
    check("no spool files are left behind", not os.path.isdir(spool) or not os.listdir(spool), os.listdir(spool) if os.path.isdir(spool) else [])


def phase_daemon():
    section("Daemon")
    hook = f"{WORK}/hook.sh"
    with open(hook, "w") as file:
        file.write(f"#!/bin/sh\necho \"$@\" >> {WORK}/hooks.log\n")
    os.chmod(hook, 0o755)
    pm3("stop", "logger", "--", "-t", "1")
    pm3("enable", "logger")
    pm3("enable", "degraded")
    hooks = {
        "PM3_logger_red_started_EXEC": hook,
        "PM3_logger_red_stopping_EXEC": hook,
        "PM3_logger_red_stopped_EXEC": hook,
        "PM3_logger_blue_started_EXEC": "exit 3",
        "PM3_degraded_delayed-health_degraded_EXEC": hook,
        "PM3_degraded_main_stopping_EXEC": hook,
    }
    log = open(f"{WORK}/daemon.log", "w")
    daemon = subprocess.Popen([BIN, "daemon"], cwd=ROOT, env={**ENV, **hooks}, stdout=log, stderr=subprocess.STDOUT)
    daemon_log = lambda: plain(open(f"{WORK}/daemon.log").read())
    hook_log = lambda: open(f"{WORK}/hooks.log").read() if os.path.exists(f"{WORK}/hooks.log") else ""
    check("daemon starts the API", wait_until(lambda: f"PM3 API listening on http://{API}" in daemon_log(), 30), daemon_log())
    second = pm3("daemon", timeout=20)
    expect_fail("a second daemon refuses to start", second, "PM3 daemon socket is already in use")

    check("enabled projects that are down are started", wait_until(lambda: running("logger") == ["blue", "green", "red"], 90), running("logger"))
    check("state changes are logged", wait_until(lambda: "logger/red started" in daemon_log(), 20), daemon_log())
    check("hooks run with project, service and event", wait_until(lambda: "logger red started" in hook_log(), 20), hook_log())
    check("a failing hook is reported once", daemon_log().count("Hook failed for logger/blue started") == 1, daemon_log())

    pm3("stop", "logger", "--", "-t", "1")
    check("CLI lifecycle is reported to the daemon", wait_until(lambda: "logger/red stopping" in daemon_log() and "logger/red stopped" in daemon_log(), 20), daemon_log())
    check("lifecycle hooks run", wait_until(lambda: "logger red stopping" in hook_log() and "logger red stopped" in hook_log(), 20), hook_log())

    section("Daemon API")
    status, _, body = api("GET", "/projects")
    names = [project["name"] for project in body.get("projects", [])]
    check("GET /projects", status == 200 and "logger" in names and set(body["projects"][0]) == {"created", "enabled", "name", "ports", "state", "workingDir"}, body)
    status, _, body = api("GET", "/projects?detailed=1")
    healthy = next((project for project in body.get("projects", []) if project["name"] == "healthy"), {})
    check("detailed state includes the duration", status == 200 and healthy.get("state", "").startswith("up ("), healthy)
    status, _, body = api("GET", "/projects/?detailed=x")
    check("invalid boolean is a 400", status == 400 and body == {"error": "Invalid boolean value for detailed"}, (status, body))
    status, _, body = api("POST", "/projects/healthy/show")
    check("show lists services", status == 200 and [service["service"] for service in body["project"]["services"]] == ["delayed-health", "main", "prebuilt"], body)
    status, headers, _ = api("GET", "/projects/healthy/show")
    check("wrong method is a 405 with Allow", status == 405 and headers.get("allow") == "POST", (status, headers))
    check("unknown route is a 404", api("GET", "/nope")[0] == 404)
    status, _, body = api("POST", "/projects/nope/show")
    check("unknown project is a 404", status == 404 and body == {"error": "Project not found: nope"}, (status, body))
    check("invalid JSON body is a 400", api("POST", "/projects/logger/start", b"{bad")[2] == {"error": "Request body must be valid JSON"})
    check("conflicting flags are a 400", api("POST", "/projects/logger/start?git=1&local=1")[2] == {"error": "Cannot use git with local"})
    status, _, body = api("POST", "/projects/logger/start", b'{"build": false}')
    check("POST start", status == 200 and body["project"]["state"].startswith("up"), (status, body))
    check("API lifecycle is tracked", wait_until(lambda: daemon_log().count("logger/red started") >= 2, 20), daemon_log())
    try:
        api("POST", "/projects/logger/stop", timeout=2)
    except Exception:
        pass
    check("an API stop finishes after the client disconnects", wait_until(lambda: running("logger") == [], 90), running("logger"))
    status, _, body = api("POST", "/projects/logger/restart?no-build=1")
    check("POST restart", status == 200 and body["project"]["state"].startswith("up"), (status, body))

    section("Daemon: compatibility with the Deno CLI")
    if os.path.exists(OLD_BIN):
        before = daemon_log().count("logger/red stopping")
        old = subprocess.run([OLD_BIN, "stop", "logger"], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=180)
        check("Deno CLI works against the Rust database", old.returncode == 0, old.stderr[-300:])
        check("Deno CLI notifications reach the Rust daemon", wait_until(lambda: daemon_log().count("logger/red stopping") > before, 20), daemon_log()[-500:])

    section("Daemon: x-pm3 enforcement")
    check("degraded project was autostarted", wait_until(lambda: "degraded/main started" in daemon_log(), 120), daemon_log())
    check("policy stops a project whose required service became blocked", wait_until(lambda: "Stopping degraded: Required services permanently unstartable: main" in daemon_log(), 120), daemon_log())
    check("the stopped stack is down", wait_until(lambda: running("degraded") == [], 60), running("degraded"))
    check("policy hooks run", wait_until(lambda: "degraded delayed-health degraded" in hook_log() and "degraded main stopping" in hook_log(), 20), hook_log())

    section("Daemon: shutdown and persistence")
    daemon.send_signal(signal.SIGTERM)
    try:
        daemon.wait(timeout=30)
        check("SIGTERM stops the daemon", daemon.returncode == 0, daemon.returncode)
    except subprocess.TimeoutExpired:
        daemon.kill()
        check("SIGTERM stops the daemon", False, "timeout")
    check("the socket is removed", not os.path.exists(f"{WORK}/daemon.sock"))
    connection = sqlite3.connect(f"{WORK}/pm3.sqlite")
    rows = dict(
        connection.execute(
            "select p.name || '/' || s.service, s.status from projectServiceState s join projects p on p.id = s.projectId"
        ).fetchall()
    )
    check("service states are persisted", rows.get("degraded/main") == "stopped" and rows.get("logger/red") == "stopped", rows)

    pm3("disable", "degraded")
    pm3("disable", "logger")
    log = open(f"{WORK}/daemon2.log", "w")
    daemon = subprocess.Popen([BIN, "daemon"], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)
    restarted_log = lambda: plain(open(f"{WORK}/daemon2.log").read())
    check("restarted daemon comes up", wait_until(lambda: "PM3 API listening" in restarted_log(), 30), restarted_log())
    time.sleep(5)
    check("restart doesn't re-stop or restart anything", "Stopping " not in restarted_log() and running("degraded") == [], restarted_log())
    daemon.send_signal(signal.SIGTERM)
    daemon.wait(timeout=30)


def phase_migration():
    section("Existing database compatibility")
    source = os.path.expanduser("~/.local/share/pm3/pm3.sqlite")
    if not os.path.exists(source):
        check("real database available", True)
        return
    target = f"{WORK}/real.sqlite"
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as reader, sqlite3.connect(target) as writer:
        reader.backup(writer)
    expected = [row[0] for row in sqlite3.connect(target).execute("select name from projects order by name")]
    listing = pm3("list", env={"PM3_DATABASE_PATH": target})
    check("the Rust build reads a copy of the real database", listing.returncode == 0 and all(name in listing.out for name in expected), describe(listing))
    migrations = sqlite3.connect(target).execute("select count(*) from kysely_migration").fetchone()[0]
    check("migration history is intact", migrations == 7, migrations)


def phase_remove():
    section("Remove")
    expect_fail("running projects can't be removed", pm3("rm", "healthy"), 'Failed to remove project: "healthy" is running')
    expect_fail("invalid directories need --force", pm3("rm", "broken"), "Project broken has invalid cwd '/nonexistent/pm3/app'")
    expect_ok("--force removes broken projects", pm3("rm", "broken", "--force"))
    expect_fail("unknown projects", pm3("rm", "broken"), 'Failed to remove project: "broken" not found')
    pm3("stop", "healthy")
    removed = pm3("rm", "healthy")
    expect_ok("rm removes stopped projects and their artifacts", removed, "Removed healthy/main")
    check("no healthy containers remain", containers("healthy") == [])
    check("rm deletes the project", state("healthy") is None)


def cleanup():
    section("Cleanup")
    for name in ["logger", "degraded", "unhealthy", "safe", "git-same", "git-pulled", "git-failed", "nocompose", "registry-selection"]:
        pm3("rm", name, "--force")
    for name in ["logger", "healthy"]:
        pm3("rm", name, "--force", env={"PM3_DATABASE_PATH": f"{WORK}/multi.sqlite"})
    for name in ["a", "b", "c", "d"]:
        pm3("rm", name, "--force", env={"PM3_DATABASE_PATH": f"{WORK}/bulk.sqlite"})
    shutil.rmtree(os.path.join(ROOT, "test-projects", "git", "generated"), ignore_errors=True)
    leftovers = [project for project in FIXTURES + ["no-changes", "pulled-commits", "failed-pull"] if containers(project)]
    check("no fixture containers remain", not leftovers, leftovers)
    shutil.rmtree(WORK, ignore_errors=True)


def main():
    if not os.path.exists(BIN):
        sys.exit(f"Build first: cargo build --release ({BIN} missing)")
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(f"{WORK}/empty")
    started = time.time()
    try:
        for phase in [phase_cli, phase_registry, phase_lifecycle, phase_health, phase_git, phase_logs, phase_daemon, phase_migration, phase_remove]:
            try:
                phase()
            except Exception as error:
                check(f"{phase.__name__} ran to completion", False, repr(error))
    finally:
        if "--keep" not in sys.argv:
            cleanup()
    failed = [name for name, passed in results if not passed]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed in {time.time() - started:.0f}s")
    for name in failed:
        print(f"  FAILED: {name}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
