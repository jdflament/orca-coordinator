# Contributing

See also the Contributing and Releasing sections of the [README](README.md).

## Checks

`npm run check` (Node tests, typecheck, `orca plugin validate`, `orca plugin test`) must pass before a PR.

## Upgrade safety: a release never breaks an existing install

The user's config and board outlive releases. Rule: **every change to a stored shape needs a
migration and a fixture test.**

1. Stored shapes are `config.yaml` (`schemaVersion`), `board.json` (`version`), `panel.json` and the files in the state folder.
2. Bump the version constant in `bin/lib/migrate.mjs` and add ONE small step for it to `CONFIG_STEPS` or `BOARD_STEPS`. A step only adds or renames; it never deletes keys it does not know. It runs automatically on read, must be idempotent, and the original is copied to `<file>.bak-v<old version>` once before the first rewrite.
3. Readers ignore unknown fields and default missing ones; a failing request shows a message in its own panel section, never a global error.
4. The plugin update path runs `coordinator.mjs migrate`, never `init`/setup.
5. `test/fixtures/upgrade/<tag>/` holds a real snapshot of each released version. `test/upgrade.test.mjs` and the upgrade tests in `plugin/src/worker.test.ts` run the current board, config, setup and panel handlers against every fixture. Add a test for your migration there.

## Release checklist

Besides the steps in the README:

- [ ] `npm run fixtures:upgrade vX.Y.Z` on the new tag, commit `test/fixtures/upgrade/vX.Y.Z` (a release adds its own fixture).
- [ ] The upgrade tests from the last two released versions pass (`npm test`, then `npm run check`).
