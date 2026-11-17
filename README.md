# pi-code-hygiene

A small Pi extension that runs [codehygiene](https://github.com/brianbell-x/codehygiene) on every file the agent writes or edits, so readability problems that linters miss show up without anyone having to remember to ask.

[Install](#install) · [Modes](#modes) · [Limits](#limits-and-privacy) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

codehygiene scores structure instead of syntax: pyramid nesting, comments that repeat the next line, swallowed errors, `*Factory` and `*Manager` ceremony, cryptic short names, magic indices and copy-pasted blocks. Its author recommends running it from a hook in the agent harness rather than as a skill. This package is that hook. It does not replace `pi-lsp`, type checkers or your project's linter, and it does not check behavior or security.

Status: no release yet. The extension is checked with its own test suite and a real codehygiene install on Windows with Pi 1.5.2 and Node 26. Other platforms are untested. codehygiene is an early preview and its author documents false positives, so the extension starts in a mode that only measures.

## Install

The extension needs codehygiene installed outside the package: a Python environment with numpy and a checkout pinned to one commit. These commands create it under `%LOCALAPPDATA%\pi-hygiene` (PowerShell, [uv](https://docs.astral.sh/uv/) required):

```powershell
$dir = Join-Path $env:LOCALAPPDATA "pi-hygiene"
New-Item -ItemType Directory -Force $dir | Out-Null
git clone https://github.com/brianbell-x/codehygiene.git "$dir\src"
git -C "$dir\src" checkout 0221af718b51a56b6ee0fbea52f0bf42afa381bb
uv venv "$dir\venv"
uv pip install --python "$dir\venv\Scripts\python.exe" numpy==2.5.5

# The extension only runs when the files listed in this manifest still have these hashes.
$files = "__init__.py", "__main__.py", "update_check.py", "weights.npz"
$sha = [System.Security.Cryptography.SHA256]::Create()
$files | ForEach-Object {
  $bytes = [System.IO.File]::ReadAllBytes("$dir\src\codehygiene\$_")
  $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLower()
  "$hash *codehygiene/$_"
} | Set-Content "$dir\manifest.sha256" -Encoding ascii
```

Check that the `weights.npz` line starts with `72f35d4e48e128b8593ef831a804cd95e7e37dcb577ceca2f8985a35e29eb30b`. If you check out another commit, the manifest records whatever you installed; reading that code first is up to you. A hash detects accidental changes in that folder, not someone who can already write to it.

Then add the extension from a local clone of this repository and reload Pi:

```powershell
git clone https://github.com/Yivas/pi-code-hygiene.git
pi install .\pi-code-hygiene
# restart Pi, or run /reload
```

Requirements: Node.js 22.19 or later and Pi with the `tool_result` extension event.

## Modes

| Mode | What happens after a successful `edit` or `write` |
|-|-|
| `shadow` (default) | Analyzes the file in the background and appends one line to `state/shadow.jsonl`. The tool result is not changed and nothing waits. |
| `on` | Waits for the analysis (up to 3 s) and appends a short note with up to three findings of probability 0.55 or more. |
| `off` | Does nothing. |

Choose the mode with the `PI_CODE_HYGIENE_MODE` environment variable or by writing `shadow`, `on` or `off` to `%LOCALAPPDATA%\pi-hygiene\mode`. The file is read on every edit, so a change applies immediately. Without either, the mode is `shadow`; a mode file with any other text counts as `off`. In `on` mode a note looks like this:

```text
[code-hygiene] Heuristic readability notes for this file (codehygiene preview; false positives are expected):
  line 9: swallowed_error (0.88)
  line 5: noisy_comment (0.89)
Optional. Working code does not need rewriting to silence these.
```

The note is information. The extension never marks an edit as failed, never asks the agent to continue, and does not show the same note twice in a row for a file. Any failure (missing Python, changed files, timeout, crash) is recorded and otherwise ignored.

Other settings: `PI_CODE_HYGIENE_HOME` moves the install folder and `PI_CODE_HYGIENE_PYTHON` points to another interpreter.

## Limits and privacy

- It sees edits made through Pi's `edit` and `write` tools. Changes made by `bash`, by an editor, or by a subagent that does not load the extension are not analyzed.
- It analyzes files with the extensions codehygiene documents (`.py .ts .tsx .js .jsx .mjs .cjs .rs .go .c .h .cc .cpp .cxx .hpp .zig .java .cs .lua`), up to 200 KB, outside `node_modules`, `.git`, `.venv`, `venv`, `dist`, `build`, `target` and `__pycache__`. Paths containing `*`, `?` or `[` are skipped because codehygiene treats them as patterns.
- At most two analyses run at once and at most eight wait; the rest are skipped. The 3 s limit counts the wait for a free slot, so an edit is never held longer than that. A newer edit of the same file replaces the pending analysis. A file that changes while it is being analyzed produces no note.
- Each analysis starts a Python process and takes about 0.35 s on the development machine (Windows, Python 3.11, numpy 2.5.5). In `on` mode that time is added to the edit.
- Everything is local. The extension makes no network requests and codehygiene runs with `--no-update-check`. The log holds counts, timings and a salted hash of the path: no code, no paths and no text from the findings.
- codehygiene scores the whole file, not the lines you changed, so older problems can show up after a small edit.

## Documentation and support

Issues are welcome in [GitHub Issues](../../issues), pull requests as described in [CONTRIBUTING.md](CONTRIBUTING.md), and security reports through [SECURITY.md](SECURITY.md). No response time is promised. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

codehygiene is © Brian Bell and used under its MIT license; this package neither bundles nor redistributes it. This package is released under the [MIT License](LICENSE).
