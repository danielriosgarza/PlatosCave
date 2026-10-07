"""Tests of the runner harness (docs/design/runner.md section 12, item P3-14).

The harness is exercised as a subprocess with temporary roots, the nonce and the job on its
stdin and the frame read from its stdout, so prctl, the signal handler, the wait loop and the
end-of-check kill act on the harness process and never on this one. Only pure helpers are
called in-process. Run with `python3 -m unittest discover -s runner/harness`.
"""

import base64
import json
import os
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run  # noqa: E402

PROTOCOL = os.path.abspath(os.path.join(HERE, "..", "protocol", "v1"))
NONCE = "0123456789abcdef0123456789abcdef"
IN_IMAGE = os.environ.get("PARALLAX_IMAGE") == "1"
HAS_R = shutil.which("Rscript") is not None
# Optional command that runs the harness as pid 1 of its own namespace, for example
# PARALLAX_HARNESS_PREFIX="unshare --pid --fork --mount-proc" (needs privileges).
HARNESS_PREFIX = shlex.split(os.environ.get("PARALLAX_HARNESS_PREFIX", ""))


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------


def make_job(files, checks, set_="full", wall=20, memory=512, output=1048576):
    entries = []
    for path, spec in files.items():
        content, hidden = spec if isinstance(spec, tuple) else (spec, False)
        entry = {"path": path, "content": content}
        if hidden:
            entry["hidden"] = True
        entries.append(entry)
    return {
        "v": 1,
        "jobId": "6f1d2c3a-4b5e-4f60-9a71-82b3c4d5e6f7",
        "runtime": {"id": "python-3.12", "language": "python"},
        "set": set_,
        "limits": {"wallSeconds": wall, "memoryMiB": memory, "outputBytes": output},
        "files": entries,
        "checks": checks,
    }


def script(name, file, hidden=False, **extra):
    check = {"name": name, "kind": "script", "visibility": "hidden" if hidden else "public", "file": file}
    check.update(extra)
    return check


def stdio(name, file, expected, mode="exact", hidden=False, **extra):
    check = {
        "name": name, "kind": "stdio", "visibility": "hidden" if hidden else "public", "file": file,
        "expected": {"stdout": expected}, "compare": {"mode": mode},
    }
    check.update(extra)
    return check


def call(name, function, expected, mode="exact", file="solution.py", args=None, hidden=False, **extra):
    check = {
        "name": name, "kind": "call", "visibility": "hidden" if hidden else "public", "file": file,
        "function": function, "expected": expected, "compare": {"mode": mode},
    }
    if args is not None:
        check["args"] = args
    check.update(extra)
    return check


class Outcome:
    def __init__(self, completed, roots):
        self.returncode = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr.decode("utf-8", "replace")
        self.roots = roots
        self.result = None
        if completed.returncode == 0:
            self.result = parse_frame(completed.stdout, NONCE)

    def check(self, index=0):
        return self.result["checks"][index]


def parse_frame(stdout, nonce):
    head = ("\n--parallax-result %s\n" % nonce).encode()
    tail = ("\n--parallax-end %s\n" % nonce).encode()
    assert stdout.startswith(head), stdout[:200]
    assert stdout.endswith(tail), stdout[-200:]
    body = stdout[len(head) : -len(tail)]
    assert b"\n" not in body, "the result is one line"
    return json.loads(body.decode("utf-8"))


# Starts the harness under a lower RLIMIT_NOFILE, as the container's Ulimits do.
NOFILE_WRAPPER = (
    "import resource, runpy, sys\n"
    "limit = int(sys.argv[1])\n"
    "resource.setrlimit(resource.RLIMIT_NOFILE, (limit, limit))\n"
    "sys.argv = sys.argv[2:]\n"
    "runpy.run_path(sys.argv[0], run_name='__main__')\n"
)


def run_harness(job, raw=None, args=(), timeout=180, roots=None, prepare=None, nofile=None):
    """Spawn run.py with temporary roots. `raw` replaces the whole stdin stream."""
    with tempfile.TemporaryDirectory() as base:
        work, tmp, ipc = (os.path.join(base, name) for name in ("work", "tmp", "ipc"))
        for directory in (work, tmp, ipc):
            os.mkdir(directory)
        paths = {"work": work, "tmp": tmp, "ipc": ipc}
        if prepare is not None:
            prepare(paths)
        if raw is None:
            raw = (NONCE + "\n" + json.dumps(job)).encode("utf-8")
        launcher = [sys.executable] if nofile is None else [sys.executable, "-c", NOFILE_WRAPPER, str(nofile)]
        completed = subprocess.run(
            [*HARNESS_PREFIX, *launcher, os.path.join(HERE, "run.py"), "--work", work, "--tmp", tmp, "--ipc", ipc, *args],
            input=raw, capture_output=True, timeout=timeout,
        )
        return Outcome(completed, paths)


def processes_with(token):
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit() and int(entry) != os.getpid():
            try:
                with open("/proc/%s/cmdline" % entry, "rb") as handle:
                    if token.encode() in handle.read():
                        found.append(int(entry))
            except OSError:
                pass
    return found


