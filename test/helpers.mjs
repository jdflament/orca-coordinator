// Shared test setup: a temp home with XDG folders, a config file, and fake `orca`, `gh` and
// `curl` executables on PATH (the only mocked boundary). A fake answers by rule from
// <tmp>/fake/<cli>.json and appends every call to <tmp>/fake/calls.jsonl.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toYaml } from '../bin/lib/yaml.mjs'

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const FAKE = path.join(ROOT, 'test', 'fake-cli.mjs')

export function sandbox({ config = {}, writeConfig = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-coord-')))
  const home = path.join(dir, 'home')
  const bin = path.join(dir, 'fake')
  const state = path.join(dir, 'state')
  const configPath = path.join(home, '.config', 'orca-coordinator', 'config.yaml')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  for (const cli of ['orca', 'gh', 'curl']) {
    const file = path.join(bin, cli)
    fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${cli} "$@"\n`)
    fs.chmodSync(file, 0o755)
  }
  const base = { person: { name: 'Alex', github: 'alex' }, paths: { state, workspace: path.join(dir, 'ws'), orca: path.join(bin, 'orca') }, github: { org: 'acme' } }
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USER: os.userInfo().username,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    ORCA_CLI_BIN_DIR: bin,
    FAKE_DIR: bin,
    LANG: 'en_US.UTF-8'
  }
  const box = {
    dir,
    home,
    state,
    configPath,
    env,
    /** rules: [{ match: ['terminal', 'list'], stdout: '...', status: 0 }] (first rule whose tokens all appear in argv) */
    fake(cli, rules) {
      fs.writeFileSync(path.join(bin, `${cli}.json`), JSON.stringify(rules))
    },
    calls(cli) {
      const file = path.join(bin, 'calls.jsonl')
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !cli || c.cli === cli).map((c) => c.args)
    },
    writeConfig(value) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, toYaml(value))
    },
    run(file, args = [], { input, extraEnv = {} } = {}) {
      const isNode = file.endsWith('.mjs')
      const result = spawnSync(isNode ? process.execPath : 'bash', [path.join(ROOT, file), ...args], {
        encoding: 'utf8',
        input: input ?? '',
        env: { ...env, ...extraEnv }
      })
      return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() }
    }
  }
  if (writeConfig) box.writeConfig(deep(base, config))
  return box
}

function deep(a, b) {
  if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
    const out = { ...a }
    for (const k of Object.keys(b)) out[k] = deep(a[k], b[k])
    return out
  }
  return b === undefined ? a : b
}

export const ok = (result) => JSON.stringify({ ok: true, result })
