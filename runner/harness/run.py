#!/usr/bin/env python3
"""Parallax runner harness (docs/design/runner.md section 4).

Reads a nonce line and a job document from stdin, runs every check of the job in a
subprocess, compares in this process and writes one nonce-framed result document to
stdout. Standard library only: the same file is the harness of the Python and the R image.

Exit codes: 0 result written, 64 bad input (nonce or job), 70 internal fault.
"""

import argparse
import base64
import codecs
import ctypes
import json
import os
import posixpath
import re
import select
import signal
import stat
import subprocess
import sys
import threading
import time
from fractions import Fraction

HARNESS_VERSION = "3"
HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))

EXIT_BAD_INPUT = 64
EXIT_INTERNAL = 70

NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
NONCE_LINE_BYTES = 33
MAX_JOB_BYTES = 4 * 1024 * 1024
MAX_FILES = 64
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_CHECKS = 50
MAX_TEXT_BYTES = 262144
STDIN_TIMEOUT_SECONDS = 10
COMPILE_CAP_SECONDS = 5.0
COMPILE_OUTPUT_BYTES = 64 * 1024
OUTCOME_MAX_BYTES = 8 * 1024 * 1024
JOIN_TIMEOUT_SECONDS = 10.0

BOUNDS = {
    "wallSeconds": (1, 60),
    "memoryMiB": (64, 2048),
    "outputBytes": (4096, 4 * 1024 * 1024),
}
EXPECTED_MAX = 2048
ACTUAL_MAX = 2048
MESSAGE_MAX = 512
ELLIPSIS = "\u2026"

PATH_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
NUMBER_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")

PR_SET_DUMPABLE = 4
PR_SET_CHILD_SUBREAPER = 36

CGROUP_V2_EVENTS = "/sys/fs/cgroup/memory.events"
CGROUP_V1_OOM_CONTROL = "/sys/fs/cgroup/memory/memory.oom_control"

DEFAULT_WORK = "/work"
DEFAULT_TMP = "/tmp"
DEFAULT_IPC = ["/dev/shm", "/dev/mqueue"]
ENV_PATH = "/usr/local/bin:/usr/bin:/bin"

# Python source of the compile phase: parses every file named on the command line and, on
# the first failure, writes "<file>\n<line or empty>\n<message>" to stdout and exits 1.
PY_COMPILE_SCRIPT = (
    "import ast,sys\n"
    "for f in sys.argv[1:]:\n"
    "    try:\n"
    "        ast.parse(open(f, 'rb').read(), f)\n"
    "    except (SyntaxError, ValueError) as e:\n"
    "        sys.stdout.write(f + '\\n' + str(getattr(e, 'lineno', None) or '') + '\\n'"
    " + str(getattr(e, 'msg', None) or e))\n"
    "        sys.exit(1)\n"
)
R_COMPILE_SCRIPT = (
    "for (f in commandArgs(TRUE)) { r <- tryCatch({ parse(f); NULL }, error = function(e)"
    " conditionMessage(e)); if (!is.null(r)) { m <- regmatches(r, regexpr(':[0-9]+:[0-9]+:', r));"
    " l <- if (length(m)) sub('^:([0-9]+):.*', '\\\\1', m) else '';"
    " cat(f, '\\n', l, '\\n', r, sep = ''); quit(status = 1) } }"
)


class InputError(Exception):
    """The nonce or the job on stdin is unusable (exit 64)."""


class InternalFault(Exception):
    """A fact the harness relies on does not hold (exit 70)."""


# --------------------------------------------------------------------------------------
# Size helpers: every cut is by the size of the JSON encoding with ensure_ascii=False.
# --------------------------------------------------------------------------------------


def encoded_len(text):
    """Bytes the text occupies inside a JSON string (UTF-8, quotes and escapes counted)."""
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8")) - 2


def cut_encoded(text, limit, ellipsis=True):
    """Prefix of text whose encoding is at most `limit` bytes; ends with the ellipsis when cut."""
    if encoded_len(text) <= limit:
        return text
    room = limit - (encoded_len(ELLIPSIS) if ellipsis else 0)
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if encoded_len(text[:mid]) <= room:
            low = mid
        else:
            high = mid - 1
    return text[:low] + (ELLIPSIS if ellipsis else "")


def one_line(text):
    return text.replace("\r", " ").replace("\n", " ")


def show(value):
    return json.dumps(value, ensure_ascii=False)


# --------------------------------------------------------------------------------------
# Job validation (structure and the semantic rules of design section 3.1).
# --------------------------------------------------------------------------------------


def decoded_size(file):
    if file.get("encoding", "utf8") == "base64":
        try:
            return len(base64.b64decode(file["content"], validate=True))
        except ValueError as error:
            raise InputError("file %s is not valid base64" % file["path"]) from error
    return len(file["content"].encode("utf-8"))


def file_bytes(file):
    if file.get("encoding", "utf8") == "base64":
        return base64.b64decode(file["content"], validate=True)
    return file["content"].encode("utf-8")


