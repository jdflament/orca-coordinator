#!/usr/bin/env node
// Prints the merged config as CFG_* shell assignments: `eval "$(node config-shell.mjs)"`.
// Ticketing and chat are those of the repo the script acts on: $COORDINATOR_REPO (name or path),
// else the configured repo holding the current folder, else the default (see adapters.mjs).
import { currentRepo, withRepoAdapters } from './adapters.mjs'
import { loadConfig, shellQuote, toShellExports } from './config.mjs'

try {
  const strict = !process.argv.includes('--lenient')
  const { config } = loadConfig({ strict })
  const repo = currentRepo(config)
  process.stdout.write(toShellExports(withRepoAdapters(config, repo)) + `CFG_repo=${shellQuote(repo?.name ?? '')}\n`)
} catch (err) {
  process.stderr.write(`orca-coordinator: ${err.message}\n`)
  process.exit(3)
}