def kill_all(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


# The constraints of result.schema.json, encoded here so every produced result is checked.
CHECK_FIELDS = {
    "name", "status", "errorKind", "durationMs", "expected", "actual", "message", "exitCode",
    "signal", "stdout", "stderr", "truncated",
}


def assert_result_shape(test, result):
    test.assertEqual(
        set(result) - {"compileError"}, {"v", "harnessVersion", "runtime", "checks", "truncated", "durationMs"}
    )
    test.assertEqual(result["v"], 1)
    test.assertRegex(result["harnessVersion"], r"^[0-9]+$")
    test.assertEqual(set(result["runtime"]), {"language", "version"})
    test.assertIn(result["runtime"]["language"], ("python", "r"))
    test.assertLessEqual(len(result["runtime"]["version"]), 64)
    test.assertTrue(1 <= len(result["checks"]) <= 50)
    test.assertIsInstance(result["truncated"], bool)
    test.assertIsInstance(result["durationMs"], int)
    test.assertGreaterEqual(result["durationMs"], 0)
    if "compileError" in result:
        error = result["compileError"]
        test.assertTrue({"file", "message"} <= set(error) <= {"file", "line", "message"})
        test.assertLessEqual(len(error["file"]), 200)
        test.assertLessEqual(len(error["message"]), 2048)
        if "line" in error:
            test.assertGreaterEqual(error["line"], 1)
    for entry in result["checks"]:
        test.assertTrue(set(entry) <= CHECK_FIELDS, set(entry) - CHECK_FIELDS)
        test.assertTrue({"name", "status", "durationMs", "stdout", "stderr", "truncated"} <= set(entry))
        test.assertRegex(entry["name"], r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
        test.assertIn(entry["status"], ("passed", "failed", "error", "timeout", "skipped"))
        if entry["status"] == "error":
            test.assertIn(entry["errorKind"], ("exception", "exit", "signal", "memory", "spawn", "harness"))
        else:
            test.assertNotIn("errorKind", entry)
        test.assertLessEqual(len(entry.get("expected", "")), 2048)
        test.assertLessEqual(len(entry.get("actual", "")), 2048)
        test.assertLessEqual(len(entry.get("message", "")), 512)
        if "exitCode" in entry:
            test.assertTrue(0 <= entry["exitCode"] <= 255)
        if "signal" in entry:
            test.assertTrue(1 <= entry["signal"] <= 64)
        test.assertIsInstance(entry["truncated"], bool)
        test.assertLessEqual(len(entry["stdout"]), 4 * 1024 * 1024)


class HarnessCase(unittest.TestCase):
    def go(self, job, **kwargs):
        outcome = run_harness(job, **kwargs)
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        assert_result_shape(self, outcome.result)
        return outcome


# --------------------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------------------


class PureHelpers(unittest.TestCase):
    def test_encoded_size_cuts(self):
        quotes = '"' * 3000  # each quote encodes as two bytes
        cut = run.cut_encoded(quotes, 2048)
        self.assertLessEqual(run.encoded_len(cut), 2048)
        self.assertTrue(cut.endswith(run.ELLIPSIS))
        self.assertGreater(len(cut), 1000)
        accents = "\u00e9" * 3000  # two bytes in UTF-8
        cut = run.cut_encoded(accents, 512)
        self.assertLessEqual(run.encoded_len(cut), 512)
        self.assertLessEqual(len(json.dumps(cut, ensure_ascii=False).encode()) - 2, 512)
        self.assertEqual(run.cut_encoded("short", 512), "short")
        self.assertEqual(run.cut_encoded("a" * 2048, 2048), "a" * 2048)

    def test_output_budget_counts_encoded_size(self):
        budget = run.OutputBudget(10)
        self.assertEqual(budget.take("abc"), ("abc", False))
        kept, cut = budget.take('"' * 10)  # 7 bytes left: three quotes (6 bytes)
        self.assertEqual((kept, cut), ('"' * 3, True))
        self.assertEqual(budget.take("x"), ("", True))
        self.assertEqual(budget.take(""), ("", False))

    def test_compare_text_modes(self):
        cases = [
            ("exact", "a\nb\n", "a\nb\n", True),
            ("exact", "a\nb\n", "a\nb", False),
            ("exact", "a  \n", "a\n", False),
            ("trimmed", "a  \nb\n\n\n", "a\nb", True),
            ("trimmed", "a b\n", "a  b\n", False),
            ("tokens", "1  2\n3", "1 2 3\n", True),
            ("tokens", "1 2 3", "1 2 4", False),
            ("numeric", "1.0 x 2", "1.0000000001 x 2", True),
            ("numeric", "1.0 x 2", "1.1 x 2", False),
            ("numeric", "1.0 x 2", "1.0 y 2", False),
            ("numeric", "1 2", "1 2 3", False),
        ]
        for mode, expected, actual, matches in cases:
            with self.subTest(mode=mode, expected=expected, actual=actual):
                self.assertEqual(run.compare_text(mode, expected, actual)[0], matches)
        self.assertEqual(run.compare_text("exact", "a\nb\nc\n", "a\nX\nc\n")[1], "Line 2 differs")
        self.assertEqual(run.compare_text("tokens", "a b c", "a b d")[1], "Token 3 differs")

    def test_numeric_tolerance(self):
        self.assertTrue(run.compare_text("numeric", "1.29", "1.2900005", abs_tol=1e-6, rel_tol=0)[0])
        self.assertFalse(run.compare_text("numeric", "1.29", "1.2900011", abs_tol=1e-6, rel_tol=0)[0])
        self.assertTrue(run.compare_text("numeric", "1000", "1001", abs_tol=0, rel_tol=0.01)[0])

    def test_values_equal(self):
        self.assertTrue(run.values_equal(1, 1.0))
        self.assertTrue(run.values_equal([1, [2]], [1.0, [2.0]]))
        self.assertFalse(run.values_equal(True, 1))
        self.assertFalse(run.values_equal([1], [1, 2]))
        self.assertFalse(run.values_equal({"a": 1}, {"b": 1}))
        self.assertTrue(run.values_equal({"a": 1.5}, {"a": 1.5}))
        self.assertFalse(run.values_equal(1.29, 1.2900001))
        self.assertTrue(run.values_equal(1.29, 1.2900001, numeric=True, abs_tol=1e-6))
        self.assertTrue(run.values_equal("NaN", "NaN", numeric=True))
        self.assertFalse(run.values_equal("1", 1))

    def test_environment_table(self):
        env = run.child_env("/tmp/c1", "python")
        self.assertEqual(
            set(env),
            {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PARALLAX_JOB", "PYTHONHASHSEED",
             "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
             "MKL_NUM_THREADS"},
        )
        self.assertEqual(env["PATH"], "/usr/local/bin:/usr/bin:/bin")
        self.assertEqual(env["HOME"], "/tmp/c1")
        self.assertEqual(env["TMPDIR"], "/tmp/c1")
        self.assertEqual(env["PYTHONHASHSEED"], "0")
        self.assertEqual(run.child_env("/tmp/c1", "r")["R_LIBS_USER"], "/tmp/none")
        self.assertNotIn("R_LIBS_USER", env)

    def test_python_command_table_never_uses_isolated_mode(self):
        harness = run.Harness(make_job({"a.py": ""}, [script("A", "a.py")]), "/w", "/t", time.monotonic, [])
        for kind in ("stdio", "script", "call"):
            argv = harness.command(kind, "a.py", [])
            self.assertEqual(argv[1:4], ["-s", "-P", "-B"])
            self.assertNotIn("-I", argv)
            self.assertNotIn("-E", argv)

    def test_oom_counter_parsing(self):
        self.assertEqual(run.parse_oom_kill("low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\n"), 1)
        self.assertIsNone(run.parse_oom_kill("oom_kill\n"))
        self.assertIsNone(run.parse_oom_kill(""))

    def test_ipc_default_and_replacement(self):
        self.assertEqual(run.parse_args([]).ipc, ["/dev/shm", "/dev/mqueue"])
        self.assertEqual(run.parse_args([]).work, "/work")
        self.assertEqual(run.parse_args([]).tmp, "/tmp")
        self.assertEqual(run.parse_args(["--ipc", "/x"]).ipc, ["/x"])
        self.assertEqual(run.parse_args(["--ipc", "/x", "--ipc", "/y"]).ipc, ["/x", "/y"])

    def test_sweep_removes_trees_no_path_can_name(self):
        with tempfile.TemporaryDirectory() as root:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            for _ in range(1500):  # deeper than the recursion limit
                os.mkdir("d", dir_fd=fd)
                nxt = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = nxt
            os.close(fd)
            locked = os.path.join(root, "locked")
            os.mkdir(locked)
            with open(os.path.join(locked, "f"), "w"):
                pass
            os.chmod(locked, 0)
            os.symlink("/nonexistent", os.path.join(root, "link"))
            os.mkfifo(os.path.join(root, "fifo"))
            run.clear_directory(root)
            self.assertEqual(os.listdir(root), [])

    def test_call_spec_carries_no_expected_value(self):
        job = make_job({"solution.py": "def f(x): return x\n"}, [call("A", "f", {"value": 1}, args=[1])])
        harness = run.Harness(job, "/w", "/t", time.monotonic, [])
        spec = harness.call_spec(job["checks"][0], "/t/c1/outcome.json")
        self.assertEqual(set(spec), {"file", "function", "args", "kwargs", "outcomePath"})
        self.assertNotIn("expected", json.dumps(spec))
        self.assertNotIn("compare", json.dumps(spec))


class TimerThread(unittest.TestCase):
    def spawn_sleeper(self):
        return subprocess.Popen(["sleep", "30"], start_new_session=True)

    def test_the_timer_receives_the_pid_after_the_spawn_and_kills_at_once_when_its_deadline_has_passed(self):
        killer = run.Killer(0.0, time.monotonic)  # the deadline is already over when the pid arrives
        killer.start()
        time.sleep(0.05)
        self.assertFalse(killer.fired, "nothing is killed before a pid exists")
        proc = self.spawn_sleeper()
        started = time.monotonic()
        killer.arm(proc.pid)
        proc.wait(timeout=5)
        killer.join(5)
        self.assertLess(time.monotonic() - started, 2)
        self.assertTrue(killer.fired)
        self.assertEqual(proc.returncode, -signal.SIGKILL)

    def test_a_cancelled_timer_kills_nothing_and_ends(self):
        killer = run.Killer(0.2, time.monotonic)
        killer.start()
        killer.cancel()  # cancelled while it still waits for a pid
        killer.join(5)
        self.assertFalse(killer.is_alive())
        self.assertFalse(killer.fired)
        proc = self.spawn_sleeper()
        try:
            time.sleep(0.4)
            self.assertIsNone(proc.poll())
        finally:
            proc.kill()
            proc.wait()

    def test_the_timer_waits_for_its_deadline(self):
        killer = run.Killer(0.5, time.monotonic)
        killer.start()
        proc = self.spawn_sleeper()
        started = time.monotonic()
        killer.arm(proc.pid)
        proc.wait(timeout=10)
        self.assertGreaterEqual(time.monotonic() - started, 0.4)
        killer.join(5)


# --------------------------------------------------------------------------------------
# Input handling
# --------------------------------------------------------------------------------------


class Input(HarnessCase):
    def simple_job(self):
        return make_job({"a.py": "print('hi')\n"}, [stdio("Hi", "a.py", "hi\n")])

    def test_nonce_and_job_are_read_from_stdin_and_the_nonce_frames_the_result(self):
        outcome = self.go(self.simple_job())
        self.assertEqual(outcome.check()["status"], "passed")

    def test_missing_nonce_exits_64_without_output(self):
        outcome = run_harness(None, raw=json.dumps(self.simple_job()).encode())
        self.assertEqual(outcome.returncode, 64)
        self.assertEqual(outcome.stdout, b"")

    def test_malformed_nonces_exit_64(self):
        body = json.dumps(self.simple_job())
        for nonce in ("0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "g" * 32, "0" * 33, ""):
            with self.subTest(nonce=nonce):
                outcome = run_harness(None, raw=(nonce + "\n" + body).encode())
                self.assertEqual(outcome.returncode, 64)
                self.assertEqual(outcome.stdout, b"")

    def test_job_that_is_not_json_exits_64(self):
        for body in ("not json", "[]", '{"v": 2}', "", '{"v": 1, "limits": {"wallSeconds": NaN}}'):
            with self.subTest(body=body):
                self.assertEqual(run_harness(None, raw=(NONCE + "\n" + body).encode()).returncode, 64)

    def maximal_job_bytes(self, extra=0):
        """A job whose serialisation is exactly 4 MiB (plus `extra` bytes of trailing space)."""
        job = make_job({"a.py": "print('x')\n", "pad.txt": ""}, [stdio("X", "a.py", "x\n")])
        overhead = len(json.dumps(job, separators=(",", ":")).encode())
        room = 4 * 1024 * 1024 - overhead
        newlines = room // 2 - 10  # two bytes each once escaped, decoded size stays under 2 MiB
        job["files"][1]["content"] = "\n" * newlines + "x" * (room - 2 * newlines)
        body = json.dumps(job, separators=(",", ":")).encode()
        self.assertEqual(len(body), 4 * 1024 * 1024)
        decoded = sum(len(f["content"].encode()) for f in job["files"])
        self.assertLessEqual(decoded, 2 * 1024 * 1024)
        return body + b" " * extra

    def test_a_maximal_four_mebibyte_job_is_accepted(self):
        raw = (NONCE + "\n").encode() + self.maximal_job_bytes()
        self.assertEqual(len(raw), 4 * 1024 * 1024 + 33)
        outcome = self.go(None, raw=raw)
        self.assertEqual(outcome.check()["status"], "passed")

    def test_a_stream_over_the_cap_exits_64(self):
        raw = (NONCE + "\n").encode() + self.maximal_job_bytes(extra=1)
        outcome = run_harness(None, raw=raw)
        self.assertEqual(outcome.returncode, 64)
        self.assertEqual(outcome.stdout, b"")

    def test_rejected_and_invalid_fixtures_exit_64(self):
        names = []
        for folder in ("rejected", "invalid"):
            directory = os.path.join(PROTOCOL, "examples", folder)
            names += [os.path.join(directory, n) for n in sorted(os.listdir(directory)) if n.startswith("job-")]
        harness_cannot_see = {"job-image-tag-not-pinned.json"}  # the runner resolves images, not the harness
        checked = 0
        for path in names:
            if os.path.basename(path) in harness_cannot_see:
                continue
            checked += 1
            with self.subTest(fixture=os.path.relpath(path, PROTOCOL)):
                with open(path, "rb") as handle:
                    raw = (NONCE + "\n").encode() + handle.read()
                outcome = run_harness(None, raw=raw)
                self.assertEqual(outcome.returncode, 64, outcome.stderr)
                self.assertEqual(outcome.stdout, b"")
        self.assertGreaterEqual(checked, 9)

    def test_valid_examples_run(self):
        for name in ("job-sample-python.json", "job-full-python-replay.json"):
            with self.subTest(example=name):
                with open(os.path.join(PROTOCOL, "examples", name)) as handle:
                    job = json.load(handle)
                outcome = self.go(job)
                self.assertEqual([c["name"] for c in outcome.result["checks"]], [c["name"] for c in job["checks"]])

    def test_semantic_rules_each_exit_64(self):
        base = lambda: make_job(  # noqa: E731
            {"solution.py": "x = 1\n", "hidden.py": ("y = 2\n", True)},
            [script("One", "solution.py", hidden=True, files=["hidden.py"])],
        )
        mutations = {
            "duplicate check names": lambda j: j["checks"].append(dict(j["checks"][0])),
            "public set with a hidden check": lambda j: j.update(set="public"),
            "check names a missing file": lambda j: j["checks"][0].update(file="nope.py"),
            "public check names a hidden file": lambda j: j["checks"][0].update(visibility="public"),
            "path is a directory prefix": lambda j: j["files"].append({"path": "solution.py/x", "content": ""}),
            "duplicate paths after normalisation": lambda j: j["files"].append({"path": "a//b", "content": ""}) or j["files"].append({"path": "a/b", "content": ""}),
            "files over 2 MiB": lambda j: j["files"].append({"path": "big.txt", "content": "x" * (2 * 1024 * 1024)}),
            "path traversal": lambda j: j["files"].append({"path": "../x", "content": ""}),
            "bad base64": lambda j: j["files"].append({"path": "b.bin", "content": "!!", "encoding": "base64"}),
        }
        self.assertEqual(run_harness(base()).returncode, 0)
        for name, mutate in mutations.items():
            job = base()
            mutate(job)
            with self.subTest(rule=name):
                self.assertEqual(run_harness(job).returncode, 64)


# --------------------------------------------------------------------------------------
# Compile phase and check kinds
# --------------------------------------------------------------------------------------


class Compile(HarnessCase):
    def test_compile_error_is_reported_and_every_check_is_skipped(self):
        job = make_job(
            {"solution.py": "def f(:\n    pass\n", "ok.py": "x = 1\n", "tests/h.py": ("def broken(:\n", True)},
            [call("One", "f", {"value": 1}), script("Two", "ok.py")],
        )
        outcome = self.go(job)
        error = outcome.result["compileError"]
        self.assertEqual(error["file"], "solution.py")
        self.assertEqual(error["line"], 1)
        self.assertTrue(error["message"])
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["skipped", "skipped"])
        self.assertEqual(outcome.check()["message"], "Not run: solution.py does not compile")

    def test_hidden_files_are_not_parsed_in_the_compile_phase(self):
        job = make_job(
            {"ok.py": "x = 1\n", "h.py": ("def broken(:\n", True)}, [script("A", "ok.py")]
        )
        outcome = self.go(job)
        self.assertNotIn("compileError", outcome.result)
        self.assertEqual(outcome.check()["status"], "passed")

    def test_a_byte_order_mark_or_coding_cookie_is_not_a_compile_error(self):
        latin = "# -*- coding: latin-1 -*-\nprint('caf\u00e9')\n".encode("latin-1")
        job = make_job({"bom.py": "\ufeffprint('hi')\n"}, [stdio("Bom", "bom.py", "hi\n"), stdio("Latin", "latin.py", "caf\u00e9\n")])
        job["files"].append({"path": "latin.py", "content": base64.b64encode(latin).decode(), "encoding": "base64"})
        outcome = self.go(job)
        self.assertNotIn("compileError", outcome.result)
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "passed"])

    def test_a_traceback_shows_no_launcher_or_runpy_frames(self):
        job = make_job({"p.py": "raise RuntimeError('boom')\n"}, [stdio("A", "p.py", "")])
        stderr = self.go(job).check()["stderr"]
        self.assertIn("p.py", stderr)
        self.assertNotIn("runpy", stderr)
        self.assertNotIn("launch.py", stderr)

    def test_runtime_error_is_not_a_compile_error(self):
        job = make_job({"p.py": "raise RuntimeError('boom')\n"}, [stdio("A", "p.py", "")])
        outcome = self.go(job)
        self.assertNotIn("compileError", outcome.result)
        entry = outcome.check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "exit"))
        self.assertIn("RuntimeError: boom", entry["stderr"])
        self.assertNotIn("launch.py", entry["stderr"])

    def test_the_sweep_also_follows_the_compile_phase(self):
        probe = (
            "import os, sys\n"
            "print(sorted(os.listdir(sys.argv[1])), sorted(os.listdir(sys.argv[2])))\n"
        )

        def prepare(paths):
            for root in ("tmp", "ipc"):
                with open(os.path.join(paths[root], "stale"), "w"):
                    pass
            os.mkdir(os.path.join(paths["work"], "c1"))  # the first check directory, pre-created

        job = make_job({"p.py": probe}, [script("A", "p.py")])
        # The program lists the roots it is told about; they are only known to the test, so the
        # check passes them through its arguments after the run created them.
        with tempfile.TemporaryDirectory() as base:
            paths = {name: os.path.join(base, name) for name in ("work", "tmp", "ipc")}
            for directory in paths.values():
                os.mkdir(directory)
            prepare(paths)
            job["checks"][0]["args"] = [paths["tmp"], paths["ipc"]]
            completed = subprocess.run(
                [*HARNESS_PREFIX, sys.executable, os.path.join(HERE, "run.py"), "--work", paths["work"], "--tmp", paths["tmp"], "--ipc", paths["ipc"]],
                input=(NONCE + "\n" + json.dumps(job)).encode(), capture_output=True, timeout=120,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        entry = parse_frame(completed.stdout, NONCE)["checks"][0]
        self.assertEqual(entry["status"], "passed", entry)
        self.assertEqual(entry["stdout"], "['c1'] []\n")


class Stdio(HarnessCase):
    def test_every_compare_mode(self):
        files = {"p.py": "import sys\nsys.stdout.write(sys.argv[1].replace('|', '\\n'))\n"}
        cases = [
            ("exact", "a\nb\n", "a|b|", "passed"),
            ("exact", "a\nb\n", "a|b", "failed"),
            ("trimmed", "a\nb\n", "a  |b|||", "passed"),
            ("tokens", "a b", "a|  b", "passed"),
            ("tokens", "a b", "a|c", "failed"),
            ("numeric", "1.5 x", "1.5000000001|x", "passed"),
            ("numeric", "1.5 x", "1.6|x", "failed"),
        ]
        checks = [
            stdio("C%d" % i, "p.py", expected, mode, args=[arg])
            for i, (mode, expected, arg, _) in enumerate(cases)
        ]
        outcome = self.go(make_job(files, checks))
        for i, (mode, _, _, status) in enumerate(cases):
            with self.subTest(mode=mode, index=i):
                self.assertEqual(outcome.check(i)["status"], status)

    def test_a_failed_comparison_reports_expected_actual_and_message(self):
        job = make_job({"p.py": "print('a')\nprint('x')\n"}, [stdio("A", "p.py", "a\nb\n")])
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "failed")
        self.assertEqual(entry["expected"], "a\nb\n")
        self.assertEqual(entry["actual"], "a\nx\n")
        self.assertEqual(entry["message"], "Line 2 differs")
        self.assertEqual(entry["exitCode"], 0)

    def test_wrong_exit_code_is_error_exit(self):
        job = make_job({"p.py": "import sys\nprint('ok')\nsys.exit(3)\n"}, [stdio("A", "p.py", "ok\n")])
        entry = self.go(job).check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "exit"))
        self.assertEqual(entry["message"], "Exited with code 3")
        self.assertEqual(entry["exitCode"], 3)

    def test_expected_exit_code_is_honoured(self):
        check = stdio("A", "p.py", "ok\n")
        check["expected"]["exitCode"] = 3
        job = make_job({"p.py": "import sys\nprint('ok')\nsys.exit(3)\n"}, [check])
        self.assertEqual(self.go(job).check()["status"], "passed")

    def test_stdin_and_args_reach_the_program(self):
        source = "import sys\nprint(sys.argv[1:], sys.stdin.read())\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "['x', 'y'] hello\n", args=["x", "y"], stdin="hello")])
        self.assertEqual(self.go(job).check()["status"], "passed")

    def test_killed_by_a_signal_is_error_signal(self):
        source = "import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "")])
        entry = self.go(job).check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "signal"))
        self.assertEqual(entry["signal"], signal.SIGTERM)


