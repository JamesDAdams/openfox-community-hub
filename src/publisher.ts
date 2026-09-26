import { readdir, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type {
  PackAgentItem,
  PackCommandItem,
  PackManifest,
  PackMcpServerConfig,
  PackSkillItem,
  PackWorkflowItem,
  RegistryIndex,
  RegistryIndexEntry,
} from './types.js'
import { validatePackManifest } from './schema.js'
import { parseMarkdownFrontmatter } from './frontmatter.js'

export const GITHUB_TOKEN_CREATE_URL =
  'https://github.com/settings/tokens/new?description=OpenFox+Community+Hub+Publisher+(1+Year)&scopes=public_repo'

export interface LocalItemInfo {
  id: string
  name: string
  description?: string
  color?: string
  group?: string
  scope: 'project' | 'global'
  type: 'workflow' | 'agent' | 'subagent' | 'skill' | 'command' | 'mcp'
  mcpConfig?: {
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
    headers?: Record<string, string>
    env?: Record<string, string>
  }
}

export interface LocalInventory {
  workflows: LocalItemInfo[]
  agents: LocalItemInfo[]
  subAgents: LocalItemInfo[]
  skills: LocalItemInfo[]
  commands: LocalItemInfo[]
  mcpServers: LocalItemInfo[]
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function scanSkillsDirectory(
  baseDir: string,
  relativePath: string = '',
  scope: 'project' | 'global',
  results: LocalItemInfo[],
): Promise<void> {
  const currentDir = relativePath ? join(baseDir, relativePath) : baseDir
  if (!(await fileExists(currentDir))) return

  try {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      if (entry.isDirectory()) {
        const subDir = join(currentDir, entry.name)
        const subRel = relativePath ? `${relativePath}/${entry.name}` : entry.name
        const skillMd = join(subDir, 'SKILL.md')
        const skillAltMd = join(subDir, `${entry.name}.md`)

        if ((await fileExists(skillMd)) || (await fileExists(skillAltMd))) {
          const target = (await fileExists(skillMd)) ? skillMd : skillAltMd
          const raw = await readFile(target, 'utf8')
          const { data } = parseMarkdownFrontmatter(raw)
          const name = (data['name'] as string) ?? (data['id'] as string) ?? entry.name
          const desc = (data['description'] as string) ?? ''
          const group = (data['group'] as string) ?? (relativePath ? relativePath.replace(/\//g, ' · ') : undefined)
          const displayName = group ? `${group} · ${name}` : name

          if (!results.some((s) => s.id === subRel || s.name === displayName)) {
            results.push({
              id: subRel,
              name: displayName,
              description: desc,
              group,
              scope,
              type: 'skill',
            })
          }
        } else {
          // Recurse deeper into group folder
          await scanSkillsDirectory(baseDir, subRel, scope, results)
        }
      } else if (entry.name.endsWith('.md')) {
        const id = relativePath
          ? `${relativePath}/${entry.name.replace(/\.md$/, '')}`
          : entry.name.replace(/\.md$/, '')
        const raw = await readFile(join(currentDir, entry.name), 'utf8')
        const { data } = parseMarkdownFrontmatter(raw)
        const name = (data['name'] as string) ?? (data['id'] as string) ?? id
        const group = (data['group'] as string) ?? (relativePath ? relativePath.replace(/\//g, ' · ') : undefined)
        const displayName = group ? `${group} · ${name}` : name

        if (!results.some((s) => s.id === id || s.name === displayName)) {
          results.push({
            id,
            name: displayName,
            description: (data['description'] as string) ?? '',
            group,
            scope,
            type: 'skill',
          })
        }
      } else if (entry.name.endsWith('.json')) {
        const id = relativePath
          ? `${relativePath}/${entry.name.replace(/\.json$/, '')}`
          : entry.name.replace(/\.json$/, '')
        const parsed = await readJsonSafe<Record<string, unknown>>(join(currentDir, entry.name))
        if (parsed) {
          const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
          const name = (meta['name'] as string) ?? (parsed['name'] as string) ?? id
          const group = (meta['group'] as string) ?? (relativePath ? relativePath.replace(/\//g, ' · ') : undefined)
          const displayName = group ? `${group} · ${name}` : name

          if (!results.some((s) => s.id === id || s.name === displayName)) {
            results.push({
              id,
              name: displayName,
              description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
              group,
              scope,
              type: 'skill',
            })
          }
        }
      }
    }
  } catch {
    // ignore
  }
}

export async function listLocalItems(
  workdir: string,
  configDir: string,
): Promise<LocalInventory> {
  const inventory: LocalInventory = {
    workflows: [],
    agents: [],
    subAgents: [],
    skills: [],
    commands: [],
    mcpServers: [],
  }

  const globalDirs = [configDir]
  if (configDir.includes('openfox-dev')) {
    globalDirs.push(configDir.replace('openfox-dev', 'openfox'))
  } else if (configDir.includes('openfox')) {
    globalDirs.push(configDir.replace('openfox', 'openfox-dev'))
  }

  const scopes: Array<{ scope: 'project' | 'global'; dir: string }> = [
    { scope: 'project', dir: join(workdir, '.openfox') },
    ...globalDirs.map((dir) => ({ scope: 'global' as const, dir })),
  ]

  for (const { scope, dir } of scopes) {
    if (!(await fileExists(dir))) continue

    // 1. Workflows
    const wfDir = join(dir, 'workflows')
    if (await fileExists(wfDir)) {
      try {
        const files = await readdir(wfDir)
        for (const f of files) {
          if (f.endsWith('.json')) {
            const parsed = await readJsonSafe<Record<string, unknown>>(join(wfDir, f))
            if (parsed) {
              const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
              const id = (meta['id'] as string) ?? (parsed['id'] as string) ?? f.replace(/\.workflow\.json$/, '').replace(/\.json$/, '')
              const name = (meta['name'] as string) ?? (parsed['name'] as string) ?? id
              const description = (meta['description'] as string) ?? (parsed['description'] as string) ?? ''
              if (!inventory.workflows.some((w) => w.id === id)) {
                inventory.workflows.push({ id, name, description, scope, type: 'workflow' })
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 2. Agents & Sub-agents (.agent.md, .md, .json)
    const agDir = join(dir, 'agents')
    if (await fileExists(agDir)) {
      try {
        const files = await readdir(agDir)
        for (const f of files) {
          if (f.endsWith('.json')) {
            const parsed = await readJsonSafe<Record<string, unknown>>(join(agDir, f))
            if (parsed) {
              const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
              const id = (meta['id'] as string) ?? (parsed['id'] as string) ?? f.replace(/\.json$/, '')
              const name = (meta['name'] as string) ?? (parsed['name'] as string) ?? id
              const description = (meta['description'] as string) ?? (parsed['description'] as string) ?? ''
              const color = (meta['color'] as string) ?? (parsed['color'] as string) ?? undefined
              const isSubAgent = Boolean(meta['subagent'] ?? parsed['subagent'])

              if (isSubAgent) {
                if (!inventory.subAgents.some((sa) => sa.id === id)) {
                  inventory.subAgents.push({ id, name, description, color, scope, type: 'subagent' })
                }
              } else {
                if (!inventory.agents.some((ag) => ag.id === id)) {
                  inventory.agents.push({ id, name, description, color, scope, type: 'agent' })
                }
              }
            }
          } else if (f.endsWith('.agent.md') || f.endsWith('.md')) {
            try {
              const raw = await readFile(join(agDir, f), 'utf8')
              const { data } = parseMarkdownFrontmatter(raw)
              const id = (data['id'] as string) ?? f.replace(/\.agent\.md$/, '').replace(/\.md$/, '')
              const name = (data['name'] as string) ?? id
              const description = (data['description'] as string) ?? ''
              const color = (data['color'] as string) ?? undefined
              const isSubAgent = Boolean(data['subagent'])

              if (isSubAgent) {
                if (!inventory.subAgents.some((sa) => sa.id === id)) {
                  inventory.subAgents.push({ id, name, description, color, scope, type: 'subagent' })
                }
              } else {
                if (!inventory.agents.some((ag) => ag.id === id)) {
                  inventory.agents.push({ id, name, description, color, scope, type: 'agent' })
                }
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 3. Skills (recursive folder scan)
    const skDir = join(dir, 'skills')
    await scanSkillsDirectory(skDir, '', scope, inventory.skills)

    // 4. Commands (.command.md, .md, .json)
    const cmdDir = join(dir, 'commands')
    if (await fileExists(cmdDir)) {
      try {
        const files = await readdir(cmdDir)
        for (const f of files) {
          if (f.endsWith('.json')) {
            const parsed = await readJsonSafe<Record<string, unknown>>(join(cmdDir, f))
            if (parsed) {
              const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
              const id = (meta['id'] as string) ?? (parsed['id'] as string) ?? f.replace(/\.json$/, '')
              const name = (meta['name'] as string) ?? (parsed['name'] as string) ?? id
              if (!inventory.commands.some((cmd) => cmd.id === id)) {
                inventory.commands.push({ id, name, scope, type: 'command' })
              }
            }
          } else if (f.endsWith('.command.md') || f.endsWith('.md')) {
            try {
              const raw = await readFile(join(cmdDir, f), 'utf8')
              const { data } = parseMarkdownFrontmatter(raw)
              const id = (data['id'] as string) ?? f.replace(/\.command\.md$/, '').replace(/\.md$/, '')
              const name = (data['name'] as string) ?? id
              const description = (data['description'] as string) ?? ''
              if (!inventory.commands.some((cmd) => cmd.id === id)) {
                inventory.commands.push({ id, name, description, scope, type: 'command' })
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 5. MCP Servers (mcp.json and config.json)
    const mcpFiles = [join(dir, 'mcp.json'), join(dir, 'config.json')]
    for (const mcpFile of mcpFiles) {
      if (await fileExists(mcpFile)) {
        const parsed = await readJsonSafe<Record<string, unknown>>(mcpFile)
        const servers = (parsed?.['mcpServers'] ?? parsed) as Record<string, unknown> | undefined
        if (servers && typeof servers === 'object') {
          for (const [srvName, srvConf] of Object.entries(servers)) {
            if (srvConf && typeof srvConf === 'object' && ('command' in srvConf || 'url' in srvConf || 'transport' in srvConf)) {
              const conf = srvConf as Record<string, unknown>
              if (!inventory.mcpServers.some((m) => m.id === srvName)) {
                inventory.mcpServers.push({
                  id: srvName,
                  name: srvName,
                  description: `Transport: ${conf['transport'] ?? 'stdio'}`,
                  scope,
                  type: 'mcp',
                  mcpConfig: {
                    transport: conf['transport'] === 'http' ? 'http' : 'stdio',
                    command: conf['command'] as string | undefined,
                    args: conf['args'] as string[] | undefined,
                    url: conf['url'] as string | undefined,
                    headers: (conf['headers'] as Record<string, string> | undefined) ?? {},
                    env: (conf['env'] as Record<string, string> | undefined) ?? {},
                  },
                })
              }
            }
          }
        }
      }
    }
  }

  return inventory
}

export async function resolveComponentDependencies(
  type: string,
  id: string,
  workdir: string,
  configDir: string,
): Promise<Array<{ type: string; id: string }>> {
  const globalDirs = [configDir]
  if (configDir.includes('openfox-dev')) {
    globalDirs.push(configDir.replace('openfox-dev', 'openfox'))
  } else if (configDir.includes('openfox')) {
    globalDirs.push(configDir.replace('openfox', 'openfox-dev'))
  }
  const searchDirs = [join(workdir, '.openfox'), ...globalDirs]
  const inventory = await listLocalItems(workdir, configDir)
  const resolved: Array<{ type: string; id: string }> = []
  const resolvedKeys = new Set<string>()

  const addResolved = (itemType: string, itemId: string) => {
    const key = `${itemType}:${itemId}`
    if (!resolvedKeys.has(key)) {
      resolvedKeys.add(key)
      resolved.push({ type: itemType, id: itemId })
    }
  }

  const agentIdsToVisit = new Set<string>()
  const visitedAgentIds = new Set<string>()
  const skillIdsToVisit = new Set<string>()
  const mcpNamesToVisit = new Set<string>()

  // Helper to extract mentions from any prompt/instruction text
  const extractFromText = (text: string) => {
    if (!text) return

    // 1. Check all inventory skills directly in text
    for (const sk of inventory.skills) {
      const shortId = sk.id.split('/').pop()?.toLowerCase() ?? sk.id.toLowerCase()
      const lowerText = text.toLowerCase()
      if (
        lowerText.includes(sk.id.toLowerCase()) ||
        lowerText.includes(shortId) ||
        (sk.name && lowerText.includes(sk.name.toLowerCase()))
      ) {
        skillIdsToVisit.add(sk.id)
      }
    }

    // 2. Check all inventory agents / subagents directly in text
    for (const ag of [...inventory.agents, ...inventory.subAgents]) {
      const lowerText = text.toLowerCase()
      if (lowerText.includes(ag.id.toLowerCase())) {
        if (!visitedAgentIds.has(ag.id)) {
          agentIdsToVisit.add(ag.id)
        }
      }
    }

    // 3. Check all inventory MCP servers directly in text
    for (const mcp of inventory.mcpServers) {
      const lowerText = text.toLowerCase()
      if (lowerText.includes(mcp.id.toLowerCase()) || lowerText.includes(mcp.name.toLowerCase())) {
        mcpNamesToVisit.add(mcp.id)
      }
    }

    // 4. Regex fallback for load_skill mentions
    const loadSkillMatches = text.matchAll(/load_skill[^\n`"']*?(?:with\s+)?(?:`|["'])([^`"'\n)]+)["'`]/gi)
    for (const match of loadSkillMatches) {
      if (match[1] && match[1].trim() !== 'with') {
        skillIdsToVisit.add(match[1].trim())
      }
    }

    // 5. Regex fallback for `xxx` skill or skill `xxx`
    const skillWordMatches = text.matchAll(/(?:skills?|compétences?)\s+[`"']([^`"'\n]+)[`"']|[`"']([^`"'\n]+)[`"']\s+(?:skills?|compétences?)/gi)
    for (const match of skillWordMatches) {
      const found = match[1] ?? match[2]
      if (found) skillIdsToVisit.add(found.trim())
    }

    // 6. Sub-agents / agents called or mentioned in prompts
    const subAgentMatches = text.matchAll(/(?:call_sub_agent|sub-agent|subagent|delegate to|calling)\s+(?:with\s+)?(?:subAgentType:\s*)?(?:`|["']|\b)([a-zA-Z0-9_-]+)(?:`|["']|\b)/gi)
    for (const match of subAgentMatches) {
      const candidate = match[1]?.trim()
      if (candidate && candidate !== 'with' && candidate !== 'via' && candidate !== 'using' && candidate !== 'subAgentType') {
        if (!visitedAgentIds.has(candidate)) {
          agentIdsToVisit.add(candidate)
        }
      }
    }
  }

  // Helper to extract MCP servers from tool lists
  const extractFromTools = (tools: string[]) => {
    const builtInPrefixes = ['read', 'write', 'edit', 'run', 'ask', 'load', 'session', 'dev', 'background', 'workspace', 'project', 'step', 'describe', 'web', 'return', 'chrome']
    for (const tool of tools) {
      if (tool === '__mcp_none__') continue

      for (const mcp of inventory.mcpServers) {
        if (tool.toLowerCase().startsWith(mcp.id.toLowerCase() + '_') || tool.toLowerCase().startsWith('mcp:' + mcp.id.toLowerCase())) {
          mcpNamesToVisit.add(mcp.id)
        }
      }

      if (tool.startsWith('mcp:')) {
        const parts = tool.split(':')
        if (parts[1]) mcpNamesToVisit.add(parts[1])
      } else {
        const underscoreIdx = tool.indexOf('_')
        if (underscoreIdx > 0) {
          const prefix = tool.slice(0, underscoreIdx)
          if (!builtInPrefixes.includes(prefix.toLowerCase())) {
            mcpNamesToVisit.add(prefix)
          }
        }
      }
    }
  }

  // 1. If Workflow selected, scan its steps
  if (type === 'workflow' || type === 'wf') {
    for (const dir of searchDirs) {
      const locWf = join(dir, 'workflows', `${id}.workflow.json`)
      const locAlt = join(dir, 'workflows', `${id}.json`)
      const targetLoc = (await fileExists(locWf)) ? locWf : (await fileExists(locAlt)) ? locAlt : null

      if (targetLoc) {
        const parsed = await readJsonSafe<Record<string, unknown>>(targetLoc)
        if (parsed) {
          if (typeof parsed['prompt'] === 'string') extractFromText(parsed['prompt'])

          if (Array.isArray(parsed['steps'])) {
            for (const step of parsed['steps'] as Array<Record<string, unknown>>) {
              if (typeof step['agentId'] === 'string') agentIdsToVisit.add(step['agentId'])
              if (typeof step['agentMode'] === 'string') agentIdsToVisit.add(step['agentMode'])
              if (typeof step['subAgentType'] === 'string') agentIdsToVisit.add(step['subAgentType'])
              if (typeof step['agent'] === 'string') agentIdsToVisit.add(step['agent'])

              if (Array.isArray(step['skills'])) {
                for (const s of step['skills']) {
                  if (typeof s === 'string') skillIdsToVisit.add(s)
                }
              }

              if (typeof step['prompt'] === 'string') {
                extractFromText(step['prompt'])
              }
            }
          }
        }
        break
      }
    }
  } else if (type === 'agent' || type === 'ag' || type === 'subagent' || type === 'sa') {
    agentIdsToVisit.add(id)
  }

  // 2. Recursively resolve Agents -> Sub-agents, Skills, MCP servers
  while (agentIdsToVisit.size > 0) {
    const currentBatch = Array.from(agentIdsToVisit)
    agentIdsToVisit.clear()

    for (const agId of currentBatch) {
      if (visitedAgentIds.has(agId)) continue
      visitedAgentIds.add(agId)

      let foundSubagent = false
      let found = false

      for (const dir of searchDirs) {
        const locJson = join(dir, 'agents', `${agId}.json`)
        const locAgentMd = join(dir, 'agents', `${agId}.agent.md`)
        const locMd = join(dir, 'agents', `${agId}.md`)

        if (await fileExists(locJson)) {
          const parsed = await readJsonSafe<Record<string, unknown>>(locJson)
          if (parsed) {
            const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
            foundSubagent = Boolean(meta['subagent'] ?? parsed['subagent'])
            found = true

            const explicitSkills = Array.isArray(parsed['skills']) ? (parsed['skills'] as string[]) : []
            for (const s of explicitSkills) skillIdsToVisit.add(s)

            const explicitMcps = Array.isArray(parsed['mcpServers']) ? (parsed['mcpServers'] as string[]) : []
            for (const m of explicitMcps) mcpNamesToVisit.add(m)

            const tools = (meta['allowedTools'] as string[]) ?? (parsed['allowedTools'] as string[]) ?? []
            extractFromTools(tools)

            const prompt = (parsed['prompt'] as string) ?? ''
            extractFromText(prompt)
            break
          }
        } else if ((await fileExists(locAgentMd)) || (await fileExists(locMd))) {
          const target = (await fileExists(locAgentMd)) ? locAgentMd : locMd
          const raw = await readFile(target, 'utf8')
          const { data, body } = parseMarkdownFrontmatter(raw)
          foundSubagent = Boolean(data['subagent'])
          found = true

          const explicitSkills = Array.isArray(data['skills']) ? (data['skills'] as string[]) : []
          for (const s of explicitSkills) skillIdsToVisit.add(s)

          const explicitMcps = Array.isArray(data['mcpServers']) ? (data['mcpServers'] as string[]) : []
          for (const m of explicitMcps) mcpNamesToVisit.add(m)

          const tools = (data['allowedTools'] as string[]) ?? []
          extractFromTools(tools)

          extractFromText(body)
          break
        }
      }

      if (!found) {
        const invMatch = inventory.agents.find((a) => a.id === agId) ?? inventory.subAgents.find((sa) => sa.id === agId)
        if (invMatch) {
          foundSubagent = invMatch.type === 'subagent'
          found = true
        }
      }

      if (found) {
        addResolved(foundSubagent ? 'subagent' : 'agent', agId)
      }
    }
  }

  // 3. Resolve Skills matching against inventory
  for (const skId of skillIdsToVisit) {
    const cleanId = skId.replace(/^skills?\//, '').trim()
    const match = inventory.skills.find(
      (s) =>
        s.id === cleanId ||
        s.id.endsWith(`/${cleanId}`) ||
        s.id.split('/').pop()?.toLowerCase() === cleanId.toLowerCase() ||
        s.name.toLowerCase() === cleanId.toLowerCase() ||
        s.name.toLowerCase().endsWith(`· ${cleanId.toLowerCase()}`) ||
        s.name.toLowerCase().includes(cleanId.toLowerCase()),
    )
    if (match) {
      addResolved('skill', match.id)
    } else {
      addResolved('skill', cleanId)
    }
  }

  // 4. Resolve MCP servers matching against inventory
  for (const mcpName of mcpNamesToVisit) {
    if (mcpName !== '__mcp_none__') {
      const match = inventory.mcpServers.find(
        (m) =>
          m.id.toLowerCase() === mcpName.toLowerCase() ||
          m.name.toLowerCase() === mcpName.toLowerCase() ||
          m.id.toLowerCase().includes(mcpName.toLowerCase()) ||
          mcpName.toLowerCase().includes(m.id.toLowerCase()),
      )
      if (match) {
        addResolved('mcp', match.id)
      } else {
        addResolved('mcp', mcpName)
      }
    }
  }

  return resolved
}

export function getGithubRepoFromRegistryUrl(url: string): string | null {
  const trimmed = url.trim()
  const rawMatch = trimmed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//i)
  if (rawMatch?.[1] && rawMatch[2]) return `${rawMatch[1]}/${rawMatch[2]}`

  const githubMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\//i)
  if (githubMatch?.[1] && githubMatch[2]) return `${githubMatch[1]}/${githubMatch[2]}`

  return null
}

export async function verifyGitlabToken(
  token: string,
  fetchFn: typeof fetch = globalThis.fetch,
  host: string = 'gitlab.com',
): Promise<{ valid: boolean; username?: string; error?: string }> {
  if (!token || !token.trim()) {
    return { valid: false, error: 'Token is empty' }
  }

  try {
    const res = await fetchFn(`https://${host}/api/v4/user`, {
      headers: {
        'PRIVATE-TOKEN': token.trim(),
        'User-Agent': 'OpenFox-Community-Hub-Plugin',
      },
    })

    if (!res.ok) {
      return { valid: false, error: `GitLab API responded with ${res.status} ${res.statusText}` }
    }

    const data = (await res.json()) as { username?: string; name?: string }
    return { valid: true, username: data.username || data.name || 'gitlab-user' }
  } catch (err) {
    return { valid: false, error: (err as Error).message }
  }
}

export async function verifyRegistryToken(
  token: string,
  type: 'github' | 'gitlab' = 'github',
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ valid: boolean; username?: string; error?: string }> {
  if (type === 'gitlab') {
    return verifyGitlabToken(token, fetchFn)
  }
  return verifyGithubToken(token, fetchFn)
}

export async function verifyGithubToken(token: string, fetchFn: typeof fetch = globalThis.fetch): Promise<{ valid: boolean; username?: string; error?: string }> {
  if (!token || !token.trim()) {
    return { valid: false, error: 'Token is empty' }
  }

  try {
    const res = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenFox-Community-Hub-Plugin',
      },
    })

    if (!res.ok) {
      return { valid: false, error: `GitHub API responded with ${res.status} ${res.statusText}` }
    }

    const data = (await res.json()) as { login: string }
    return { valid: true, username: data.login }
  } catch (err) {
    return { valid: false, error: (err as Error).message }
  }
}

export interface CustomPackOptions {
  workdir: string
  configDir: string
  metadata: {
    name?: string
    version?: string
    displayName?: string
    description?: string
    author?: string
    tags?: string[]
  }
  selected: {
    workflows?: string[]
    agents?: string[]
    subAgents?: string[]
    skills?: string[]
    commands?: string[]
    mcpServers?: string[]
  }
  mcpCustomConfigs?: Record<string, { args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }>
}

export async function buildCustomPack(options: CustomPackOptions): Promise<PackManifest> {
  const { workdir, configDir, metadata, selected, mcpCustomConfigs } = options
  const globalDirs = [configDir]
  if (configDir.includes('openfox-dev')) {
    globalDirs.push(configDir.replace('openfox-dev', 'openfox'))
  } else if (configDir.includes('openfox')) {
    globalDirs.push(configDir.replace('openfox', 'openfox-dev'))
  }
  const searchDirs = [join(workdir, '.openfox'), ...globalDirs]

  const workflows: PackWorkflowItem[] = []
  const agents: PackAgentItem[] = []
  const subAgents: PackAgentItem[] = []
  const skills: PackSkillItem[] = []
  const commands: PackCommandItem[] = []
  const mcpServers: Record<string, PackMcpServerConfig> = {}

  // 1. Selected Workflows
  for (const wfId of selected.workflows ?? []) {
    for (const dir of searchDirs) {
      const loc = join(dir, 'workflows', `${wfId}.workflow.json`)
      const locAlt = join(dir, 'workflows', `${wfId}.json`)
      const targetLoc = (await fileExists(loc)) ? loc : (await fileExists(locAlt)) ? locAlt : null

      if (targetLoc) {
        const parsed = await readJsonSafe<Record<string, unknown>>(targetLoc)
        if (parsed) {
          const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
          workflows.push({
            id: (meta['id'] as string) ?? (parsed['id'] as string) ?? wfId,
            name: (meta['name'] as string) ?? (parsed['name'] as string) ?? wfId,
            description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
            version: (meta['version'] as string) ?? (parsed['version'] as string),
            color: (meta['color'] as string) ?? (parsed['color'] as string),
            entryStep: (parsed['entryStep'] as string) ?? (parsed['steps'] as Array<{ id: string }>)?.[0]?.id ?? 'start',
            steps: (parsed['steps'] as PackWorkflowItem['steps']) ?? [],
            settings: parsed['settings'] as PackWorkflowItem['settings'],
          })
          break
        }
      }
    }
  }

  // 2. Selected Agents & Sub-agents (.json, .agent.md, .md)
  const allAgentIds = [
    ...(selected.agents ?? []).map((id) => ({ id, subagent: false })),
    ...(selected.subAgents ?? []).map((id) => ({ id, subagent: true })),
  ]

  for (const { id: agId, subagent } of allAgentIds) {
    for (const dir of searchDirs) {
      const locJson = join(dir, 'agents', `${agId}.json`)
      const locAgentMd = join(dir, 'agents', `${agId}.agent.md`)
      const locMd = join(dir, 'agents', `${agId}.md`)

      if (await fileExists(locJson)) {
        const parsed = await readJsonSafe<Record<string, unknown>>(locJson)
        if (parsed) {
          const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
          const item: PackAgentItem = {
            id: (meta['id'] as string) ?? (parsed['id'] as string) ?? agId,
            name: (meta['name'] as string) ?? (parsed['name'] as string) ?? agId,
            description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
            subagent: Boolean(subagent || meta['subagent'] || parsed['subagent']),
            prompt: (parsed['prompt'] as string) ?? '',
            allowedTools: (meta['allowedTools'] as string[]) ?? (parsed['allowedTools'] as string[]) ?? [],
            skills: (parsed['skills'] as string[]) ?? [],
            mcpServers: (parsed['mcpServers'] as string[]) ?? [],
            color: (meta['color'] as string) ?? (parsed['color'] as string),
          }
          if (item.subagent) subAgents.push(item)
          else agents.push(item)
          break
        }
      } else if ((await fileExists(locAgentMd)) || (await fileExists(locMd))) {
        const target = (await fileExists(locAgentMd)) ? locAgentMd : locMd
        const raw = await readFile(target, 'utf8')
        const { data, body } = parseMarkdownFrontmatter(raw)
        const item: PackAgentItem = {
          id: (data['id'] as string) ?? agId,
          name: (data['name'] as string) ?? agId,
          description: (data['description'] as string) ?? '',
          subagent: Boolean(subagent || data['subagent']),
          prompt: body,
          allowedTools: (data['allowedTools'] as string[]) ?? [],
          skills: (data['skills'] as string[]) ?? [],
          mcpServers: (data['mcpServers'] as string[]) ?? [],
          color: (data['color'] as string) ?? undefined,
        }
        if (item.subagent) subAgents.push(item)
        else agents.push(item)
        break
      }
    }
  }

  // 3. Selected Skills (supports nested path ids like G2S/browser-tester or direct ids)
  for (const skId of selected.skills ?? []) {
    for (const dir of searchDirs) {
      const locDir = join(dir, 'skills', skId, 'SKILL.md')
      const locDirAlt = join(dir, 'skills', skId, `${skId.split('/').pop()}.md`)
      const locMd = join(dir, 'skills', `${skId}.md`)
      const locJson = join(dir, 'skills', `${skId}.json`)

      if (await fileExists(locDir)) {
        const raw = await readFile(locDir, 'utf8')
        const { data, body } = parseMarkdownFrontmatter(raw)
        const name = (data['name'] as string) ?? skId.split('/').pop() ?? skId
        skills.push({ id: skId, name, description: (data['description'] as string) ?? `Skill ${skId}`, prompt: body || raw })
        break
      } else if (await fileExists(locDirAlt)) {
        const raw = await readFile(locDirAlt, 'utf8')
        const { data, body } = parseMarkdownFrontmatter(raw)
        const name = (data['name'] as string) ?? skId.split('/').pop() ?? skId
        skills.push({ id: skId, name, description: (data['description'] as string) ?? `Skill ${skId}`, prompt: body || raw })
        break
      } else if (await fileExists(locMd)) {
        const raw = await readFile(locMd, 'utf8')
        const { data, body } = parseMarkdownFrontmatter(raw)
        const name = (data['name'] as string) ?? skId.split('/').pop() ?? skId
        skills.push({ id: skId, name, description: (data['description'] as string) ?? `Skill ${skId}`, prompt: body || raw })
        break
      } else if (await fileExists(locJson)) {
        const parsed = await readJsonSafe<Record<string, unknown>>(locJson)
        if (parsed) {
          const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
          skills.push({
            id: (meta['id'] as string) ?? (parsed['id'] as string) ?? skId,
            name: (meta['name'] as string) ?? (parsed['name'] as string) ?? skId,
            description: (meta['description'] as string) ?? (parsed['description'] as string) ?? '',
            prompt: (parsed['prompt'] as string) ?? '',
          })
          break
        }
      }
    }
  }

  // 4. Selected Commands
  for (const cmdId of selected.commands ?? []) {
    for (const dir of searchDirs) {
      const locJson = join(dir, 'commands', `${cmdId}.json`)
      const locCmdMd = join(dir, 'commands', `${cmdId}.command.md`)
      const locMd = join(dir, 'commands', `${cmdId}.md`)

      if (await fileExists(locJson)) {
        const parsed = await readJsonSafe<Record<string, unknown>>(locJson)
        if (parsed) {
          const meta = (parsed['metadata'] as Record<string, unknown> | undefined) ?? {}
          commands.push({
            id: (meta['id'] as string) ?? (parsed['id'] as string) ?? cmdId,
            name: (meta['name'] as string) ?? (parsed['name'] as string) ?? cmdId,
            prompt: (parsed['prompt'] as string) ?? '',
            agentMode: (meta['agentMode'] as string) ?? (parsed['agentMode'] as string),
          })
          break
        }
      } else if ((await fileExists(locCmdMd)) || (await fileExists(locMd))) {
        const target = (await fileExists(locCmdMd)) ? locCmdMd : locMd
        const raw = await readFile(target, 'utf8')
        const { data, body } = parseMarkdownFrontmatter(raw)
        commands.push({
          id: (data['id'] as string) ?? cmdId,
          name: (data['name'] as string) ?? cmdId,
          prompt: body,
          agentMode: (data['agentMode'] as string) ?? undefined,
        })
        break
      }
    }
  }

  // 5. Selected MCP Servers (mcp.json and config.json)
  for (const srvName of selected.mcpServers ?? []) {
    for (const dir of searchDirs) {
      const mcpFiles = [join(dir, 'mcp.json'), join(dir, 'config.json')]
      for (const mcpFile of mcpFiles) {
        if (await fileExists(mcpFile)) {
          const parsed = await readJsonSafe<Record<string, unknown>>(mcpFile)
          const servers = (parsed?.['mcpServers'] ?? parsed) as Record<string, unknown> | undefined
          if (servers?.[srvName]) {
            const conf = servers[srvName] as Record<string, unknown>
            const isHttp = conf['transport'] === 'http'
            const customOverride = mcpCustomConfigs?.[srvName]
            const envRaw = customOverride?.env ?? (conf['env'] as Record<string, string> | undefined) ?? {}
            const headersRaw = customOverride?.headers ?? (conf['headers'] as Record<string, string> | undefined) ?? {}
            const argsRaw = customOverride?.args ?? (conf['args'] as string[] | undefined)
            const urlRaw = customOverride?.url ?? (conf['url'] as string | undefined)
            const envRequirements: PackMcpServerConfig['envRequirements'] = []
            const cleanEnv: Record<string, string> = {}
            const cleanHeaders: Record<string, string> = {}

            // Handle stdio env
            if (!isHttp) {
              for (const [envKey, envVal] of Object.entries(envRaw)) {
                const match = typeof envVal === 'string' ? envVal.match(/\$\{([^}]+)\}/) : null
                if (match?.[1]) {
                  envRequirements.push({ key: match[1], description: `Environment variable for ${srvName}`, required: true })
                  cleanEnv[envKey] = `\${${match[1]}}`
                } else if (
                  /token|key|secret|password|auth|bearer|credential/i.test(envKey) &&
                  typeof envVal === 'string' &&
                  !envVal.startsWith('http://') &&
                  !envVal.startsWith('https://')
                ) {
                  envRequirements.push({ key: envKey, description: `API Key / Secret for ${srvName}`, required: true })
                  cleanEnv[envKey] = `\${${envKey}}`
                } else {
                  cleanEnv[envKey] = envVal
                }
              }
            }

            // Handle http headers
            if (isHttp) {
              for (const [headKey, headVal] of Object.entries(headersRaw)) {
                const match = typeof headVal === 'string' ? headVal.match(/\$\{([^}]+)\}/) : null
                if (match?.[1]) {
                  envRequirements.push({ key: match[1], description: `Header variable for ${srvName}`, required: true })
                  cleanHeaders[headKey] = `\${${match[1]}}`
                } else if (
                  /token|key|secret|password|auth|bearer/i.test(headKey) ||
                  (typeof headVal === 'string' && /bearer|token|key/i.test(headVal))
                ) {
                  const reqKey = `${srvName.toUpperCase()}_TOKEN`
                  envRequirements.push({ key: reqKey, description: `Authentication header for ${srvName}`, required: true })
                  cleanHeaders[headKey] = `Bearer \${${reqKey}}`
                } else {
                  cleanHeaders[headKey] = headVal
                }
              }
            }

            mcpServers[srvName] = {
              transport: isHttp ? 'http' : 'stdio',
              command: isHttp ? undefined : (conf['command'] as string | undefined),
              args: isHttp ? undefined : argsRaw,
              url: isHttp ? urlRaw : undefined,
              headers: isHttp && Object.keys(cleanHeaders).length > 0 ? cleanHeaders : undefined,
              env: !isHttp && Object.keys(cleanEnv).length > 0 ? cleanEnv : undefined,
              envRequirements: envRequirements.length > 0 ? envRequirements : undefined,
            }
            break
          }
        }
      }
    }
  }

  const rawName = metadata.name ?? (metadata.author && metadata.displayName ? `${metadata.author}-${metadata.displayName}` : 'community-pack')
  const slugName = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')

  const manifest: PackManifest = {
    schemaVersion: 1,
    name: slugName,
    version: metadata.version || '1.0.0',
    displayName: metadata.displayName || slugName,
    description: metadata.description || '',
    author: metadata.author || 'Community',
    tags: metadata.tags ?? ['community-pack'],
    contents: {
      ...(workflows.length > 0 ? { workflows } : {}),
      ...(agents.length > 0 ? { agents } : {}),
      ...(subAgents.length > 0 ? { subAgents } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(commands.length > 0 ? { commands } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    },
  }

  return validatePackManifest(manifest)
}

export function incrementPatchVersion(version: string = '1.0.0'): string {
  const clean = version.trim().replace(/^v/, '')
  const parts = clean.split('.')
  if (parts.length >= 3) {
    const patchNum = parseInt(parts[2] ?? '0', 10)
    if (!isNaN(patchNum)) {
      return `${parts[0]}.${parts[1]}.${patchNum + 1}`
    }
  } else if (parts.length === 2) {
    const minorNum = parseInt(parts[1] ?? '0', 10)
    if (!isNaN(minorNum)) {
      return `${parts[0]}.${parts[1]}.1`
    }
  } else if (parts.length === 1) {
    const majorNum = parseInt(parts[0] ?? '1', 10)
    if (!isNaN(majorNum)) {
      return `${majorNum}.0.1`
    }
  }
  return '1.0.1'
}

export function getPackAuthorUsername(pack: RegistryIndexEntry | PackManifest): string {
  if (typeof pack.author === 'string') {
    const trimmed = pack.author.replace(/^@/, '').trim()
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parts = trimmed.split('/')
      return (parts[parts.length - 1] ?? '').replace(/^@/, '')
    }
    return trimmed
  }
  if (pack.author && typeof pack.author === 'object') {
    if (pack.author.url) {
      const parts = pack.author.url.trim().split('/')
      const user = parts[parts.length - 1]
      if (user) return user.replace(/^@/, '')
    }
    if (pack.author.name) {
      const trimmed = pack.author.name.replace(/^@/, '').trim()
      // If author name is "FirstName LastName", check if pack.name starts with username
      const dashIdx = pack.name.indexOf('-')
      if (dashIdx > 0 && !trimmed.includes(' ')) {
        return trimmed
      }
      if (dashIdx > 0) {
        return pack.name.slice(0, dashIdx)
      }
      return trimmed
    }
  }
  // Fallback to pack name slug prefix: <username>-<packname>
  const dashIdx = pack.name.indexOf('-')
  if (dashIdx > 0) {
    return pack.name.slice(0, dashIdx)
  }
  return ''
}

export interface PublishPackOptions {
  token: string
  pack: PackManifest
  targetRepo?: string // defaults to 'JamesDAdams/openfox-community'
  fetchFn?: typeof fetch
}

export interface PublishPackResult {
  success: boolean
  prUrl: string
  prNumber: number
  branch: string
}

export async function publishPackToGitHub(options: PublishPackOptions): Promise<PublishPackResult> {
  const { token, pack, targetRepo = 'JamesDAdams/openfox-community', fetchFn = globalThis.fetch } = options

  if (!token || !token.trim()) {
    throw new Error('GitHub Personal Access Token is required to publish a pull request.')
  }

  const cleanToken = token.trim()
  const validatedPack = validatePackManifest(pack)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenFox-Community-Hub-Plugin',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  // 1. Verify user authentication
  const userRes = await fetchFn('https://api.github.com/user', { headers })
  if (!userRes.ok) {
    throw new Error(`GitHub token verification failed: ${userRes.status} ${userRes.statusText}`)
  }
  const userData = (await userRes.json()) as { login: string }
  const username = userData.login

  // Verify if updating an existing pack, ensure current user is original author
  try {
    const existingPackRes = await fetchFn(
      `https://api.github.com/repos/${targetRepo}/contents/packs/${validatedPack.name}.json`,
      { headers },
    )
    if (existingPackRes.ok) {
      const existingData = (await existingPackRes.json().catch(() => ({}))) as { content?: string }
      if (existingData.content) {
        const decoded = JSON.parse(Buffer.from(existingData.content, 'base64').toString('utf8')) as PackManifest
        const originalAuthor = getPackAuthorUsername(decoded)
        if (originalAuthor && originalAuthor.toLowerCase() !== username.toLowerCase()) {
          throw new Error(
            `You cannot modify this pack because you are not the author (original author: @${originalAuthor}).`,
          )
        }
      }
    }
  } catch (err) {
    if ((err as Error).message.includes('You cannot modify')) {
      throw err
    }
  }

  // 2. Get default branch commit SHA of targetRepo (try main, fallback to master)
  let baseSha = ''
  const repoRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/git/ref/heads/main`, { headers })
  if (repoRes.ok) {
    const repoData = (await repoRes.json()) as { object: { sha: string } }
    baseSha = repoData.object.sha
  } else {
    const masterRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/git/ref/heads/master`, { headers })
    if (masterRes.ok) {
      const masterData = (await masterRes.json()) as { object: { sha: string } }
      baseSha = masterData.object.sha
    } else {
      throw new Error(`Failed to fetch default branch (main/master) from ${targetRepo}: ${repoRes.status}`)
    }
  }

  // 3. Determine repository to branch on: check if user owns targetRepo or needs fork
  const targetRepoOwner = targetRepo.split('/')[0] ?? ''
  const isDirectOwner = username.toLowerCase() === targetRepoOwner.toLowerCase()
  let branchRepo = targetRepo
  let branchBaseSha = baseSha

  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const headBranchRef = `pack-${validatedPack.name}-v${validatedPack.version}-${Date.now()}-${randomSuffix}`

  if (!isDirectOwner) {
    const forkRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/forks`, {
      method: 'POST',
      headers,
    })

    if (forkRes.ok || forkRes.status === 202) {
      const forkData = (await forkRes.json().catch(() => ({}))) as { full_name?: string }
      branchRepo = forkData.full_name ?? `${username}/${targetRepo.split('/')[1]}`
    } else {
      branchRepo = `${username}/${targetRepo.split('/')[1]}`
    }

    // Retrieve fork default branch SHA or fallback to targetBaseSha
    const forkRefRes = await fetchFn(`https://api.github.com/repos/${branchRepo}/git/ref/heads/main`, { headers })
    if (forkRefRes.ok) {
      const forkRefData = (await forkRefRes.json()) as { object: { sha: string } }
      branchBaseSha = forkRefData.object.sha || baseSha
    } else {
      const forkMasterRes = await fetchFn(`https://api.github.com/repos/${branchRepo}/git/ref/heads/master`, { headers })
      if (forkMasterRes.ok) {
        const forkMasterData = (await forkMasterRes.json()) as { object: { sha: string } }
        branchBaseSha = forkMasterData.object.sha || baseSha
      }
    }
  }

  // 4. Create new branch from base SHA
  let createBranchRes = await fetchFn(`https://api.github.com/repos/${branchRepo}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ref: `refs/heads/${headBranchRef}`,
      sha: branchBaseSha || baseSha,
    }),
  })

  // If initial creation failed with branchBaseSha and branchRepo is a fork, retry with baseSha
  if (!createBranchRes.ok && branchBaseSha !== baseSha) {
    createBranchRes = await fetchFn(`https://api.github.com/repos/${branchRepo}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ref: `refs/heads/${headBranchRef}`,
        sha: baseSha,
      }),
    })
  }

  if (!createBranchRes.ok) {
    const branchErr = (await createBranchRes.json().catch(() => ({}))) as { message?: string }
    throw new Error(`Failed to create branch ${headBranchRef} on ${branchRepo}: ${branchErr.message ?? createBranchRes.status}`)
  }

  // 5. Create or update packs/<pack.name>.json on the branch
  const packFilePath = `packs/${validatedPack.name}.json`
  const packFileContent = Buffer.from(JSON.stringify(validatedPack, null, 2), 'utf8').toString('base64')

  // When updating an existing file on a branch, GitHub Contents API requires the blob "sha"
  let existingBlobSha: string | undefined = undefined
  try {
    const existingFileRes = await fetchFn(
      `https://api.github.com/repos/${branchRepo}/contents/${packFilePath}?ref=${headBranchRef}`,
      { headers },
    )
    if (existingFileRes.ok) {
      const fileData = (await existingFileRes.json()) as { sha?: string }
      existingBlobSha = fileData.sha
    } else if (branchRepo !== targetRepo) {
      // Fallback check on targetRepo default branch if fork is synced with it
      const targetFileRes = await fetchFn(
        `https://api.github.com/repos/${targetRepo}/contents/${packFilePath}?ref=main`,
        { headers },
      )
      if (targetFileRes.ok) {
        const targetFileData = (await targetFileRes.json()) as { sha?: string }
        existingBlobSha = targetFileData.sha
      }
    }
  } catch {
    // ignore lookup error
  }

  const putBody: Record<string, unknown> = {
    message: `feat(pack): add ${validatedPack.name} v${validatedPack.version}`,
    content: packFileContent,
    branch: headBranchRef,
  }
  if (existingBlobSha) {
    putBody['sha'] = existingBlobSha
  }

  const putRes = await fetchFn(`https://api.github.com/repos/${branchRepo}/contents/${packFilePath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody),
  })

  if (!putRes.ok) {
    const putErr = (await putRes.json().catch(() => ({}))) as { message?: string }
    throw new Error(`Failed to commit pack file to branch ${headBranchRef}: ${putErr.message ?? putRes.status}`)
  }

  // 6. Build contents summary for PR description
  const summary = {
    workflows: (validatedPack.contents.workflows ?? []).map((w) => `${w.name} (${w.id})`),
    agents: (validatedPack.contents.agents ?? []).map((a) => `${a.name} (${a.id})`),
    subAgents: (validatedPack.contents.subAgents ?? []).map((sa) => `${sa.name} (${sa.id})`),
    skills: (validatedPack.contents.skills ?? []).map((s) => s.name),
    commands: (validatedPack.contents.commands ?? []).map((c) => c.prompt || c.name),
    mcpServers: Object.entries(validatedPack.contents.mcpServers ?? {}).map(([name, conf]) =>
      conf.envRequirements?.length
        ? `${name} (Requires ${conf.envRequirements.map((r) => r.key).join(', ')})`
        : name,
    ),
  }

  // 7. Create Pull Request on targetRepo (index.json is rebuilt automatically on merge by GitHub Actions)
  const prHead = branchRepo === targetRepo ? headBranchRef : `${username}:${headBranchRef}`
  const prBody = [
    `## 📦 New OpenFox Community Pack: \`${validatedPack.name}\``,
    '',
    `**Version:** \`v${validatedPack.version}\``,
    `**Author:** ${typeof validatedPack.author === 'string' ? validatedPack.author : validatedPack.author?.name ?? username}`,
    '',
    `### Description`,
    typeof validatedPack.description === 'string' ? validatedPack.description : validatedPack.description?.['en'] ?? '',
    '',
    '### Included Components',
    summary.workflows.length ? `- **Workflows (${summary.workflows.length}):** ${summary.workflows.join(', ')}` : null,
    summary.agents.length ? `- **Agents (${summary.agents.length}):** ${summary.agents.join(', ')}` : null,
    summary.subAgents.length ? `- **Sub-agents (${summary.subAgents.length}):** ${summary.subAgents.join(', ')}` : null,
    summary.skills.length ? `- **Skills (${summary.skills.length}):** ${summary.skills.join(', ')}` : null,
    summary.mcpServers.length ? `- **MCP Servers (${summary.mcpServers.length}):** ${summary.mcpServers.join(', ')}` : null,
    summary.commands.length ? `- **Commands (${summary.commands.length}):** ${summary.commands.join(', ')}` : null,
    '',
    '---',
    '_Automated PR created with OpenFox Community Hub Publisher._',
  ]
    .filter(Boolean)
    .join('\n')

  const prRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `feat(pack): add ${validatedPack.name} v${validatedPack.version}`,
      head: prHead,
      base: 'main',
      body: prBody,
    }),
  })

  if (!prRes.ok) {
    const errData = (await prRes.json().catch(() => ({}))) as { message?: string }
    throw new Error(`Failed to create Pull Request: ${errData.message ?? prRes.statusText}`)
  }

  const prData = (await prRes.json()) as { html_url: string; number: number }

  return {
    success: true,
    prUrl: prData.html_url,
    prNumber: prData.number,
    branch: headBranchRef,
  }
}

export interface PublishStatus {
  state: 'creating' | 'validating' | 'merged' | 'error'
  prNumber: number
  prUrl: string
  branch?: string
  packName: string
  targetRepo?: string
  checksStatus?: 'pending' | 'in_progress' | 'success' | 'failure'
  merged?: boolean
  errorMessage?: string
  lastCheckedAt: string
}

export async function checkGithubPrStatus(options: {
  token?: string
  prNumber: number
  targetRepo?: string
  fetchFn?: typeof fetch
}): Promise<{
  state: 'validating' | 'merged' | 'error'
  merged: boolean
  checksStatus: 'pending' | 'in_progress' | 'success' | 'failure'
  errorMessage?: string
}> {
  const { token, prNumber, targetRepo = 'JamesDAdams/openfox-community', fetchFn = globalThis.fetch } = options
  const cleanToken = token?.trim()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenFox-Community-Hub-Plugin',
    ...(cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {}),
  }

  const prRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/pulls/${prNumber}`, { headers })
  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR status: ${prRes.status} ${prRes.statusText}`)
  }
  const prData = (await prRes.json()) as {
    state: string
    merged: boolean
    merged_at: string | null
    head: { sha: string }
  }

  if (prData.merged || prData.merged_at) {
    return {
      state: 'merged',
      merged: true,
      checksStatus: 'success',
    }
  }

  if (prData.state === 'closed' && !prData.merged) {
    return {
      state: 'error',
      merged: false,
      checksStatus: 'failure',
      errorMessage: 'Pull Request was closed without merging.',
    }
  }

  const headSha = prData.head?.sha
  if (headSha) {
    try {
      let anyFailed = false
      let anyInProgress = false
      let checkRunCount = 0
      let allChecksCompleted = true

      // 1. Check Runs (GitHub Actions Workflows)
      const checkRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/commits/${headSha}/check-runs`, {
        headers,
      })
      if (checkRes.ok) {
        const checkData = (await checkRes.json()) as {
          total_count: number
          check_runs: Array<{ status: string; conclusion: string | null; name: string }>
        }

        checkRunCount = checkData.total_count
        if (checkRunCount > 0) {
          anyFailed = checkData.check_runs.some(
            (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled',
          )
          anyInProgress = checkData.check_runs.some((r) => r.status === 'in_progress' || r.status === 'queued')
          allChecksCompleted = checkData.check_runs.every((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped'))
        }
      }

      // 2. Commit Statuses (Combined Status API)
      const statusRes = await fetchFn(`https://api.github.com/repos/${targetRepo}/commits/${headSha}/status`, {
        headers,
      })
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as {
          state: string
          total_count: number
          statuses: Array<{ state: string; context: string }>
        }

        if (statusData.total_count > 0 || statusData.state) {
          if (statusData.state === 'failure' || statusData.state === 'error') {
            anyFailed = true
          } else if (statusData.state === 'pending') {
            anyInProgress = true
          } else if (statusData.state === 'success') {
            if (checkRunCount === 0) {
              allChecksCompleted = true
            }
          }
        }
      }

      if (anyFailed) {
        return {
          state: 'error',
          merged: false,
          checksStatus: 'failure',
          errorMessage: 'Validation checks failed on GitHub Actions.',
        }
      }

      if (allChecksCompleted && checkRunCount > 0) {
        return {
          state: 'validating',
          merged: false,
          checksStatus: 'success',
        }
      }

      if (anyInProgress) {
        return {
          state: 'validating',
          merged: false,
          checksStatus: 'in_progress',
        }
      }
    } catch {
      // ignore check error and fallback to pending
    }
  }

  return {
    state: 'validating',
    merged: false,
    checksStatus: 'pending',
  }
}
