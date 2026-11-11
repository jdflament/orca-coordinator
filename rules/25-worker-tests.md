## Tests in worker specs

Any spec that writes tests carries this bar:
- Test behaviour through public entry points (handlers, CLI commands, board verbs); each test guards a named failure. Fewer sharp tests over many shallow ones.
- Cover the risky paths: invalid or partial config, missing files, failed external commands, rejected input, save-then-read keeps unknown keys, no write without an explicit action.
- Use a real temp-dir filesystem; mock only external CLI boundaries. Weak existing tests are rewritten or deleted, and named in the report.
