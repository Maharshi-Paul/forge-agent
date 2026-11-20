# Flask tasks (pallets/flask 3.1.3)

These are the fixed Round 1 tasks from the competition brief. The demo repository
must be `pallets/flask` release tag `3.1.3` at commit `22d92470`.

Run `npm run demo:setup` to create the ignored `flask/` demo workspace.

---

## Task A - Inline edit (single file)

### Exact instruction to give the agent

Open `src/flask/helpers.py`, select the function `get_debug_flag`, and instruct:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

### Expected result

`get_debug_flag` treats `off` and `n` as false without changing the existing
behaviour for `0`, `false`, `no`, or other values. The proposed diff is reviewed
and accepted before the file is written.

### How to verify

```powershell
$env:FLASK_DEBUG = 'off'
python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
# False
```

### Status

- [ ] Run end to end through the extension
- [ ] Hunk reviewed and accepted
- [ ] Verification shown on screen

---

## Task B - Agent mode (three or more files, none named)

### Exact instruction to give the agent

In the agent panel, with no files mentioned, instruct:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

### Expected result

The agent discovers and proposes changes to at least three files (implementation,
test, and documentation), without being told their paths. Review and accept the
hunks, then briefly show the TrueForge session and tool calls.

### How to verify

```powershell
pytest tests/test_cli.py -q
flask --help
flask config
```

Show the passing test suite, the `config` command in help, and masked JSON.

### Status

- [ ] Run end to end through the extension
- [ ] Three or more files discovered unprompted
- [ ] Hunks reviewed and accepted
- [ ] Tests pass

---

## Task C - Resilience

### Exact instruction to give the agent

Configure TrueForge with an unreachable endpoint or an invalid key, then repeat
Task A.

### Expected result

The editor stays responsive, visibly reports the failure or automatically moves to
the configured fallback model, and does not silently write any files.

### How to verify

```powershell
git status --short
```

The Flask working tree remains clean after the failed or rerouted turn.

### Status

- [ ] Run end to end through the extension
- [ ] Primary failure and fallback shown
- [ ] Workspace remains clean
