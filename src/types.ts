export type LocalizedString = string | { en: string; fr: string; [lang: string]: string }

export type InstallScope = 'project' | 'global'

export interface EnvRequirement {
  key: string
  description?: string | LocalizedString
  required?: boolean
  default?: string
}

export interface PackMcpServerConfig {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  envRequirements?: EnvRequirement[]
  disabledTools?: string[]
  timeout?: number
}

export interface PackSkillItem {
  id: string
  name: string
  description: string
  prompt: string
  group?: string
  version?: string
}

export interface PackCommandItem {
  id: string
  name: string
  prompt: string
  agentMode?: string
}

export interface PackAgentItem {
  id: string
  name: string
  description: string
  subagent?: boolean
  prompt: string
  allowedTools?: string[]
  skills?: string[]
  mcpServers?: string[]
  color?: string
}

export interface PackWorkflowStep {
  id: string
  name: string
  phase?: string
  type?: 'agent' | 'subagent' | 'shell' | 'user' | 'parallel'
  agentMode?: string
  subAgentType?: string
  command?: string
  prompt?: string
  transitions?: Array<{
    target: string
    condition?: string
    priority?: number
  }>
  [key: string]: unknown
}

export interface PackWorkflowItem {
  id: string
  name: string
  description: string
  version?: string
  color?: string
  entryStep: string
  steps: PackWorkflowStep[]
  settings?: {
    maxIterations?: number
    [key: string]: unknown
  }
}

export interface PackContents {
  workflows?: PackWorkflowItem[]
  agents?: PackAgentItem[]
  subAgents?: PackAgentItem[]
  skills?: PackSkillItem[]
  commands?: PackCommandItem[]
  mcpServers?: Record<string, PackMcpServerConfig>
}

export interface PackManifest {
  schemaVersion: 1
  name: string
  version: string
  displayName?: string | LocalizedString
  description?: string | LocalizedString
  author?: string | { name: string; url?: string; email?: string }
  tags?: string[]
  homepage?: string
  repositoryUrl?: string
  contents: PackContents
  dependencies?: Array<{
    name: string
    version?: string
  }>
}

export interface PackContentsSummary {
  workflows?: string[]
  agents?: string[]
  subAgents?: string[]
  skills?: string[]
  commands?: string[]
  mcpServers?: string[]
}

export interface RegistryIndexEntry {
  name: string
  version: string
  displayName?: string | LocalizedString
  description?: string | LocalizedString
  author?: string | { name: string; url?: string; email?: string }
  tags?: string[]
  downloadUrl: string
  updatedAt?: string
  checksum?: string
  contentsSummary?: PackContentsSummary
  registryUrl?: string
  registryLabel?: string
  registryType?: RegistryType
}

export type RegistryType = 'github' | 'gitlab'

export interface RegistryConfig {
  type: RegistryType
  url: string
  label?: string
  token?: string
}

/** One user-configured registry row: source, URL and its own access token. */
export interface RegistryRow {
  source: RegistryType
  url: string
  token?: string
}

export interface RegistryIndex {
  version: 1
  name?: string
  description?: string
  updatedAt?: string
  packs: RegistryIndexEntry[]
}

export interface InstallOptions {
  scope: InstallScope
  workdir: string
  configDir: string
  envValues?: Record<string, string>
  overwrite?: boolean
}

export interface InstallResult {
  success: boolean
  packName: string
  packVersion: string
  scope: InstallScope
  installed: {
    workflows: string[]
    agents: string[]
    skills: string[]
    commands: string[]
    mcpServers: string[]
  }
  missingEnv: EnvRequirement[]
  error?: string
}

export interface ExportOptions {
  workflowId: string
  workdir: string
  configDir: string
  packMetadata?: {
    name?: string
    version?: string
    displayName?: string | LocalizedString
    description?: string | LocalizedString
    author?: string | { name: string; url?: string; email?: string }
    tags?: string[]
    repositoryUrl?: string
  }
}
