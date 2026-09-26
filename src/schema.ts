import type {
  LocalizedString,
  PackAgentItem,
  PackCommandItem,
  PackContents,
  PackManifest,
  PackMcpServerConfig,
  PackSkillItem,
  PackWorkflowItem,
  RegistryIndex,
  RegistryIndexEntry,
} from './types.js'

export class ValidationError extends Error {
  public readonly errors: string[]
  constructor(errors: string[]) {
    super(`Validation failed:\n- ${errors.join('\n- ')}`)
    this.name = 'ValidationError'
    this.errors = errors
  }
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function isLocalizedString(val: unknown): val is LocalizedString {
  if (typeof val === 'string') return true
  if (isObject(val)) {
    return typeof val['en'] === 'string' && typeof val['fr'] === 'string'
  }
  return false
}

export function validatePackManifest(data: unknown): PackManifest {
  const errors: string[] = []

  if (!isObject(data)) {
    throw new ValidationError(['Expected pack manifest to be an object'])
  }

  if (data['schemaVersion'] !== 1) {
    errors.push("Field 'schemaVersion' must be 1")
  }

  if (typeof data['name'] !== 'string' || !/^[a-z0-9-_]+$/.test(data['name'])) {
    errors.push("Field 'name' is required and must be lowercase alphanumeric, dash, or underscore")
  }

  if (typeof data['version'] !== 'string' || data['version'].trim().length === 0) {
    errors.push("Field 'version' is required and must be a non-empty string")
  }

  if (data['displayName'] !== undefined && !isLocalizedString(data['displayName'])) {
    errors.push("Field 'displayName' must be a string or localized object with 'en' and 'fr'")
  }

  if (data['description'] !== undefined && !isLocalizedString(data['description'])) {
    errors.push("Field 'description' must be a string or localized object with 'en' and 'fr'")
  }

  if (data['tags'] !== undefined) {
    if (!Array.isArray(data['tags']) || !data['tags'].every((t) => typeof t === 'string')) {
      errors.push("Field 'tags' must be an array of strings")
    }
  }

  if (!isObject(data['contents'])) {
    errors.push("Field 'contents' must be an object")
  }

  if (errors.length > 0) {
    throw new ValidationError(errors)
  }

  const rawContents = data['contents'] as Record<string, unknown>
  const contents: PackContents = {}

  // Workflows
  if (rawContents['workflows'] !== undefined) {
    if (!Array.isArray(rawContents['workflows'])) {
      errors.push("contents.workflows must be an array")
    } else {
      contents.workflows = rawContents['workflows'].map((wfRaw, idx) => {
        if (!isObject(wfRaw)) {
          errors.push(`contents.workflows[${idx}] must be an object`)
          return {} as PackWorkflowItem
        }
        if (typeof wfRaw['id'] !== 'string' || !wfRaw['id']) {
          errors.push(`contents.workflows[${idx}].id is required`)
        }
        if (typeof wfRaw['name'] !== 'string' || !wfRaw['name']) {
          errors.push(`contents.workflows[${idx}].name is required`)
        }
        if (typeof wfRaw['entryStep'] !== 'string' || !wfRaw['entryStep']) {
          errors.push(`contents.workflows[${idx}].entryStep is required`)
        }
        if (!Array.isArray(wfRaw['steps'])) {
          errors.push(`contents.workflows[${idx}].steps must be an array`)
        }
        return wfRaw as unknown as PackWorkflowItem
      })
    }
  }

  // Agents
  if (rawContents['agents'] !== undefined) {
    if (!Array.isArray(rawContents['agents'])) {
      errors.push("contents.agents must be an array")
    } else {
      contents.agents = rawContents['agents'].map((agRaw, idx) => {
        if (!isObject(agRaw)) {
          errors.push(`contents.agents[${idx}] must be an object`)
          return {} as PackAgentItem
        }
        if (typeof agRaw['id'] !== 'string' || !agRaw['id']) {
          errors.push(`contents.agents[${idx}].id is required`)
        }
        if (typeof agRaw['prompt'] !== 'string') {
          errors.push(`contents.agents[${idx}].prompt must be a string`)
        }
        return agRaw as unknown as PackAgentItem
      })
    }
  }

  // Sub-agents
  if (rawContents['subAgents'] !== undefined) {
    if (!Array.isArray(rawContents['subAgents'])) {
      errors.push("contents.subAgents must be an array")
    } else {
      contents.subAgents = rawContents['subAgents'] as PackAgentItem[]
    }
  }

  // Skills
  if (rawContents['skills'] !== undefined) {
    if (!Array.isArray(rawContents['skills'])) {
      errors.push("contents.skills must be an array")
    } else {
      contents.skills = rawContents['skills'].map((skRaw, idx) => {
        if (!isObject(skRaw)) {
          errors.push(`contents.skills[${idx}] must be an object`)
          return {} as PackSkillItem
        }
        if (typeof skRaw['id'] !== 'string' || !skRaw['id']) {
          errors.push(`contents.skills[${idx}].id is required`)
        }
        if (typeof skRaw['prompt'] !== 'string') {
          errors.push(`contents.skills[${idx}].prompt must be a string`)
        }
        return skRaw as unknown as PackSkillItem
      })
    }
  }

  // Commands
  if (rawContents['commands'] !== undefined) {
    if (!Array.isArray(rawContents['commands'])) {
      errors.push("contents.commands must be an array")
    } else {
      contents.commands = rawContents['commands'] as PackCommandItem[]
    }
  }

  // MCP Servers
  if (rawContents['mcpServers'] !== undefined) {
    if (!isObject(rawContents['mcpServers'])) {
      errors.push("contents.mcpServers must be an object")
    } else {
      contents.mcpServers = {}
      for (const [name, confRaw] of Object.entries(rawContents['mcpServers'])) {
        if (!isObject(confRaw)) {
          errors.push(`contents.mcpServers['${name}'] must be an object`)
          continue
        }
        if (confRaw['transport'] !== 'stdio' && confRaw['transport'] !== 'http') {
          errors.push(`contents.mcpServers['${name}'].transport must be 'stdio' or 'http'`)
        }
        contents.mcpServers[name] = confRaw as unknown as PackMcpServerConfig
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors)
  }

  return {
    schemaVersion: 1,
    name: data['name'] as string,
    version: data['version'] as string,
    displayName: data['displayName'] as LocalizedString | undefined,
    description: data['description'] as LocalizedString | undefined,
    author: data['author'] as PackManifest['author'],
    tags: data['tags'] as string[] | undefined,
    homepage: data['homepage'] as string | undefined,
    repositoryUrl: data['repositoryUrl'] as string | undefined,
    contents,
    dependencies: data['dependencies'] as PackManifest['dependencies'],
  }
}

export function safeValidatePackManifest(
  data: unknown,
): { success: true; data: PackManifest } | { success: false; error: ValidationError } {
  try {
    const validated = validatePackManifest(data)
    return { success: true, data: validated }
  } catch (err) {
    return {
      success: false,
      error: err instanceof ValidationError ? err : new ValidationError([(err as Error).message]),
    }
  }
}

export function validateRegistryIndex(data: unknown): RegistryIndex {
  const errors: string[] = []

  if (!isObject(data)) {
    throw new ValidationError(['Expected registry index to be an object'])
  }

  if (data['version'] !== 1) {
    errors.push("Registry 'version' must be 1")
  }

  if (!Array.isArray(data['packs'])) {
    errors.push("Registry 'packs' must be an array")
  }

  if (errors.length > 0) {
    throw new ValidationError(errors)
  }

  const packs = (data['packs'] as unknown[]).map((pRaw, idx) => {
    if (!isObject(pRaw)) {
      throw new ValidationError([`packs[${idx}] must be an object`])
    }
    if (typeof pRaw['name'] !== 'string' || !pRaw['name']) {
      throw new ValidationError([`packs[${idx}].name is required`])
    }
    if (typeof pRaw['version'] !== 'string' || !pRaw['version']) {
      throw new ValidationError([`packs[${idx}].version is required`])
    }
    if (typeof pRaw['downloadUrl'] !== 'string' || !pRaw['downloadUrl']) {
      throw new ValidationError([`packs[${idx}].downloadUrl is required`])
    }
    return pRaw as unknown as RegistryIndexEntry
  })

  return {
    version: 1,
    name: data['name'] as string | undefined,
    description: data['description'] as string | undefined,
    updatedAt: data['updatedAt'] as string | undefined,
    packs,
  }
}