def _require(condition, message):
    if not condition:
        raise InputError(message)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _valid_path(value):
    return isinstance(value, str) and len(value) <= 200 and PATH_RE.match(value) is not None


def validate_job(job):
    """Raise InputError unless the job is structurally sound and obeys the semantic rules."""
    _require(isinstance(job, dict), "job is not an object")
    _require(job.get("v") == 1, "unsupported protocol version")
    runtime = job.get("runtime")
    _require(isinstance(runtime, dict) and runtime.get("language") in ("python", "r"), "bad runtime")
    _require(job.get("set") in ("public", "full"), "bad set")
    limits = job.get("limits")
    _require(isinstance(limits, dict), "bad limits")
    for key, (low, high) in BOUNDS.items():
        _require(_is_int(limits.get(key)) and low <= limits[key] <= high, "limit %s out of bounds" % key)

    files = job.get("files")
    _require(isinstance(files, list) and 1 <= len(files) <= MAX_FILES, "bad files")
    by_path = {}
    total = 0
    for file in files:
        _require(isinstance(file, dict), "bad file entry")
        _require(_valid_path(file.get("path")), "bad file path")
        _require(isinstance(file.get("content"), str), "bad file content")
        _require(file.get("encoding", "utf8") in ("utf8", "base64"), "bad file encoding")
        _require(isinstance(file.get("hidden", False), bool), "bad file hidden flag")
        total += decoded_size(file)
        normal = posixpath.normpath(file["path"])
        _require(normal not in by_path, "duplicate file path")
        by_path[normal] = file
    _require(total <= MAX_FILE_BYTES, "files exceed 2 MiB decoded")
    for path in by_path:
        parts = path.split("/")
        for depth in range(1, len(parts)):
            _require("/".join(parts[:depth]) not in by_path, "a file path is a directory prefix of another")

    checks = job.get("checks")
    _require(isinstance(checks, list) and 1 <= len(checks) <= MAX_CHECKS, "bad checks")
    names = set()
    public = job["set"] == "public"
    for check in checks:
        _require(isinstance(check, dict), "bad check entry")
        name = check.get("name")
        _require(isinstance(name, str) and NAME_RE.match(name) is not None, "bad check name")
        _require(name not in names, "duplicate check name")
        names.add(name)
        kind = check.get("kind")
        _require(kind in ("stdio", "call", "script"), "bad check kind")
        _require(check.get("visibility") in ("public", "hidden"), "bad check visibility")
        timeout = check.get("timeoutSeconds")
        _require(timeout is None or (_is_int(timeout) and 1 <= timeout <= 60), "bad timeoutSeconds")
        _require(_valid_path(check.get("file")), "bad check file")
        extra = check.get("files", [])
        _require(isinstance(extra, list) and len(extra) <= 16 and all(_valid_path(p) for p in extra), "bad check files")
        args = check.get("args", [])
        _require(isinstance(args, list) and len(args) <= 32, "bad check args")
        if kind != "call":
            _require(all(isinstance(a, str) and len(a) <= 1024 for a in args), "bad check args")
        stdin = check.get("stdin", "")
        _require(isinstance(stdin, str) and len(stdin) <= MAX_TEXT_BYTES, "bad check stdin")
        compare = check.get("compare", {"mode": "exact"})
        _require(isinstance(compare, dict), "bad compare")
        modes = {"stdio": ("exact", "trimmed", "tokens", "numeric"), "call": ("exact", "numeric", "repr")}
        if kind in modes:
            _require(compare.get("mode") in modes[kind], "bad compare mode")
            for key in ("abs", "rel"):
                value = compare.get(key, 0)
                _require(isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0, "bad tolerance")
        expected = check.get("expected")
        if kind == "stdio":
            _require(isinstance(expected, dict) and isinstance(expected.get("stdout"), str), "bad expected")
            _require(len(expected["stdout"]) <= MAX_TEXT_BYTES, "bad expected")
            code = expected.get("exitCode", 0)
            _require(_is_int(code) and 0 <= code <= 255, "bad expected exit code")
        elif kind == "call":
            _require(isinstance(check.get("function"), str) and re.match(r"^[A-Za-z_.][A-Za-z0-9_.]{0,127}$", check["function"]), "bad function")
            _require(isinstance(check.get("kwargs", {}), dict), "bad kwargs")
            _require(isinstance(expected, dict) and ("value" in expected) != ("raises" in expected), "call expects exactly one of value and raises")
            if "raises" in expected:
                raises = expected["raises"]
                _require(isinstance(raises, dict) and isinstance(raises.get("type"), str), "bad raises")
                _require(isinstance(raises.get("message", ""), str), "bad raises message")
            if compare.get("mode") == "repr" and "value" in expected:
                _require(isinstance(expected["value"], str), "repr mode expects a string value")

        # Semantic rules 2 and 3.
        named = [check["file"]] + list(extra)
        for path in named:
            normal = posixpath.normpath(path)
            _require(normal in by_path, "check names a file that is not in files")
            if check["visibility"] == "public":
                _require(not by_path[normal].get("hidden", False), "a public check names a hidden file")
        _require(not (public and check["visibility"] == "hidden"), "a public job holds a hidden check")
    if public:
        _require(not any(f.get("hidden", False) for f in files), "a public job holds a hidden file")


