# Adapters

One script per tool, one interface per kind, so playbooks and rules never name a
vendor CLI. `config.yaml` picks the kind (`adapters.<kind>.kind`); the rendered
playbooks call `{{adapters.ticketing.run}} --repo <repo>` / `{{adapters.chat.run}} --repo <repo>`.

Ticketing and chat are per repository (`bin/lib/adapters.mjs`, `adapterFor(config, kind, repo)`):
the built-in defaults, then `adapters.<kind>` (the default), then the repo's own `repos[].<kind>`
block (merged when it keeps the same kind, else over that tool's defaults), then the repo's own
`.orca-coordinator.yaml`. A script acts for `$COORDINATOR_REPO` (a name or path; an unknown one is
an error), else the configured repo holding the current folder, else the default: `env.sh` exports
that repo's resolved `CFG_adapters_*` (and `CFG_repo`), so the scripts below are unchanged.
Every script
reads config through `bin/lib/env.sh` and treats writes as sensitive: they refuse
unless called with `--yes`, which the coordinator passes only after the human's
explicit go.

## ticketing/<kind>.sh  (linear, jira, github, none)

| Command | Prints |
| ------- | ------ |
| `get <id>` | the issue with comments, JSON when the tool has it |
| `list [--todo]` | identifiers of the human's assigned issues, one per line (`--todo`: only `todoStates`) |
| `url <id>` | the UI link (`adapters.ticketing.issueUrl`) |
| `comment <id> <text> --yes` | adds a comment (write) |
| `create <json> --yes` | creates an issue from `{title, description, parent?, labels?}` (write) |
| `status <id> <state> --yes` | moves an issue (write) |

`linear` uses the `orca linear` CLI (Orca's own connector), `jira` the
[jira-cli](https://github.com/ankitpokhrel/jira-cli), `github` the `gh` CLI
(`github.org` plus the repo in the id, `owner/repo#123`). `none` exits 2.

## chat/<kind>.sh  (slack, none)

| Command | Prints |
| ------- | ------ |
| `search <query>` | matching messages (`slack`: Web API with the credential from `secretRef`) |
| `draft <channel> <text>` | writes a draft file under `<state>/drafts/` and prints its path |
| `post <channel> <text> --yes` | posts (write); refused for `draftOnlyChannels` |

When `adapters.chat.via` is `mcp:<tool>`, the agent reads chat through its own
tool and the script is only used for drafts.

## flags/<kind>.sh  (unleash, none)

| Command | Prints |
| ------- | ------ |
| `get <flag>` | environments, strategies, constraints |
| `list [query]` | flags with their environment state |
| `url <flag>` | the UI link (`adapters.flags.uiUrl`) |
| `toggle <flag> <env> on|off --yes` | flips (write) |

Adding a kind: copy the closest script, keep the command names, register the kind in
`bin/lib/config.mjs` (`*_KINDS`).
