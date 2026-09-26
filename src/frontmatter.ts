/**
 * Dependency-free YAML frontmatter helpers shared by the installer, the bundler
 * and the publisher.
 *
 * The Hub ships with no runtime dependencies, so we cannot lean on gray-matter
 * (which the core uses). The parser below covers the subset of YAML the core
 * writes and reads: flat scalars, block sequences and nested maps.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

function coerceScalar(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

export function parseMarkdownFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) {
    return { data: {}, body: content }
  }

  const endIdx = trimmed.indexOf('\n---', 3)
  if (endIdx === -1) {
    return { data: {}, body: content }
  }

  const rawHeader = trimmed.slice(3, endIdx).trim()
  const body = trimmed.slice(endIdx + 4).trim()
  const data: Record<string, unknown> = {}

  const lines = rawHeader.split('\n')
  let currentKey = ''
  let isMultiline = false
  let multilineType = ''
  let multilineLines: string[] = []
  let isArray = false
  let arrayItems: string[] = []
  const nestedStack: Array<{ indent: number; obj: Record<string, unknown> }> = []

  const flushCurrent = () => {
    if (currentKey) {
      if (isMultiline) {
        if (multilineType.includes('>')) {
          data[currentKey] = multilineLines.join(' ').trim()
        } else {
          data[currentKey] = multilineLines.join('\n').trim()
        }
      } else if (isArray) {
        data[currentKey] = arrayItems
      }
    }
    isMultiline = false
    multilineType = ''
    multilineLines = []
    isArray = false
    arrayItems = []
    nestedStack.length = 0
  }

  for (const line of lines) {
    const trimmedLine = line.trim()
    const indent = line.length - line.trimStart().length

    if (indent > 0 && currentKey) {
      if (isMultiline) {
        multilineLines.push(trimmedLine)
        continue
      } else if (trimmedLine.startsWith('- ')) {
        isArray = true
        let itemVal = trimmedLine.slice(2).trim()
        if (itemVal.startsWith('"') && itemVal.endsWith('"')) itemVal = itemVal.slice(1, -1)
        else if (itemVal.startsWith("'") && itemVal.endsWith("'")) itemVal = itemVal.slice(1, -1)
        arrayItems.push(itemVal)
        continue
      }

      const nestedColonIdx = trimmedLine.indexOf(':')
      if (nestedColonIdx > 0) {
        if (nestedStack.length === 0) {
          const root: Record<string, unknown> = {}
          data[currentKey] = root
          nestedStack.push({ indent: 0, obj: root })
        }
        while (nestedStack.length > 1 && nestedStack[nestedStack.length - 1]!.indent >= indent) {
          nestedStack.pop()
        }
        const nestedKey = trimmedLine.slice(0, nestedColonIdx).trim()
        const nestedVal = trimmedLine.slice(nestedColonIdx + 1).trim()
        const target = nestedStack[nestedStack.length - 1]!.obj
        if (!nestedVal) {
          const child: Record<string, unknown> = {}
          target[nestedKey] = child
          nestedStack.push({ indent, obj: child })
        } else {
          target[nestedKey] = coerceScalar(nestedVal)
        }
        continue
      }
    }

    const colonIdx = line.indexOf(':')
    if (colonIdx > 0 && indent === 0) {
      flushCurrent()
      const key = line.slice(0, colonIdx).trim()
      const val = line.slice(colonIdx + 1).trim()

      if (val === '>-' || val === '>' || val === '|' || val === '|-') {
        currentKey = key
        isMultiline = true
        multilineType = val
      } else if (!val) {
        currentKey = key
      } else {
        data[key] = coerceScalar(val)
        currentKey = key
      }
    }
  }

  flushCurrent()

  return { data, body }
}

const SAFE_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 .,;!?()/@_+-]*$/

function formatScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  return SAFE_SCALAR.test(text) && !text.endsWith(' ') ? text : JSON.stringify(text)
}

function serializeFrontmatter(data: Record<string, unknown>, indent = ''): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue

    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${indent}${key}:`)
      for (const item of value) {
        lines.push(`${indent}  - ${formatScalar(item)}`)
      }
      continue
    }

    if (typeof value === 'object') {
      const nested = serializeFrontmatter(value as Record<string, unknown>, `${indent}  `)
      if (nested.length === 0) continue
      lines.push(`${indent}${key}:`)
      lines.push(...nested)
      continue
    }

    lines.push(`${indent}${key}: ${formatScalar(value)}`)
  }
  return lines
}

/** Build a markdown file with a frontmatter block the core loaders accept. */
export function buildMarkdownFrontmatter(data: Record<string, unknown>, body: string): string {
  const header = serializeFrontmatter(data)
  return `---\n${header.join('\n')}\n---\n\n${body.trim()}\n`
}
