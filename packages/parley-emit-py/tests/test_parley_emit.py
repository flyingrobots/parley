"""The parley_emit.py suite: standard library only.

Run from the package directory with `python3 -m unittest discover -s tests`. The oracles that live
in TypeScript (the repository doctor, parley-read's loader and ajv) are run over this writer's
output by `test/parley-emit-py.test.ts`, which also runs this suite, so `bun test` covers both.
Every line every case here emits is checked against its exact schema pair with the writer's own
bounded checker (PY-17c); the doctor is the independent check.
"""

import ast
import hashlib
import io
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import warnings

PACKAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(PACKAGE))
sys.path.insert(0, PACKAGE)

import parley_emit as pe  # noqa: E402

RESULT = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/t/schemas/t.count/1.0.0",
    "type": "object",
    "required": ["event", "t", "seq", "run", "value", "_schema"],
    "properties": {
        "event": {"const": "result"},
        "value": {"type": "integer", "minimum": 0},
        "_schema": {"type": "object", "required": ["id", "version"], "additionalProperties": False,
                    "properties": {"id": {"const": "t.count"}, "version": {"const": "1.0.0"}}},
    },
}
T_COUNT = ("t.count", "1.0.0")
EXTRA = {T_COUNT: RESULT}
SECRET = "s3cret-value-xyz"


class Capture:
    def __init__(self, fail_on=None):
        self.lines = []
        self.fail_on = fail_on

    def write(self, line):
        if self.fail_on and self.fail_on in line:
            raise BrokenPipeError(32, "Broken pipe")
        self.lines.append(line)

    @property
    def text(self):
        return "".join(self.lines)

    @property
    def objs(self):
        return [json.loads(line) for line in self.lines]


def tool(**over):
    spec = dict(
        name="t", version="0.0.1",
        commands={"count": {
            "intent": "Count the things under the working directory",
            "effects": {"reads": ["<cwd>/**"], "writes": [], "network": False, "idempotent": True},
            "secrets": ["--token", "T_TOKEN", "netrc"],
            "emits": [{"id": "t.count", "version": "1.0.0", "schema": RESULT}],
        }},
        retention={"count": 100},
    )
    spec.update(over)
    return pe.define_tool(**spec)


def scratch():
    d = tempfile.mkdtemp(prefix="parley-py-")
    state = tempfile.mkdtemp(prefix="parley-py-state-")
    return d, state, {"XDG_STATE_HOME": state}


class Outcome:
    def __init__(self, status, stdout, stderr, receipt_path):
        self.status, self.stdout, self.stderr, self.path = status, stdout, stderr, receipt_path
        self.receipt = ""
        if receipt_path and os.path.exists(receipt_path):
            with open(receipt_path, encoding="utf-8") as f:
                self.receipt = f.read()

    @property
    def receipt_lines(self):
        return [json.loads(line) for line in self.receipt.splitlines()]

    @property
    def everything(self):
        return self.stdout.text + self.stderr.text + self.receipt


def run_count(cwd, env, argv, body, over=None, inputs=None, **extra):
    out, err = Capture(), Capture()
    opts = dict(cwd=cwd, env=env, stdout=out, stderr=err, resolved=lambda args, c: {"command": "count", "args": args})
    if inputs is not None:
        opts["inputs"] = lambda args, c: inputs
    opts.update(extra)
    status = pe.main(tool(**(over or {})), ["t", *argv], lambda run, args: body(run), **opts)
    path = None
    if out.lines:
        try:
            path = json.loads(out.lines[0]).get("paths", {}).get("receipt")
        except ValueError:
            path = None
    return Outcome(status, out, err, path)


def assert_valid(tc, o, extra=EXTRA):
    """PY-17c: every JSON line on every stream validates against its exact pair."""
    texts = [line for line in o.stdout.lines + o.stderr.lines] + [line for line in o.receipt.splitlines()]
    for line in texts:
        obj = json.loads(line)
        v = pe.validate_line(obj, extra)
        tc.assertTrue(v.ok, f"{line}\n{v}")


def assert_lifecycle(tc, o):
    out, rec = o.stdout.objs, o.receipt_lines
    tc.assertEqual(out[0]["event"], "run")
    tc.assertEqual(out[0]["seq"], 0)
    tc.assertEqual(rec[0]["event"], "receipt.head")
    tc.assertEqual(out[-1]["event"], "end")
    tc.assertEqual(rec[-1]["event"], "end")
    tc.assertEqual(out[-1]["seq"], rec[-1]["seq"])
    seqs = {x["seq"] for x in out + rec + o.stderr.objs}
    tc.assertEqual(out[-1]["seq"], max(seqs))


class TestConformance(unittest.TestCase):
    def test_golden_run(self):
        d, _, env = scratch()
        with open(os.path.join(d, "a.txt"), "w") as f:
            f.write("hello")

        def body(run):
            run.step("read a.txt as UTF-8", "no BOM; the default is UTF-8", {"bytes": 5})
            run.warning("input.encoding_guessed", "a.txt has no BOM or charset; read as UTF-8", remedy="declare the encoding", remedy_target="a.txt")
            run.result({"event": "result", "value": 1}, T_COUNT)

        o = run_count(d, env, ["count"], body, inputs=[{"path": "a.txt"}])
        self.assertEqual(o.status, 0)
        assert_lifecycle(self, o)
        assert_valid(self, o)
        self.assertTrue(any(x["event"] == "receipt.inputs" for x in o.receipt_lines))
        self.assertEqual([x["event"] for x in o.stderr.objs], ["warning"])


class TestSequence(unittest.TestCase):
    def test_ten_thousand_results_one_gapless_counter(self):
        d, _, env = scratch()

        def body(run):
            for i in range(10_000):
                run.result({"event": "result", "value": i}, T_COUNT)
            run.warning("t.halfway", "a warning between the results")

        o = run_count(d, env, ["count"], body)
        self.assertEqual(o.status, 0)
        seen = {}
        for obj in o.stdout.objs + o.stderr.objs + o.receipt_lines:
            seen.setdefault(obj["seq"], obj["event"])
        final = o.stdout.objs[-1]["seq"]
        self.assertEqual(sorted(seen), list(range(final + 1)))
        self.assertEqual(len([x for x in o.stdout.objs if x["event"] == "result"]), 10_000)
        values = [x["value"] for x in o.stdout.objs if x["event"] == "result"]
        self.assertEqual(values, list(range(10_000)))


    def test_threads_emitting_at_once_share_one_counter(self):
        import threading
        d, _, env = scratch()

        def body(run):
            def work(k):
                for i in range(300):
                    run.result({"event": "result", "value": i}, T_COUNT)
                    if i % 50 == 0:
                        print(f"thread {k} at {i}")
            threads = [threading.Thread(target=work, args=(k,)) for k in range(8)]
            for th in threads:
                th.start()
            for th in threads:
                th.join()

        o = run_count(d, env, ["count"], body)
        self.assertEqual(o.status, 0)
        seqs = [x["seq"] for x in o.receipt_lines]
        self.assertEqual(seqs, list(range(1, o.stdout.objs[-1]["seq"] + 1)), "the receipt holds every seq after the bootstrap line, once, in order")
        self.assertEqual(len([x for x in o.stdout.objs if x["event"] == "result"]), 2400)
        self.assertEqual(len([x for x in o.receipt_lines if x.get("decision") == "captured stray output"]), 48)


