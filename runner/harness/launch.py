"""Run a student program with its own directory first on sys.path.

The interpreter runs with -P (no script directory on sys.path), so a sibling import
or `from solution import ...` would fail without this. The check directory is the cwd
(docs/design/runner.md section 4.1).
"""

import os
import runpy
import sys
import traceback


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: launch.py FILE [ARGS...]\n")
        return 2
    sys.path.insert(0, os.getcwd())
    sys.argv = sys.argv[1:]
    try:
        runpy.run_path(sys.argv[0], run_name="__main__")
    except SystemExit:
        raise
    except BaseException:
        etype, error, tb = sys.exc_info()
        skip = (os.path.abspath(__file__), os.path.abspath(runpy.__file__))
        while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) in skip:
            tb = tb.tb_next
        traceback.print_exception(etype, error, tb)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
