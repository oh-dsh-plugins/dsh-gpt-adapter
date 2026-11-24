# Maintaining DSH compatibility

The targets in [compat.mjs](./compat.mjs) define the candidate's DSH engine range, source packages, and host test matrix. The first target is the local development baseline. Record the Node.js requirement and the host's Cordis and Schemastery versions for each new target.

Add the prospective target before creating an unpublished candidate so the official DSH installer can exercise its normal compatibility check. Then run:

```sh
pnpm compat:sync
pnpm install --no-frozen-lockfile
pnpm test
```

Commit the generated manifest, workspace policy, and lockfile together. CI packs one `.tgz` and records its SHA-256 checksum. Every matrix job checks the checksum, installs the archive in a fresh DSH profile, verifies the plugin RPC, and opens the real Models settings page to check the context presets. The `rc.1`, `rc.5`, and `alpha.2` jobs also save `516K` and reopen the model to verify the saved value. A temporary startup patch gives each host an empty Codex directory. The release job publishes the checked archive from the same run. Record support in the release notes after the matrix passes.

Use `node scripts/test-host-compat.mjs <dsh-version> <archive>` for the host and browser checks. Install Chromium with `pnpm exec playwright-core install chromium`, or point `DSH_COMPAT_CHROMIUM` at an installed Chromium executable. Use `node scripts/test-compat.mjs --archive <archive> <dsh-version>` to exercise the packaged implementation. Use a Node.js version accepted by the tested host.

Context presets depend on the identity and fingerprint of the native Models component's loaded module. Missing or mismatched identity leaves the native editor available. A mounted form keeps the component selected at mount. DSH itself owns the form's lifetime during native module replacement. The host fingerprint gate rejects unverified request implementations, and per-provider route identity gates GPT capabilities.

The official `0.2.3-alpha.1` CLI fails before plugin loading because its published Loader dependency lacks `EntryValidationError` and `validateOptions`. Keep that release outside the candidate range. `0.2.3-alpha.2` uses the newer Loader family and is tested separately.