class Call(HarnessCase):
    SOURCE = (
        "def add(a, b):\n    return a + b\n"
        "def pair():\n    return (1, 2.0)\n"
        "def nothing():\n    return None\n"
        "def boom():\n    raise ValueError('bad input 42')\n"
        "def key():\n    return {}['k']\n"
        "def kw(a, b=2):\n    return a * b\n"
        "def weird():\n    return {1, 2}\n"
        "def nan():\n    return float('nan')\n"
        "def echo():\n    import sys\n    return sys.stdin.read()\n"
        "def noisy():\n    print('to stdout')\n    return 1\n"
        "class K:\n    @staticmethod\n    def m():\n        return 'm'\n"
        "def leave():\n    import os\n    os._exit(0)\n"
    )

    def outcome_for(self, *checks):
        return self.go(make_job({"solution.py": self.SOURCE}, list(checks)))

    def test_value_modes(self):
        outcome = self.outcome_for(
            call("Exact", "add", {"value": 3}, args=[1, 2]),
            call("Exact float vs int", "add", {"value": 3.0}, args=[1, 2]),
            call("Numeric", "add", {"value": 0.3}, "numeric", args=[0.1, 0.2]),
            call("Exact misses float noise", "add", {"value": 0.3}, args=[0.1, 0.2]),
            call("Tuple is a list", "pair", {"value": [1, 2]}),
            call("Repr", "pair", {"value": "(1, 2.0)"}, "repr"),
            call("Repr of a set", "weird", {"value": "{1, 2}"}, "repr"),
            call("Not jsonable exact", "weird", {"value": "{1, 2}"}),
            call("Kwargs", "kw", {"value": 8}, kwargs={"a": 4, "b": 2}),
            call("Dotted", "K.m", {"value": "m"}),
            call("NaN", "nan", {"value": "NaN"}),
            call("Wrong value", "add", {"value": 4}, args=[1, 2]),
        )
        statuses = [c["status"] for c in outcome.result["checks"]]
        self.assertEqual(
            statuses,
            ["passed", "passed", "passed", "failed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "failed"],
        )
        wrong = outcome.check(11)
        self.assertEqual((wrong["expected"], wrong["actual"]), ("4", "3"))
        self.assertEqual(wrong["message"], "Expected 4, received 3")

    def test_raises_is_matched_by_class_base_and_message(self):
        outcome = self.outcome_for(
            call("Exact class", "boom", {"raises": {"type": "ValueError"}}),
            call("Base class", "boom", {"raises": {"type": "Exception"}}),
            call("Message", "boom", {"raises": {"type": "ValueError", "message": r"input \d+"}}),
            call("Wrong message", "boom", {"raises": {"type": "ValueError", "message": "^nope"}}),
            call("Wrong class", "key", {"raises": {"type": "ValueError"}}),
            call("Lookup base", "key", {"raises": {"type": "LookupError"}}),
            call("Not raised", "nothing", {"raises": {"type": "ValueError"}}),
        )
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]],
            ["passed", "passed", "passed", "failed", "failed", "passed", "failed"],
        )
        not_raised = outcome.check(6)
        self.assertEqual(not_raised["message"], "Expected ValueError, but the call returned None")
        self.assertEqual(not_raised["actual"], "returned None")

    def test_an_unexpected_exception_is_error_exception(self):
        entry = self.outcome_for(call("A", "boom", {"value": 1})).check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "exception"))
        self.assertEqual(entry["message"], "ValueError: bad input 42")

    def test_missing_function_is_error_exception(self):
        entry = self.outcome_for(call("A", "missing", {"value": 1})).check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "exception"))
        self.assertIn("AttributeError", entry["message"])

    def test_a_program_that_leaves_before_the_call_returns_is_error_exit(self):
        entry = self.outcome_for(call("A", "leave", {"value": 1})).check()
        self.assertEqual((entry["status"], entry["errorKind"]), ("error", "exit"))

    def test_stdin_reaches_the_function_after_the_specification_line(self):
        entry = self.outcome_for(call("A", "echo", {"value": "hello\nworld"}, stdin="hello\nworld")).check()
        self.assertEqual(entry["status"], "passed", entry)

    def test_stdin_is_readable_below_the_python_buffer(self):
        source = (
            "def via_open():\n    return open(0).read()\n"
            "def via_os_read():\n    import os\n    return os.read(0, 100).decode()\n"
            "def via_sys():\n    import sys\n    return sys.stdin.read()\n"
            "def via_raw():\n    import sys\n    return sys.stdin.buffer.raw.read(100).decode()\n"
            "def via_cat():\n    import subprocess\n"
            "    return subprocess.run(['cat'], capture_output=True, text=True).stdout\n"
        )
        names = ["via_open", "via_os_read", "via_sys", "via_raw", "via_cat"]
        job = make_job(
            {"solution.py": source},
            [call(n, n, {"value": "hello\n"}, stdin="hello\n") for n in names],
        )
        outcome = self.go(job)
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]], ["passed"] * len(names), outcome.result["checks"]
        )

    def test_printing_inside_a_call_is_captured_not_framed(self):
        outcome = self.outcome_for(call("A", "noisy", {"value": 1}))
        self.assertEqual(outcome.check()["stdout"], "to stdout\n")
        self.assertEqual(outcome.check()["status"], "passed")

    def test_an_outcome_with_a_lone_surrogate_is_a_result_not_a_harness_fault(self):
        forged = (
            "import os\n"
            "def f():\n"
            "    path = os.path.join(os.environ['HOME'], 'outcome.json')\n"
            "    with open(path, 'w') as handle:\n"
            "        handle.write('{\"ok\": false, \"exception\": {\"type\": \"E\", \"bases\": [\"\\\\ud800\"],"
            " \"message\": \"\\\\ud800\"}}')\n"
            "    os._exit(0)\n"
        )
        job = make_job(
            {"solution.py": forged},
            [call("Forged", "f", {"value": 1}), call("Forged raises", "f", {"raises": {"type": "E"}})],
        )
        outcome = self.go(job)
        first, second = outcome.check(0), outcome.check(1)
        self.assertEqual((first["status"], first["errorKind"]), ("error", "exception"))
        self.assertEqual(second["status"], "passed")

    def test_a_returned_lone_surrogate_is_compared_not_a_crash(self):
        source = "import os\ndef f():\n    return os.fsdecode(b'a\\xff')\ndef g():\n    raise ValueError(os.fsdecode(b'\\xff'))\n"
        job = make_job(
            {"solution.py": source},
            [call("Value", "f", {"value": "a?"}), call("Raises", "g", {"raises": {"type": "ValueError"}})],
        )
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["status"], "failed")  # it became U+FFFD, never an author's "?"
        self.assertEqual(outcome.check(1)["status"], "passed")

    def test_a_huge_integer_in_a_numeric_comparison_is_a_verdict_not_a_crash(self):
        source = "def bigp():\n    return 10 ** 400 + 1\ndef big():\n    return 10 ** 400\ndef bigs():\n    return [10 ** 400]\n"
        job = make_job(
            {"solution.py": source},
            [
                call("Huge vs float", "big", {"value": 1.5}, "numeric"),
                call("Huge in list", "bigs", {"value": [1.5]}, "numeric"),
                call("Float vs huge expected", "big", {"value": 10 ** 400}, "numeric"),
                call("Huge equals itself", "big", {"value": 10 ** 400}, "exact"),
                call("Huge within relTol", "bigp", {"value": 10 ** 400}, "numeric"),
            ],
        )
        outcome = self.go(job)
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]], ["failed", "failed", "passed", "passed", "passed"]
        )

    def test_a_job_holding_a_lone_surrogate_exits_64(self):
        job = make_job({"p.py": "x = 1\n"}, [script("A", "p.py")])
        raw = (NONCE + "\n" + json.dumps(job).replace('"x = 1', '"\\ud800 = 1')).encode()
        self.assertEqual(run_harness(None, raw=raw).returncode, 64)

    def test_driver_runs_outside_the_harness_and_writes_its_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory, "m.py"), "w") as handle:
                handle.write("def f(x):\n    return x * 2\n")
            outcome = os.path.join(directory, "out.json")
            spec = {"file": "m.py", "function": "f", "args": [21], "kwargs": {}, "outcomePath": outcome}
            done = subprocess.run(
                [sys.executable, "-s", "-P", "-B", os.path.join(HERE, "driver.py")],
                input=(json.dumps(spec) + "\nrest").encode(), cwd=directory, capture_output=True,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            with open(outcome) as handle:
                self.assertEqual(json.load(handle), {"ok": True, "value": 42, "jsonable": True, "repr": "42"})


class Script(HarnessCase):
    def test_script_pass_and_fail(self):
        job = make_job(
            {
                "ok.py": "assert 1 + 1 == 2\n",
                "bad.py": "x = 1\nassert x == 2, 'x should be 2'\n",
                "silent.py": "import sys\nsys.exit(4)\n",
            },
            [script("Pass", "ok.py"), script("Fail", "bad.py"), script("Silent", "silent.py")],
        )
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["status"], "passed")
        failed = outcome.check(1)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["message"], "AssertionError: x should be 2")
        self.assertEqual(outcome.check(2)["message"], "Exited with code 4")

    def test_script_check_imports_a_sibling_module_from_the_check_directory(self):
        job = make_job(
            {"helper.py": "VALUE = 7\n", "main.py": "import helper\nassert helper.VALUE == 7\n"},
            [script("A", "main.py")],
        )
        self.assertEqual(self.go(job).check()["status"], "passed")

    def test_imports_from_a_subdirectory_package(self):
        job = make_job(
            {"pkg/__init__.py": "", "pkg/m.py": "N = 3\n", "main.py": "from pkg.m import N\nassert N == 3\n"},
            [script("A", "main.py")],
        )
        self.assertEqual(self.go(job).check()["status"], "passed")


