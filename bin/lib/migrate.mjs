// Stored-data migrations: how a new release reads data an older release wrote, without breaking it.
//
// Rules (rules/90-upgrades.md): every change to a stored shape (config.yaml, board.json) bumps the
// schema version and adds ONE small step here, plus a fixture test (test/upgrade.test.mjs).
// A step only adds or renames; it never deletes keys it does not know. Steps run automatically when
// the data is read, are idempotent (a second run changes nothing), and the original file is copied
// to <file>.bak-v<old version> once, before the first rewrite. Data written by a NEWER version is
// left untouched. A migration that cannot run (read-only file, unreadable data) reports and
// reads on: it never stops the panel or the CLI.

import fs from 'node:fs'
import { parseYaml, toYaml } from './yaml.mjs'

export const CONFIG_VERSION = 2
export const BOARD_VERSION = 2

/** Steps of a version: { to, apply }. apply gets the data (config: the file text) and returns the migrated data. */
export const BOARD_STEPS = []

/** config.yaml is migrated as TEXT, so the user's comments and layout survive; a step that needs structure parses and re-serializes itself. */
export const CONFIG_STEPS = [
  {
    to: 1,
    apply(text) {
      if (/^schemaVersion:/m.test(text)) return text
      const header = /^(#[^\n]*\n|\s*\n)*/.exec(text)?.[0] ?? ''
      return `${header}schemaVersion: 1\n${text.slice(header.length)}`
    }
  },
  {
    // rules.optional used to be implicit (missing = every optional rule on). Write it out, so the
    // default can later be simplified without changing what an existing install gets. The names are
    // the optional rules that existed at this version, frozen: later rules are not switched on here.
    to: 2,
    apply(text) {
      const stamped = text.replace(/^schemaVersion:.*$/m, 'schemaVersion: 2')
      const data = parseYaml(stamped) || {}
      if (Array.isArray(data.rules?.optional)) return stamped
      if (!/^rules:/m.test(stamped)) return `${stamped}${stamped.endsWith('\n') ? '' : '\n'}rules:\n  optional: [${OPTIONAL_RULES_AT_V2.join(', ')}]\n`
      // A rules: block without optional (rare): re-serialize, keeping every key; the backup keeps the comments.
      const header = /^(#[^\n]*\n)+/.exec(stamped)?.[0] ?? ''
      return header + toYaml({ ...data, rules: { ...(data.rules && typeof data.rules === 'object' ? data.rules : {}), optional: [...OPTIONAL_RULES_AT_V2] } })
    }
  }
]

export const OPTIONAL_RULES_AT_V2 = ['planning-tracker', 'five-line-plan', 'drafts']

/** Applies, in order, every step above `from`; returns the data and whether a step ran. Pure. */
export function runSteps(data, steps, from, current) {
  let out = data
  let ran = false
  for (const step of [...steps].sort((a, b) => a.to - b.to)) {
    if (step.to <= from || step.to > current) continue
    out = step.apply(out)
    ran = true
  }
  return { data: out, ran }
}

const asVersion = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)

/** <file>.bak-v<from> is written once: an existing backup (the first original) is never replaced. */
export function backupOnce(file, from) {
  const backup = `${file}.bak-v${from}`
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  return backup
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** Board object from disk → current shape (in memory). Returns { board, from, migrated }. */
export function migrateBoardData(board, steps = BOARD_STEPS, current = BOARD_VERSION) {
  const from = asVersion(board?.version)
  if (from > current) return { board, from, migrated: false, newer: true }
  const { data, ran } = runSteps(board, steps, from, current)
  // Stamping an unversioned or older board counts as a migration; unknown keys stay.
  const migrated = ran || from !== current
  return { board: migrated ? { ...data, version: current } : data, from, migrated }
}

/**
 * Migrates board.json in place when its version is older: backup once, then rewrite.
 * Returns { migrated, from, to, backup?, error? }; never throws.
 */
export function migrateBoardFile(file, steps = BOARD_STEPS, current = BOARD_VERSION) {
  try {
    if (!fs.existsSync(file)) return { migrated: false }
    const board = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!board || typeof board !== 'object' || Array.isArray(board)) return { migrated: false }
    const result = migrateBoardData(board, steps, current)
    if (!result.migrated) return { migrated: false, from: result.from }
    const backup = backupOnce(file, result.from)
    writeAtomic(file, JSON.stringify(result.board, null, 2) + '\n')
    return { migrated: true, from: result.from, to: current, backup }
  } catch (error) {
    return { migrated: false, error: error.message }
  }
}

export function configVersionOf(text) {
  try {
    return asVersion(parseYaml(text)?.schemaVersion)
  } catch {
    return 0
  }
}

/**
 * Migrates config.yaml in place when its schemaVersion is older (or missing): backup once, then
 * rewrite. The result must still parse and keep every top-level key it had, or nothing is written.
 * Returns { migrated, from, to, backup?, error? }; never throws.
 */
export function migrateConfigFile(file, steps = CONFIG_STEPS, current = CONFIG_VERSION) {
  try {
    if (!fs.existsSync(file)) return { migrated: false }
    const text = fs.readFileSync(file, 'utf8')
    const before = parseYaml(text)
    if (before !== null && (typeof before !== 'object' || Array.isArray(before))) return { migrated: false }
    const from = configVersionOf(text)
    if (from >= current) return { migrated: false, from }
    const { data } = runSteps(text, steps, from, current)
    const after = parseYaml(data)
    const lost = Object.keys(before || {}).filter((key) => !(key in (after || {})))
    if (lost.length) throw new Error(`a migration would drop ${lost.join(', ')}`)
    const backup = backupOnce(file, from)
    writeAtomic(file, data)
    return { migrated: true, from, to: current, backup }
  } catch (error) {
    return { migrated: false, error: error.message }
  }
}

/** Both files of a state: used by `coordinator migrate`, the plugin's update path and the panel worker. */
export function migrateAll({ configPath, boardPath }) {
  return { config: migrateConfigFile(configPath), board: boardPath ? migrateBoardFile(boardPath) : { migrated: false } }
}