class TestInv(unittest.TestCase):
    def body(self, run):
        run.result({"event": "result", "value": 1}, T_COUNT)

    @staticmethod
    def inv_of(o):
        for x in o.receipt_lines:
            if x["event"] == "receipt.inputs":
                return x.get("inv")
        return None

    def test_stable_then_changed_by_an_edit(self):
        d, _, env = scratch()
        p = os.path.join(d, "a.txt")
        with open(p, "w") as f:
            f.write("hello")
        a = run_count(d, env, ["count"], self.body, inputs=[{"path": "a.txt"}])
        b = run_count(d, env, ["count"], self.body, inputs=[{"path": "a.txt"}])
        self.assertRegex(self.inv_of(a), r"^[0-9a-f]{64}$")
        self.assertEqual(self.inv_of(a), self.inv_of(b))
        self.assertNotIn("inv", a.stdout.objs[0])
        inputs = next(x for x in a.receipt_lines if x["event"] == "receipt.inputs")
        self.assertEqual(inputs["inputs"][0]["sha256"], hashlib.sha256(b"hello").hexdigest())
        self.assertLess(inputs["seq"], a.receipt_lines[-1]["seq"])
        with open(p, "w") as f:
            f.write("hellp")
        c = run_count(d, env, ["count"], self.body, inputs=[{"path": "a.txt"}])
        self.assertNotEqual(self.inv_of(a), self.inv_of(c))
        assert_valid(self, a)

    def test_known_at_bootstrap_without_inputs(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count"], self.body)
        self.assertRegex(o.stdout.objs[0]["inv"], r"^[0-9a-f]{64}$")
        self.assertEqual(o.receipt_lines[0]["inv"], o.stdout.objs[0]["inv"])

    def test_missing_input_omits_inv(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count"], self.body, inputs=[{"path": "nope.txt"}])
        inputs = next(x for x in o.receipt_lines if x["event"] == "receipt.inputs")
        self.assertEqual(inputs["inputs"][0], {"path": "nope.txt", "error": "input.unreadable"})
        self.assertFalse(any("inv" in x for x in o.stdout.objs + o.receipt_lines))
        self.assertEqual(o.stdout.objs[-1]["event"], "end")
        assert_valid(self, o)

    def test_excludes_declared_secrets(self):
        d, _, env = scratch()
        a = run_count(d, env, ["count", "--token", "s3cret-one"], self.body)
        b = run_count(d, env, ["count", "--token", "s3cret-two"], self.body)
        self.assertEqual(a.stdout.objs[0]["inv"], b.stdout.objs[0]["inv"])

    def test_tree_and_stdin_inputs(self):
        d, _, env = scratch()
        os.mkdir(os.path.join(d, "src"))
        for name, text in (("a.txt", "one"), ("secret.pem", "key-1")):
            with open(os.path.join(d, "src", name), "w") as f:
                f.write(text)
        decl = [{"path": ".", "role": "tree", "exclude": ["src/secret.pem"]}]
        a = run_count(d, env, ["count"], lambda r: None, inputs=decl)
        with open(os.path.join(d, "src", "secret.pem"), "w") as f:
            f.write("key-2")
        b = run_count(d, env, ["count"], lambda r: None, inputs=decl)
        self.assertEqual(self.inv_of(a), self.inv_of(b))
        o = run_count(d, env, ["count"], lambda r: r.input("-", "from stdin"), inputs=[{"path": "-", "role": "stdin"}])
        inputs = next(x for x in o.receipt_lines if x["event"] == "receipt.inputs")
        self.assertEqual(inputs["inputs"][0]["sha256"], hashlib.sha256(b"from stdin").hexdigest())

    def test_an_input_the_handler_could_not_read_is_recorded_unread(self):
        # PY-15g (flyingrobots/parley#110): the handler fails to read a declared input, says so,
        # and the file appears before end. The writer must not hash bytes the program never saw.
        d, _, env = scratch()
        refused = []

        def body(run):
            run.input_unreadable("dag.json")
            with open(os.path.join(run.cwd, "dag.json"), "w") as f:
                f.write("{}")
            try:
                run.input_unreadable("typo.json")
            except ValueError:
                refused.append("undeclared")
            run.finalise_inputs()
            try:
                run.input_unreadable("dag.json")
            except ValueError:
                refused.append("settled")
            run.error("dag_spec.unreadable", "could not read dag.json")

        o = run_count(d, env, ["count"], body, inputs=[{"path": "dag.json"}])
        self.assertEqual(o.status, 2)
        inputs = next(x for x in o.receipt_lines if x["event"] == "receipt.inputs")
        self.assertEqual(inputs["inputs"], [{"path": "dag.json", "error": "input.unreadable"}])
        self.assertFalse(any("inv" in x for x in o.stdout.objs + o.receipt_lines))
        self.assertEqual(refused, ["undeclared", "settled"])
        assert_valid(self, o)


class TestRedaction(unittest.TestCase):
    def test_declared_secrets_in_the_head(self):
        d, _, env = scratch()
        o = run_count(d, {**env, "T_TOKEN": SECRET}, ["count", "--token", SECRET, "--other=" + SECRET + "-tail", "--token=" + SECRET],
                      lambda r: None, over={"sources": {"netrc": lambda: True}})
        head = o.receipt_lines[0]
        self.assertEqual(head["argv"], ["t", "count", "--token", "[redacted]", "--other=[redacted]-tail", "--token=[redacted]"])
        self.assertEqual(head["redacted"]["argv"], [3, 4, 5])
        self.assertEqual(head["redacted"]["env"], ["T_TOKEN"])
        self.assertEqual(head["redacted"]["sources"], ["netrc"])
        self.assertTrue(head["redacted"]["resolved"])
        self.assertNotIn(SECRET, o.everything)
        self.assertIs(o.stdout.objs[-1]["redacted"], True)
        assert_valid(self, o)

    def test_a_later_surfacing_is_replaced_and_recorded(self):
        d, _, env = scratch()

        def body(run):
            run.step("fetched", "because", {"url": "https://x/?t=" + SECRET})
            run.result({"event": "result", "value": 1, "note": SECRET}, T_COUNT, {"extra": "token=" + SECRET})
            run.error("fetch.failed", "the fetch of " + SECRET + " failed")

        o = run_count(d, env, ["count", "--token", SECRET], body)
        step = next(x for x in o.receipt_lines if x["event"] == "receipt.step")
        self.assertEqual(step["detail"]["url"], "https://x/?t=[redacted]")
        reds = [x for x in o.receipt_lines if x["event"] == "redaction"]
        self.assertIn({"in": step["seq"], "at": "/detail/url"}, [{"in": x["in"], "at": x["at"]} for x in reds])
        self.assertTrue(any(x["at"] == "/extra" for x in reds))
        self.assertNotIn(SECRET, o.everything)
        self.assertEqual(o.status, 2)
        assert_valid(self, o)

    def test_no_redacted_field_when_nothing_was_redacted(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count"], lambda r: None)
        self.assertNotIn("redacted", o.receipt_lines[0])
        self.assertIs(o.stdout.objs[-1]["redacted"], False)

    def test_scrub_widely_resolve_narrowly(self):
        """flyingrobots/parley#93, spec section 5.3: another command's variable is scrubbed and
        listed in redacted.env; its credential source is never resolved."""
        d, _, env = scratch()
        other = "b-token-value-q7"
        called = []

        def source(name):
            def resolve():
                called.append(name)
                return True
            return resolve

        effects = {"reads": [], "writes": [], "network": False, "idempotent": True}
        two = pe.define_tool(
            name="t", version="0.0.1",
            commands={
                "a": {"intent": "The command that runs", "effects": effects, "secrets": ["--token", "A_TOKEN", "alpha"], "emits": [{"id": "t.count", "version": "1.0.0", "schema": RESULT}]},
                "b": {"intent": "A command that does not run", "effects": effects, "secrets": ["B_TOKEN", "beta"], "emits": [{"id": "t.count", "version": "1.0.0", "schema": RESULT}]},
            },
            retention={"count": 100},
            sources={"alpha": source("alpha"), "beta": source("beta")},
        )
        out, err = Capture(), Capture()
        status = pe.main(two, ["t", "a", "--note=" + other], lambda run, a: run.step("noted", "the argument is echoed", {"note": other}),
                         cwd=d, env={**env, "B_TOKEN": other}, stdout=out, stderr=err)
        self.assertEqual(status, 0)
        o = Outcome(status, out, err, out.objs[0]["paths"]["receipt"])
        head = o.receipt_lines[0]
        self.assertEqual(head["argv"], ["t", "a", "--note=[redacted]"])
        self.assertEqual(head["redacted"]["env"], ["B_TOKEN"])
        self.assertEqual(head["redacted"]["sources"], ["alpha"])
        self.assertEqual(called, ["alpha"])
        self.assertNotIn(other, o.everything)
        assert_valid(self, o)

    def test_a_secret_in_the_working_directory_path_relocates_the_receipt(self):
        d, state, env = scratch()
        zone = os.path.join(d, "zone-x9")
        os.mkdir(zone)
        o = run_count(zone, env, ["count", "--token", "zone-x9"], lambda r: r.result({"event": "result", "value": 1, "note": "zone-x9 is in"}, T_COUNT))
        self.assertEqual(o.status, 0)
        self.assertTrue(o.path.startswith(os.path.join(state, "parley")))
        self.assertNotIn("zone-x9", o.everything)
        self.assertTrue(any(x["event"] == "warning" and x["code"] == "receipt.relocated" for x in o.stderr.objs))
        assert_valid(self, o)

    def test_a_secret_every_receipt_path_would_carry_is_a_startup_failure(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count", "--token", "receipts"], lambda r: None)
        self.assertEqual(o.status, 3)
        self.assertEqual(o.stdout.lines, [])
        self.assertEqual([x["code"] for x in o.stderr.objs], ["startup.secret_in_path"])
        self.assertNotIn("receipts", o.stderr.text)

    def test_numbers_keys_and_nested_secrets(self):
        d, _, env = scratch()
        resolved = lambda args, c: {"command": "count", "pin": int(args[1]), args[1]: True}  # noqa: E731
        out1 = run_count(d, env, ["count", "--token", "4321"], lambda r: r.step("checked", "because", {4321: "key", "n": 4321}), resolved=resolved)
        out2 = run_count(d, env, ["count", "--token", "9999"], lambda r: None, resolved=resolved)
        head = out1.receipt_lines[0]
        self.assertEqual(head["resolved"]["pin"], "[redacted]")
        self.assertIs(head["resolved"]["[redacted]"], True)
        self.assertEqual(sorted(head["redacted"]["resolved"]), ["/[redacted]", "/pin"])
        self.assertEqual(head["inv"], out2.receipt_lines[0]["inv"])
        self.assertNotIn("4321", out1.receipt)
        o = run_count(d, {**env, "T_TOKEN": "abcdef"}, ["count", "--token", "abc"], lambda r: r.step("s", "b", {"a": "abcdef", "b": "abc", "c": "xabcdefx"}))
        step = next(x for x in o.receipt_lines if x["event"] == "receipt.step")
        self.assertEqual(step["detail"], {"a": "[redacted]", "b": "[redacted]", "c": "x[redacted]x"})
        self.assertNotIn("def", o.receipt)

    def test_writer_scalars_and_identity_are_left_alone(self):
        d, _, env = scratch()
        o = run_count(d, {**env, "T_TOKEN": "4729"}, ["count", "--token", "false", "--dry-run"], lambda r: r.step("s", "b", {"flag": False, "n": 4729}))
        self.assertEqual(o.status, 0)
        self.assertIs(o.stdout.objs[0]["dry_run"], True)
        self.assertIs(o.receipt_lines[0]["effects"]["network"], False)
        step = next(x for x in o.receipt_lines if x["event"] == "receipt.step")
        self.assertEqual(step["detail"], {"flag": "[redacted]", "n": "[redacted]"})
        for secret in ("count", "1.0.0"):
            out, err = Capture(), Capture()
            self.assertEqual(pe.main(tool(), ["t", "--schema", "--token", secret], lambda r, a: None, cwd=d, env=env, stdout=out, stderr=err), 0)
            cmd = next(x for x in out.objs if x["event"] == "command")
            self.assertEqual(cmd["name"], "count")
            self.assertEqual(cmd["emits"][0], {"id": "t.count", "version": "1.0.0"})

    def test_a_secret_in_the_session_is_a_startup_failure(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count", "--token", "s3s"], lambda r: None, session="ses_s3s_1")
        self.assertEqual(o.status, 3)
        self.assertEqual([x["code"] for x in o.stderr.objs], ["startup.secret_in_identity"])
        self.assertNotIn("s3s", o.stderr.text)


class TestStartupFailure(unittest.TestCase):
    def test_no_writable_location(self):
        d, state, env = scratch()
        os.chmod(d, 0o555)
        os.chmod(state, 0o555)
        try:
            o = run_count(d, env, ["count"], lambda r: None)
        finally:
            os.chmod(d, 0o755)
            os.chmod(state, 0o755)
        self.assertEqual(o.status, 3)
        self.assertEqual(o.stdout.lines, [])
        self.assertEqual(len(o.stderr.objs), 1)
        line = o.stderr.objs[0]
        self.assertEqual((line["event"], line["seq"], line["code"]), ("startup.failed", 0, "startup.receipt_unwritable"))
        self.assertTrue(pe.validate_line(line).ok)

    def test_read_only_working_directory_falls_back(self):
        d, state, env = scratch()
        os.chmod(d, 0o555)
        try:
            o = run_count(d, env, ["count"], lambda r: None)
        finally:
            os.chmod(d, 0o755)
        self.assertEqual(o.status, 0)
        self.assertTrue(o.path.startswith(os.path.join(state, "parley")))
        self.assertEqual(os.path.dirname(o.path), pe.state_receipt_dir(d, env))

    def test_unknown_command(self):
        d, _, env = scratch()
        two = dict(commands={
            "count": {"intent": "count", "effects": {"reads": [], "writes": [], "network": False, "idempotent": True}, "secrets": ["--token"], "emits": [{"id": "t.count", "version": "1.0.0"}]},
            "other": {"intent": "other", "effects": {"reads": [], "writes": [], "network": False, "idempotent": True}, "secrets": ["--key"], "emits": [{"id": "t.count", "version": "1.0.0"}]},
        })
        for argv in (["--token", SECRET], ["__class__"]):
            o = run_count(d, env, argv, lambda r: None, over=two)
            self.assertEqual(o.status, 3)
            self.assertEqual(o.stdout.lines, [])
            self.assertEqual([x["code"] for x in o.stderr.objs], ["startup.unknown_command"])
            self.assertNotIn(SECRET, o.stderr.text)
        self.assertFalse(os.path.exists(os.path.join(d, ".parley", "receipts")) and os.listdir(os.path.join(d, ".parley", "receipts")))

    def test_a_raising_resolver_is_arguments_invalid(self):
        d, _, env = scratch()

        def bad(args, c):
            raise ValueError("bad value " + SECRET)

        o = run_count(d, env, ["count", "--token", SECRET], lambda r: None, resolved=bad)
        self.assertEqual(o.status, 3)
        self.assertEqual(o.stdout.lines, [])
        self.assertEqual([x["code"] for x in o.stderr.objs], ["startup.arguments_invalid"])
        self.assertIn("[redacted]", o.stderr.objs[0]["problem"])
        self.assertNotIn(SECRET, o.stderr.text)
        self.assertEqual(os.listdir(os.path.join(d, ".parley", "receipts")), [])


class TestSinks(unittest.TestCase):
    def test_a_stdout_failure_before_end_exits_4(self):
        d, _, env = scratch()
        out, err = Capture(fail_on='"result"'), Capture()
        status = pe.main(tool(), ["t", "count"], lambda run, a: run.result({"event": "result", "value": 1}, T_COUNT), cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 4)
        self.assertTrue(err.objs[0]["code"].startswith("sink."))
        o = Outcome(status, out, err, out.objs[0]["paths"]["receipt"])
        self.assertEqual(o.receipt_lines[-1]["status"], 4)
        self.assertTrue(any(x["event"] == "error" for x in o.receipt_lines))

    def test_a_stdout_failure_on_the_bootstrap_keeps_the_head_first(self):
        d, _, env = scratch()
        out, err = Capture(fail_on='"event":"run"'), Capture()
        status = pe.main(tool(), ["t", "count"], lambda run, a: None, cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 4)
        rdir = os.path.join(d, ".parley", "receipts")
        o = Outcome(status, out, err, os.path.join(rdir, os.listdir(rdir)[0]))
        self.assertEqual(o.receipt_lines[0]["event"], "receipt.head")
        self.assertTrue(any(x["event"] == "error" for x in o.receipt_lines))
        self.assertEqual((o.receipt_lines[-1]["event"], o.receipt_lines[-1]["status"]), ("end", 4))

    def test_stdout_closed_early_in_a_real_process(self):
        d, _, env = scratch()
        script = os.path.join(d, "many.py")
        with open(script, "w") as f:
            f.write(TOOL_SCRIPT + "sys.exit(pe.main(tool, ['t', 'count'], lambda run, a: [run.result({'event': 'result', 'value': i, 'pad': 'x' * 2000}, ('t.count', '1.0.0')) for i in range(400)]))\n")
        proc = subprocess.run(["bash", "-c", f"{sys.executable} {script} 2>err.txt | head -c 1 >/dev/null; exit ${{PIPESTATUS[0]}}"], cwd=d, env={**os.environ, **env}, capture_output=True)
        self.assertEqual(proc.returncode, 4)
        with open(os.path.join(d, "err.txt"), encoding="utf-8") as f:
            err = f.read()
        err_lines = err.splitlines()
        self.assertGreaterEqual(len(err_lines), 1)
        objs = [json.loads(line) for line in err_lines]
        self.assertEqual([x["code"] for x in objs], ["sink.write_failed"])
        self.assertNotIn("Traceback", err)
        rdir = os.path.join(d, ".parley", "receipts")
        o = Outcome(4, Capture(), Capture(), os.path.join(rdir, [n for n in os.listdir(rdir) if n.endswith(".jsonl")][0]))
        self.assertEqual((o.receipt_lines[-1]["event"], o.receipt_lines[-1]["status"]), ("end", 4))

    def test_a_stalled_nonblocking_pipe_is_waited_on(self):
        d, _, env = scratch()
        script = os.path.join(d, "big.py")
        with open(script, "w") as f:
            f.write("import os\nos.set_blocking(1, False)\n" + TOOL_SCRIPT + "sys.exit(pe.main(tool, ['t', 'count'], lambda run, a: [run.result({'event': 'result', 'value': i, 'pad': 'x' * 5000}, ('t.count', '1.0.0')) for i in range(60)]))\n")
        proc = subprocess.run(["bash", "-c", f"{sys.executable} {script} 2>err.txt | (sleep 1.5; cat); exit ${{PIPESTATUS[0]}}"], cwd=d, env={**os.environ, **env}, capture_output=True)
        with open(os.path.join(d, "err.txt"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "")
        self.assertEqual(proc.returncode, 0)
        lines = proc.stdout.decode("utf-8").splitlines()
        self.assertEqual(len(lines), 62)
        self.assertEqual(json.loads(lines[-1])["status"], 0)

    def test_nothing_follows_end(self):
        d, _, env = scratch()
        seen = {}

        def body(run):
            run.end(0)
            try:
                run.step("late", "too late")
            except pe.ParleyClosed:
                seen["closed"] = True

        o = run_count(d, env, ["count"], body)
        self.assertTrue(seen.get("closed"))
        self.assertEqual(o.status, 0)
        self.assertEqual(len([x for x in o.stdout.objs if x["event"] == "end"]), 1)
        assert_lifecycle(self, o)

    def test_misuse_is_refused(self):
        d, _, env = scratch()
        seen = []

        def body(run):
            for f in (lambda: run.result({"event": "result", "value": 1, "seq": 99}, T_COUNT),
                      lambda: run.result({"event": "result", "value": 1}, T_COUNT, {"run": "other"}),
                      lambda: run.page(None, True),
                      lambda: run.error("Not A Code", "p"),
                      lambda: run.warning("a.b", ""),
                      lambda: run.result({"event": "result", "value": float("nan")}, T_COUNT)):
                try:
                    f()
                except ValueError:
                    seen.append(True)
            run.error("x.y", "p")
            try:
                run.end(0)
            except ValueError:
                seen.append(True)

        o = run_count(d, env, ["count"], body)
        self.assertEqual(len(seen), 7)
        self.assertEqual(o.status, 2)
        assert_lifecycle(self, o)


TOOL_SCRIPT = (
    "import sys\n"
    f"sys.path.insert(0, {PACKAGE!r})\n"
    "import parley_emit as pe\n"
    "tool = pe.define_tool(name='t', version='0.0.1', commands={'count': {'intent': 'count', 'effects': {'reads': [], 'writes': [], 'network': False, 'idempotent': True}, 'secrets': [], 'emits': [{'id': 't.count', 'version': '1.0.0'}]}}, retention={'count': 10})\n"
)


class TestCapture(unittest.TestCase):
    def test_stray_output_lands_in_the_receipt(self):
        d, _, env = scratch()
        before = (sys.stdout, sys.stderr)

        def body(run):
            print("hello from a library")
            sys.stderr.write("and an error\n")
            sys.stdout.buffer.write(b"bytes too\n")
            logging.getLogger("some.library").warning("a logged warning")
            with warnings.catch_warnings():
                warnings.simplefilter("always")
                warnings.warn("a python warning")
            print("no newline at the end", end="")

        o = run_count(d, env, ["count"], body)
        self.assertEqual((sys.stdout, sys.stderr), before)
        self.assertEqual(o.stderr.lines, [])
        for line in o.stdout.lines:
            json.loads(line)
        for text in ("hello from a library", "and an error", "bytes too", "a logged warning", "a python warning", "no newline at the end"):
            self.assertIn(text, o.receipt)
        assert_valid(self, o)

    def test_a_library_asking_for_the_descriptor_is_refused(self):
        import faulthandler
        d, _, env = scratch()
        o = run_count(d, env, ["count"], lambda r: faulthandler.enable())
        self.assertEqual(o.status, 2)
        self.assertEqual([x["code"] for x in o.stderr.objs], ["uncaught.exception"])
        self.assertIn("UnsupportedOperation", o.stderr.objs[0]["problem"])
        self.assertFalse(faulthandler.is_enabled())

    def test_output_before_the_receipt_exists_is_held(self):
        d, _, env = scratch()

        def resolver():
            print("resolver says hello")
            return False

        o = run_count(d, env, ["count"], lambda r: None, over={"sources": {"netrc": resolver}})
        self.assertIn("resolver says hello", o.receipt)
        self.assertEqual(o.receipt_lines[0]["event"], "receipt.head")

    def test_in_a_real_process_nothing_but_protocol_lines(self):
        d, _, env = scratch()
        script = os.path.join(d, "noisy.py")
        with open(script, "w") as f:
            f.write(TOOL_SCRIPT + "import logging, warnings\n"
                    "def body(run, a):\n"
                    "    print('printed-in-process'); logging.error('logged-in-process'); warnings.warn('warned-in-process')\n"
                    "    run.result({'event': 'result', 'value': 1}, ('t.count', '1.0.0'))\n"
                    "sys.exit(pe.main(tool, ['t', 'count'], body))\n")
        proc = subprocess.run([sys.executable, script], cwd=d, env={**os.environ, **env}, capture_output=True)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")
        lines = proc.stdout.decode("utf-8").splitlines()
        for line in lines:
            json.loads(line)
        with open(json.loads(lines[0])["paths"]["receipt"], encoding="utf-8") as f:
            receipt = f.read()
        for text in ("printed-in-process", "logged-in-process", "warned-in-process"):
            self.assertIn(text, receipt)


class TestTopLevelHandler(unittest.TestCase):
    def test_an_exception_in_the_handler_is_an_error_line(self):
        d, _, env = scratch()

        def body(run):
            raise RuntimeError("boom")

        o = run_count(d, env, ["count"], body)
        self.assertEqual(o.status, 2)
        err = o.stderr.objs[0]
        self.assertEqual(err["code"], "uncaught.exception")
        self.assertIn("boom", err["problem"])
        self.assertNotIn("detail", err)
        rec = next(x for x in o.receipt_lines if x["event"] == "error")
        self.assertEqual(rec["seq"], err["seq"])
        self.assertIn("Traceback", rec["detail"]["traceback"])
        self.assertNotIn("Traceback", o.stderr.text)
        self.assertEqual(o.stdout.objs[-1]["status"], 2)
        assert_valid(self, o)
        assert_lifecycle(self, o)

    def test_a_failure_inside_the_writer_itself(self):
        d, _, env = scratch()
        saved = (pe._retain, pe._choose_location)
        before = (sys.stdout, sys.stderr)

        def broken(*a, **k):
            raise RuntimeError("the writer broke")

        try:
            pe._retain = broken  # after the bootstrap line: an error line and end
            after = run_count(d, env, ["count"], lambda r: None)
            pe._retain = saved[0]
            pe._choose_location = broken  # before it: one startup line
            before_boot = run_count(d, env, ["count"], lambda r: None)
        finally:
            pe._retain, pe._choose_location = saved
        self.assertEqual(after.status, 2)
        self.assertEqual([x["code"] for x in after.stderr.objs], ["uncaught.writer_failure"])
        assert_lifecycle(self, after)
        assert_valid(self, after)
        self.assertEqual(before_boot.status, 3)
        self.assertEqual(before_boot.stdout.lines, [])
        self.assertEqual([x["code"] for x in before_boot.stderr.objs], ["startup.writer_failed"])
        self.assertTrue(pe.validate_line(before_boot.stderr.objs[0]).ok)
        self.assertEqual((sys.stdout, sys.stderr), before)

    def test_a_writer_failure_after_the_reservation_leaves_no_receipt(self):
        d, _, env = scratch()
        saved = pe.Run

        def broken(*a, **k):
            raise RuntimeError("the writer broke between the reservation and the bootstrap line")

        try:
            pe.Run = broken
            o = run_count(d, env, ["count"], lambda r: None)
        finally:
            pe.Run = saved
        self.assertEqual(o.status, 3)
        self.assertEqual([x["code"] for x in o.stderr.objs], ["startup.writer_failed"])
        self.assertEqual(os.listdir(os.path.join(d, ".parley", "receipts")), [], "a startup failure leaves no receipt (spec section 3.2)")

    def test_system_exit_and_keyboard_interrupt(self):
        d, _, env = scratch()
        for exc, code in ((SystemExit(5), "uncaught.exit"), (KeyboardInterrupt(), "uncaught.exception")):
            def body(run, exc=exc):
                raise exc
            o = run_count(d, env, ["count"], body)
            self.assertEqual(o.status, 2)
            self.assertEqual([x["code"] for x in o.stderr.objs], [code])
            assert_lifecycle(self, o)
        o = run_count(d, env, ["count"], lambda r: sys.exit(0))
        self.assertEqual(o.status, 0)

    def test_a_raising_renderer_falls_back_and_warns_once(self):
        d, _, env = scratch()
        out, err = Capture(), Capture()

        def boom(line):
            raise RuntimeError("renderer broke")

        def body(run, a):
            run.result({"event": "result", "value": 2}, T_COUNT)
            run.result({"event": "result", "value": 3}, T_COUNT)

        status = pe.main(tool(human=boom), ["t", "count", "--human"], body, cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 0)
        self.assertIn("result:", out.text)
        self.assertEqual(len([line for line in err.lines if "human.renderer_failed" in line]), 1)

    def test_a_raising_source_resolver_means_not_present(self):
        d, _, env = scratch()

        def bad():
            raise OSError("keychain locked")

        o = run_count(d, env, ["count"], lambda r: None, over={"sources": {"netrc": bad}})
        self.assertEqual(o.status, 0)
        self.assertNotIn("redacted", o.receipt_lines[0])

    def test_a_raise_during_discovery_is_an_error_line(self):
        d, _, env = scratch()
        circular = {}
        circular["self"] = circular
        cmd = dict(tool().commands["count"])
        cmd["emits"] = [{"id": "t.count", "version": "1.0.0", "schema": circular}]
        out, err = Capture(), Capture()
        status = pe.main(tool(commands={"count": cmd}), ["t", "--schema"], lambda r, a: None, cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 2)
        self.assertEqual([x["code"] for x in err.objs], ["uncaught.exception"])
        self.assertEqual((out.objs[-1]["event"], out.objs[-1]["status"]), ("end", 2))

    def test_a_record_that_is_not_json_leaves_no_gap(self):
        d, _, env = scratch()

        def body(run):
            run.result({"event": "result", "value": 1}, T_COUNT)
            run.result({"event": "result", "value": object()}, T_COUNT)

        o = run_count(d, env, ["count"], body)
        self.assertEqual(o.status, 2)
        self.assertEqual(o.stderr.objs[0]["code"], "uncaught.exception")
        seqs = sorted({x["seq"] for x in o.stdout.objs + o.stderr.objs + o.receipt_lines})
        self.assertEqual(seqs, list(range(seqs[-1] + 1)))


class TestDiscovery(unittest.TestCase):
    def test_schema_is_a_run(self):
        d, _, env = scratch()
        out, err = Capture(), Capture()

        def must_not_run(run, a):
            raise AssertionError("handler must not run")

        self.assertEqual(pe.main(tool(), ["t", "--schema"], must_not_run, cwd=d, env=env, stdout=out, stderr=err), 0)
        self.assertEqual(out.objs[0]["event"], "run")
        self.assertEqual(out.objs[-1]["event"], "end")
        self.assertEqual([x["name"] for x in out.objs if x["event"] == "command"], ["count"])
        ids = [f"{x['id']}@{x['version']}" for x in out.objs if x["event"] == "schema"]
        for want in ("t.count@1.0.0", "parley.error@2.0.0", "parley.run.bootstrap@1.1.1", "parley.startup.failed@1.0.0"):
            self.assertIn(want, ids)
        self.assertNotIn("parley.history.transform@1.0.0", ids)
        assert_valid(self, Outcome(0, out, err, out.objs[0]["paths"]["receipt"]))

    def test_help_describes_one_command_and_its_error_types(self):
        d, _, env = scratch()
        out, err = Capture(), Capture()
        self.assertEqual(pe.main(tool(), ["t", "count", "--help"], lambda r, a: None, cwd=d, env=env, stdout=out, stderr=err), 0)
        self.assertEqual(len([x for x in out.objs if x["event"] == "command"]), 1)
        ids = [f"{x['id']}@{x['version']}" for x in out.objs if x["event"] == "schema"]
        self.assertEqual(ids, ["t.count@1.0.0", "parley.error@2.0.0", "parley.startup.failed@1.0.0"])

    def test_a_schema_document_is_published_as_declared(self):
        # PY-4d (flyingrobots/parley#111): a declared secret whose value occurs in a static schema
        # document must not rewrite it; the command line, which carries paths, is still scrubbed.
        d, _, env = scratch()
        env = {**env, "T_TOKEN": "object"}
        commands = {"count": {
            "intent": "Count each object under the working directory",
            "effects": {"reads": ["<cwd>/**"], "writes": [], "network": False, "idempotent": True},
            "secrets": ["T_TOKEN"],
            "emits": [{"id": "t.count", "version": "1.0.0", "schema": RESULT}],
        }}
        out, err = Capture(), Capture()
        status = pe.main(tool(commands=commands), ["t", "count", "--help"], lambda r, a: None, cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 0)
        docs = {x["id"]: x["schema"] for x in out.objs if x["event"] == "schema"}
        self.assertEqual(docs["t.count"], RESULT)
        self.assertEqual(docs["parley.error"], pe.schema_for(("parley.error", "2.0.0")))
        command = next(x for x in out.objs if x["event"] == "command")
        self.assertEqual(command["intent"], "Count each [redacted] under the working directory")
        o = Outcome(status, out, err, out.objs[0]["paths"]["receipt"])
        schema_seqs = {x["seq"] for x in o.receipt_lines if x["event"] == "schema"}
        self.assertFalse(any(x["in"] in schema_seqs for x in o.receipt_lines if x["event"] == "redaction"))
        self.assertTrue(o.stdout.objs[-1]["redacted"])
        assert_valid(self, o)


PLAIN = {"reads": [], "writes": [], "network": False, "idempotent": True}
TWO_COMMANDS = {
    "plan": {"intent": "plan", "effects": PLAIN, "emits": [{"id": "t.count", "version": "1.0.0"}]},
    "edit": {"intent": "edit", "effects": PLAIN, "emits": [{"id": "t.count", "version": "1.0.0"}]},
}


def select(argv, commands=None):
    """Run argv through `main` and return (status, the command and arguments `resolved` saw, those the handler saw, stderr codes)."""
    d, _, env = scratch()
    out, err = Capture(), Capture()
    seen = {}

    def resolved(args, command):
        seen["resolved"] = (command, list(args))
        return {"command": command, "args": list(args)}

    def handler(run, args):
        seen["handler"] = list(args)

    over = {"commands": commands} if commands is not None else {}
    status = pe.main(tool(**over), ["t", *argv], handler, cwd=d, env=env, stdout=out, stderr=err, resolved=resolved)
    return status, seen.get("resolved"), seen.get("handler"), [x.get("code") for x in err.objs]


class TestCommandSelection(unittest.TestCase):
    """PY-21: the command is the first argument once the writer's flags are set aside, and only it is removed."""

    def test_a_flag_value_equal_to_the_commands_name_reaches_the_tool(self):
        status, resolved, handler, _ = select(["edit", "--reason", "edit"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", ["--reason", "edit"]))
        self.assertEqual(handler, ["--reason", "edit"])

    def test_a_flag_value_naming_another_command_does_not_select_it(self):
        status, resolved, handler, _ = select(["edit", "--reason", "plan"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", ["--reason", "plan"]))
        self.assertEqual(handler, ["--reason", "plan"])

    def test_the_command_is_the_first_argument_once_the_writers_flags_are_set_aside(self):
        status, resolved, handler, codes = select(["--reason", "plan", "edit"], TWO_COMMANDS)
        self.assertEqual(status, 3)
        self.assertEqual(codes, ["startup.unknown_command"])
        self.assertIsNone(resolved)
        self.assertIsNone(handler)
        status, resolved, handler, _ = select(["--dry-run", "edit", "--reason", "edit"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", ["--reason", "edit"]))
        self.assertEqual(handler, ["--reason", "edit"])

    def test_a_one_command_tool_removes_its_name_only_from_the_first_position(self):
        for argv in (["count", "--label", "count"], ["--label", "count"]):
            status, resolved, handler, _ = select(argv)
            self.assertEqual(status, 0, argv)
            self.assertEqual(resolved, ("count", ["--label", "count"]), argv)
            self.assertEqual(handler, ["--label", "count"], argv)


def dash(argv, commands=None):
    """Run argv through `main`; return (status, resolved's view, the handler's args, its dry_run, stdout objects, stderr codes)."""
    d, _, env = scratch()
    out, err = Capture(), Capture()
    seen = {}

    def resolved(args, command):
        seen["resolved"] = (command, list(args))
        return {"command": command, "args": list(args)}

    def handler(run, args):
        seen["handler"] = list(args)
        seen["dry_run"] = run.dry_run

    over = {"commands": commands} if commands is not None else {}
    status = pe.main(tool(**over), ["t", *argv], handler, cwd=d, env=env, stdout=out, stderr=err, resolved=resolved)
    return status, seen.get("resolved"), seen.get("handler"), seen.get("dry_run"), out.objs, [x.get("code") for x in err.objs]


class TestDoubleDash(unittest.TestCase):
    """PY-22: `--` ends the writer's flags; the first `--` is removed and everything after it reaches the tool."""

    def test_a_writer_flag_before_the_double_dash_is_the_writers(self):
        status, _, handler, _, out, _ = dash(["edit", "--note", "-h"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertIsNone(handler)
        self.assertEqual([o["name"] for o in out if o.get("event") == "command"], ["edit"])

    def test_after_the_double_dash_a_writer_flags_text_reaches_the_tool(self):
        status, resolved, handler, _, out, _ = dash(["edit", "--", "--note", "-h"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", ["--note", "-h"]))
        self.assertEqual(handler, ["--note", "-h"])
        self.assertFalse(any(o.get("event") == "command" for o in out))

    def test_only_the_first_double_dash_is_removed(self):
        status, resolved, handler, _, _, _ = dash(["edit", "--"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", []))
        self.assertEqual(handler, [])
        status, resolved, handler, _, _, _ = dash(["edit", "--", "a", "--", "b"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("edit", ["a", "--", "b"]))
        self.assertEqual(handler, ["a", "--", "b"])

    def test_writer_flags_after_the_double_dash_are_not_the_writers(self):
        status, _, handler, dry_run, out, _ = dash(["edit", "--", "--dry-run", "--human"], TWO_COMMANDS)
        self.assertEqual(status, 0)
        self.assertIs(dry_run, False)
        self.assertNotIn("dry_run", out[0])
        self.assertEqual(handler, ["--dry-run", "--human"])

    def test_the_command_is_never_taken_from_after_the_double_dash(self):
        status, _, handler, _, _, codes = dash(["--", "edit"], TWO_COMMANDS)
        self.assertEqual(status, 3)
        self.assertEqual(codes, ["startup.unknown_command"])
        self.assertIsNone(handler)
        status, resolved, handler, _, _, _ = dash(["--", "count"])
        self.assertEqual(status, 0)
        self.assertEqual(resolved, ("count", ["count"]))
        self.assertEqual(handler, ["count"])


class TestHygiene(unittest.TestCase):
    def test_the_ignore_file_is_created_whole(self):
        d, _, env = scratch()
        run_count(d, env, ["count"], lambda r: None)
        with open(os.path.join(d, ".parley", ".gitignore")) as f:
            self.assertEqual(f.read(), "*\n")
        self.assertEqual(sorted(os.listdir(os.path.join(d, ".parley"))), [".gitignore", "receipts"])

    def test_an_existing_ignore_file_is_never_overwritten(self):
        d, _, env = scratch()
        os.mkdir(os.path.join(d, ".parley"))
        with open(os.path.join(d, ".parley", ".gitignore"), "w") as f:
            f.write("# mine\n*\n!keep\n")
        o = run_count(d, env, ["count"], lambda r: None)
        with open(os.path.join(d, ".parley", ".gitignore")) as f:
            self.assertEqual(f.read(), "# mine\n*\n!keep\n")
        self.assertTrue(o.path.startswith(os.path.join(d, ".parley")))

    def test_a_users_ignore_file_sends_the_receipt_to_the_fallback(self):
        d, state, env = scratch()
        os.mkdir(os.path.join(d, ".parley"))
        with open(os.path.join(d, ".parley", ".gitignore"), "w") as f:
            f.write("receipts/\n")
        o = run_count(d, env, ["count"], lambda r: None)
        with open(os.path.join(d, ".parley", ".gitignore")) as f:
            self.assertEqual(f.read(), "receipts/\n")
        self.assertTrue(o.path.startswith(os.path.join(state, "parley")))
        self.assertTrue(any(x["code"] == "receipt.relocated" for x in o.stderr.objs))
        assert_valid(self, o)

    def test_a_negation_that_can_reinclude_receipts_sends_the_receipt_to_the_fallback(self):
        # PY-12d (flyingrobots/parley#109): with `*`, nothing under receipts/ can be staged unless a
        # negation re-includes the directory itself; a writer that cannot tell treats it as one.
        for text in ("*\n!receipts/\n!receipts/**\n", "*\n!rec*\n", "*\n!*/\n", "*\n!**/receipts\n",
                     "*\n!receipts/**\n", "*\n!/Receipts/\n", "*\n!r[e]ceipts\n"):
            with self.subTest(text=text):
                d, state, env = scratch()
                os.mkdir(os.path.join(d, ".parley"))
                with open(os.path.join(d, ".parley", ".gitignore"), "w") as f:
                    f.write(text)
                o = run_count(d, env, ["count"], lambda r: None)
                with open(os.path.join(d, ".parley", ".gitignore")) as f:
                    self.assertEqual(f.read(), text)
                self.assertTrue(o.path.startswith(os.path.join(state, "parley")), o.path)
                warn = next(x for x in o.stderr.objs if x.get("code") == "receipt.relocated")
                self.assertIn("negation", warn["problem"])
                assert_valid(self, o)
        for text in ("*\n!keep\n", "*\n# !receipts/\n", "*\n\\!receipts\n", "*\n"):
            with self.subTest(text=text):
                d, _, env = scratch()
                os.mkdir(os.path.join(d, ".parley"))
                with open(os.path.join(d, ".parley", ".gitignore"), "w") as f:
                    f.write(text)
                o = run_count(d, env, ["count"], lambda r: None)
                self.assertTrue(o.path.startswith(os.path.join(d, ".parley")), o.path)


class TestRetention(unittest.TestCase):
    def test_by_count_oldest_first(self):
        d, _, env = scratch()
        paths = []
        for _ in range(5):
            paths.append(run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 3}}).path)
            time.sleep(0.01)
        rdir = os.path.join(d, ".parley", "receipts")
        self.assertEqual(len([n for n in os.listdir(rdir) if n.endswith(".jsonl")]), 3)
        self.assertFalse(os.path.exists(paths[0]))
        self.assertFalse(os.path.exists(paths[1]))
        self.assertTrue(os.path.exists(paths[4]))
        with open(paths[4]) as f:
            self.assertTrue(any(json.loads(line).get("decision", "").startswith("retention: deleted") for line in f))

    def test_per_tool_another_tools_receipts_are_never_counted_or_deleted(self):
        d, _, env = scratch()
        rdir = os.path.join(d, ".parley", "receipts")
        os.makedirs(rdir)
        os.makedirs(os.path.join(d, ".parley"), exist_ok=True)
        with open(os.path.join(d, ".parley", ".gitignore"), "w") as f:
            f.write("*\n")
        others = []
        for i in range(6):
            name = pe.ulid(1000 + i) + ".jsonl"
            head = {"event": "receipt.head", "t": 1, "seq": 1, "run": name[:-6], "tool": "parley-read" if i % 2 else "other", "v": "1", "argv": [], "resolved": {}, "inputs": [], "_schema": pe.SCHEMA_IDS["head"]}
            end = {"event": "end", "t": 1, "seq": 2, "run": name[:-6], "status": 0, "receipt": os.path.join(rdir, name), "redacted": False, "_schema": pe.SCHEMA_IDS["end"]}
            with open(os.path.join(rdir, name), "w") as f:
                f.write(json.dumps(head) + "\n" + json.dumps(end) + "\n")
            os.utime(os.path.join(rdir, name), (1, 1))
            others.append(os.path.join(rdir, name))
        mine = [run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 2}}).path for _ in range(4)]
        for p in others:
            self.assertTrue(os.path.exists(p), p)
        self.assertEqual([os.path.exists(p) for p in mine], [False, False, True, True])

    def test_never_a_receipt_in_flight_and_sidecars_go_with_their_bundle(self):
        d, _, env = scratch()
        rows = [{"i": i, "text": "x" * 30} for i in range(3000)]
        big = run_count(d, env, ["count"], lambda r: r.result({"event": "result", "value": 1}, T_COUNT, {"rows": rows}), over={"retention": {"count": 1}})
        side = os.path.join(d, ".parley", "receipts", big.stdout.objs[0]["run"])
        self.assertTrue(os.path.isdir(side))
        # A receipt of this tool with no end, younger than a day: in flight.
        rdir = os.path.join(d, ".parley", "receipts")
        flight = os.path.join(rdir, pe.ulid(5) + ".jsonl")
        with open(flight, "w") as f:
            f.write(json.dumps({"event": "receipt.head", "t": 1, "seq": 1, "run": os.path.basename(flight)[:-6], "tool": "t", "v": "0.0.1", "argv": [], "resolved": {}, "inputs": [], "_schema": pe.SCHEMA_IDS["head"]}) + "\n")
        os.utime(flight, (time.time() - 3600, time.time() - 3600))
        run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 1}})
        self.assertFalse(os.path.exists(big.path))
        self.assertFalse(os.path.exists(side))
        self.assertTrue(os.path.exists(flight))

    def test_a_dry_run_deletes_nothing_and_says_so(self):
        d, _, env = scratch()
        for _ in range(3):
            run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 2}})
        rdir = os.path.join(d, ".parley", "receipts")
        before = len(os.listdir(rdir))
        o = run_count(d, env, ["count", "--dry-run"], lambda r: None, over={"retention": {"count": 1}})
        self.assertEqual(len(os.listdir(rdir)), before + 1)
        self.assertIs(o.stdout.objs[0]["dry_run"], True)
        self.assertIs(o.receipt_lines[0]["dry_run"], True)
        self.assertTrue(any(x.get("decision", "").startswith("retention: would delete") for x in o.receipt_lines))
        assert_valid(self, o)

    def test_a_receipt_that_moved_after_the_scan_is_spared(self):
        # PY-13f (flyingrobots/parley#112): an incomplete receipt silent for two days whose owner
        # appends after the scan. The age is read at the decision, and a receipt that moved since
        # is not deleted.
        d, _, env = scratch()
        run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 100}})
        rdir = os.path.join(d, ".parley", "receipts")
        stale = os.path.join(rdir, pe.ulid(5) + ".jsonl")
        with open(stale, "w") as f:
            f.write(json.dumps({"event": "receipt.head", "t": 1, "seq": 1, "run": os.path.basename(stale)[:-6], "tool": "t", "v": "0.0.1", "argv": [], "resolved": {}, "inputs": [], "_schema": pe.SCHEMA_IDS["head"]}) + "\n")
        two_days = time.time() - 2 * 86400
        os.utime(stale, (two_days, two_days))
        real = pe._has_ended

        def owner_appends(path):
            if path == stale:
                with open(stale, "a") as f:
                    f.write(json.dumps({"event": "receipt.step", "t": 2, "seq": 2, "run": os.path.basename(stale)[:-6], "decision": "resumed", "because": "its owner woke", "_schema": pe.SCHEMA_IDS["step"]}) + "\n")
            return real(path)

        with unittest.mock.patch.object(pe, "_has_ended", owner_appends):
            run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 1}})
        self.assertTrue(os.path.exists(stale))

    def test_sidecars_survive_when_the_receipt_cannot_be_unlinked(self):
        # PY-13g (flyingrobots/parley#113): a bundle is deleted together or not at all.
        d, _, env = scratch()
        rows = [{"i": i, "text": "x" * 30} for i in range(3000)]
        big = run_count(d, env, ["count"], lambda r: r.result({"event": "result", "value": 1}, T_COUNT, {"rows": rows}), over={"retention": {"count": 100}})
        side = os.path.join(os.path.dirname(big.path), big.stdout.objs[0]["run"])
        self.assertTrue(os.path.isdir(side))
        real = os.unlink

        def refuse(path, *a, **k):
            if os.path.abspath(path) == big.path:
                raise PermissionError(1, "Operation not permitted", path)
            return real(path, *a, **k)

        with unittest.mock.patch.object(pe.os, "unlink", refuse):
            o = run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 1}})
        self.assertTrue(os.path.exists(big.path))
        self.assertTrue(os.path.isdir(side))
        self.assertEqual(os.listdir(side), [f"{next(x for x in big.receipt_lines if x['event'] == 'sidecar')['source']}.json"])
        step = next(x for x in o.receipt_lines if x.get("decision", "").startswith("retention:"))
        self.assertNotIn(os.path.basename(big.path), step.get("detail", {}).get("receipts", []))

        # A receipt another run removed first: its sidecars still go, so no orphan is left.
        def gone(path, *a, **k):
            if os.path.abspath(path) == big.path:
                real(path)
                raise FileNotFoundError(2, "No such file or directory", path)
            return real(path, *a, **k)

        with unittest.mock.patch.object(pe.os, "unlink", gone):
            run_count(d, env, ["count"], lambda r: None, over={"retention": {"count": 1}})
        self.assertFalse(os.path.exists(big.path))
        self.assertFalse(os.path.exists(side))