# --------------------------------------------------------------------------------------
# Time, output, environment
# --------------------------------------------------------------------------------------


class Limits(HarnessCase):
    def test_per_check_timeout_is_timeout_and_the_next_check_still_runs(self):
        job = make_job(
            {"loop.py": "while True:\n    pass\n", "ok.py": "print('fine')\n"},
            [script("Loop", "loop.py", timeoutSeconds=1), stdio("Next", "ok.py", "fine\n")],
            wall=30,
        )
        started = time.monotonic()
        outcome = self.go(job)
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(outcome.check(0)["status"], "timeout")
        self.assertEqual(outcome.check(1)["status"], "passed")

    def test_wall_budget_spent_later_checks_are_skipped(self):
        job = make_job(
            {"loop.py": "while True:\n    pass\n", "ok.py": "print('fine')\n"},
            [script("Loop", "loop.py"), stdio("Next", "ok.py", "fine\n"), stdio("Last", "ok.py", "fine\n")],
            wall=2,
        )
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["status"], "timeout")
        for index in (1, 2):
            self.assertEqual(outcome.check(index)["status"], "skipped")
            self.assertEqual(outcome.check(index)["message"], "Not run: time budget spent")

    def test_a_timeout_kills_the_whole_process_group(self):
        token = "tok" + uuid.uuid4().hex
        source = (
            "import subprocess, sys, time\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', %r])\n"
            "time.sleep(60)\n" % token
        )
        job = make_job({"p.py": source}, [script("A", "p.py", timeoutSeconds=1)])
        try:
            outcome = self.go(job)
            self.assertEqual(outcome.check()["status"], "timeout")
            self.assertEqual(processes_with(token), [])
        finally:
            kill_all(processes_with(token))

    def test_output_is_cut_at_output_bytes_across_checks(self):
        job = make_job(
            {"a.py": "print('a' * 2999)\n", "b.py": "print('b' * 2999)\n"},
            [script("A", "a.py"), script("B", "b.py")],
            output=4096,
        )
        outcome = self.go(job)
        self.assertEqual(len(outcome.check(0)["stdout"]), 3000)
        self.assertFalse(outcome.check(0)["truncated"])
        self.assertEqual(len(outcome.check(1)["stdout"]), 1095)  # the newline encodes as two bytes
        self.assertTrue(outcome.check(1)["truncated"])
        self.assertTrue(outcome.result["truncated"])

    def test_one_check_may_use_the_whole_budget_and_a_large_print_finishes(self):
        job = make_job(
            {"big.py": "import sys\nsys.stdout.write('x' * (10 * 1024 * 1024))\n"},
            [script("Big", "big.py")],
            output=8192,
        )
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "passed")
        self.assertEqual(len(entry["stdout"]), 8192)
        self.assertTrue(entry["truncated"])

    def test_captured_text_is_counted_by_its_encoded_size(self):
        source = "import sys\nsys.stdout.write('\"' * 3000)\nsys.stderr.write('\\u00e9' * 3000)\n"
        job = make_job({"p.py": source}, [script("A", "p.py")], output=4096)
        entry = self.go(job).check()
        total = run.encoded_len(entry["stdout"]) + run.encoded_len(entry["stderr"])
        self.assertLessEqual(total, 4096)
        self.assertGreater(total, 4096 - 4)
        self.assertTrue(entry["truncated"])

    def test_a_flooded_stderr_does_not_fail_a_correct_stdio_program(self):
        source = "import sys\nprint('hi')\nfor _ in range(20000):\n    print('debug line', file=sys.stderr)\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "hi\n")], output=4096)
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "passed")
        self.assertTrue(entry["truncated"])
        self.assertEqual(entry["actual"], "hi\n")  # compared on stdout's own text, not the shared budget

    def test_stdout_larger_than_output_bytes_cannot_pass_a_stdio_comparison(self):
        job = make_job({"p.py": "print('a' * 6000)\n"}, [stdio("A", "p.py", "a" * 6000 + "\n")], output=4096)
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "failed")
        self.assertTrue(entry["truncated"])

    def test_a_stdio_check_after_one_that_used_the_shared_output_budget_still_passes(self):
        job = make_job(
            {"a.py": "print('a' * 3998)\n", "b.py": "print('b' * 1000)\n"},
            [script("Fill", "a.py"), stdio("B", "b.py", "b" * 1000 + "\n")],
            output=4096,
        )
        outcome = self.go(job)
        entry = outcome.check(1)
        self.assertEqual(entry["status"], "passed")
        self.assertTrue(entry["truncated"])  # the shared capture ran out ...
        self.assertLess(len(entry["stdout"]), 1001)
        self.assertEqual(entry["actual"], "b" * 1000 + "\n")  # ... but the comparison used the check's own stdout

    def test_a_stdio_check_whose_program_floods_stderr_still_passes(self):
        source = "import sys\nprint('c' * 1500)\nsys.stderr.write('e' * (2 * 1024 * 1024))\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "c" * 1500 + "\n")], output=4096)
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "passed")
        self.assertTrue(entry["truncated"])
        self.assertEqual(entry["actual"], "c" * 1500 + "\n")

    def test_a_stdio_check_whose_own_stdout_exceeds_output_bytes_fails_with_the_output_limit_message(self):
        job = make_job({"p.py": "print('a' * 6000)\n"}, [stdio("A", "p.py", "a" * 6000 + "\n")], output=4096)
        entry = self.go(job).check()
        self.assertEqual(entry["status"], "failed")
        self.assertEqual(entry["message"], "Output exceeds the output limit of the question")

    def test_expected_actual_and_message_are_cut_by_encoded_size(self):
        long_text = "\u00e9" * 3000
        job = make_job(
            {"p.py": "print('\"' * 3000)\n", "q.py": "import sys\nsys.stderr.write('\\u00e9' * 2000)\nsys.exit(1)\n"},
            [stdio("Stdio", "p.py", long_text), script("Script", "q.py")],
        )
        outcome = self.go(job)
        stdio_entry, script_entry = outcome.check(0), outcome.check(1)
        self.assertLessEqual(run.encoded_len(stdio_entry["expected"]), 2048)
        self.assertLessEqual(run.encoded_len(stdio_entry["actual"]), 2048)
        self.assertTrue(stdio_entry["expected"].endswith(run.ELLIPSIS))
        self.assertTrue(stdio_entry["actual"].endswith(run.ELLIPSIS))
        self.assertLessEqual(run.encoded_len(script_entry["message"]), 512)
        self.assertTrue(script_entry["message"].endswith(run.ELLIPSIS))

    def test_a_loop_check_with_a_tiny_cap_ends_timeout_with_no_process_left(self):
        token = "tiny" + uuid.uuid4().hex
        job = make_job({"loop.py": "while True:\n    pass\n"}, [script("Loop", "loop.py", args=[token])], wall=1)
        try:
            outcome = self.go(job)
            self.assertEqual(outcome.check()["status"], "timeout")
            self.assertEqual(processes_with(token), [])
        finally:
            kill_all(processes_with(token))


