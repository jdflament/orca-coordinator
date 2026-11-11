// Fake `orca` / `gh` / `curl` for tests (see helpers.mjs): logs the call, answers by rule.
// gh's --jq / -q filter is applied with the real jq, as gh would.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [cli, ...args] = process.argv.slice(2)
const dir = process.env.FAKE_DIR
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ cli, args }) + '\n')
const rulesFile = path.join(dir, `${cli}.json`)
const rules = fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : []
const rule = rules.find((r) => r.match.every((token) => args.includes(token)))
if (!rule) {
  process.stderr.write(`fake ${cli}: no rule for ${args.join(' ')}\n`)
  process.exit(1)
}
let out = rule.stdout ?? ''
const q = Math.max(args.indexOf('--jq'), args.indexOf('-q'))
if (cli === 'gh' && q !== -1 && (rule.status ?? 0) === 0) {
  const jq = spawnSync('jq', ['-r', args[q + 1]], { input: out, encoding: 'utf8' })
  out = jq.stdout
}
process.stdout.write(out)
process.exit(rule.status ?? 0)
