# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is `0.y.z`, a minor release can include breaking changes.

## [Unreleased]

## [0.1.0] - 2026-11-17

First release.

### Added

- A Pi extension that runs [codehygiene](https://github.com/brianbell-x/codehygiene) after every successful `edit` or `write` of a supported file.
- Three modes: `shadow` (the default; records timings and counts and leaves the tool result alone), `on` (appends a short note with up to three findings) and `off`.
- A pinned install checked against a manifest of file hashes, run without a shell and without network access.
- A log of counts, timings and a salted hash of each path, with no code, paths or finding text.
- Limits: two analyses at once and eight waiting, 3 s per file including the wait, 200 KB per file.

[Unreleased]: https://github.com/Yivas/pi-code-hygiene/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Yivas/pi-code-hygiene/releases/tag/v0.1.0