def parse_input(raw):
    """Split the stdin stream into (nonce, job); raise InputError on any defect."""
    _require(len(raw) <= MAX_JOB_BYTES + NONCE_LINE_BYTES, "stream too large")
    newline = raw.find(b"\n")
    _require(newline == NONCE_LINE_BYTES - 1, "missing nonce line")
    try:
        nonce = raw[:newline].decode("ascii")
    except UnicodeDecodeError as error:
        raise InputError("malformed nonce") from error
    _require(NONCE_RE.match(nonce) is not None, "malformed nonce")

    def reject_constant(name):
        raise ValueError("non-finite number " + name)

    try:
        job = json.loads(raw[newline + 1 :].decode("utf-8"), parse_constant=reject_constant)
    except (ValueError, RecursionError) as error:
        raise InputError("job is not valid JSON") from error
    try:
        json.dumps(job, ensure_ascii=False).encode("utf-8")
    except (UnicodeEncodeError, RecursionError) as error:
        raise InputError("job holds text that is not valid Unicode") from error
    validate_job(job)
    return nonce, job


def read_stdin(fd=0, cap=MAX_JOB_BYTES + NONCE_LINE_BYTES, timeout=STDIN_TIMEOUT_SECONDS):
    deadline = time.monotonic() + timeout
    chunks, total = [], 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise InputError("timed out reading stdin")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            raise InputError("timed out reading stdin")
        data = os.read(fd, 65536)
        if not data:
            return b"".join(chunks)
        total += len(data)
        if total > cap:
            raise InputError("stream too large")
        chunks.append(data)


# --------------------------------------------------------------------------------------
# Comparison (pure).
# --------------------------------------------------------------------------------------


def numbers_match(actual, expected, abs_tol, rel_tol):
    try:
        return abs(actual - expected) <= abs_tol + rel_tol * abs(expected)
    except OverflowError:  # an int too large for a float on one side: compare exactly
        try:
            exact = Fraction(actual) - Fraction(expected)
            return abs(exact) <= Fraction(abs_tol) + Fraction(rel_tol) * abs(Fraction(expected))
        except (OverflowError, ValueError):  # inf or nan on one side
            return actual == expected


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def values_equal(expected, actual, numeric=False, abs_tol=1e-6, rel_tol=1e-9):
    """Structural equality of two JSON values; with `numeric` numbers match within tolerance."""
    if _is_number(expected) or _is_number(actual):
        if not (_is_number(expected) and _is_number(actual)):
            return False
        if numeric:
            return numbers_match(actual, expected, abs_tol, rel_tol)
        return actual == expected
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(expected) == len(actual)
            and all(values_equal(e, a, numeric, abs_tol, rel_tol) for e, a in zip(expected, actual))
        )
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and expected.keys() == actual.keys()
            and all(values_equal(expected[k], actual[k], numeric, abs_tol, rel_tol) for k in expected)
        )
    return type(expected) is type(actual) and expected == actual


def _first_difference(expected, actual):
    for index in range(min(len(expected), len(actual))):
        if expected[index] != actual[index]:
            return index
    return min(len(expected), len(actual)) if len(expected) != len(actual) else None


def compare_text(mode, expected, actual, abs_tol=1e-6, rel_tol=1e-9):
    """Compare stdout with the expected text; return (matches, message)."""
    if mode == "exact":
        if expected == actual:
            return True, ""
        index = _first_difference(expected.split("\n"), actual.split("\n"))
        return False, "Line %d differs" % (index + 1) if index is not None else "Output differs"
    if mode == "trimmed":
        def trim(text):
            lines = [line.rstrip() for line in text.split("\n")]
            while lines and lines[-1] == "":
                lines.pop()
            return lines

        left, right = trim(expected), trim(actual)
        if left == right:
            return True, ""
        index = _first_difference(left, right)
        return False, "Line %d differs" % (index + 1)
    left, right = expected.split(), actual.split()
    if mode == "tokens":
        if left == right:
            return True, ""
        return False, "Token %d differs" % (_first_difference(left, right) + 1)
    # numeric
    for index in range(max(len(left), len(right))):
        if index >= len(left) or index >= len(right):
            return False, "Token %d differs" % (index + 1)
        want, got = left[index], right[index]
        if want == got:
            continue
        if NUMBER_RE.match(want) and NUMBER_RE.match(got):
            if numbers_match(float(got), float(want), abs_tol, rel_tol):
                continue
        return False, "Token %d differs" % (index + 1)
    return True, ""


def parse_oom_kill(text):
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "oom_kill" and parts[1].isdigit():
            return int(parts[1])
    return None


def read_oom_kills():
    for path in (CGROUP_V2_EVENTS, CGROUP_V1_OOM_CONTROL):
        try:
            with open(path, encoding="ascii") as handle:
                count = parse_oom_kill(handle.read())
        except (OSError, UnicodeDecodeError):
            continue
        if count is not None:
            return count
    return 0