class TestSidecars(unittest.TestCase):
    def test_a_large_record_is_stored_beside_the_receipt(self):
        d, _, env = scratch()
        rows = [{"i": i, "text": "x" * 30} for i in range(3000)]
        o = run_count(d, env, ["count"], lambda r: r.result({"event": "result", "value": 1}, T_COUNT, {"rows": rows}))
        res = next(x for x in o.stdout.objs if x["event"] == "result")
        self.assertNotIn("rows", res)
        side = next(x for x in o.receipt_lines if x["event"] == "sidecar")
        self.assertEqual(side["source"], res["seq"])
        with open(os.path.join(os.path.dirname(o.path), side["path"]), "rb") as f:
            stored = f.read()
        self.assertEqual(len(stored), side["bytes"])
        self.assertGreater(side["bytes"], pe.SIDECAR_THRESHOLD)
        self.assertEqual(hashlib.sha256(stored).hexdigest(), side["sha256"])
        self.assertEqual(len(json.loads(stored)["rows"]), 3000)
        self.assertFalse(any(x["event"] == "result" for x in o.receipt_lines))
        assert_valid(self, o)

    def test_a_blocked_sidecar_keeps_the_record_inline(self):
        d, _, env = scratch()
        rows = [{"i": i, "text": "x" * 30} for i in range(3000)]

        def body(run):
            with open(os.path.join(run.receipt_dir, run.id), "w") as f:
                f.write("a file where the sidecar directory should go")
            run.result({"event": "result", "value": 1}, T_COUNT, {"rows": rows})

        o = run_count(d, env, ["count"], body)
        self.assertEqual(o.status, 4)
        self.assertEqual(len(next(x for x in o.receipt_lines if x["event"] == "result")["rows"]), 3000)
        self.assertTrue(any(x["event"] == "error" and x["code"] == "sink.sidecar_failed" for x in o.receipt_lines))
        self.assertEqual(o.receipt_lines[-1]["status"], 4)

    def test_a_large_head_is_still_first_and_inline(self):
        d, _, env = scratch()
        o = run_count(d, env, ["count"], lambda r: None, resolved=lambda a, c: {"command": "count", "blob": "y" * 70_000})
        self.assertEqual(o.receipt_lines[0]["event"], "receipt.head")
        self.assertFalse(any(x["event"] == "sidecar" for x in o.receipt_lines))


