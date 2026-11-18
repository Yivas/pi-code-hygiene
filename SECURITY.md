# Security Policy

## Supported versions

| Version | Supported |
|-|-|
| 0.2.x | Yes |

Fixes go into the latest 0.2.x release. Older versions do not get fixes.

## Scope

`pi-code-hygiene` is a local Pi extension. After a successful `edit` or `write` it starts a Python process (`python -I -B <codehygiene> <file> --json --no-update-check --threshold <value>`) in an install folder you create, and it reads the edited file. It runs without a shell and makes no network requests of its own. It writes one log file in that folder with counts, timings, the version of the extension and a salted hash of each path; it stores no code, no paths and no text from findings. The same folder holds `config.json` with the settings (`mode`, `threshold`, `maxFindings`, `rounds`), and `config.json.bad`, a copy of a settings file that could not be parsed, taken right before it is replaced.

What it trusts and what it does not protect against:

- The extension runs the Python interpreter and the codehygiene files in `PI_CODE_HYGIENE_HOME` (default `%LOCALAPPDATA%\pi-hygiene`). Anyone who can write there can run code as you. The manifest of file hashes detects accidental changes, not a user or process that can also rewrite the manifest.
- `config.json` in that folder is input, not code: it cannot point the extension at another interpreter, another install folder or another set of files, and it has no way to add text to a tool result or to a prompt. A `threshold` or `rounds` value changes how much is reported, never what is executed.
- codehygiene is third-party software with a model file (`weights.npz`) that cannot be audited by reading it. This package neither bundles nor reviews it.
- The salt that protects path hashes in the log has no extra access protection on Windows beyond the folder's permissions.
- A repository cannot make the extension run its own code: the interpreter and the package come only from the install folder, and files from the project are only read as text.

Reports about the following are in scope: running code from an unexpected location, writing outside the install folder, leaking code or paths into the log, or a way for edited content to change what the extension executes. Findings or scores that you consider wrong are not security issues; open a regular issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: [report a vulnerability](https://github.com/Yivas/pi-code-hygiene/security/advisories/new). Do not open a public issue for it.

Include the version or commit, your Pi version and operating system, and a minimal reproduction. Remove credentials, session files, prompts, personal paths and unredacted logs. No response time, reward or CVE assignment is promised; the reports are read by one maintainer.