def child_env(home, language):
    env = {
        "PATH": ENV_PATH,
        "HOME": home,
        "TMPDIR": home,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PARALLAX_JOB": "1",
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }
    if language == "r":
        env["R_LIBS_USER"] = "/tmp/none"
    return env


# --------------------------------------------------------------------------------------
# Capture and timing threads.
# --------------------------------------------------------------------------------------


class OutputBudget:
    """What is left of the job's outputBytes, counted by encoded size, shared by all streams."""

    def __init__(self, limit):
        self.limit = limit
        self.left = limit
        self.lock = threading.Lock()

    def take(self, text):
        """Return (kept text, cut) and spend the budget."""
        if not text:
            return "", False
        size = encoded_len(text)
        with self.lock:
            if size <= self.left:
                self.left -= size
                return text, False
            kept = cut_encoded(text, self.left, ellipsis=False)
            self.left = 0
            return kept, True


class Reader(threading.Thread):
    """Drains one pipe until EOF; keeps what fits the budget and discards the rest."""

    def __init__(self, fd, budget, whole=False):
        super().__init__(daemon=True)
        self.fd = fd
        self.budget = budget
        self.parts = []
        self.truncated = False
        # With `whole`, the stream's own text is also kept apart from the shared budget (up to
        # the job's outputBytes), so a stdio comparison does not depend on how much of the budget
        # the other stream happened to use first.
        self.whole = whole
        self.seen = 0
        self.over = False
        self.whole_parts = []
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def _keep(self, text):
        if self.whole and text and not self.over:
            self.seen += encoded_len(text)
            if self.seen > self.budget.limit:
                self.over = True
                self.whole_parts = []
            else:
                self.whole_parts.append(text)
        if self.truncated or not text:
            return
        kept, cut = self.budget.take(text)
        self.parts.append(kept)
        self.truncated = cut

    def run(self):
        try:
            while True:
                data = os.read(self.fd, 65536)
                if not data:
                    break
                self._keep(self.decoder.decode(data))
            self._keep(self.decoder.decode(b"", final=True))
        finally:
            os.close(self.fd)

    @property
    def text(self):
        return "".join(self.parts)


class Killer(threading.Thread):
    """Kills the check's process group at its deadline.

    Created before the spawn so that no thread starts after it; it receives the group id
    through `arm()` once Popen returned and kills at once when the deadline has passed.
    """

    def __init__(self, cap, clock):
        super().__init__(daemon=True)
        self.clock = clock
        self.deadline = clock() + cap
        self.pgid = None
        self.fired = False
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop_flag = threading.Event()

    def arm(self, pgid):
        self.pgid = pgid
        self.wake.set()

    def cancel(self):
        with self.lock:
            self.stop_flag.set()
        self.wake.set()

    def run(self):
        self.wake.wait()
        if self.stop_flag.is_set():
            return
        delay = self.deadline - self.clock()
        if delay > 0 and self.stop_flag.wait(delay):
            return
        with self.lock:
            if self.stop_flag.is_set():
                return
            self.fired = True
            try:
                os.killpg(self.pgid, signal.SIGKILL)
            except OSError:
                pass


class Exec:
    """What one subprocess run produced."""

    def __init__(self):
        self.returncode = None
        self.spawn_error = None
        self.fired = False
        self.stdout = ""
        self.stderr = ""
        self.truncated = False
        self.stdout_over = False
        self.stdout_whole = ""
        self.duration_ms = 0
        self.oom = False
        self.outcome = None


# --------------------------------------------------------------------------------------
# The harness proper.
# --------------------------------------------------------------------------------------


def scrub_text(value):
    """Replace what UTF-8 cannot carry (lone surrogates, which JSON escapes admit) in every string.

    The outcome file is written by student-controlled code, so its strings are untrusted
    before they are measured, cut or framed.
    """
    if isinstance(value, str):
        return value.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    if isinstance(value, list):
        return [scrub_text(item) for item in value]
    if isinstance(value, dict):
        return {scrub_text(key): scrub_text(item) for key, item in value.items()}
    return value


def clear_directory(path):
    """Remove everything under `path` (not `path` itself), iteratively and by directory fd.

    Student code may leave trees nested deeper than a path can name or a recursion can follow,
    directories without permissions and special files; none of that may stop the sweep. Only
    one directory fd is open at a time (the container's nofile limit is 256): the walk goes
    back up through `..`, which is safe because no student process is alive during a sweep.
    """
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    fd = os.open(path, flags)
    frames = [[None, os.listdir(fd), 0]]  # (name in parent, entries, next index) per level
    try:
        while True:
            frame = frames[-1]
            if frame[2] < len(frame[1]):
                entry = frame[1][frame[2]]
                frame[2] += 1
                info = os.lstat(entry, dir_fd=fd)
                if stat.S_ISDIR(info.st_mode):
                    os.chmod(entry, 0o700, dir_fd=fd)
                    child = os.open(entry, flags, dir_fd=fd)
                    os.close(fd)
                    fd = child
                    frames.append([entry, os.listdir(fd), 0])
                else:
                    os.unlink(entry, dir_fd=fd)
                continue
            frames.pop()
            if not frames:
                return
            parent = os.open("..", flags, dir_fd=fd)
            os.close(fd)
            fd = parent
            os.rmdir(frame[0], dir_fd=fd)
    finally:
        os.close(fd)


