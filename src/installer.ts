import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type {
  EnvRequirement,
  InstallOptions,
  InstallResult,
  PackMcpServerConfig,
} from './types.js'
import { validatePackManifest } from './schema.js'
import { buildMarkdownFrontmatter } from './frontmatter.js'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function installPack(
  pack: unknown,
  options: InstallOptions,
): Promise<InstallResult> {
  const manifest = validatePackManifest(pack)
  const { scope, workdir, configDir, envValues = {}, overwrite = true } = options

  const targetBaseDir = scope === 'project' ? join(workdir, '.openfox') : configDir
  await ensureDir(targetBaseDir)

  const installedWorkflows: string[] = []
  const installedAgents: string[] = []
  const installedSkills: string[] = []
  const installedCommands: string[] = []
  const installedMcpServers: string[] = []
  const missingEnvRequirements: EnvRequirement[] = []

  // 1. Install Workflows
  if (manifest.contents.workflows && manifest.contents.workflows.length > 0) {
    const workflowsDir = join(targetBaseDir, 'workflows')
    await ensureDir(workflowsDir)

    for (const wf of manifest.contents.workflows) {
      const filePath = join(workflowsDir, `${wf.id}.workflow.json`)
      if (!overwrite && (await fileExists(filePath))) {
        continue
      }
      const wfPayload = {
        metadata: {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          version: wf.version ?? manifest.version,
          color: wf.color,
        },
        entryStep: wf.entryStep,
        settings: wf.settings ?? { maxIterations: 50 },
        steps: wf.steps,
      }
      await writeFile(filePath, JSON.stringify(wfPayload, null, 2), 'utf8')
      installedWorkflows.push(wf.id)
    }
  }

  // 2. Install Agents & Sub-agents
  const allAgents = [
    ...(manifest.contents.agents ?? []),
    ...(manifest.contents.subAgents ?? []).map((sa) => ({ ...sa, subagent: true })),
  ]

  if (allAgents.length > 0) {
    const agentsDir = join(targetBaseDir, 'agents')
    await ensureDir(agentsDir)

    for (const ag of allAgents) {
      const filePath = join(agentsDir, `${ag.id}.agent.md`)
      if (!overwrite && (await fileExists(filePath))) {
        continue
      }
      const agentContent = buildMarkdownFrontmatter(
        {
          id: ag.id,
          name: ag.name,
          description: ag.description,
          subagent: Boolean(ag.subagent),
          allowedTools: ag.allowedTools ?? [],
          ...(ag.skills?.length ? { skills: ag.skills } : {}),
          ...(ag.mcpServers?.length ? { mcpServers: ag.mcpServers } : {}),
          ...(ag.color ? { color: ag.color } : {}),
        },
        ag.prompt,
      )
      await writeFile(filePath, agentContent, 'utf8')
      installedAgents.push(ag.id)
    }
  }

  // 3. Install Skills
  if (manifest.contents.skills && manifest.contents.skills.length > 0) {
    const skillsDir = join(targetBaseDir, 'skills')
    await ensureDir(skillsDir)

    for (const sk of manifest.contents.skills) {
      const skillFolder = join(skillsDir, sk.id)
      await ensureDir(skillFolder)
      const skillFilePath = join(skillFolder, 'SKILL.md')

      if (!overwrite && (await fileExists(skillFilePath))) {
        continue
      }

      const skillContent = buildMarkdownFrontmatter(
        {
          name: sk.id,
          description: sk.description,
          ...(sk.group ? { group: sk.group } : {}),
          ...(sk.version || sk.name !== sk.id
            ? {
                metadata: {
                  ...(sk.version ? { version: sk.version } : {}),
                  ...(sk.name !== sk.id ? { openfox: { displayName: sk.name } } : {}),
                },
              }
            : {}),
        },
        sk.prompt,
      )

      await writeFile(skillFilePath, skillContent, 'utf8')
      installedSkills.push(sk.id)
    }
  }

  // 4. Install Commands
  if (manifest.contents.commands && manifest.contents.commands.length > 0) {
    const commandsDir = join(targetBaseDir, 'commands')
    await ensureDir(commandsDir)

    for (const cmd of manifest.contents.commands) {
      const filePath = join(commandsDir, `${cmd.id}.command.md`)
      if (!overwrite && (await fileExists(filePath))) {
        continue
      }
      const cmdContent = buildMarkdownFrontmatter(
        {
          id: cmd.id,
          name: cmd.name,
          ...(cmd.agentMode ? { agentMode: cmd.agentMode } : {}),
        },
        cmd.prompt,
      )
      await writeFile(filePath, cmdContent, 'utf8')
      installedCommands.push(cmd.id)
    }
  }

  // 5. Install & Configure MCP Servers
  if (manifest.contents.mcpServers && Object.keys(manifest.contents.mcpServers).length > 0) {
    const mcpFilePath = join(targetBaseDir, 'mcp.json')
    const existingMcp = await readJsonSafe<Record<string, unknown>>(mcpFilePath, {
      mcpServers: {},
    })

    const mcpServersRecord =
      (existingMcp['mcpServers'] as Record<string, PackMcpServerConfig> | undefined) ??
      (existingMcp as Record<string, PackMcpServerConfig>)

    for (const [srvName, srvConf] of Object.entries(manifest.contents.mcpServers)) {
      const finalEnv: Record<string, string> = { ...(srvConf.env ?? {}) }

      // Check environment requirements
      if (srvConf.envRequirements) {
        for (const req of srvConf.envRequirements) {
          const suppliedValue = envValues[req.key] ?? process.env[req.key] ?? req.default
          if (suppliedValue !== undefined) {
            finalEnv[req.key] = suppliedValue
          } else if (req.required !== false) {
            missingEnvRequirements.push(req)
          }
        }
      }

      // Replace ${VAR} templates in env if values provided
      for (const [k, v] of Object.entries(finalEnv)) {
        const match = typeof v === 'string' ? v.match(/^\$\{([^}]+)\}$/) : null
        if (match?.[1]) {
          const varName = match[1]
          const val = envValues[varName] ?? process.env[varName]
          if (val) {
            finalEnv[k] = val
          }
        }
      }

      mcpServersRecord[srvName] = {
        transport: srvConf.transport,
        command: srvConf.command,
        args: srvConf.args,
        url: srvConf.url,
        headers: srvConf.headers,
        env: Object.keys(finalEnv).length > 0 ? finalEnv : undefined,
        disabledTools: srvConf.disabledTools,
        timeout: srvConf.timeout,
      }

      installedMcpServers.push(srvName)
    }

    const updatedMcpJson = existingMcp['mcpServers']
      ? { ...existingMcp, mcpServers: mcpServersRecord }
      : mcpServersRecord

    await writeFile(mcpFilePath, JSON.stringify(updatedMcpJson, null, 2), 'utf8')
  }

  return {
    success: true,
    packName: manifest.name,
    packVersion: manifest.version,
    scope,
    installed: {
      workflows: installedWorkflows,
      agents: installedAgents,
      skills: installedSkills,
      commands: installedCommands,
      mcpServers: installedMcpServers,
    },
    missingEnv: missingEnvRequirements,
  }
}

/**
 * The core item domains actually written by an install, so the client can
 * refresh exactly those caches instead of asking the user to restart OpenFox.
 */
export function installedItemKinds(result: InstallResult): string[] {
  const kinds: string[] = []
  if (result.installed.workflows.length > 0) kinds.push('workflows')
  if (result.installed.agents.length > 0) kinds.push('agents')
  if (result.installed.skills.length > 0) kinds.push('skills')
  if (result.installed.commands.length > 0) kinds.push('commands')
  if (result.installed.mcpServers.length > 0) kinds.push('mcpServers')
  return kinds
}