class TestHuman(unittest.TestCase):
    def test_human_renders_prose_and_keeps_the_receipt(self):
        d, _, env = scratch()
        out, err = Capture(), Capture()
        t = tool(human=lambda line: f"counted {line['value']}" if line["event"] == "result" else None)
        status = pe.main(t, ["t", "count", "--human"], lambda run, a: run.result({"event": "result", "value": 9}, T_COUNT), cwd=d, env=env, stdout=out, stderr=err)
        self.assertEqual(status, 0)
        self.assertEqual(out.lines, ["counted 9\n"])
        rdir = os.path.join(d, ".parley", "receipts")
        with open(os.path.join(rdir, os.listdir(rdir)[0])) as f:
            lines = [json.loads(line) for line in f]
        self.assertEqual(lines[0]["event"], "receipt.head")
        self.assertEqual(lines[-1]["event"], "end")


class TestShippedSchemas(unittest.TestCase):
    def test_embedded_schemas_are_the_drafts(self):
        self.assertRegex(pe.SCHEMA_SOURCE["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(pe.schema_text_digests(), pe.SCHEMA_SOURCE["files"])
        drafts = os.path.join(ROOT, "schemas")
        files = sorted(f for f in os.listdir(drafts) if f.endswith(".schema.json"))
        self.assertEqual(sorted(pe.SCHEMA_SOURCE["files"]), files, "the embedded set differs from schemas/; run bun run sync-schemas in packages/parley-emit-py")
        for f in files:
            with open(os.path.join(drafts, f), "rb") as fh:
                self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), pe.SCHEMA_SOURCE["files"][f], f"{f} is stale; run bun run sync-schemas in packages/parley-emit-py")

    def test_every_shipped_schema_is_inside_the_checkers_subset(self):
        for s in pe.SCHEMAS:
            self.assertIsNone(pe.schema_subset_gap(s["schema"]), f"{s['id']}@{s['version']}")
        self.assertEqual(pe.schema_subset_gap({"type": "object", "properties": {"a": {"$ref": "#/$defs/x"}}}), "$ref")
        self.assertEqual(pe.schema_subset_gap({"type": "string", "format": "uri"}), "format uri")
        self.assertEqual(pe.check_record({"a": 1}, {"properties": {"a": {"uniqueItems": True}}}).unsupported, "uniqueItems")
        self.assertEqual(pe.validate_line({"event": "x", "_schema": {"id": "nobody.knows", "version": "1.0.0"}}).ok, False)

    def test_the_checker_reads_ecmascript_anchors(self):
        hexs = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
        self.assertTrue(pe.check_record("a" * 64, hexs).ok)
        self.assertFalse(pe.check_record("a" * 64 + "\n", hexs).ok)
        self.assertFalse(pe.check_record(True, {"type": "integer"}).ok)
        self.assertTrue(pe.check_record(2.0, {"type": "integer"}).ok)