def proc_parents():
    """Map pid to (ppid, state) for every process visible in /proc."""
    table = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % entry, "rb") as handle:
                data = handle.read().decode("ascii", "replace")
        except OSError:
            continue
        # "pid (comm) state ppid ..." where comm may contain spaces and parentheses.
        tail = data[data.rfind(")") + 2 :].split()
        if len(tail) >= 2:
            table[int(entry)] = (int(tail[1]), tail[0])
    return table


def live_descendants(me):
    table = proc_parents()
    found = []
    for pid, (_, state) in table.items():
        if state == "Z" or pid == me:
            continue
        seen, current = set(), pid
        while current in table and current not in seen:
            seen.add(current)
            current = table[current][0]
            if current == me:
                found.append(pid)
                break
    return found


class Harness:
    def __init__(self, job, work_dir, tmp_dir, clock, ipc_dirs, python="python3"):
        self.job = job
        self.work_dir = work_dir
        self.tmp_dir = tmp_dir
        self.clock = clock
        self.ipc_dirs = list(ipc_dirs)
        self.language = job["runtime"]["language"]
        self.python = python
        self.baseline_threads = threading.active_count()
        self.files = {posixpath.normpath(f["path"]): f for f in job["files"]}
        self.pid1 = os.getpid() == 1

    # -- command table (design section 4.1) ------------------------------------------

    def command(self, kind, file, args):
        harness = HARNESS_DIR
        if self.language == "python":
            base = [self.python, "-s", "-P", "-B"]
            if kind == "call":
                return base + [os.path.join(harness, "driver.py")]
            return base + [os.path.join(harness, "launch.py"), file] + list(args)
        if kind == "call":
            return ["Rscript", "--vanilla", os.path.join(harness, "driver.R")]
        return ["Rscript", "--vanilla", file] + list(args)

    def compile_command(self, files):
        if self.language == "python":
            return [self.python, "-s", "-P", "-B", "-c", PY_COMPILE_SCRIPT] + files
        return ["Rscript", "--vanilla", "-e", R_COMPILE_SCRIPT] + files

    def interpreter_version(self):
        if self.language == "python":
            argv = [self.python, "--version"]
        else:
            argv = ["Rscript", "-e", 'cat(R.version$major, R.version$minor, sep=".")']
        try:
            done = subprocess.run(
                argv, env=child_env(self.tmp_dir, self.language), cwd=self.tmp_dir,
                capture_output=True, timeout=10, stdin=subprocess.DEVNULL,
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            return "unknown"
        text = (done.stdout or done.stderr).decode("utf-8", "replace").strip()
        if text.startswith("Python "):
            text = text[len("Python ") :]
        return text[:64] or "unknown"

    # -- running one subprocess (design section 4.3) ----------------------------------

    def oom_kills(self):
        return read_oom_kills()

    def execute(self, name, files, argv, stdin_bytes, cap, budget, outcome_path=None, home_files=()):
        """Materialise `files` (and `home_files`, given as (path, bytes), into the check's private
        directory), run `argv` capped at `cap` seconds, clean up. Returns Exec."""
        cwd = os.path.join(self.work_dir, name)
        home = os.path.join(self.tmp_dir, name)
        res = Exec()
        started = self.clock()
        readers, killer = [], None
        proc = None
        for directory in (cwd, home):
            try:
                os.mkdir(directory)
            except FileExistsError as error:
                raise InternalFault("%s already exists" % directory) from error
            except OSError as error:
                res.spawn_error = "Could not prepare the check: %s" % (error.strerror or error)
                break
        if res.spawn_error is None:
            try:
                for path, content in files:
                    target = os.path.join(cwd, path)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(target, "wb") as handle:
                        handle.write(content)
                stdin_path = os.path.join(home, "stdin")
                with open(stdin_path, "wb") as handle:
                    handle.write(stdin_bytes)
                for path, content in home_files:
                    with open(path, "wb") as handle:
                        handle.write(content)
            except OSError as error:
                res.spawn_error = "Could not prepare the check: %s" % (error.strerror or error)
        if res.spawn_error is None:
            proc, readers, killer = self.spawn_and_wait(res, cwd, home, argv, stdin_path, cap, budget)
        res.duration_ms = int((self.clock() - started) * 1000)
        # End of check, in the fixed order: timer cancelled, kill and reap, readers joined,
        # then the sweep.
        if killer is not None:
            killer.cancel()
        self.kill_all(proc.pid if proc is not None else None)
        self.reap_all()
        for thread in readers + ([killer] if killer is not None else []):
            thread.join(JOIN_TIMEOUT_SECONDS)
            if thread.is_alive():
                raise InternalFault("a helper thread did not end")
        if killer is not None:
            res.fired = killer.fired
        if readers:
            res.stdout, res.stderr = readers[0].text, readers[1].text
            res.stdout_over = readers[0].over
            res.stdout_whole = "".join(readers[0].whole_parts)
            res.truncated = readers[0].truncated or readers[1].truncated
        if outcome_path is not None and res.spawn_error is None:
            res.outcome = self.read_outcome(outcome_path)
        self.sweep()
        if threading.active_count() != self.baseline_threads:
            raise InternalFault("a thread outlived its check")
        if proc is not None and proc.returncode is None:
            raise InternalFault("the direct child's returncode was not set")
        return res

    def spawn_and_wait(self, res, cwd, home, argv, stdin_path, cap, budget):
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        readers = [Reader(out_r, budget, whole=True), Reader(err_r, budget)]
        killer = Killer(cap, self.clock)
        for thread in readers + [killer]:
            thread.start()
        if threading.active_count() != self.baseline_threads + 3:
            raise InternalFault("reader threads and timer are not all running before the spawn")
        stdin_fd = os.open(stdin_path, os.O_RDONLY)
        oom_before = self.oom_kills()
        proc = None
        try:
            try:
                proc = subprocess.Popen(
                    argv, cwd=cwd, env=child_env(home, self.language), stdin=stdin_fd,
                    stdout=out_w, stderr=err_w, start_new_session=True, close_fds=True,
                )
            except (OSError, ValueError) as error:
                reason = getattr(error, "strerror", None) or str(error)
                res.spawn_error = "Could not start the program: %s" % reason
                killer.cancel()
        finally:
            os.close(stdin_fd)
            os.close(out_w)
            os.close(err_w)
        if proc is not None:
            killer.arm(proc.pid)  # start_new_session: the group id is the pid
            if threading.active_count() > self.baseline_threads + 3:
                raise InternalFault("a thread started after the spawn")
            self.wait_child(proc)
            res.returncode = proc.returncode
            res.oom = self.oom_kills() > oom_before
        return proc, readers, killer

    @staticmethod
    def wait_child(proc):
        """Wait with waitpid(-1), reaping orphans as they die; set proc.returncode from it."""
        while True:
            try:
                pid, status = os.waitpid(-1, 0)
            except ChildProcessError as error:
                raise InternalFault("the direct child vanished") from error
            if pid == proc.pid:
                proc.returncode = os.waitstatus_to_exitcode(status)
                return

    def kill_all(self, pgid):
        if pgid is not None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
        if self.pid1:
            try:
                os.kill(-1, signal.SIGKILL)
            except OSError:
                pass
            return
        me = os.getpid()
        for _ in range(1000):
            victims = live_descendants(me)
            if not victims:
                return
            for pid in victims:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            self.reap_nowait()
            time.sleep(0.001)
        raise InternalFault("descendants survive SIGKILL")

    @staticmethod
    def reap_nowait():
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return

    @staticmethod
    def reap_all():
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                return

    @staticmethod
    def read_outcome(path):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > OUTCOME_MAX_BYTES:
                return None
            data = os.read(fd, OUTCOME_MAX_BYTES + 1) if info.st_size else b""
        except OSError:
            return None
        finally:
            os.close(fd)
        try:
            value = scrub_text(json.loads(data.decode("utf-8")))
        except (ValueError, RecursionError):
            return None
        return value if isinstance(value, dict) else None

    def sweep(self):
        for root in [self.work_dir, self.tmp_dir] + self.ipc_dirs:
            if not os.path.isdir(root):
                continue
            try:
                clear_directory(root)
            except OSError as error:
                raise InternalFault("sweep of %s failed: %s" % (root, error)) from error

    # -- phases -----------------------------------------------------------------------

    def visible_files(self, check):
        selected = {}
        for path, file in self.files.items():
            if not file.get("hidden", False):
                selected[path] = file
        if check is not None and check["visibility"] == "hidden":
            for path in [check["file"]] + list(check.get("files", [])):
                selected[posixpath.normpath(path)] = self.files[posixpath.normpath(path)]
        return [(path, file_bytes(file)) for path, file in sorted(selected.items())]

    def compile_phase(self, remaining):
        suffixes = (".py",) if self.language == "python" else (".r", ".R")
        targets = sorted(p for p, f in self.files.items() if not f.get("hidden", False) and p.endswith(suffixes))
        if not targets:
            return None
        cap = min(COMPILE_CAP_SECONDS, max(remaining, 0.001))
        res = self.execute("compile", self.visible_files(None), self.compile_command(targets), b"", cap, OutputBudget(COMPILE_OUTPUT_BYTES))
        if res.spawn_error is not None or res.fired or res.returncode != 1:
            return None
        parts = res.stdout.split("\n", 2)
        if len(parts) != 3 or parts[0] not in targets:
            return None
        error = {"file": parts[0], "message": cut_encoded(parts[2].strip() or "Syntax error", 2048)}
        if parts[1].isdigit() and int(parts[1]) >= 1:
            error["line"] = int(parts[1])
        return error

    @staticmethod
    def call_spec(check, outcome_path):
        """What the driver is told (stdin line for Python, call.json for R): never `expected` or `compare` (design section 4.5)."""
        return {
            "file": posixpath.normpath(check["file"]),
            "function": check["function"],
            "args": check.get("args", []),
            "kwargs": check.get("kwargs", {}),
            "outcomePath": outcome_path,
        }

    def run_check(self, index, check, budget, remaining):
        name = "c%d" % (index + 1)
        home = os.path.join(self.tmp_dir, name)
        kind = check["kind"]
        timeout = check.get("timeoutSeconds")
        cap = min(timeout if timeout is not None else remaining, remaining)
        stdin_text = check.get("stdin", "")
        outcome_path = None
        home_files = ()
        if kind == "call":
            outcome_path = os.path.join(home, "outcome.json")
            spec = self.call_spec(check, outcome_path)
            if self.language == "r":
                # R connections buffer, so a spec line read from stdin would swallow part of the
                # student's input: driver.R takes the spec from a file and stdin stays whole.
                spec_path = os.path.join(home, "call.json")
                home_files = ((spec_path, json.dumps(spec).encode("utf-8")),)
                stdin_bytes = stdin_text.encode("utf-8")
                argv = self.command("call", None, []) + [spec_path]
            else:
                stdin_bytes = (json.dumps(spec) + "\n" + stdin_text).encode("utf-8")
                argv = self.command("call", None, [])
        else:
            stdin_bytes = stdin_text.encode("utf-8")
            argv = self.command(kind, posixpath.normpath(check["file"]), check.get("args", []))
        res = self.execute(name, self.visible_files(check), argv, stdin_bytes, cap, budget, outcome_path, home_files)
        return self.judge(check, res, self.job["limits"]["memoryMiB"], cap)

    # -- verdicts (design sections 3.1 and 3.2) -----------------------------------------

    def judge(self, check, res, memory_mib, cap):
        entry = {
            "name": check["name"],
            "durationMs": res.duration_ms,
            "stdout": res.stdout,
            "stderr": res.stderr,
            "truncated": res.truncated,
        }

        def done(status, error_kind=None, **fields):
            entry["status"] = status
            if error_kind is not None:
                entry["errorKind"] = error_kind
            for key in ("expected", "actual"):
                if key in fields:
                    entry[key] = cut_encoded(fields[key], EXPECTED_MAX if key == "expected" else ACTUAL_MAX)
            if "message" in fields:
                entry["message"] = cut_encoded(one_line(fields["message"]), MESSAGE_MAX)
            return entry

        if res.spawn_error is not None:
            return done("error", "spawn", message=res.spawn_error)
        code = res.returncode
        if code >= 0:
            entry["exitCode"] = code
        else:
            entry["signal"] = -code
        if res.fired and code == -signal.SIGKILL:
            return done("timeout", message="Timed out after %s s" % ("%g" % round(cap, 3)))
        if code == -signal.SIGKILL and res.oom:
            return done("error", "memory", message="Killed: memory limit of %d MiB exceeded" % memory_mib)
        if code < 0:
            return done("error", "signal", message="Killed by signal %d" % -code)

        kind = check["kind"]
        compare = check.get("compare", {"mode": "exact"})
        mode = compare.get("mode", "exact")
        abs_tol = compare.get("abs", 1e-6)
        rel_tol = compare.get("rel", 1e-9)
        if kind == "script":
            if code == 0:
                return done("passed")
            lines = [line for line in res.stderr.splitlines() if line.strip()]
            return done("failed", message=lines[-1].strip() if lines else "Exited with code %d" % code)
        if kind == "stdio":
            expected = check["expected"]
            want_code = expected.get("exitCode", 0)
            if code != want_code:
                return done("error", "exit", message="Exited with code %d" % code)
            if res.stdout_over:
                return done("failed", expected=expected["stdout"], actual=res.stdout,
                            message="Output exceeds the output limit of the question")
            ok, message = compare_text(mode, expected["stdout"], res.stdout_whole, abs_tol, rel_tol)
            if ok:
                return done("passed", expected=expected["stdout"], actual=res.stdout_whole)
            return done("failed", expected=expected["stdout"], actual=res.stdout_whole, message=message)
        return self.judge_call(check, res, mode, abs_tol, rel_tol, done)

    @staticmethod
    def judge_call(check, res, mode, abs_tol, rel_tol, done):
        outcome = res.outcome
        expected = check["expected"]
        if not (isinstance(outcome, dict) and isinstance(outcome.get("ok"), bool)):
            if res.returncode != 0:
                return done("error", "exit", message="Exited with code %d" % res.returncode)
            return done("error", "exit", message="The program ended before the call returned")

        if outcome["ok"]:
            actual_repr = outcome.get("repr") if isinstance(outcome.get("repr"), str) else "<unrepresentable>"
            jsonable = outcome.get("jsonable") is True
            actual_text = show(outcome.get("value")) if jsonable else actual_repr
            if "raises" in expected:
                return done("failed", expected=expected["raises"]["type"], actual="returned " + actual_repr,
                            message="Expected %s, but the call returned %s" % (expected["raises"]["type"], actual_repr))
            want = expected["value"]
            if mode == "repr":
                matches = want == actual_repr
                expected_text = want
                actual_text = actual_repr
            else:
                expected_text = show(want)
                if jsonable:
                    matches = values_equal(want, outcome.get("value"), mode == "numeric", abs_tol, rel_tol)
                else:
                    matches = isinstance(want, str) and want == actual_repr
            if matches:
                return done("passed", expected=expected_text, actual=actual_text)
            return done("failed", expected=expected_text, actual=actual_text,
                        message="Expected %s, received %s" % (expected_text, actual_text))

        error = outcome.get("exception")
        if not isinstance(error, dict) or not isinstance(error.get("type"), str):
            return done("error", "harness", message="The driver reported an unreadable exception")
        message = error.get("message") if isinstance(error.get("message"), str) else ""
        bases = [b for b in error.get("bases", []) if isinstance(b, str)] if isinstance(error.get("bases"), list) else []
        described = "%s: %s" % (error["type"], message) if message else error["type"]
        if "value" in expected:
            return done("error", "exception", expected=show(expected["value"]) if mode != "repr" else expected["value"],
                        actual=described, message=described)
        raises = expected["raises"]
        if raises["type"] in [error["type"]] + bases:
            pattern = raises.get("message")
            if pattern:
                try:
                    found = re.search(pattern, message) is not None
                except re.error:
                    return done("error", "harness", message="expected.raises.message is not a valid pattern")
                if not found:
                    return done("failed", expected="%s matching %s" % (raises["type"], pattern), actual=described,
                                message="Expected %s matching %s, but the call raised %s" % (raises["type"], pattern, described))
            return done("passed", expected=raises["type"], actual=described)
        return done("failed", expected=raises["type"], actual=described,
                    message="Expected %s, but the call raised %s" % (raises["type"], described))

    # -- the whole job ----------------------------------------------------------------

    def run(self):
        started = self.clock()
        limits = self.job["limits"]
        wall = limits["wallSeconds"]
        version = self.interpreter_version()
        compile_error = self.compile_phase(wall - (self.clock() - started))
        budget = OutputBudget(limits["outputBytes"])
        entries = []
        for index, check in enumerate(self.job["checks"]):
            remaining = wall - (self.clock() - started)
            if compile_error is not None:
                skipped = "Not run: %s does not compile" % compile_error["file"]
            elif remaining <= 0:
                skipped = "Not run: time budget spent"
            else:
                skipped = None
            if skipped is not None:
                entries.append({
                    "name": check["name"], "status": "skipped", "durationMs": 0,
                    "message": skipped, "stdout": "", "stderr": "", "truncated": False,
                })
                continue
            entries.append(self.run_check(index, check, budget, remaining))
        result = {
            "v": 1,
            "harnessVersion": HARNESS_VERSION,
            "runtime": {"language": self.language, "version": version},
        }
        if compile_error is not None:
            result["compileError"] = compile_error
        result["checks"] = entries
        result["truncated"] = any(entry["truncated"] for entry in entries)
        result["durationMs"] = int((self.clock() - started) * 1000)
        return result


def run(job, work_dir, tmp_dir, clock, ipc_dirs, python="python3"):
    """Run every check of a validated job and return the result document."""
    return Harness(job, work_dir, tmp_dir, clock, ipc_dirs, python).run()


# --------------------------------------------------------------------------------------
# Process level: only ever executed in the harness process itself (design section 4.2).
# --------------------------------------------------------------------------------------


def frame(nonce, result):
    body = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    return ("\n--parallax-result %s\n%s\n--parallax-end %s\n" % (nonce, body, nonce)).encode("utf-8")


def prctl(option, value):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(option, value, 0, 0, 0) != 0:
        raise InternalFault("prctl(%d) failed: errno %d" % (option, ctypes.get_errno()))


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="run.py", add_help=False)
    parser.add_argument("--work", default=DEFAULT_WORK)
    parser.add_argument("--tmp", default=DEFAULT_TMP)
    parser.add_argument("--ipc", action="append", default=None)
    parser.add_argument("--python", default="python3")
    args = parser.parse_args(argv)
    if args.ipc is None:  # an explicit --ipc replaces the default list
        args.ipc = list(DEFAULT_IPC)
    return args


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit:
        return EXIT_BAD_INPUT
    try:
        nonce, job = parse_input(read_stdin())
    except InputError as error:
        sys.stderr.write("harness: bad input: %s\n" % error)
        return EXIT_BAD_INPUT
    try:
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        prctl(PR_SET_DUMPABLE, 0)
        prctl(PR_SET_CHILD_SUBREAPER, 1)
        signal.signal(signal.SIGINT, lambda signum, frame_: None)
        result = run(job, args.work, args.tmp, time.monotonic, args.ipc, args.python)
        output = frame(nonce, result)
        stream = sys.stdout.buffer
        stream.write(output)
        stream.flush()
    except Exception as error:  # an internal fault: the runner sees a non-zero exit
        sys.stderr.write("harness: internal fault: %s: %s\n" % (type(error).__name__, error))
        return EXIT_INTERNAL
    return 0


if __name__ == "__main__":
    sys.exit(main())
