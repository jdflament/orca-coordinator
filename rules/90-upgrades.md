## Upgrades never break the user

A new release must never break an existing panel or config; updates migrate stored data.
- Any change to a stored shape (config.yaml, board.json, panel.json, state files) needs a schema-version bump, one small migration step in `bin/lib/migrate.mjs`, and a fixture test in `test/upgrade.test.mjs`.
- A migration only adds or renames: it never deletes keys it does not know, runs on read, is idempotent, and backs the original up once (`<file>.bak-v<old>`).
- The plugin update path runs migrations, never setup; user config changes only through a migration or the user's own save.
- A worker spec that touches a stored shape names its migration and fixture in the report.
