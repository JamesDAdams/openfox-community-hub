import { readdir, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type {
  ExportOptions,
  PackAgentItem,
  PackCommandItem,
  PackManifest,
  PackMcpServerConfig,
  PackSkillItem,
  PackWorkflowItem,
  EnvRequirement,
} from './types.js'
import { validatePackManifest } from './schema.js'
import { parseMarkdownFrontmatter } from './frontmatter.js'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function readAgentFromJson(parsed: Record<string, unknown> | null, agentId: string): PackAgentItem | null {
  if (!parsed) return null
  const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
  return {
    id: (meta['id'] as string) ?? (parsed['id'] as string) ?? agentId,
    name: (meta['name'] as string) ?? (parsed['name'] as string) ?? agentId,
    description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
    subagent: Boolean(meta['subagent'] ?? parsed['subagent']),
    prompt: (parsed['prompt'] as string) ?? '',
    allowedTools: toStringArray(meta['allowedTools'] ?? parsed['allowedTools']),
    skills: toStringArray(parsed['skills']),
    mcpServers: toStringArray(parsed['mcpServers']),
    color: (meta['color'] as string) ?? (parsed['color'] as string),
  }
}

function readAgentFromMarkdown(raw: string, agentId: string): PackAgentItem {
  const { data, body } = parseMarkdownFrontmatter(raw)
  return {
    id: (data['id'] as string) ?? agentId,
    name: (data['name'] as string) ?? agentId,
    description: (data['description'] as string) ?? '',
    subagent: data['subagent'] === true,
    prompt: body,
    allowedTools: toStringArray(data['allowedTools']),
    skills: toStringArray(data['skills']),
    mcpServers: toStringArray(data['mcpServers']),
    color: data['color'] as string | undefined,
  }
}

export async function exportPack(options: ExportOptions): Promise<PackManifest> {
  const { workflowId, workdir, configDir, packMetadata } = options

  const projectOpenfoxDir = join(workdir, '.openfox')
  const globalConfigDir = configDir

  // 1. Locate and load workflow
  const workflowLocations = [
    join(projectOpenfoxDir, 'workflows', `${workflowId}.workflow.json`),
    join(projectOpenfoxDir, 'workflows', `${workflowId}.json`),
    join(globalConfigDir, 'workflows', `${workflowId}.workflow.json`),
    join(globalConfigDir, 'workflows', `${workflowId}.json`),
  ]

  let workflowData: PackWorkflowItem | null = null
  for (const loc of workflowLocations) {
    if (await fileExists(loc)) {
      const parsed = await readJsonFile<Record<string, unknown>>(loc)
      if (parsed) {
        const metadata = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
        workflowData = {
          id: (metadata['id'] as string) ?? (parsed['id'] as string) ?? workflowId,
          name: (metadata['name'] as string) ?? (parsed['name'] as string) ?? workflowId,
          description: (metadata['description'] as string) ?? (parsed['description'] as string) ?? '',
          version: (metadata['version'] as string) ?? (parsed['version'] as string),
          color: (metadata['color'] as string) ?? (parsed['color'] as string),
          entryStep: (parsed['entryStep'] as string) ?? (parsed['steps'] as Array<{ id: string }>)?.[0]?.id ?? 'start',
          steps: (parsed['steps'] as PackWorkflowItem['steps']) ?? [],
          settings: parsed['settings'] as PackWorkflowItem['settings'],
        }
        break
      }
    }
  }

  if (!workflowData) {
    throw new Error(`Workflow '${workflowId}' not found in project or global configuration.`)
  }

  const agentIdsToResolve = new Set<string>()
  const skillIdsToResolve = new Set<string>()
  const mcpServerNamesToResolve = new Set<string>()

  // 2. Discover dependencies from workflow steps
  for (const step of workflowData.steps) {
    if (step.agentMode) {
      agentIdsToResolve.add(step.agentMode)
    }
    if (step.subAgentType) {
      agentIdsToResolve.add(step.subAgentType)
    }
    if (typeof step['agent'] === 'string') {
      agentIdsToResolve.add(step['agent'])
    }
    if (Array.isArray(step['skills'])) {
      for (const s of step['skills']) {
        if (typeof s === 'string') skillIdsToResolve.add(s)
      }
    }
  }

  // 3. Resolve agents and sub-agents
  const resolvedAgents: PackAgentItem[] = []
  const resolvedSubAgents: PackAgentItem[] = []

  for (const agentId of agentIdsToResolve) {
    const agentLocations = [
      join(projectOpenfoxDir, 'agents', `${agentId}.agent.md`),
      join(projectOpenfoxDir, 'agents', `${agentId}.json`),
      join(globalConfigDir, 'agents', `${agentId}.agent.md`),
      join(globalConfigDir, 'agents', `${agentId}.json`),
    ]

    for (const loc of agentLocations) {
      if (await fileExists(loc)) {
        const agentItem = loc.endsWith('.json')
          ? readAgentFromJson(await readJsonFile<Record<string, unknown>>(loc), agentId)
          : readAgentFromMarkdown(await readFile(loc, 'utf8'), agentId)

        if (agentItem) {
          const isSubAgent = Boolean(agentItem.subagent)

          if (isSubAgent) {
            resolvedSubAgents.push(agentItem)
          } else {
            resolvedAgents.push(agentItem)
          }

          // Collect skills and MCP servers from agent
          if (agentItem.skills) {
            for (const s of agentItem.skills) skillIdsToResolve.add(s)
          }
          if (agentItem.mcpServers) {
            for (const m of agentItem.mcpServers) mcpServerNamesToResolve.add(m)
          }

          // Extract tools that might correspond to MCP servers (e.g., "mcp:serverName:tool")
          if (agentItem.allowedTools) {
            for (const tool of agentItem.allowedTools) {
              if (tool.startsWith('mcp:')) {
                const parts = tool.split(':')
                if (parts[1]) mcpServerNamesToResolve.add(parts[1])
              }
            }
          }
          break
        }
      }
    }
  }

  // 4. Resolve skills
  const resolvedSkills: PackSkillItem[] = []
  for (const skillId of skillIdsToResolve) {
    const skillLocations = [
      join(projectOpenfoxDir, 'skills', skillId, 'SKILL.md'),
      join(projectOpenfoxDir, 'skills', `${skillId}.md`),
      join(projectOpenfoxDir, 'skills', `${skillId}.json`),
      join(globalConfigDir, 'skills', skillId, 'SKILL.md'),
      join(globalConfigDir, 'skills', `${skillId}.md`),
      join(globalConfigDir, 'skills', `${skillId}.json`),
    ]

    for (const loc of skillLocations) {
      if (await fileExists(loc)) {
        if (loc.endsWith('.json')) {
          const parsed = await readJsonFile<Record<string, unknown>>(loc)
          if (parsed) {
            const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
            resolvedSkills.push({
              id: (meta['id'] as string) ?? (parsed['id'] as string) ?? skillId,
              name: (meta['name'] as string) ?? (parsed['name'] as string) ?? skillId,
              description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
              prompt: (parsed['prompt'] as string) ?? '',
              group: (meta['group'] as string) ?? (parsed['group'] as string),
              version: (meta['version'] as string) ?? (parsed['version'] as string),
            })
            break
          }
        } else {
          const raw = await readFile(loc, 'utf8')
          const { data, body } = parseMarkdownFrontmatter(raw)
          const meta = (data['metadata'] as Record<string, unknown> | undefined) ?? {}
          const openfox = (meta['openfox'] as Record<string, unknown> | undefined) ?? {}
          const portableName = (data['name'] as string) ?? skillId
          const version = meta['version'] ?? data['version']
          const group = (data['group'] as string) ?? undefined
          resolvedSkills.push({
            id: (data['id'] as string) ?? portableName,
            name: (openfox['displayName'] as string) ?? portableName,
            description: (data['description'] as string) ?? '',
            prompt: body,
            ...(group ? { group } : {}),
            ...(version === undefined ? {} : { version: String(version) }),
          })
          break
        }
      }
    }
  }

  // 5. Resolve MCP Servers
  const resolvedMcpServers: Record<string, PackMcpServerConfig> = {}
  const mcpConfigFiles = [
    join(projectOpenfoxDir, 'mcp.json'),
    join(globalConfigDir, 'mcp.json'),
  ]

  for (const mcpFile of mcpConfigFiles) {
    if (await fileExists(mcpFile)) {
      const parsed = await readJsonFile<Record<string, unknown>>(mcpFile)
      const servers = (parsed?.['mcpServers'] ?? parsed) as Record<string, unknown> | undefined
      if (servers && typeof servers === 'object') {
        for (const [srvName, srvConfRaw] of Object.entries(servers)) {
          if (srvConfRaw && typeof srvConfRaw === 'object') {
            const conf = srvConfRaw as Record<string, unknown>
            if (mcpServerNamesToResolve.size === 0 || mcpServerNamesToResolve.has(srvName)) {
              const envRaw = (conf['env'] as Record<string, string> | undefined) ?? {}
              const envRequirements: EnvRequirement[] = []
              const cleanEnv: Record<string, string> = {}

              for (const [envKey, envVal] of Object.entries(envRaw)) {
                // If it's a template like ${MY_TOKEN}
                const match = typeof envVal === 'string' ? envVal.match(/\$\{([^}]+)\}/) : null
                if (match?.[1]) {
                  envRequirements.push({
                    key: match[1],
                    description: `Environment variable for ${srvName}`,
                    required: true,
                  })
                  cleanEnv[envKey] = `\${${match[1]}}`
                } else if (
                  /token|key|secret|password|auth|bearer|credential/i.test(envKey) &&
                  typeof envVal === 'string' &&
                  !envVal.startsWith('http://') &&
                  !envVal.startsWith('https://')
                ) {
                  // Redact explicit secrets and create env requirement
                  envRequirements.push({
                    key: envKey,
                    description: `API Key / Secret for ${srvName}`,
                    required: true,
                  })
                  cleanEnv[envKey] = `\${${envKey}}`
                } else {
                  cleanEnv[envKey] = envVal
                }
              }

              resolvedMcpServers[srvName] = {
                transport: conf['transport'] === 'http' ? 'http' : 'stdio',
                command: conf['command'] as string | undefined,
                args: conf['args'] as string[] | undefined,
                url: conf['url'] as string | undefined,
                headers: conf['headers'] as Record<string, string> | undefined,
                env: Object.keys(cleanEnv).length > 0 ? cleanEnv : undefined,
                envRequirements: envRequirements.length > 0 ? envRequirements : undefined,
                disabledTools: conf['disabledTools'] as string[] | undefined,
                timeout: typeof conf['timeout'] === 'number' ? conf['timeout'] : undefined,
              }
            }
          }
        }
      }
    }
  }

  // 6. Resolve associated commands
  const resolvedCommands: PackCommandItem[] = []
  const commandDirs = [
    join(projectOpenfoxDir, 'commands'),
    join(globalConfigDir, 'commands'),
  ]

  for (const cmdDir of commandDirs) {
    if (await fileExists(cmdDir)) {
      try {
        const files = await readdir(cmdDir)
        for (const file of files) {
          const filePath = join(cmdDir, file)
          let cmdId = ''
          let cmdName = ''
          let prompt = ''
          let agentMode: string | undefined

          if (file.endsWith('.command.md')) {
            const raw = await readFile(filePath, 'utf8')
            const { data, body } = parseMarkdownFrontmatter(raw)
            cmdId = (data['id'] as string) ?? file.replace(/\.command\.md$/, '')
            cmdName = (data['name'] as string) ?? cmdId
            prompt = body
            agentMode = data['agentMode'] as string | undefined
          } else if (file.endsWith('.json')) {
            const parsed = await readJsonFile<Record<string, unknown>>(filePath)
            if (!parsed) continue
            const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
            cmdId = (meta['id'] as string) ?? (parsed['id'] as string) ?? file.replace('.json', '')
            cmdName = (meta['name'] as string) ?? (parsed['name'] as string) ?? cmdId
            prompt = (parsed['prompt'] as string) ?? ''
            agentMode = (meta['agentMode'] as string) ?? (parsed['agentMode'] as string)
          } else {
            continue
          }

          if (prompt.includes(workflowId) || cmdName.toLowerCase().includes(workflowId.toLowerCase())) {
            resolvedCommands.push({
              id: cmdId,
              name: cmdName,
              prompt,
              ...(agentMode ? { agentMode } : {}),
            })
          }
        }
      } catch {
        // ignore read errors
      }
    }
  }

  // 7. Assemble PackManifest
  const packName =
    packMetadata?.name ??
    workflowData.id
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')

  const rawManifest: PackManifest = {
    schemaVersion: 1,
    name: packName,
    version: packMetadata?.version ?? workflowData.version ?? '1.0.0',
    displayName: packMetadata?.displayName ?? workflowData.name,
    description: packMetadata?.description ?? workflowData.description,
    author: packMetadata?.author ?? 'Community',
    tags: packMetadata?.tags ?? ['workflow', workflowData.id],
    repositoryUrl: packMetadata?.repositoryUrl,
    contents: {
      workflows: [workflowData],
      ...(resolvedAgents.length > 0 ? { agents: resolvedAgents } : {}),
      ...(resolvedSubAgents.length > 0 ? { subAgents: resolvedSubAgents } : {}),
      ...(resolvedSkills.length > 0 ? { skills: resolvedSkills } : {}),
      ...(resolvedCommands.length > 0 ? { commands: resolvedCommands } : {}),
      ...(Object.keys(resolvedMcpServers).length > 0 ? { mcpServers: resolvedMcpServers } : {}),
    },
  }

  return validatePackManifest(rawManifest)
}
