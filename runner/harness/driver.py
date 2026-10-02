"""Call driver (docs/design/runner.md section 4.5).

The first line of stdin is the call specification
`{ file, function, args, kwargs, outcomePath }`; whatever follows is the check's stdin
for the student function. The driver never receives `expected` or `compare`: the
harness compares. The outcome is written to `outcomePath` as one JSON document:

    { "ok": true,  "value": <json or null>, "jsonable": bool, "repr": str }
    { "ok": false, "exception": { "type": str, "bases": [str, ...], "message": str } }
"""

import importlib.util
import json
import math
import os
import sys


def to_json(value):
    """Convert a value to something json can carry, or raise TypeError."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, (list, tuple)):
        return [to_json(item) for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("non-string key")
        return {key: to_json(item) for key, item in value.items()}
    if type(value).__module__.split(".")[0] == "numpy" and hasattr(value, "tolist"):
        return to_json(value.tolist())
    raise TypeError("not json serialisable")


def safe_repr(value):
    try:
        return repr(value)
    except Exception:
        return "<unrepresentable>"


def read_spec():
    raw = sys.stdin.buffer.readline()
    return json.loads(raw.decode("utf-8"))


def load_module(file):
    name = os.path.splitext(os.path.basename(file))[0] or "student"
    spec = importlib.util.spec_from_file_location(name, os.path.abspath(file))
    if spec is None or spec.loader is None:
        raise ImportError("cannot load " + file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def outcome_for(spec):
    try:
        module = load_module(spec["file"])
        target = module
        for part in spec["function"].split("."):
            target = getattr(target, part)
        value = target(*spec.get("args", []), **spec.get("kwargs", {}))
    except BaseException as error:  # SystemExit and KeyboardInterrupt included
        return {
            "ok": False,
            "exception": {
                "type": type(error).__name__,
                "bases": [cls.__name__ for cls in type(error).__mro__[1:]],
                "message": str(error),
            },
        }
    try:
        converted, jsonable = to_json(value), True
        json.dumps(converted, allow_nan=False)
    except Exception:
        converted, jsonable = None, False
    return {"ok": True, "value": converted, "jsonable": jsonable, "repr": safe_repr(value)}


def main():
    spec = read_spec()
    sys.path.insert(0, os.getcwd())
    outcome = outcome_for(spec)
    with open(spec["outcomePath"], "w", encoding="utf-8") as handle:
        json.dump(outcome, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