class Environment(HarnessCase):
    def test_the_child_environment_contains_exactly_the_table_keys(self):
        source = "import json, os\nprint(json.dumps(dict(os.environ), sort_keys=True))\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "")])
        stdout = self.go(job, ).check()["stdout"]
        env = json.loads(stdout)
        self.assertEqual(set(env), set(run.child_env("/x", "python")))
        self.assertEqual(env["PATH"], "/usr/local/bin:/usr/bin:/bin")
        self.assertEqual(env["PARALLAX_JOB"], "1")
        self.assertEqual(env["PYTHONHASHSEED"], "0")
        self.assertRegex(env["HOME"], r"/tmp/c1$")
        self.assertEqual(env["HOME"], env["TMPDIR"])

    def test_two_runs_of_a_program_printing_a_set_of_strings_give_identical_output(self):
        source = "print(list({'apple', 'banana', 'cherry', 'damson', 'elder', 'fig'}), hash('apple'))\n"
        job = make_job({"p.py": source}, [script("A", "p.py")])
        first = self.go(job).check()["stdout"]
        second = self.go(job).check()["stdout"]
        self.assertEqual(first, second)
        direct = subprocess.run(
            ["python3", "-s", "-P", "-B", "-c", source], env={"PYTHONHASHSEED": "0", "PATH": run.ENV_PATH},
            capture_output=True, text=True,
        )
        self.assertEqual(first, direct.stdout)

    def test_cwd_is_the_check_directory_and_tmp_is_private(self):
        source = "import os\nprint(os.getcwd().rsplit('/', 1)[1], os.environ['TMPDIR'].rsplit('/', 1)[1])\n"
        job = make_job({"p.py": source}, [script("A", "p.py"), script("B", "p.py")])
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["stdout"], "c1 c1\n")
        self.assertEqual(outcome.check(1)["stdout"], "c2 c2\n")

    def test_the_program_cannot_read_the_container_stdin(self):
        job = make_job({"p.py": "import sys\nprint(repr(sys.stdin.read()))\n"}, [script("A", "p.py")])
        self.assertEqual(self.go(job).check()["stdout"], "''\n")


# --------------------------------------------------------------------------------------
# Hidden files and the sweep
# --------------------------------------------------------------------------------------


class Visibility(HarnessCase):
    LISTING = "import os\nprint(sorted(os.path.join(d, f) for d, _, fs in os.walk('.') for f in fs))\n"

    def test_public_check_sees_no_hidden_file_and_hidden_check_sees_only_its_declared_hidden_files(self):
        job = make_job(
            {
                "list.py": self.LISTING,
                "data/public.csv": "1\n",
                "tests/hidden_a.py": ("a\n", True),
                "tests/hidden_b.py": ("b\n", True),
                "tests/hidden_c.py": ("c\n", True),
            },
            [
                script("Public", "list.py"),
                script("Hidden A", "list.py", hidden=True, files=["tests/hidden_a.py"]),
                script("Hidden AB", "list.py", hidden=True, files=["tests/hidden_a.py", "tests/hidden_b.py"]),
                script("Public again", "list.py"),
            ],
        )
        outcome = self.go(job)
        base = ["./data/public.csv", "./list.py"]
        expect = [
            base,
            sorted(base + ["./tests/hidden_a.py"]),
            sorted(base + ["./tests/hidden_a.py", "./tests/hidden_b.py"]),
            base,
        ]
        for index, files in enumerate(expect):
            with self.subTest(check=index):
                self.assertEqual(outcome.check(index)["stdout"].strip(), repr(files))

    def test_a_hidden_file_that_is_the_check_program_is_materialised_for_that_check_only(self):
        job = make_job(
            {"list.py": self.LISTING, "tests/hidden_test.py": ("print('hidden ran')\n", True)},
            [script("Hidden", "tests/hidden_test.py", hidden=True), script("Public", "list.py")],
        )
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["stdout"], "hidden ran\n")
        self.assertEqual(outcome.check(1)["stdout"].strip(), repr(["./list.py"]))

    def test_binary_files_are_decoded(self):
        job = make_job({"p.py": "print(open('d.bin', 'rb').read())\n"}, [script("A", "p.py")])
        job["files"].append({"path": "d.bin", "content": base64.b64encode(b"\x00\xffabc").decode(), "encoding": "base64"})
        self.assertEqual(self.go(job).check()["stdout"], "b'\\x00\\xffabc'\n")