ALLOWED_IMPORTS = {"__future__", "hashlib", "io", "json", "os", "re", "sys", "threading", "time", "traceback", "typing"}


class TestPortability(unittest.TestCase):
    def test_standard_library_only(self):
        with open(os.path.join(PACKAGE, "parley_emit.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        found = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                found.add((node.module or "").split(".")[0])
        self.assertTrue(found <= ALLOWED_IMPORTS, found - ALLOWED_IMPORTS)

    def test_runs_on_this_interpreter(self):
        self.assertGreaterEqual(sys.version_info[:2], (3, 9))

    def test_vendor_info_names_the_files_digest(self):
        proc = subprocess.run([sys.executable, os.path.join(PACKAGE, "parley_emit.py"), "--vendor-info"], capture_output=True)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")
        lines = proc.stdout.decode("utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        info = json.loads(lines[0])
        with open(os.path.join(PACKAGE, "parley_emit.py"), "rb") as f:
            self.assertEqual(info["sha256"], hashlib.sha256(f.read()).hexdigest())
        self.assertEqual(info["_schema"], {"id": "parley.tooling.vendor_info", "version": "1.0.0"})
        bad = subprocess.run([sys.executable, os.path.join(PACKAGE, "parley_emit.py"), "--nope"], capture_output=True)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stderr)["code"], "vendor.usage")

    def test_a_vendored_copy_runs_alone(self):
        d, _, env = scratch()
        vendor = os.path.join(d, "vendor")
        os.mkdir(vendor)
        shutil.copy(os.path.join(PACKAGE, "parley_emit.py"), vendor)
        with open(os.path.join(vendor, "tool.py"), "w") as f:
            f.write(TOOL_SCRIPT.replace(repr(PACKAGE), repr(vendor)) + "sys.exit(pe.main(tool, ['t', 'count'], lambda run, a: run.result({'event': 'result', 'value': 1}, ('t.count', '1.0.0'))))\n")
        work = os.path.join(d, "work")
        os.mkdir(work)
        proc = subprocess.run([sys.executable, "-I", os.path.join(vendor, "tool.py")], cwd=work, env={**os.environ, **env}, capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines()]
        self.assertEqual([x["event"] for x in lines], ["run", "result", "end"])


if __name__ == "__main__":
    unittest.main()
