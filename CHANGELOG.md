# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is `0.y.z`, a minor release can include breaking changes.

## [Unreleased]

### Changed

- The `/hygiene` menu shows a short description next to every entry, in a second column, and the value in use next to the setting it belongs to, so an entry can be read without trying it. The column follows the terminal width, collapses to one line on a narrow one, and keeps working when a client has no terminal at all.
- The app said nothing when the host answered with something that was not in the menu; now it says so and stays open, and a host that only answers nonsense closes the menu instead of looping.

## [0.3.0] - 2026-11-18

### Added

- `/hygiene`, a command with a menu and an argument form: status, mode, threshold and note limits, a check of the installation, a summary of the log, and reset. It shows the version in memory next to the one on disk and says `STALE` when a restart is missing. Values are picked from lists, cancelling writes nothing, and reset and the install check ask first. It uses the dialog methods that also work in RPC, and it writes to the log instead of standard output when there is no UI.
- `config.json` in the install folder, with `mode`, `threshold`, `maxFindings` and `rounds`. It is validated key by key, read on every edit, and written atomically with a retry; an unreadable file is kept as `config.json.bad` first. A value that is not understood falls back to its own default and is recorded once per session as `bad_config`.
- Every log record now carries `v`, the version of the extension that wrote it, and each session starts with a `session` record: version in memory and on disk, `stale`, the mode that applies and where it came from, the threshold, the note limits and the moment the module was loaded. It is written even in `off` mode. A second copy of the extension loaded in the same process no longer registers a second set of hooks: the newest activation wins and the older one goes quiet, with a `duplicate_load` record.

### Changed
- The plain `mode` file of earlier versions is still read as the last source before the default, but nothing writes it any more; `config.json` is what the menu and the command write. Precedence is per key, and the mode keeps the behaviour it had: a file with a value this version does not know still leaves the mode at `off`, and an unusable `PI_CODE_HYGIENE_MODE` still leaves the file or the default in charge.
- The first save through the menu or the command copies the legacy mode into `config.json`, so the file becomes the only source from then on and a later edit of the old file no longer changes anything.
- The threshold passed to codehygiene, the number of findings per note and the rounds of `fix` come from the configuration instead of being constants. The thresholds `fix` applies per finding kind are still constants.
- The README says that updating a packaged extension needs a restart of Pi: `/reload` clears Pi's own cache, but the module URL is the same and Node returns the copy it already evaluated.

## [0.2.1] - 2026-11-18

### Changed

- The expected codehygiene commit is now `b97871b` (0.5.1) instead of `0221af7` (0.5.0). Upstream repaired false positives for Go, so the notes are quieter on code the previous pin used to flag. The files are the same, but `weights.npz` and `__init__.py` changed, so an installation made from the previous instructions keeps working and no longer matches the hashes this README prints until it is rebuilt at the new commit. The 0.2.0 tarball documented the old pin; this one documents the new one.
- A mode value is read without regard to surrounding space or capital letters, so `Fix` works, and an empty value counts as unset. A value this version does not know is never used and never overrides the other setting: a valid one applies, and when neither is valid the mode is `off` if a mode file exists and `shadow` if it does not. The wrong value is written once per session to the log as `bad_mode`, so a silent stop leaves a trace, and the environment value is the one named when both are wrong.
- The README says plainly that `fix` mode is experimental: its findings are checked, its effect on an agent is not measured.

## [0.2.0] - 2026-11-18

### Added

- A `fix` mode. It reports up to three findings in the code the agent wrote during the run, with a recipe for each, in two rounds per file: a note, then a final pass if the next edit touches a flagged line. It adds one fixed rule to the system prompt, only in this mode.
- A weekly GitHub Actions workflow that opens an issue when codehygiene's `main` moves past the commit pinned in `compat/codehygiene.json`. It uses no third-party code beyond a commit-pinned `actions/checkout`, writes nothing but issues, and copies no upstream text into the issue.
- Log fields to compare modes: findings in the edit, findings shown, why others were left out, the round, whether an edit was a re-check, and, against the previous analysis of the same file, how many were resolved, persisted or new.

## [0.1.0] - 2026-11-17

First release.

### Added

- A Pi extension that runs [codehygiene](https://github.com/brianbell-x/codehygiene) after every successful `edit` or `write` of a supported file.
- Three modes: `shadow` (the default; records timings and counts and leaves the tool result alone), `on` (appends a short note with up to three findings) and `off`.
- A pinned install checked against a manifest of file hashes, run without a shell and without network access.
- A log of counts, timings and a salted hash of each path, with no code, paths or finding text.
- Limits: two analyses at once and eight waiting, 3 s per file including the wait, 200 KB per file.

[0.3.0]: https://github.com/Yivas/pi-code-hygiene/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Yivas/pi-code-hygiene/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Yivas/pi-code-hygiene/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Yivas/pi-code-hygiene/releases/tag/v0.1.0
