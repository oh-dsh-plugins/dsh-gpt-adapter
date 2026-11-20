# Maintaining DSH compatibility

The ordered targets in [compat.mjs](./compat.mjs) are the supported-version source.
The first target is the development baseline; the full suite covers it. CI derives
all remaining runtimes from this directory rather than maintaining another list.

After verifying a new DSH version, add its target and source package aliases, then run:

```sh
pnpm compat:sync
pnpm install --no-frozen-lockfile
pnpm test
```

Push the change in a pull request. GitHub Actions runs the baseline suite and the
derived matrix for all remaining supported versions. The release workflow requires
the same checks before publishing. Use `pnpm test:compat` locally only when debugging
a specific compatibility failure.

The sync command updates the literal npm engine/peer ranges, development source
aliases, and exact build-input release-age exclusions. Builds check these derived
declarations and fail with an actionable message if they drift. Commit the updated
manifest, workspace policy, and lockfile together. Update the user-facing support
notes and verify the actual packaged plugin before declaring a new version supported.

Context presets are optional. An incompatible native settings renderer keeps its
original component, displays an availability message, and leaves provider controls
and the speed selector registered. The backend native-adapter fingerprint gate
continues to reject unverified request implementations.
