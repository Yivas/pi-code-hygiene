## Summary

<!-- What changes for the user, and why? -->

## Checks

- [ ] `npm run check` and `npm test` pass.
- [ ] A behavior change has a test against the public extension, using a stand-in for `pi.exec`.
- [ ] The extension still never marks an edit as failed, makes no network requests, fails silently, and logs no code, paths or finding text.
- [ ] README and documentation are updated when the install layout, the modes or the log format change.

## Privacy

- [ ] I removed prompts, sessions, personal paths, credentials and unredacted logs.
