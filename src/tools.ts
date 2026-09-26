import type { PluginTool, PluginToolContext, PluginToolResult } from '../../../../src/plugin/index.js'
import { fetchRegistries, inspectPack, searchPacks } from './registry.js'
import { installPack } from './installer.js'
import { exportPack } from './bundler.js'
import type { InstallScope } from './types.js'

export function createHubSearchTool(getRegistryUrls: () => string[], getToken?: () => string): PluginTool {
  return {
    name: 'hub_search',
    description: 'Search the OpenFox community registries for workflows, agents, MCPs, and skills.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for in pack names, descriptions, or authors',
        },
        tag: {
          type: 'string',
          description: 'Filter by specific category or tag (e.g. "review", "git", "devops")',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<PluginToolResult> {
      try {
        const query = String(args['query'] ?? '')
        const tag = args['tag'] ? String(args['tag']) : undefined
        const token = getToken?.()
        const { index, failures } = await fetchRegistries(getRegistryUrls(), { token, forceRefresh: true })
        const results = searchPacks(index, query, { tag })

        return {
          success: true,
          output: JSON.stringify(
            {
              total: results.length,
              ...(failures.length > 0
                ? { unavailableRegistries: failures.map((failure) => failure.registryUrl) }
                : {}),
              packs: results.map((p) => ({
                name: p.name,
                version: p.version,
                displayName: p.displayName,
                description: p.description,
                tags: p.tags,
                downloadUrl: p.downloadUrl,
                registry: p.registryLabel,
              })),
            },
            null,
            2,
          ),
        }
      } catch (err: unknown) {
        return {
          success: false,
          error: (err as Error).message,
        }
      }
    },
  }
}

export function createHubInstallTool(getConfigDir: () => string, getRegistryUrls: () => string[], getToken?: () => string): PluginTool {
  return {
    name: 'hub_install',
    description:
      'Install an OpenFox Pack (workflow, agents, skills, MCPs) into the project (.openfox/) or global user config.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Pack name from registry, or direct GitHub/Gist URL, or raw JSON pack manifest',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Installation scope: "project" (into .openfox/) or "global" (into ~/.config/openfox/)',
          default: 'project',
        },
        envValues: {
          type: 'object',
          description: 'Key-value map of environment variables / API tokens required by MCP servers',
        },
      },
      required: ['source'],
    },
    async execute(args: Record<string, unknown>, context: PluginToolContext): Promise<PluginToolResult> {
      try {
        const source = String(args['source'] ?? '')
        const scope = (args['scope'] as InstallScope) ?? 'project'
        const envValues = (args['envValues'] as Record<string, string>) ?? {}
        const token = getToken?.()

        let packData: unknown

        if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('{')) {
          const inspected = await inspectPack(source, { token })
          packData = inspected.manifest
        } else {
          // Look up by name across all configured registries
          const { index } = await fetchRegistries(getRegistryUrls(), { token, forceRefresh: true })
          const match = index.packs.find((p) => p.name.toLowerCase() === source.toLowerCase())
          if (!match) {
            return {
              success: false,
              error: `Pack '${source}' not found in registry. Try searching first with hub_search.`,
            }
          }
          const inspected = await inspectPack(match.downloadUrl, { token })
          packData = inspected.manifest
        }

        const result = await installPack(packData, {
          scope,
          workdir: context.workdir,
          configDir: getConfigDir(),
          envValues,
        })

        return {
          success: true,
          output: JSON.stringify(result, null, 2),
        }
      } catch (err: unknown) {
        return {
          success: false,
          error: (err as Error).message,
        }
      }
    },
  }
}

export function createHubExportTool(getConfigDir: () => string): PluginTool {
  return {
    name: 'hub_export',
    description: 'Export a workflow and all its referenced agents, skills, and MCP servers into an OpenFox pack manifest.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'ID of the workflow to export and bundle',
        },
        name: {
          type: 'string',
          description: 'Custom name for the exported pack (slug)',
        },
        version: {
          type: 'string',
          description: 'Pack version (e.g. 1.0.0)',
        },
      },
      required: ['workflowId'],
    },
    async execute(args: Record<string, unknown>, context: PluginToolContext): Promise<PluginToolResult> {
      try {
        const workflowId = String(args['workflowId'] ?? '')
        const name = args['name'] ? String(args['name']) : undefined
        const version = args['version'] ? String(args['version']) : undefined

        const pack = await exportPack({
          workflowId,
          workdir: context.workdir,
          configDir: getConfigDir(),
          packMetadata: {
            name,
            version,
          },
        })

        return {
          success: true,
          output: JSON.stringify(pack, null, 2),
        }
      } catch (err: unknown) {
        return {
          success: false,
          error: (err as Error).message,
        }
      }
    },
  }
}
