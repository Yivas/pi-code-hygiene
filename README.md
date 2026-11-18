# pi-code-hygiene

A small Pi extension that runs [codehygiene](https://github.com/brianbell-x/codehygiene) on every file the agent writes or edits, so readability problems that linters miss show up without anyone having to remember to ask.

> **Built on codehygiene, by Brian Bell.** The analysis, the model and the idea of running it from a hook are his work: [brianbell-x/codehygiene](https://github.com/brianbell-x/codehygiene). This package is an independent Pi integration and is not affiliated with or endorsed by him. It contains none of his code; it installs and calls his tool as a separate program.

[Install](#install) · [Modes](#modes) · [Limits](#limits-and-privacy) · [Contributing](https://github.com/Yivas/pi-code-hygiene/blob/main/CONTRIBUTING.md) · [Security](https://github.com/Yivas/pi-code-hygiene/blob/main/SECURITY.md)

codehygiene scores structure instead of syntax: pyramid nesting, comments that repeat the next line, swallowed errors, `*Factory` and `*Manager` ceremony, cryptic short names, magic indices and copy-pasted blocks. Its author recommends running it from a hook in the agent harness rather than as a skill. This package is that hook. It does not replace `pi-lsp`, type checkers or your project's linter, and it does not check behavior or security.

Status: version 0.2.1 is the published one; this branch adds a configuration file and the `/hygiene` command, listed as unreleased in the changelog. It is checked on Windows with Node 26: its own test suite, and runs against a real codehygiene install. It targets the extension API of Pi 1.5.2. Other platforms are untested. codehygiene is an early preview and its author documents false positives, so the extension starts in a mode that only measures.

## Install

The extension needs codehygiene installed outside the package: a Python environment with numpy and a checkout pinned to one commit. These commands create it under `%LOCALAPPDATA%\pi-hygiene` (PowerShell, [uv](https://docs.astral.sh/uv/) required):

```powershell
$dir = Join-Path $env:LOCALAPPDATA "pi-hygiene"
New-Item -ItemType Directory -Force $dir | Out-Null
git clone https://github.com/brianbell-x/codehygiene.git "$dir\src"
git -C "$dir\src" checkout b97871bed1d678d2c95a442631c975b1264591fe
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

Check that the `weights.npz` line starts with `579f85b8e48a65a7b4be894b699d4055bf3794ede5e68ecc72f4347832ee4f13`. If you check out another commit, the manifest records whatever you installed; reading that code first is up to you. A hash detects accidental changes in that folder, not someone who can already write to it.

Then install the extension and reload Pi:

```powershell
pi install npm:pi-code-hygiene@0.2.1
```

To check a working tree without installing it, `pi -ne -e <clone>/src/index.js` loads that file and nothing else; `/hygiene status` there shows the version it actually loaded.

Then **restart Pi**, not `/reload`. A packaged extension is a `.js` module in a `"type": "module"` package, and the loader hands it to Node's native `import()`, whose registry is keyed by URL and never invalidated; `/reload` clears Pi's own cache and asks again, but the same URL returns the module already evaluated. Restarting the process is the only way to load a new version. `/hygiene` shows the version in memory and the one on disk, and says `STALE` when they differ.

Requirements: Node.js 22.19 or later and Pi with the `tool_result` extension event. To try unreleased changes, `pi install` also accepts the path of a local clone of the [repository](https://github.com/Yivas/pi-code-hygiene).

## Modes

| Mode | What happens after a successful `edit` or `write` |
|-|-|
| `shadow` (default) | Analyzes the file in the background and appends one line to `state/shadow.jsonl`. The tool result is not changed and nothing waits. |
| `on` | Waits for the analysis (up to 3 s) and appends a short note with up to three findings of probability 0.55 or more. |
| `fix` | Like `on`, but assertive and narrower: see [Fix mode](#fix-mode). |
| `off` | Does nothing. |

Choose the mode in `config.json` (`%LOCALAPPDATA%\pi-hygiene\config.json`), with `/hygiene`, or with the `PI_CODE_HYGIENE_MODE` environment variable. The plain `mode` file of earlier versions is still read; nothing writes it any more.

Each key is resolved on its own, in this order: the environment variable for the mode, then `config.json`, then the old `mode` file, then the default. `config.json` is read on every edit, so a change takes effect at once; when nothing holds a mode name the mode is `shadow`. A file that says something else is a typo, and a typo must not turn an intended `off` into running processes: when no source is valid and a file was there saying something else, the mode is `off`, while an unusable environment variable leaves the file or the default in charge, as before. Surrounding space and capital letters are ignored, and an empty value counts as unset. A value this version does not know never starts the mode it names and never overrides the other setting: if the environment variable is wrong, the file applies, and if the file is wrong, the mode is `off` unless the environment variable is valid. A value that was set but not understood is written once per session to the log as `bad_mode`, so a silent stop leaves a trace; it is recorded as "unprintable" unless it is a short printable string, and when both settings are wrong it is the environment one that is named. `fix` needs 0.2.0 or later: an older version ignores it and falls back to the mode file, or to `shadow` when there is none. In `on` mode a note looks like this:

```text
[code-hygiene] Heuristic readability notes for this file (codehygiene preview; false positives are expected):
  line 9: swallowed_error (0.88)
  line 5: noisy_comment (0.89)
Optional. Working code does not need rewriting to silence these.
```

The note is information. The extension never marks an edit as failed, never asks the agent to continue, and does not show the same note twice in a row for a file. Any failure (missing Python, changed files, timeout, crash) is recorded and otherwise ignored.

Other settings: `PI_CODE_HYGIENE_HOME` moves the install folder and `PI_CODE_HYGIENE_PYTHON` points to another interpreter.

## Settings and `/hygiene`

`/hygiene` with no arguments opens a menu: the status line first, then status and diagnostics, mode, threshold and notes, installation, log, and reset. Every value is picked from a list, cancelling changes nothing, and the two actions that overwrite something ask first. With an argument it does that one thing and exits, which is what scripts and RPC clients use:

```text
/hygiene status
/hygiene mode fix
/hygiene set threshold 0.65
/hygiene set rounds 2
/hygiene check
/hygiene reset --yes
```

Commands are dispatched by Pi in interactive and RPC modes. In `-p` and `--mode json` they are not dispatched at all, so the argument form is for RPC clients and interactive use.

`config.json` holds these keys:

| Key | Default | What it changes |
|-|-|-|
| `version` | `1` | Schema of this file, not of the package |
| `mode` | `shadow` | What happens after each analysis |
| `threshold` | `0.55` | Threshold passed to codehygiene, from 0.40 to 0.90 in steps of 0.05 |
| `maxFindings` | `3` | Findings per note, in both `on` and `fix`, from 1 to 3 |
| `rounds` | `2` | Rounds per file in `fix` mode, from 1 to 4; `1` is one note and then silence |

```json
{
  "version": 1,
  "mode": "on",
  "threshold": 0.55,
  "maxFindings": 3,
  "rounds": 2
}
```

A value that is present but not understood falls back to its own default and is reported once per session as `bad_config`, with the key and at most 16 printable characters of the value. An empty string counts as unset. An unreadable file is kept as `config.json.bad` before it is replaced. Unknown keys and a newer `version` are left alone. The menu is the only thing that writes the file, it says when a save failed, and it says when `PI_CODE_HYGIENE_MODE` will override the saved mode. The values are for this install, so they apply to every session and to any subagent that uses it.

Only the global threshold is editable. The thresholds `fix` applies per kind (0.65, and 0.75 for `poor_naming` and `special_casing`) are constants of the package, and so are the 200 KB file limit, the 3 s time limit, two concurrent analyses and the note budgets.

### Fix mode

`on` is information the agent can ignore, and agents mostly do. `fix` asks for action, with limits meant to keep it from chasing false positives. It is experimental: that it changes what an agent does is not measured, only that it shows the right findings. Its limits are starting points, not results of a trial.

- It reports only findings in code the agent wrote during the current run (within one line of it). Before the agent's first edit of a file in a run, the extension keeps the file's lines in memory; "the code you wrote" is what the edit changed, worked out against that copy. A run starts with a submitted prompt. A message sent while the agent is still working joins the same run, so it does not reset the budgets; the next prompt sent while the agent is idle starts a new run. A file that does not exist yet counts as all written. A file it cannot read, that is over 200 KB, or that would be skipped anyway (`node_modules` and similar) is not reported, and neither is a file whose lines it could not keep.
- It works in rounds per file, to follow the cycle codehygiene's author describes for agents: fix, re-check, stop. The first note opens a round. Two rounds is the default and `rounds` in `config.json` moves it from one to four; with one, the first note is the only one. The next edit of that file that touches a flagged line (or a `write`) is the re-check, and what is still flagged by that edit is listed once more as the final pass. After that the file is silent for the rest of the agent run. Edits that touch nothing flagged can still bring notes about new findings, up to three notes per file.
- A note lists at most three findings, best first, within 600 characters. They have probability 0.65 or more (0.75 for `poor_naming` and `special_casing`, the kinds most often wrong). `duplicate_block` is never reported: it needs both copies to be in the edit, and codehygiene gives one line.
- Each finding comes with what usually fixes it, a fixed text of this package. Nothing from your code goes into a note.
- A run gets at most eight notes or about 4,000 characters of them, as a cost limit, and it tracks the first 32 files it sees. With up to three findings and a recipe each, a note can reach 600 characters, so the third and weakest finding is dropped when it does not fit.
- It adds one fixed rule to the system prompt, only in this mode: the user's requested scope and the project's linter come first, and untouched code is not to be edited to improve a score.

```text
[code-hygiene] Heuristic findings (they may be wrong) in lines you just changed:
  line 10: swallowed_error (0.95) -> handle, log or rethrow; or comment why ignoring it is safe
  line 11: deep_nesting (0.90) -> flatten with a guard clause or early return
Fix only the real ones, in code you just wrote. Skip any fix that would change behavior, drop required
error handling or clash with the project linter, and name what you skipped in one sentence.
Do not edit untouched code to lower the score. (pass 1 of 2)
```

The limits are starting points, not measured values. Compare `fix` with `on` on your own work before you keep it. Every record says the version of the extension that wrote it (`v`), and each session starts with one record of its own: outcome `session`, the version in memory and the one on disk (`disk_version`), `stale`, the mode that applies, the text it came from (`mode_raw`), where it came from (`mode_source`), the threshold, the note limits, the schema of the configuration, and the moment the module was loaded. That line is written even in `off` mode, because it is how you tell that the extension is loaded at all. A record of an analysis or of a skipped edit says the mode, the tool, the file id and the outcome; a record of a rejected mode value says that its outcome was `bad_mode`, plus the value; a rejected setting is `bad_config`. Some carry more:

- An analysis that produced a result records the score and counts, how many findings the file had, and how long the wait and the run took. If the same file was analyzed earlier in the session and the file did not change in the meantime, it also says how many findings were resolved, persisted or new.
- When a note is shown, `on` and `fix` say how many findings it carried. A `fix` record may also carry the round, whether the edit was a re-check of an earlier note, how many flagged findings were resolved or persisted, and a count per reason for the findings it held back: `outside_edit`, `threshold`, `excluded`, `repeated`, `cap`, `rounds`, `file_cap`, `run_cap` or `no_baseline`.
- A record of something that produced no result carries the reason it was skipped, or the error, plus the exit code when the process returned one.

The field names are in `src/index.js`, where the record is written. What the note says is never logged, and neither is any text or hash of your code.

## Limits and privacy

- It sees edits made through Pi's `edit` and `write` tools. Changes made by `bash`, by an editor, or by a subagent that does not load the extension are not analyzed.
- It analyzes files with the extensions codehygiene documents (`.py .ts .tsx .js .jsx .mjs .cjs .rs .go .c .h .cc .cpp .cxx .hpp .zig .java .cs .lua`), up to 200 KB, outside `node_modules`, `.git`, `.venv`, `venv`, `dist`, `build`, `target` and `__pycache__`. Paths containing `*`, `?` or `[` are skipped because codehygiene treats them as patterns.
- At most two analyses run at once and at most eight wait; the rest are skipped. The 3 s limit counts the wait for a free slot, so an edit is never held longer than that. A newer edit of the same file replaces the pending analysis. A file that changes while it is being analyzed produces no note.
- Each analysis starts a Python process and takes about 0.35 s on the development machine (Windows, Python 3.11, numpy 2.5.5). In `on` mode that time is added to the edit.
- Everything is local. The extension makes no network requests and codehygiene runs with `--no-update-check`. The log holds counts, timings, versions and a salted hash of the path: no code, no paths and no text from the findings. Once per session it may also hold a rejected value, at most 16 printable characters of the configuration, or the word `unprintable`. The log is rotated to `shadow.jsonl.1` when it passes 1 MiB, and truncated instead of renamed when another process holds it open.
- `config.json` holds only the settings above. If it cannot be parsed it is copied to `config.json.bad` before a new one is written, so a file edited by hand is recoverable but stays in the install folder.
- codehygiene scores the whole file, not the lines you changed, so older problems can show up after a small edit in `shadow` and `on`. `fix` filters them out.
- The score is sensitive: a small harmless edit can move a file's score a lot, and the findings are heuristic. In `fix` mode an agent can still act on a wrong finding; the notes tell it to skip fixes that change behavior.

## Keeping up with codehygiene

codehygiene publishes no releases or tags, only commits on its `main` branch, so this repository pins one commit in [`compat/codehygiene.json`](https://github.com/Yivas/pi-code-hygiene/blob/main/compat/codehygiene.json). A weekly GitHub Actions workflow ([`upstream-watch.yml`](https://github.com/Yivas/pi-code-hygiene/blob/main/.github/workflows/upstream-watch.yml)) compares that commit with upstream `main` and opens one issue when they differ. The issue holds only checked facts: both commits, the date, how many commits apart they are, whether `weights.npz` changed, and whether upstream was archived or renamed. Nothing from upstream's text goes into it. Moving the pin is a decision made by hand; closing the issue declines that commit. The workflow can also be run manually, and GitHub pauses scheduled workflows after 60 days without repository activity.

## Documentation and support

Issues are welcome in [GitHub Issues](https://github.com/Yivas/pi-code-hygiene/issues), pull requests as described in [CONTRIBUTING.md](https://github.com/Yivas/pi-code-hygiene/blob/main/CONTRIBUTING.md), and security reports through [SECURITY.md](https://github.com/Yivas/pi-code-hygiene/blob/main/SECURITY.md). No response time is promised. Participation follows the [Code of Conduct](https://github.com/Yivas/pi-code-hygiene/blob/main/CODE_OF_CONDUCT.md). Changes between versions are listed in the [changelog](https://github.com/Yivas/pi-code-hygiene/blob/main/CHANGELOG.md).

codehygiene is a separate project by Brian Bell ([brianbell-x/codehygiene](https://github.com/brianbell-x/codehygiene)); this package neither bundles nor redistributes it. Its `pyproject.toml` declares the MIT license, but its repository has no `LICENSE` file, so read its terms before you rely on it. The commit this package expects is `b97871b` (codehygiene 0.5.1). This package is released under the [MIT License](https://github.com/Yivas/pi-code-hygiene/blob/main/LICENSE).
