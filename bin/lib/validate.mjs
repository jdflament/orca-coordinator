// A minimal JSON-schema checker for schema/board.schema.json: type, required,
// properties, enum, const, items, $ref (local), minItems, maxItems, additionalProperties.
// Returns a list of "path: problem" strings; empty means valid.

export function validateAgainst(schema, value, at = '$', problems = [], root = schema) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root)
    if (!target) throw new Error(`unknown $ref ${schema.$ref}`)
    return validateAgainst(target, value, at, problems, root)
  }
  if ('const' in schema && value !== schema.const) problems.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: must be one of ${schema.enum.join('|')}, got ${JSON.stringify(value)}`)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => isType(value, t))) {
      problems.push(`${at}: expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
      return problems
    }
  }
  if (isType(value, 'object') && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) problems.push(`${at}.${key}: required`)
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) validateAgainst(sub, value[key], `${at}.${key}`, problems, root)
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) validateAgainst(schema.additionalProperties, value[key], `${at}.${key}`, problems, root)
      }
    }
  } else if (isType(value, 'object') && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const key of Object.keys(value)) validateAgainst(schema.additionalProperties, value[key], `${at}.${key}`, problems, root)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: at least ${schema.minItems} item(s)`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: at most ${schema.maxItems} item(s)`)
    if (schema.items) value.forEach((item, i) => validateAgainst(schema.items, item, `${at}[${i}]`, problems, root))
  }
  return problems
}

function isType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}
