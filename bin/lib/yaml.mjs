// A small YAML reader and writer for config files: block mappings and sequences,
// flow `{a: b}` and `[a, b]`, quoted and plain scalars, comments. No anchors,
// no multi-line scalars, no tags. Enough for config.yaml; `coordinator config`
// prints what was parsed so a mistake is visible at once.

export function parseYaml(text) {
  const lines = text.split(/\r?\n/).map(stripComment)
  const items = []
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return
    const indent = raw.length - raw.trimStart().length
    items.push({ indent, text: raw.trim(), line: i + 1 })
  })
  if (items.length === 0) return {}
  const [value] = parseBlock(items, 0, items[0].indent)
  return value
}

function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

function parseBlock(items, start, indent) {
  if (items[start].text.startsWith('- ') || items[start].text === '-') return parseSequence(items, start, indent)
  return parseMapping(items, start, indent)
}

function parseSequence(items, start, indent) {
  const list = []
  let i = start
  while (i < items.length && items[i].indent === indent && (items[i].text.startsWith('- ') || items[i].text === '-')) {
    const rest = items[i].text === '-' ? '' : items[i].text.slice(2).trim()
    if (rest === '') {
      const next = items[i + 1]
      if (next && next.indent > indent) {
        const [value, end] = parseBlock(items, i + 1, next.indent)
        list.push(value)
        i = end
      } else {
        list.push(null)
        i++
      }
    } else if (looksLikeMapEntry(rest)) {
      const entryIndent = indent + 2
      const synthetic = [{ indent: entryIndent, text: rest, line: items[i].line }]
      let j = i + 1
      while (j < items.length && items[j].indent > indent) synthetic.push(items[j++])
      const [value] = parseMapping(synthetic, 0, entryIndent)
      list.push(value)
      i = j
    } else {
      list.push(parseScalar(rest, items[i].line))
      i++
    }
  }
  return [list, i]
}

function looksLikeMapEntry(text) {
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"') || text.startsWith("'")) return false
  return Boolean(text.match(/^([^:]+?):(\s|$)/))
}

function parseMapping(items, start, indent) {
  const map = {}
  let i = start
  while (i < items.length && items[i].indent === indent) {
    const item = items[i]
    if (item.text.startsWith('- ')) throw new Error(`yaml line ${item.line}: unexpected list item`)
    const m = item.text.match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/)
    if (!m) throw new Error(`yaml line ${item.line}: expected "key: value", got "${item.text}"`)
    const key = parseScalar(m[1], item.line)
    const rest = (m[2] ?? '').trim()
    if (rest === '') {
      const next = items[i + 1]
      if (next && next.indent > indent) {
        const [value, end] = parseBlock(items, i + 1, next.indent)
        map[key] = value
        i = end
      } else if (next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-')) {
        const [value, end] = parseSequence(items, i + 1, indent)
        map[key] = value
        i = end
      } else {
        map[key] = null
        i++
      }
    } else {
      map[key] = parseScalar(rest, item.line)
      i++
    }
  }
  if (i < items.length && items[i].indent > indent) throw new Error(`yaml line ${items[i].line}: bad indentation`)
  return [map, i]
}

export function parseScalar(text, line = 0) {
  const t = text.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (t.startsWith('"')) return parseDoubleQuoted(t, line)
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new Error(`yaml line ${line}: unterminated string`)
    return t.slice(1, -1).replace(/''/g, "'")
  }
  if (t.startsWith('{')) return parseFlowMap(t, line)
  if (t.startsWith('[')) return parseFlowSeq(t, line)
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

function parseDoubleQuoted(t, line) {
  if (!t.endsWith('"') || t.length < 2) throw new Error(`yaml line ${line}: unterminated string`)
  return t.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' })[c])
}

function splitFlow(inner) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"') current += inner[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function parseFlowMap(t, line) {
  if (!t.endsWith('}')) throw new Error(`yaml line ${line}: unterminated {`)
  const map = {}
  for (const part of splitFlow(t.slice(1, -1))) {
    const m = part.match(/^("[^"]*"|'[^']*'|[^:]+?):\s*(.*)$/s)
    if (!m) throw new Error(`yaml line ${line}: expected "key: value" in {}, got "${part}"`)
    map[parseScalar(m[1], line)] = parseScalar(m[2], line)
  }
  return map
}

function parseFlowSeq(t, line) {
  if (!t.endsWith(']')) throw new Error(`yaml line ${line}: unterminated [`)
  return splitFlow(t.slice(1, -1)).map((part) => parseScalar(part, line))
}

// ---- writer ----

export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`
    return value
      .map((item) => {
        if (isPlainObject(item)) return `${pad}- ${toYaml(item, indent + 2).trimStart()}`
        return `${pad}- ${scalarToYaml(item)}\n`
      })
      .join('')
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}{}\n`
    return keys
      .map((key) => {
        const v = value[key]
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${key}: []\n`
          if (v.every((x) => !isPlainObject(x) && !Array.isArray(x))) return `${pad}${key}: [${v.map(scalarToYaml).join(', ')}]\n`
          return `${pad}${key}:\n${toYaml(v, indent + 2)}`
        }
        if (isPlainObject(v)) return Object.keys(v).length ? `${pad}${key}:\n${toYaml(v, indent + 2)}` : `${pad}${key}: {}\n`
        return `${pad}${key}: ${scalarToYaml(v)}\n`
      })
      .join('')
  }
  return `${pad}${scalarToYaml(value)}\n`
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function scalarToYaml(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (s === '' || /^[\s#\-?:,\[\]{}&*!|>'"%@`]/.test(s) || /[:#]\s|:$|\s$|^(true|false|null|~)$|^-?\d+(\.\d+)?$/.test(s) || s.includes('\n')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return s
}