class Sweep(HarnessCase):
    def test_nothing_under_a_swept_root_survives_a_check(self):
        # The hidden check stashes its hidden file under the tmp and ipc roots, pre-creates the
        # next check directory and leaves a locked directory and a fifo behind; the public
        # check that follows must find none of it.
        def stash_source(paths):
            return (
                "import os\n"
                "data = open('secret.txt').read()\n"
                "open(%r, 'w').write(data)\n"
                "open(%r, 'w').write(data)\n"
                "os.mkdir(%r)\n"
                "open(os.path.join(%r, 'copy'), 'w').write(data)\n"
                "os.mkdir(%r)\n"
                "open(os.path.join(%r, 'f'), 'w').close()\n"
                "os.chmod(%r, 0)\n"
                "os.mkfifo(%r)\n"
                "print('stashed')\n"
            ) % (
                os.path.join(paths["tmp"], "stash"), os.path.join(paths["ipc"], "stash"),
                os.path.join(paths["work"], "c2"), os.path.join(paths["work"], "c2"),
                os.path.join(paths["tmp"], "locked"), os.path.join(paths["tmp"], "locked"),
                os.path.join(paths["tmp"], "locked"), os.path.join(paths["ipc"], "fifo"),
            )

        def probe_source(paths):
            return (
                "import os\n"
                "roots = %r\n"
                "print(sorted(os.listdir(roots[0])), sorted(os.listdir(roots[1])), sorted(os.listdir(roots[2])))\n"
            ) % ([paths["work"], paths["tmp"], paths["ipc"]],)

        outcome = self.run_with_roots(stash_source, probe_source)
        self.assertEqual(outcome.check(0)["status"], "passed", outcome.check(0))
        self.assertEqual(outcome.check(0)["stdout"], "stashed\n")
        self.assertEqual(outcome.check(1)["status"], "passed", outcome.check(1))
        self.assertEqual(outcome.check(1)["stdout"], "['c2'] ['c2'] []\n")

    def test_a_tree_deeper_than_the_open_file_limit_is_swept_under_nofile_256(self):
        source = "import os\nfor _ in range(600):\n    os.mkdir('d')\n    os.chdir('d')\nprint('deep')\n"
        job = make_job(
            {"deep.py": source, "ok.py": "print('after')\n"},
            [stdio("Deep", "deep.py", "deep\n"), stdio("After", "ok.py", "after\n")],
        )
        outcome = self.go(job, nofile=256)
        self.assertEqual(outcome.check(0)["status"], "passed")
        self.assertEqual(outcome.check(1)["status"], "passed")

    def run_with_roots(self, stash_source, probe_source):
        with tempfile.TemporaryDirectory() as base:
            paths = {name: os.path.join(base, name) for name in ("work", "tmp", "ipc")}
            for directory in paths.values():
                os.mkdir(directory)
            job = make_job(
                {
                    "stash.py": (stash_source(paths), True),
                    "secret.txt": ("hidden material\n", True),
                    "probe.py": probe_source(paths),
                },
                [
                    script("Stash", "stash.py", hidden=True, files=["secret.txt"]),
                    script("Probe", "probe.py"),
                ],
            )
            completed = subprocess.run(
                [*HARNESS_PREFIX, sys.executable, os.path.join(HERE, "run.py"), "--work", paths["work"], "--tmp", paths["tmp"], "--ipc", paths["ipc"]],
                input=(NONCE + "\n" + json.dumps(job)).encode(), capture_output=True, timeout=120,
            )
            outcome = Outcome(completed, paths)
            self.assertEqual(outcome.returncode, 0, outcome.stderr)
            assert_result_shape(self, outcome.result)
            # After the last check every root is empty again.
            for name, directory in paths.items():
                self.assertEqual(os.listdir(directory), [], name)
            return outcome


# --------------------------------------------------------------------------------------
# Processes, signals and threads
# --------------------------------------------------------------------------------------


class Processes(HarnessCase):
    def test_orphaned_processes_are_reaped_during_a_check(self):
        token = "orph" + uuid.uuid4().hex
        source = (
            "import os, subprocess, time\n"
            "for i in range(60):\n"
            "    pid = os.fork()\n"
            "    if pid == 0:\n"
            "        if os.fork() == 0:\n"
            "            time.sleep(0.05)\n"
            "            os._exit(0)\n"
            "        os._exit(0)\n"
            "    os.waitpid(pid, 0)\n"
            "time.sleep(0.5)\n"
            "subprocess.run(['true'], check=True)\n"
            "print('still spawning')\n"
        )
        job = make_job({"p.py": source}, [stdio("A", "p.py", "still spawning\n", args=[token])])
        try:
            outcome = self.go(job)
            self.assertEqual(outcome.check()["status"], "passed", outcome.check())
            self.assertEqual(processes_with(token), [])
        finally:
            kill_all(processes_with(token))

    def test_a_daemon_holding_the_pipes_does_not_block_the_check_and_its_orphans_are_reaped(self):
        token = "daem" + uuid.uuid4().hex
        source = (
            "import os, sys, time\n"
            "if os.fork() == 0:\n"
            "    os.setsid()\n"
            "    for _ in range(3):\n"
            "        if os.fork() == 0:\n"
            "            if os.fork() == 0:\n"
            "                time.sleep(120)\n"
            "            os._exit(0)\n"
            "    time.sleep(120)\n"
            "    os._exit(0)\n"
            "print('parent done')\n"
        )
        job = make_job({"p.py": source, "ok.py": "print('next')\n"}, [stdio("Daemon", "p.py", "parent done\n", args=[token], timeoutSeconds=30), stdio("Next", "ok.py", "next\n")])
        started = time.monotonic()
        try:
            outcome = self.go(job)
            elapsed = time.monotonic() - started
            self.assertEqual(outcome.check(0)["status"], "passed", outcome.check(0))
            self.assertEqual(outcome.check(1)["status"], "passed")
            self.assertLess(elapsed, 20, "the readers are joined only after the kill-and-reap")
            self.assertEqual(processes_with(token), [])
        finally:
            kill_all(processes_with(token))

    def test_the_directs_child_returncode_is_set_from_the_wait_loop(self):
        # The harness asserts proc.returncode is not None after every check and exits 70
        # otherwise; a run that returns a result, with the child's own exit code in it, shows
        # the status came from the wait loop.
        job = make_job(
            {"quick.py": "import sys\nsys.exit(5)\n", "ok.py": "print('ok')\n"},
            [script("Quick", "quick.py"), stdio("Ok", "ok.py", "ok\n"), script("Quick again", "quick.py")],
        )
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["exitCode"], 5)
        self.assertEqual(outcome.check(1)["status"], "passed")
        self.assertEqual(outcome.check(2)["exitCode"], 5)

    def test_student_code_sending_sigint_to_the_harness_does_not_interrupt_it(self):
        source = "import os, signal\nos.kill(os.getppid(), signal.SIGINT)\nprint('sent')\n"
        job = make_job({"p.py": source, "ok.py": "print('after')\n"}, [stdio("Send", "p.py", "sent\n"), stdio("After", "ok.py", "after\n")])
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["status"], "passed")
        self.assertEqual(outcome.check(1)["status"], "passed")

    def test_a_student_program_receives_sigint_at_its_default_disposition(self):
        source = "import signal\nprint(signal.getsignal(signal.SIGINT) is signal.default_int_handler)\n"
        job = make_job({"p.py": source}, [stdio("A", "p.py", "True\n")])
        self.assertEqual(self.go(job).check()["status"], "passed")

    def test_reader_threads_and_the_timer_exist_before_the_child_is_spawned(self):
        # The harness asserts its thread count before and after every spawn and exits 70 when a
        # thread starts after it; a job that returns a result means the ordering held.
        job = make_job({"p.py": "print('x')\n"}, [stdio("A", "p.py", "x\n"), stdio("B", "p.py", "x\n")])
        self.assertEqual(self.go(job).check(1)["status"], "passed")

    @unittest.skipUnless(IN_IMAGE, "needs the image's PidsLimit of 64")
    def test_a_program_that_saturates_the_pids_limit_does_not_stop_the_next_check(self):
        token = "bomb" + uuid.uuid4().hex
        source = (
            "import os, time\n"
            "kids = 0\n"
            "for _ in range(300):\n"
            "    try:\n"
            "        pid = os.fork()\n"
            "    except OSError:\n"
            "        break\n"
            "    if pid == 0:\n"
            "        time.sleep(60)\n"
            "        os._exit(0)\n"
            "    kids += 1\n"
            "print('forked', kids > 10)\n"
        )
        job = make_job({"bomb.py": source, "ok.py": "print('next')\n"}, [script("Bomb", "bomb.py", args=[token]), stdio("Next", "ok.py", "next\n")])
        outcome = self.go(job)
        self.assertEqual(outcome.check(0)["status"], "passed")
        self.assertEqual(outcome.check(1)["status"], "passed")

    def test_a_spawn_failure_tears_down_the_pipes_readers_and_timer(self):
        checks = [stdio("Check %d" % i, "p.py", "x\n") for i in range(50)]
        job = make_job({"p.py": "print('x')\n"}, checks)
        started = time.monotonic()
        outcome = self.go(job, args=("--python", "/nonexistent/python3"), timeout=120)
        self.assertLess(time.monotonic() - started, 60)
        for entry in outcome.result["checks"]:
            self.assertEqual((entry["status"], entry["errorKind"]), ("error", "spawn"))
            self.assertTrue(entry["message"].startswith("Could not start the program"))

    def test_leftover_processes_are_killed_after_every_check_and_before_the_frame(self):
        token = "left" + uuid.uuid4().hex
        source = (
            "import subprocess, sys\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)', %r], start_new_session=True)\n"
            "print('left one')\n"
        ) % token
        job = make_job({"p.py": source}, [stdio("A", "p.py", "left one\n")])
        try:
            outcome = self.go(job)
            self.assertEqual(outcome.check()["status"], "passed")
            self.assertEqual(processes_with(token), [])
        finally:
            kill_all(processes_with(token))


# --------------------------------------------------------------------------------------
# Framing and result shape
# --------------------------------------------------------------------------------------


