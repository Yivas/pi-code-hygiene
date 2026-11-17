# Contributing

Thanks for helping improve `pi-code-hygiene`. Issues and pull requests are welcome. There is one maintainer and no response time is promised.

## Before opening an issue

- Search existing issues.
- Include the package version or commit, Pi version, Node.js version, operating system and a minimal reproduction.
- For a wrong or surprising finding, say which file kind it was (language, rough size) and what you expected. Paste the file only if it is yours to share.
- Remove credentials, session files, prompts, personal paths and unredacted logs.
- Report security vulnerabilities through [`SECURITY.md`](SECURITY.md), not a public issue.
- Findings and scores come from codehygiene, a separate project. A scoring problem belongs in [its issue tracker](https://github.com/brianbell-x/codehygiene/issues); an issue here is right when this extension ran it, filtered it or reported it wrongly.

## Pull requests

A pull request should:

- explain what changes for the user and why;
- include a test for any behavior change, written against the public extension (`tool_result` in, tool result and log out), with a stand-in for `pi.exec` so that tests need neither Python nor network;
- keep the code and documentation in English;
- keep the extension's boundaries: it never marks an edit as failed, never asks the agent to continue, makes no network requests, fails silently, and writes no code, paths or finding text to its log;
- not add dependencies, telemetry or a second way to run codehygiene without a discussion first;
- pass `npm run check` and `npm test`.

Changes to the install layout, the modes or the log format also need a README update.

## Code of conduct

Participation follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
