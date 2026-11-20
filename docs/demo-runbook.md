# Four-minute Round 1 demo

Prepare the environment first:

```powershell
npm install
npm run demo:setup
npm run build
code flask
```

In the Extension Development Host, add the two upstreams from
`.vscode/settings.example.json` to the Flask workspace settings. Store their keys
using **Forge: Configure API Key**. Use the same provider for both entries if it
offers two usable models.

Record these scenes in order. Waiting time may be removed, but do not cut from an
instruction to its diff.

1. **Task A (0:00-0:55):** open and select `get_debug_flag`, run the exact Task A
   instruction, accept the hunk, then show `FLASK_DEBUG=off` returning `False`.
2. **Task B (0:55-2:35):** open Forge chat in the Flask workspace and paste the
   exact Task B instruction without mentioning paths. Show the Output Channel
   tools, the TrueForge session, the three-file review, `pytest tests/test_cli.py
   -q`, `flask --help`, and `flask config` masking values.
3. **Task C (2:35-3:40):** restore a clean Flask tree, toggle **Forge: Break
   Primary Model**, repeat Task A, and show the proxy moving to the fallback model.
   Finish with `git status --short` proving no unreviewed write occurred.
4. **Close (3:40-4:00):** briefly show the hunk review controls and README setup.

Before recording, reset the demo repository with `git -C flask reset --hard
22d92470` and confirm `git -C flask status --short` produces no output.