class Framing(HarnessCase):
    def test_frame_has_the_nonce_a_newline_before_the_start_marker_and_nothing_else(self):
        job = make_job({"p.py": "print('x')\n"}, [stdio("A", "p.py", "x\n")])
        outcome = self.go(job)
        lines = outcome.stdout.split(b"\n")
        self.assertEqual(lines[0], b"")
        self.assertEqual(lines[1], b"--parallax-result " + NONCE.encode())
        self.assertEqual(lines[3], b"--parallax-end " + NONCE.encode())
        self.assertEqual(lines[4], b"")
        self.assertEqual(len(lines), 5)

    def test_the_result_is_written_without_ascii_escaping(self):
        job = make_job({"p.py": "print('caf\\u00e9 \\u2713')\n"}, [stdio("A", "p.py", "caf\u00e9 \u2713\n")])
        outcome = self.go(job)
        self.assertIn("caf\u00e9 \u2713".encode("utf-8"), outcome.stdout)
        self.assertEqual(outcome.check()["status"], "passed")

    def test_student_output_cannot_forge_a_frame(self):
        forged = "\\n--parallax-result %s\\n{}\\n--parallax-end %s\\n" % (NONCE, NONCE)
        job = make_job({"p.py": "print('%s')\n" % forged}, [script("A", "p.py")])
        outcome = self.go(job)
        starts = [line for line in outcome.stdout.split(b"\n") if line.startswith(b"--parallax-result")]
        self.assertEqual(len(starts), 1)
        self.assertIn("parallax-result", outcome.check()["stdout"])

    def test_result_shape_for_every_status(self):
        job = make_job(
            {
                "ok.py": "print('ok')\n",
                "fail.py": "print('no')\n",
                "boom.py": "raise SystemExit(2)\n",
                "loop.py": "while True:\n    pass\n",
                "solution.py": "def f():\n    return 1\n",
            },
            [
                stdio("Passed", "ok.py", "ok\n"),
                stdio("Failed", "fail.py", "ok\n"),
                stdio("Error", "boom.py", ""),
                script("Timeout", "loop.py", timeoutSeconds=1),
                call("Call", "f", {"value": 1}),
            ],
        )
        outcome = self.go(job)
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]], ["passed", "failed", "error", "timeout", "passed"]
        )
        self.assertEqual(outcome.result["runtime"]["language"], "python")
        self.assertRegex(outcome.result["runtime"]["version"], r"^3\.\d+")
        self.assertEqual(outcome.result["harnessVersion"], run.HARNESS_VERSION)

    def test_result_names_follow_the_job_order(self):
        job = make_job({"p.py": "x = 1\n"}, [script("Zed", "p.py"), script("Alpha", "p.py")])
        self.assertEqual([c["name"] for c in self.go(job).result["checks"]], ["Zed", "Alpha"])


# --------------------------------------------------------------------------------------
# R (design sections 4.1 and 4.5; runs where Rscript exists: the r-4.6 image)
# --------------------------------------------------------------------------------------


def r_job(files, checks, **kwargs):
    job = make_job(files, checks, **kwargs)
    job["runtime"] = {"id": "r-4.6", "language": "r"}
    return job


def r_call(name, function, expected, mode="exact", **extra):
    return call(name, function, expected, mode, file="solution.R", **extra)


@unittest.skipUnless(HAS_R, "needs Rscript (the r-4.6 image)")
class RRuntime(HarnessCase):
    SOURCE = (
        "add <- function(a, b) a + b\n"
        "total <- function(v) sum(v)\n"
        "vec <- function() c(1, 2, 3)\n"
        "named <- function() list(a = 1, b = 'x')\n"
        "kw <- function(a, b) a * b\n"
        "nothing <- function() NULL\n"
        "boom <- function() stop('bad input 42')\n"
        "matrix_value <- function() matrix(1:4, 2)\n"
        "nan <- function() NaN\n"
        "missing_value <- function() NA_real_\n"
        "bad_bytes <- function() rawToChar(as.raw(c(0x61, 0xff, 0x62)))\n"
        "echo <- function() paste(readLines(file('stdin')), collapse = '\\n')\n"
        "count <- function() length(readLines(file('stdin')))\n"
        "noisy <- function() { cat('to stdout\\n'); 1 }\n"
        "ident <- function(x) x\n"
        "lens <- function(x) list(is.list(x), length(x))\n"
        "bigvec <- function() rep(c('a\"b', 'caf\\u00e9', NA), length.out = 100000)\n"
        "huge_escapes <- function() strrep('\u00e9\\n\\t\\001\"\\\\', 300000)\n"
        "utf8_within <- function() strrep('\u00e9', 40000)\n"
        "ascii_at <- function() strrep('a', 65536)\n"
        "ascii_over <- function() strrep('a', 65537)\n"
        "stop_warning <- function() stop(simpleWarning('w'))\n"
        "stop_message <- function() stop(simpleMessage('m'))\n"
        "nested_signal <- function() withCallingHandlers(stop('boom'), error = function(e) signalCondition(structure(class = c('note', 'condition'), list(message = 'fyi', call = NULL))))\n"
        "deep <- function(n) { if (n == 0) return(0); message('d'); deep(n - 1) + 1 }\n"
        "custom <- function() stop(structure(class = c('myFailure', 'condition'), list(message = 'custom failure', call = NULL)))\n"
        "signals <- function() { signalCondition(structure(class = c('note', 'condition'), list(message = 'fyi', call = NULL))); 7 }\n"
    )

    def outcome_for(self, *checks):
        return self.go(r_job({"solution.R": self.SOURCE}, list(checks)))

    def test_stdio_script_and_runtime_version(self):
        job = r_job(
            {"hello.R": "cat('hello\\n')\n", "quit.R": "quit(status = 3)\n", "ok.R": "invisible(1)\n"},
            [
                stdio("Passed", "hello.R", "hello\n"),
                stdio("Failed", "hello.R", "bye\n"),
                stdio("Exit code", "quit.R", ""),
                script("Script", "ok.R"),
            ],
        )
        outcome = self.go(job)
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "failed", "error", "passed"])
        self.assertEqual(outcome.check(2)["message"], "Exited with code 3")
        self.assertEqual(outcome.result["runtime"]["language"], "r")
        self.assertRegex(outcome.result["runtime"]["version"], r"^\d+\.\d+")

    def test_a_syntax_error_is_a_compile_error(self):
        job = r_job({"bad.R": "x <- (\n", "ok.R": "1\n"}, [script("Run", "ok.R")])
        outcome = self.go(job)
        self.assertEqual(outcome.result["compileError"]["file"], "bad.R")
        self.assertEqual(outcome.check()["status"], "skipped")
        self.assertEqual(outcome.check()["message"], "Not run: bad.R does not compile")

    def test_call_values(self):
        outcome = self.outcome_for(
            r_call("Add", "add", {"value": 3}, args=[1, 2]),
            r_call("Vector argument", "total", {"value": 6}, args=[[1, 2, 3]]),
            r_call("Vector result", "vec", {"value": [1, 2, 3]}),
            r_call("Named list is an object", "named", {"value": {"a": 1, "b": "x"}}),
            r_call("Kwargs", "kw", {"value": 8}, kwargs={"a": 4, "b": 2}),
            r_call("Numeric", "add", {"value": 0.3}, "numeric", args=[0.1, 0.2]),
            r_call("Repr", "vec", {"value": "c(1, 2, 3)"}, "repr"),
            r_call("Matrix is not json", "matrix_value", {"value": "structure(1:4, dim = c(2L, 2L))"}),
            r_call("NaN", "nan", {"value": "NaN"}),
            r_call("Missing value is null", "missing_value", {"value": None}),
            r_call("Wrong value", "add", {"value": 4}, args=[1, 2]),
        )
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]],
            ["passed"] * 10 + ["failed"],
            outcome.result["checks"],
        )
        wrong = outcome.check(10)
        self.assertEqual((wrong["expected"], wrong["actual"]), ("4", "3"))

    def test_raises_is_matched_by_class_base_and_message(self):
        outcome = self.outcome_for(
            r_call("Exact class", "boom", {"raises": {"type": "simpleError"}}),
            r_call("Base class", "boom", {"raises": {"type": "error"}}),
            r_call("Message", "boom", {"raises": {"type": "error", "message": r"input \d+"}}),
            r_call("Wrong message", "boom", {"raises": {"type": "error", "message": "^nope"}}),
            r_call("Wrong class", "boom", {"raises": {"type": "ValueError"}}),
            r_call("Not raised", "nothing", {"raises": {"type": "error"}}),
            r_call("Unexpected", "boom", {"value": 1}),
            r_call("Missing function", "absent", {"value": 1}),
        )
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]],
            ["passed", "passed", "passed", "failed", "failed", "failed", "error", "error"],
            outcome.result["checks"],
        )
        self.assertEqual(outcome.check(5)["message"], "Expected error, but the call returned NULL")
        self.assertEqual(outcome.check(6)["message"], "simpleError: bad input 42")
        self.assertEqual(outcome.check(6)["errorKind"], "exception")
        self.assertEqual(outcome.check(7)["errorKind"], "exception")
        self.assertIn("was not found", outcome.check(7)["message"])

    def test_an_outcome_never_carries_invalid_utf8(self):
        entry = self.outcome_for(r_call("Bytes", "bad_bytes", {"value": "a\ufffdb"})).check()
        self.assertEqual(entry["status"], "passed", entry)

    def test_stdin_reaches_the_student_function_whole(self):
        lines = "\n".join(str(i) for i in range(5000))
        outcome = self.outcome_for(
            r_call("Echo", "echo", {"value": "hello\nworld"}, stdin="hello\nworld"),
            r_call("Count", "count", {"value": 5000}, stdin=lines),
            r_call("Output", "noisy", {"value": 1}),
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 3, outcome.result["checks"])
        self.assertEqual(outcome.check(2)["stdout"], "to stdout\n")

    def test_environment_and_sibling_source(self):
        files = {
            "main.R": (
                "source('helper.R')\n"
                "stopifnot(helper() == 'helped')\n"
                "stopifnot(Sys.getenv('PARALLAX_JOB') == '1')\n"
                "stopifnot(Sys.getenv('R_LIBS_USER') == '/tmp/none')\n"
                "stopifnot(grepl('/c[0-9]+$', Sys.getenv('HOME')))\n"
                "stopifnot(requireNamespace('jsonlite', quietly = TRUE))\n"
            ),
            "helper.R": "helper <- function() 'helped'\n",
        }
        entry = self.go(r_job(files, [script("Env", "main.R")])).check()
        self.assertEqual(entry["status"], "passed", entry)

    def test_a_per_check_timeout_is_followed_by_a_check_that_still_runs(self):
        files = {"loop.R": "repeat {}\n", "ok.R": "invisible(1)\n"}
        outcome = self.go(r_job(files, [script("Loop", "loop.R", timeoutSeconds=1), script("Ok", "ok.R")]))
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["timeout", "passed"])

    def test_a_function_the_student_did_not_define_is_not_found_in_base_r(self):
        # `factorial` and `rev` exist in base R; an empty solution must not pass for them.
        job = r_job(
            {"solution.R": "other <- function() 1\n"},
            [r_call("Factorial", "factorial", {"value": 120}, args=[5]), r_call("Rev", "rev", {"value": [2, 1]}, args=[[1, 2]])],
        )
        outcome = self.go(job)
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["error", "error"])
        self.assertIn("was not found", outcome.check()["message"])

    def test_student_code_cannot_replace_the_drivers_helpers(self):
        files = {
            "solution.R": "source('helpers.R')\nanswer <- function() list(a = 1)\n",
            "helpers.R": (
                "to_json <- function(x) 'null'\nclean_text <- function(s) 'x'\n"
                "json_string <- function(s) 'x'\nmain <- function() stop('hijacked')\n"
                "paste <- function(...) 'x'\n"
            ),
        }
        entry = self.go(r_job(files, [r_call("Answer", "answer", {"value": {"a": 1}})])).check()
        self.assertEqual(entry["status"], "passed", entry)

    def test_doubles_round_trip_in_exact_checks(self):
        files = {"solution.R": "third <- function() 1 / 3\nnoise <- function() 0.1 + 0.2\n"}
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Third", "third", {"value": 0.3333333333333333}),
                    r_call("Noise is not 0.3", "noise", {"value": 0.3}),
                    r_call("Noise numeric", "noise", {"value": 0.3}, "numeric"),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "failed", "passed"])

    def test_empty_named_values_are_empty_objects(self):
        files = {
            "solution.R": (
                "none_list <- function() list(a = 1, b = 2)[c(FALSE, FALSE)]\n"
                "none_vec <- function() c(a = 1)[0]\n"
                "same <- function(x) x\n"
            )
        }
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Empty named list", "none_list", {"value": {}}),
                    r_call("Empty named vector", "none_vec", {"value": {}}),
                    r_call("Empty object argument", "same", {"value": {}}, args=[{}]),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 3, outcome.result["checks"])

    def test_empty_array_arguments_are_empty_vectors(self):
        outcome = self.outcome_for(
            r_call("Sum of empty", "total", {"value": 0}, args=[[]]),
            r_call("Length of empty", "lens", {"value": [False, 0]}, args=[[]]),
            r_call("Empty round trip", "ident", {"value": []}, args=[[]]),
            r_call("Empty among others", "lens", {"value": [True, 2]}, args=[[[], [1]]]),
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 4, outcome.result["checks"])

    def test_arrays_of_arrays_stay_lists(self):
        outcome = self.outcome_for(
            r_call("One-element arrays", "lens", {"value": [True, 2]}, args=[[[1], [2]]]),
            r_call("Longer arrays", "lens", {"value": [True, 2]}, args=[[[1, 2], [3, 4]]]),
            r_call("Scalars are a vector", "lens", {"value": [False, 2]}, args=[[1, 2]]),
            r_call("Nested round trip", "ident", {"value": [1, 2]}, args=[[[1], [2]]]),
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 4, outcome.result["checks"])

    def test_a_condition_that_is_not_an_error_is_an_exception_and_signals_are_not(self):
        outcome = self.outcome_for(
            r_call("Raises custom", "custom", {"raises": {"type": "myFailure", "message": "custom"}}),
            r_call("Unexpected custom", "custom", {"value": 1}),
            r_call("Signal continues", "signals", {"value": 7}),
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "error", "passed"], outcome.result["checks"])
        self.assertEqual(outcome.check(1)["message"], "myFailure: custom failure")
        self.assertEqual(outcome.check(1)["errorKind"], "exception")

    def test_a_large_character_vector_is_serialised_quickly_and_exactly(self):
        # 100 000 elements, non-ASCII and NA among them; a per-element serialiser took ~10 s.
        pattern = ['a"b', "caf\u00e9", None]
        expected = [pattern[i % 3] for i in range(100000)]
        entry = self.outcome_for(r_call("Big", "bigvec", {"value": expected}, timeoutSeconds=5)).check()
        self.assertEqual(entry["status"], "passed", {k: entry[k] for k in entry if k not in ("expected", "actual")})

    def test_a_huge_escape_heavy_string_does_not_stall_the_repr(self):
        # 1.8 M characters of escapes (about 4.8 MB of JSON, under the 8 MiB outcome cap): deparse
        # alone took ~40 s, over the 10 s timeout; the bounded repr is a quick, ordinary failure.
        outcome = self.outcome_for(r_call("Huge", "huge_escapes", {"value": "x"}, "repr", timeoutSeconds=10))
        check = outcome.check()
        self.assertEqual(check["status"], "failed", check)
        self.assertTrue(check["actual"].startswith('"\u00e9\\n\\t'), check["actual"][:40])

    def test_repr_keeps_a_string_within_the_bound_and_cuts_one_over_it(self):
        # 40 000 characters are 80 000 bytes: over the limit in bytes, within it in characters.
        outcome = self.outcome_for(
            r_call("Within the bound and non-ASCII", "utf8_within", {"value": '"' + "\u00e9" * 40000 + '"'}, "repr"),
            r_call("At the bound", "ascii_at", {"value": '"' + "a" * 65536 + '"'}, "repr"),
            r_call("One over the bound", "ascii_over", {"value": '"' + "a" * 65536 + '\u2026"'}, "repr"),
            r_call("One over with an uncut expected", "ascii_over", {"value": '"' + "a" * 65537 + '"'}, "repr"),
        )
        self.assertEqual(
            [c["status"] for c in outcome.result["checks"]], ["passed"] * 3 + ["failed"], outcome.result["checks"]
        )

    def test_stop_with_a_warning_or_message_condition_is_an_exception(self):
        outcome = self.outcome_for(
            r_call("Warning", "stop_warning", {"raises": {"type": "simpleWarning", "message": "w"}}),
            r_call("Message", "stop_message", {"raises": {"type": "simpleMessage"}}),
            r_call("Handler signal during error", "nested_signal", {"raises": {"type": "simpleError", "message": "boom"}}),
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 3, outcome.result["checks"])

    def test_messages_in_deep_recursion_cost_no_more_than_without_the_driver(self):
        entry = self.outcome_for(r_call("Deep", "deep", {"value": 1500}, args=[1500], timeoutSeconds=5)).check()
        self.assertEqual(entry["status"], "passed", {k: entry[k] for k in entry if k not in ("stderr",)})

    def test_a_non_error_condition_at_the_top_of_the_solution_file_is_an_exception(self):
        job = r_job(
            {"solution.R": "stop(structure(class = c('myFailure', 'condition'), list(message = 'top', call = NULL)))\n"},
            [r_call("Top level", "f", {"raises": {"type": "myFailure", "message": "top"}})],
        )
        self.assertEqual(self.go(job).check()["status"], "passed")

    def test_q_defined_by_a_sourced_helper_is_found(self):
        files = {"solution.R": "source('helper.R')\n", "helper.R": "q <- function() 'helper q'\n"}
        entry = self.go(r_job(files, [r_call("Q", "q", {"value": "helper q"})])).check()
        self.assertEqual(entry["status"], "passed", entry)

    def test_character_vectors_keep_quotes_unicode_and_missing_values(self):
        files = {"solution.R": "v <- function() c('a\"b', 'caf\\u00e9', NA, 'back\\\\slash')\nk <- function() c('x\"y' = 1, z = 2)\n"}
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Vector", "v", {"value": ['a"b', "caf\u00e9", None, "back\\slash"]}),
                    r_call("Keys", "k", {"value": {'x"y': 1, "z": 2}}),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed"] * 2, outcome.result["checks"])

    def test_q_and_quit_are_not_found_unless_the_solution_defines_them(self):
        files = {"solution.R": "other <- function() 1\n"}
        outcome = self.go(
            r_job(files, [r_call("Q", "q", {"value": 1}), r_call("Quit", "quit", {"value": 1})])
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["error", "error"])
        self.assertIn("was not found", outcome.check()["message"])
        defined = self.go(r_job({"solution.R": "q <- function() 'mine'\n"}, [r_call("Q", "q", {"value": "mine"})]))
        self.assertEqual(defined.check()["status"], "passed", defined.check())

    def test_integer_arguments_are_doubles(self):
        files = {"solution.R": "square <- function(n) n * n\nkind <- function(n) is.double(n)\n"}
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Square", "square", {"value": 10000000000}, args=[100000]),
                    r_call("Double", "kind", {"value": True}, args=[5]),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "passed"], outcome.result["checks"])

    def test_a_function_sourced_into_the_global_environment_is_found_and_quit_there_is_caught(self):
        files = {
            "solution.R": "source('helper.R')\n",
            "helper.R": "answer <- function() 42\nleave <- function() quit(status = 0)\n",
        }
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Answer", "answer", {"value": 42}),
                    r_call("Quit in a helper", "leave", {"raises": {"type": "SystemExit"}}),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "passed"], outcome.result["checks"])

    def test_null_in_an_array_argument_is_a_missing_value_and_quit_is_an_exception(self):
        files = {"solution.R": "total <- function(v) sum(v, na.rm = TRUE)\nstop_now <- function() quit(status = 2)\n"}
        outcome = self.go(
            r_job(
                files,
                [
                    r_call("Total", "total", {"value": 4}, args=[[1, None, 3]]),
                    r_call("Quit", "stop_now", {"raises": {"type": "SystemExit"}}),
                ],
            )
        )
        self.assertEqual([c["status"] for c in outcome.result["checks"]], ["passed", "passed"], outcome.result["checks"])

    def test_hidden_files_stay_off_disk_for_public_checks(self):
        files = {"main.R": "stopifnot(!file.exists('secret.R'))\n", "secret.R": ("x <- 1\n", True)}
        outcome = self.go(r_job(files, [script("Public", "main.R")]))
        self.assertEqual(outcome.check()["status"], "passed", outcome.check())


if __name__ == "__main__":
    unittest.main()
