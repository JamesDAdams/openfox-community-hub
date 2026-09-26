import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  register,
  validatePackManifest,
  safeValidatePackManifest,
  validateRegistryIndex,
  exportPack,
  installPack,
  fetchRegistry,
  fetchRegistries,
  inspectPack,
  registryLabel,
  resolveRegistryUrls,
  searchPacks,
  clearRegistryCache,
  normalizePackUrl,
  resetRegistrySnapshot,
  setRegistrySnapshot,
  getRegistrySnapshot,
  getRegistryWarnings,
  getLastRegistryUrls,
  formatRefreshLabel,
  listLocalItems,
  buildCustomPack,
  publishPackToGitHub,
  verifyGithubToken,
  DEFAULT_REGISTRY_URL,
  type PackManifest,
  type RegistryIndex,
  type RegistryIndexEntry,
} from './index.js'
import { parseMarkdownFrontmatter } from './frontmatter.js'

function createMockRegistry(overrides: { configDir?: string; settings?: Record<string, unknown> } = {}) {
  const calls: Record<string, unknown[]> = {}
  const record = (key: string) => (value: unknown) => {
    calls[key] = [...(calls[key] ?? []), value]
  }

  const configDir = overrides.configDir ?? '/tmp/mock-config'
  const currentSettings = overrides.settings ?? {
    extraRegistries: '',
  }

  let isRegistering = true

  const mockContext = {
    id: 'openfox-community-hub',
    version: '1.0.0',
    runtime: { mode: 'production' as const, configDirectory: configDir },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: { get: (_key: string): any => undefined, set: vi.fn() },
    settings: () => currentSettings,
    notify: vi.fn(),
    publish: vi.fn(),
  }

  const registry = {
    runtime: { mode: 'production' as const, configDirectory: configDir },
    get context() {
      if (!isRegistering) {
        throw new Error('Plugin context is only available while a plugin is registering')
      }
      return mockContext
    },
    registerAuth: record('auth'),
    registerTransport: record('transport'),
    registerPreset: record('preset'),
    registerModelMetadataProvider: record('modelMetadata'),
    registerTool: record('tool'),
    registerCommand: record('command'),
    registerSkillSource: record('skillSource'),
    registerSettings: record('settings'),
    registerSettingsTab: record('settingsTab'),
    registerUiAction: record('uiAction'),
    registerUiBadge: record('uiBadge'),
    registerUiPanel: record('uiPanel'),
    registerHook: (event: string, handler: unknown) => record(`hook:${event}`)(handler),
    registerTransitionHandler: (name: string, handler: unknown) => record(`transition:${name}`)(handler),
    registerRpc: (method: string, handler: unknown) => record(`rpc:${method}`)(handler),
    registerAsset: record('asset'),
  }

  const finishRegistration = () => {
    isRegistering = false
  }

  return { registry, calls, mockContext, finishRegistration }
}

describe('OpenFox Community Hub Plugin', () => {
  let tempWorkdir: string
  let tempConfigDir: string

  beforeEach(async () => {
    clearRegistryCache()
    tempWorkdir = await mkdtemp(join(tmpdir(), 'openfox-hub-work-'))
    tempConfigDir = await mkdtemp(join(tmpdir(), 'openfox-hub-cfg-'))
  })

  afterEach(async () => {
    await rm(tempWorkdir, { recursive: true, force: true })
    await rm(tempConfigDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
    resetRegistrySnapshot()
  })

  // ==========================================================================
  // Criterion 1: Schema & Validation
  // ==========================================================================
  describe('Criterion 1: Schema & Validation (PackManifest v1)', () => {
    it('validates a complete valid pack manifest', () => {
      const validPack: PackManifest = {
        schemaVersion: 1,
        name: 'code-reviewer-pack',
        version: '1.2.0',
        displayName: { en: 'Code Reviewer Pack', fr: 'Pack de revue de code' },
        description: 'Comprehensive code review bundle with agents and MCP tools.',
        author: { name: 'Alice', url: 'https://github.com/alice' },
        tags: ['review', 'quality', 'git'],
        contents: {
          workflows: [
            {
              id: 'pr-review',
              name: 'PR Review',
              description: 'Automated PR review workflow',
              entryStep: 'analyze',
              steps: [
                {
                  id: 'analyze',
                  name: 'Analyze Code',
                  type: 'agent',
                  agentMode: 'security-agent',
                  transitions: [{ target: '$done', condition: 'outcome.result == "ok"' }],
                },
              ],
            },
          ],
          agents: [
            {
              id: 'security-agent',
              name: 'Security Agent',
              description: 'Finds vulnerabilities',
              prompt: 'You are a security expert.',
              allowedTools: ['read_file', 'mcp:semgrep:scan'],
              skills: ['owasp-top10'],
              mcpServers: ['semgrep'],
            },
          ],
          skills: [
            {
              id: 'owasp-top10',
              name: 'OWASP Top 10',
              description: 'OWASP security guidelines',
              prompt: '# OWASP Top 10 guidelines...',
            },
          ],
          commands: [
            {
              id: 'review-pr',
              name: 'Review PR',
              prompt: '/run-workflow pr-review',
            },
          ],
          mcpServers: {
            semgrep: {
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@semgrep/mcp'],
              envRequirements: [
                {
                  key: 'SEMGREP_APP_TOKEN',
                  description: 'Token for Semgrep cloud rules',
                  required: true,
                },
              ],
            },
          },
        },
      }

      const validated = validatePackManifest(validPack)
      expect(validated.name).toBe('code-reviewer-pack')
      expect(validated.schemaVersion).toBe(1)
      expect(validated.contents.workflows?.[0]?.id).toBe('pr-review')
    })

    it('rejects invalid pack names with spaces or uppercase', () => {
      const invalid = {
        schemaVersion: 1,
        name: 'Invalid Pack Name!',
        version: '1.0.0',
        contents: {},
      }
      const res = safeValidatePackManifest(invalid)
      expect(res.success).toBe(false)
    })

    it('validates a registry index schema', () => {
      const index: RegistryIndex = {
        version: 1,
        name: 'OpenFox Official Community Registry',
        packs: [
          {
            name: 'code-reviewer-pack',
            version: '1.2.0',
            displayName: 'Code Reviewer Pack',
            downloadUrl: 'https://raw.githubusercontent.com/alice/pack/main/pack.json',
            tags: ['review'],
          },
        ],
      }
      const validated = validateRegistryIndex(index)
      expect(validated.packs).toHaveLength(1)
      expect(validated.packs[0]?.name).toBe('code-reviewer-pack')
    })
  })

  // ==========================================================================
  // Criterion 2: Export & Bundling (Workflow & Recursive Dependencies)
  // ==========================================================================
  describe('Criterion 2: Export & Bundling (exportPack)', () => {
    it('bundles a workflow with its agents, skills, commands, and MCP servers', async () => {
      const projectWfDir = join(tempWorkdir, '.openfox', 'workflows')
      const projectAgentsDir = join(tempWorkdir, '.openfox', 'agents')
      const projectSkillsDir = join(tempWorkdir, '.openfox', 'skills', 'linter-rules')
      const projectCmdDir = join(tempWorkdir, '.openfox', 'commands')
      const projectMcpFile = join(tempWorkdir, '.openfox', 'mcp.json')

      await mkdir(projectWfDir, { recursive: true })
      await mkdir(projectAgentsDir, { recursive: true })
      await mkdir(projectSkillsDir, { recursive: true })
      await mkdir(projectCmdDir, { recursive: true })

      // Workflow
      await writeFile(
        join(projectWfDir, 'code-quality.workflow.json'),
        JSON.stringify({
          metadata: {
            id: 'code-quality',
            name: 'Code Quality Workflow',
            description: 'Run linters and tests',
            version: '1.0.0',
          },
          entryStep: 'lint-step',
          steps: [
            {
              id: 'lint-step',
              name: 'Linting',
              agentMode: 'lint-agent',
            },
            {
              id: 'sub-step',
              name: 'Sub-check',
              subAgentType: 'verifier-sub',
            },
          ],
        }),
      )

      // Agent
      await writeFile(
        join(projectAgentsDir, 'lint-agent.json'),
        JSON.stringify({
          metadata: {
            id: 'lint-agent',
            name: 'Lint Agent',
            description: 'Runs eslint and typechecks',
            subagent: false,
            allowedTools: ['read_file', 'mcp:sonar:inspect'],
          },
          prompt: 'You fix lint errors.',
          skills: ['linter-rules'],
          mcpServers: ['sonar'],
        }),
      )

      // Sub-agent
      await writeFile(
        join(projectAgentsDir, 'verifier-sub.json'),
        JSON.stringify({
          metadata: {
            id: 'verifier-sub',
            name: 'Verifier Sub-agent',
            subagent: true,
          },
          prompt: 'You verify code changes.',
        }),
      )

      // Skill
      await writeFile(
        join(projectSkillsDir, 'SKILL.md'),
        '# Custom Linter Rules\nAlways prefer functional programming.',
      )

      // Command triggering this workflow
      await writeFile(
        join(projectCmdDir, 'run-quality.json'),
        JSON.stringify({
          metadata: { id: 'run-quality', name: 'Run Quality' },
          prompt: '/run-workflow code-quality',
        }),
      )

      // MCP config with sensitive secret
      await writeFile(
        projectMcpFile,
        JSON.stringify({
          mcpServers: {
            sonar: {
              transport: 'http',
              url: 'https://sonar.example.com/api',
              headers: { 'User-Agent': 'OpenFox' },
              env: {
                SONAR_AUTH_TOKEN: 'secret_token_12345678901234567890',
                SONAR_HOST: 'https://sonar.example.com',
              },
            },
          },
        }),
      )

      // Run exportPack
      const pack = await exportPack({
        workflowId: 'code-quality',
        workdir: tempWorkdir,
        configDir: tempConfigDir,
        packMetadata: {
          author: 'Alice',
          description: 'Exported quality pack',
        },
      })

      expect(pack.name).toBe('code-quality')
      expect(pack.author).toBe('Alice')
      expect(pack.contents.workflows).toHaveLength(1)
      expect(pack.contents.workflows?.[0]?.id).toBe('code-quality')

      // Agents resolved
      expect(pack.contents.agents).toHaveLength(1)
      expect(pack.contents.agents?.[0]?.id).toBe('lint-agent')

      // Sub-agents resolved
      expect(pack.contents.subAgents).toHaveLength(1)
      expect(pack.contents.subAgents?.[0]?.id).toBe('verifier-sub')

      // Skills resolved
      expect(pack.contents.skills).toHaveLength(1)
      expect(pack.contents.skills?.[0]?.id).toBe('linter-rules')

      // Commands resolved
      expect(pack.contents.commands).toHaveLength(1)
      expect(pack.contents.commands?.[0]?.id).toBe('run-quality')

      // MCP resolved & secret redacted to envRequirement while preserving URLs
      const sonarMcp = pack.contents.mcpServers?.['sonar']
      expect(sonarMcp).toBeDefined()
      expect(sonarMcp?.envRequirements).toBeDefined()
      expect(sonarMcp?.envRequirements?.[0]?.key).toBe('SONAR_AUTH_TOKEN')
      expect(sonarMcp?.env?.['SONAR_AUTH_TOKEN']).toBe('${SONAR_AUTH_TOKEN}')
      expect(sonarMcp?.env?.['SONAR_HOST']).toBe('https://sonar.example.com')
    })
  })

  // ==========================================================================
  // Criterion 3: Import & Installation (Project & Global Scope)
  // ==========================================================================
  describe('Criterion 3: Import & Installation (installPack)', () => {
    const samplePack: PackManifest = {
      schemaVersion: 1,
      name: 'ci-runner',
      version: '2.0.0',
      displayName: 'CI Runner Pack',
      description: 'Continuous Integration pack',
      contents: {
        workflows: [
          {
            id: 'ci-pipeline',
            name: 'CI Pipeline',
            description: 'Run CI tests',
            entryStep: 'start',
            steps: [{ id: 'start', name: 'Start', type: 'agent', agentMode: 'ci-agent' }],
          },
        ],
        agents: [
          {
            id: 'ci-agent',
            name: 'CI Agent',
            description: 'CI Runner agent',
            prompt: 'Run tests.',
          },
        ],
        skills: [
          {
            id: 'test-runner-skill',
            name: 'Test Runner Skill',
            description: 'Skill for vitest',
            prompt: 'How to run vitest.',
          },
        ],
        commands: [
          {
            id: 'run-ci',
            name: 'Run CI',
            prompt: '/run-workflow ci-pipeline',
          },
        ],
        mcpServers: {
          github: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            envRequirements: [
              {
                key: 'GITHUB_TOKEN',
                description: 'Personal access token',
                required: true,
              },
            ],
          },
        },
      },
    }

    it('installs pack into project scope (.openfox/)', async () => {
      const result = await installPack(samplePack, {
        scope: 'project',
        workdir: tempWorkdir,
        configDir: tempConfigDir,
        envValues: { GITHUB_TOKEN: 'ghp_secret_123' },
      })

      expect(result.success).toBe(true)
      expect(result.scope).toBe('project')
      expect(result.missingEnv).toHaveLength(0)

      // Verify files created in tempWorkdir/.openfox
      const wfFile = join(tempWorkdir, '.openfox', 'workflows', 'ci-pipeline.workflow.json')
      const agentFile = join(tempWorkdir, '.openfox', 'agents', 'ci-agent.agent.md')
      const skillFile = join(tempWorkdir, '.openfox', 'skills', 'test-runner-skill', 'SKILL.md')
      const cmdFile = join(tempWorkdir, '.openfox', 'commands', 'run-ci.command.md')
      const mcpFile = join(tempWorkdir, '.openfox', 'mcp.json')

      const wfContent = JSON.parse(await readFile(wfFile, 'utf8'))
      expect(wfContent.metadata.id).toBe('ci-pipeline')

      const agentContent = await readFile(agentFile, 'utf8')
      expect(agentContent.startsWith('---\n')).toBe(true)
      expect(agentContent).toContain('id: ci-agent')
      expect(agentContent).toContain('name: CI Agent')
      expect(agentContent).toContain('description: CI Runner agent')
      expect(agentContent).toContain('subagent: false')
      expect(agentContent).toContain('\n---\n')
      expect(agentContent.trimEnd().endsWith('Run tests.')).toBe(true)

      const skillContent = await readFile(skillFile, 'utf8')
      expect(skillContent).toContain('How to run vitest')
      expect(skillContent.startsWith('---\nname: test-runner-skill\n')).toBe(true)
      expect(skillContent).toContain('description: Skill for vitest')
      expect(skillContent).toContain('\n---\n')
      expect(skillContent.trimEnd().endsWith('How to run vitest.')).toBe(true)

      const cmdContent = await readFile(cmdFile, 'utf8')
      expect(cmdContent.startsWith('---\n')).toBe(true)
      expect(cmdContent).toContain('id: run-ci')
      expect(cmdContent).toContain('name: Run CI')
      expect(cmdContent).toContain('\n---\n')
      expect(cmdContent.trimEnd().endsWith('/run-workflow ci-pipeline')).toBe(true)

      const mcpContent = JSON.parse(await readFile(mcpFile, 'utf8'))
      expect(mcpContent.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_secret_123')
    })

    it('installs pack into global scope (configDir) and detects missing required secrets', async () => {
      const result = await installPack(samplePack, {
        scope: 'global',
        workdir: tempWorkdir,
        configDir: tempConfigDir,
        envValues: {}, // No token provided!
      })

      expect(result.success).toBe(true)
      expect(result.scope).toBe('global')
      expect(result.missingEnv).toHaveLength(1)
      expect(result.missingEnv[0]?.key).toBe('GITHUB_TOKEN')

      // Verify created in tempConfigDir
      const wfFile = join(tempConfigDir, 'workflows', 'ci-pipeline.workflow.json')
      const wfContent = JSON.parse(await readFile(wfFile, 'utf8'))
      expect(wfContent.metadata.id).toBe('ci-pipeline')
    })

    it('writes portable skill frontmatter the core loader accepts', async () => {
      const pack: PackManifest = {
        schemaVersion: 1,
        name: 'skill-pack',
        version: '1.2.3',
        contents: {
          skills: [
            {
              id: 'dockerfile-best-practices',
              name: 'Dockerfile Best Practices',
              description: 'Rules for optimal container images',
              version: '2.0.0',
              prompt: 'Prefer multi-stage builds.',
            },
          ],
        },
      }

      await installPack(pack, { scope: 'global', workdir: tempWorkdir, configDir: tempConfigDir })

      const skillContent = await readFile(
        join(tempConfigDir, 'skills', 'dockerfile-best-practices', 'SKILL.md'),
        'utf8',
      )
      const { data, body } = parseMarkdownFrontmatter(skillContent)

      expect(data['name']).toBe('dockerfile-best-practices')
      expect(data['description']).toBe('Rules for optimal container images')
      expect(data['metadata']).toEqual({
        version: '2.0.0',
        openfox: { displayName: 'Dockerfile Best Practices' },
      })
      expect(body).toBe('Prefer multi-stage builds.')
    })

    it('installed items are visible to listLocalItems', async () => {
      await installPack(samplePack, {
        scope: 'project',
        workdir: tempWorkdir,
        configDir: tempConfigDir,
        envValues: { GITHUB_TOKEN: 'ghp_secret_123' },
      })

      const inventory = await listLocalItems(tempWorkdir, tempConfigDir)

      expect(inventory.agents.map((a) => a.id)).toContain('ci-agent')
      expect(inventory.commands.map((c) => c.id)).toContain('run-ci')
      expect(inventory.skills.map((s) => s.id)).toContain('test-runner-skill')
      expect(inventory.workflows.map((w) => w.id)).toContain('ci-pipeline')
    })

    it('round-trips an installed pack through exportPack', async () => {
      const roundTripPack: PackManifest = {
        schemaVersion: 1,
        name: 'round-trip',
        version: '1.0.0',
        contents: {
          workflows: [
            {
              id: 'rt-flow',
              name: 'RT Flow',
              description: 'Round trip workflow',
              entryStep: 'start',
              steps: [
                { id: 'start', name: 'Start', type: 'agent', agentMode: 'rt-agent', skills: ['rt-skill'] },
              ],
            },
          ],
          agents: [
            {
              id: 'rt-agent',
              name: 'RT Agent',
              description: 'Round trip agent',
              allowedTools: ['read_file'],
              color: '#3b82f6',
              prompt: 'Do the thing.',
            },
          ],
          skills: [
            {
              id: 'rt-skill',
              name: 'RT Skill',
              description: 'Round trip skill',
              version: '3.1.0',
              prompt: 'Skill body.',
            },
          ],
          commands: [{ id: 'rt-cmd', name: 'RT Command', prompt: '/run-workflow rt-flow' }],
        },
      }

      await installPack(roundTripPack, { scope: 'project', workdir: tempWorkdir, configDir: tempConfigDir })

      const exported = await exportPack({
        workflowId: 'rt-flow',
        workdir: tempWorkdir,
        configDir: tempConfigDir,
      })

      const agent = exported.contents.agents?.find((a) => a.id === 'rt-agent')
      expect(agent).toBeDefined()
      expect(agent?.name).toBe('RT Agent')
      expect(agent?.description).toBe('Round trip agent')
      expect(agent?.subagent).toBe(false)
      expect(agent?.allowedTools).toEqual(['read_file'])
      expect(agent?.color).toBe('#3b82f6')
      expect(agent?.prompt).toBe('Do the thing.')

      const skill = exported.contents.skills?.find((s) => s.id === 'rt-skill')
      expect(skill).toBeDefined()
      expect(skill?.name).toBe('RT Skill')
      expect(skill?.description).toBe('Round trip skill')
      expect(skill?.version).toBe('3.1.0')
      expect(skill?.prompt).toBe('Skill body.')

      const command = exported.contents.commands?.find((c) => c.id === 'rt-cmd')
      expect(command).toBeDefined()
      expect(command?.name).toBe('RT Command')
      expect(command?.prompt).toBe('/run-workflow rt-flow')
    })
  })

  // ==========================================================================
  // Criterion 4: Registry Sync, URL Normalization, Inspection & Search
  // ==========================================================================
  describe('Criterion 4: Registry Sync & Remote Packs (fetchRegistry, inspectPack, searchPacks)', () => {
    it('normalizes GitHub blob URLs and Gist URLs to raw format', () => {
      expect(
        normalizePackUrl('https://github.com/user/repo/blob/main/my-pack.json'),
      ).toBe('https://raw.githubusercontent.com/user/repo/main/my-pack.json')

      expect(
        normalizePackUrl('https://gist.github.com/alice/abcdef123456'),
      ).toBe('https://gist.github.com/alice/abcdef123456/raw')
    })

    it('fetches registry index live from remote registry', async () => {
      const mockIndex: RegistryIndex = {
        version: 1,
        packs: [
          {
            name: 'devops-bundle',
            version: '1.0.0',
            displayName: 'DevOps Bundle',
            description: 'Docker and Kubernetes helpers',
            downloadUrl: 'https://example.com/pack.json',
            tags: ['docker', 'k8s'],
          },
        ],
      }

      let fetchCallCount = 0
      const mockFetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++
        return {
          ok: true,
          status: 200,
          json: async () => mockIndex,
        }
      })

      // First fetch
      const res1 = await fetchRegistry({ fetchFn: mockFetch as never })
      expect(res1.packs).toHaveLength(1)
      expect(fetchCallCount).toBe(1)

      // Second fetch: always fetches live
      const res2 = await fetchRegistry({ fetchFn: mockFetch as never })
      expect(res2.packs).toHaveLength(1)
      expect(fetchCallCount).toBe(2)
    })

    it('queries the GitHub Contents API directly and never the cached raw CDN URL', async () => {
      const { getGithubApiUrl } = await import('./registry.js')
      const ghInfo = getGithubApiUrl('https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json')
      expect(ghInfo?.apiUrl).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main')
      expect(
        getGithubApiUrl('https://github.com/JamesDAdams/openfox-community/blob/main/index.json')?.apiUrl,
      ).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main')
      expect(getGithubApiUrl('https://example.com/registry.json')).toBeNull()

      const calls: { url: string; options: any }[] = []
      const mockFetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
        calls.push({ url, options: opts })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 1,
            name: 'OpenFox Registry',
            updatedAt: new Date().toISOString(),
            packs: [],
          }),
        }
      })

      await fetchRegistry({
        registryUrl: 'https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json',
        token: 'ghp_secret_token_123',
        fetchFn: mockFetch as never,
      })

      expect(calls).toHaveLength(1)
      const first = calls[0]!
      expect(first.url).toBe(
        'https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main',
      )
      expect(first.url).not.toContain('raw.githubusercontent.com')
      expect(first.url).not.toContain('_t=')
      expect(first.options?.cache).toBe('no-store')
      expect(first.options?.headers?.['Accept']).toBe('application/vnd.github.raw+json')
      expect(first.options?.headers?.['Authorization']).toBe('Bearer ghp_secret_token_123')
      expect(first.options?.headers?.['If-None-Match']).toBeUndefined()
      expect(first.options?.headers?.['Cache-Control']).toBeUndefined()
    })

    it('resolves GitHub raw URLs that use the refs/heads or refs/tags path form', async () => {
      const { getGithubApiUrl } = await import('./registry.js')

      expect(
        getGithubApiUrl('https://raw.githubusercontent.com/JamesDAdams/openfox-community/refs/heads/main/index.json')
          ?.apiUrl,
      ).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main')

      expect(
        getGithubApiUrl(
          'https://raw.githubusercontent.com/JamesDAdams/openfox-community/refs/heads/main/packs/devops-k8s.json',
        )?.apiUrl,
      ).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/packs/devops-k8s.json?ref=main')

      expect(
        getGithubApiUrl('https://raw.githubusercontent.com/JamesDAdams/openfox-community/refs/tags/v1.2.3/index.json')
          ?.apiUrl,
      ).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=v1.2.3')

      expect(
        getGithubApiUrl('https://github.com/JamesDAdams/openfox-community/raw/refs/heads/main/index.json')?.apiUrl,
      ).toBe('https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main')
    })

    it('fetches a registry configured with the refs/heads URL form through the GitHub API', async () => {
      const calls: string[] = []
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 1,
            name: 'OpenFox Registry',
            updatedAt: new Date().toISOString(),
            packs: [],
          }),
        }
      })

      await fetchRegistry({
        registryUrl: 'https://raw.githubusercontent.com/JamesDAdams/openfox-community/refs/heads/main/index.json',
        fetchFn: mockFetch as never,
      })

      expect(calls).toEqual([
        'https://api.github.com/repos/JamesDAdams/openfox-community/contents/index.json?ref=main',
      ])
    })

    it('falls back to the raw CDN URL only when the GitHub API call fails', async () => {
      const calls: string[] = []
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url)
        if (url.includes('api.github.com')) {
          return { ok: false, status: 403, statusText: 'rate limited', json: async () => ({}) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 1,
            name: 'OpenFox Registry',
            updatedAt: new Date().toISOString(),
            packs: [],
          }),
        }
      })

      const registry = await fetchRegistry({
        registryUrl: 'https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json',
        fetchFn: mockFetch as never,
      })

      expect(registry.packs).toEqual([])
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('api.github.com')
      expect(calls[1]).toBe('https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json')
      expect(calls[1]).not.toContain('_t=')
    })

    it('inspects a pack and returns contents summary & required secrets', async () => {
      const packObject: PackManifest = {
        schemaVersion: 1,
        name: 'test-inspector',
        version: '1.0.0',
        contents: {
          workflows: [
            {
              id: 'w1',
              name: 'Workflow 1',
              description: '',
              entryStep: 's1',
              steps: [{ id: 's1', name: 'S1' }],
            },
          ],
          agents: [
            { id: 'a1', name: 'A1', description: '', prompt: 'Agent 1' },
            { id: 'a2', name: 'A2', description: '', prompt: 'Agent 2' },
          ],
          skills: [{ id: 'sk1', name: 'SK1', description: '', prompt: 'Skill 1' }],
          mcpServers: {
            srv1: {
              transport: 'stdio',
              command: 'node',
              envRequirements: [{ key: 'API_KEY', required: true }],
            },
          },
        },
      }

      const inspected = await inspectPack(packObject)
      expect(inspected.summary.workflowCount).toBe(1)
      expect(inspected.summary.agentCount).toBe(2)
      expect(inspected.summary.skillCount).toBe(1)
      expect(inspected.summary.mcpCount).toBe(1)
      expect(inspected.requiredSecrets).toHaveLength(1)
      expect(inspected.requiredSecrets[0]?.key).toBe('API_KEY')
    })

    it('searches packs by keywords and tags', () => {
      const index: RegistryIndex = {
        version: 1,
        packs: [
          {
            name: 'fullstack-reviewer',
            version: '1.0.0',
            displayName: 'Fullstack Reviewer',
            description: 'Analyzes React and Node.js code',
            downloadUrl: 'https://example.com/1.json',
            tags: ['review', 'react'],
          },
          {
            name: 'k8s-deployer',
            version: '1.0.0',
            displayName: 'Kubernetes Deployer',
            description: 'Deploys Helm charts and pods',
            downloadUrl: 'https://example.com/2.json',
            tags: ['devops', 'k8s'],
          },
        ],
      }

      const results1 = searchPacks(index, 'react')
      expect(results1).toHaveLength(1)
      expect(results1[0]?.name).toBe('fullstack-reviewer')

      const results2 = searchPacks(index, 'helm', { tag: 'devops' })
      expect(results2).toHaveLength(1)
      expect(results2[0]?.name).toBe('k8s-deployer')

      const results3 = searchPacks(index, 'nonexistent')
      expect(results3).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Criterion 5: Refresh behaviour (snapshot cache, no CDN, merged re-fetch)
  // ==========================================================================
  describe('Criterion 5: Refresh behaviour (snapshot cache, no CDN, merged re-fetch)', () => {
    interface RpcResult {
      content?: unknown
      count?: number
      ok?: boolean
    }
    type RpcHandler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<RpcResult>

    const rpc = (calls: Record<string, unknown[]>, method: string): RpcHandler =>
      (calls[`rpc:${method}`] as RpcHandler[])[0]!

    const buildIndexPayload = (packs: Array<{ name: string; version?: string; displayName?: string }>) => ({
      version: 1,
      name: 'OpenFox Official Community Registry',
      updatedAt: new Date().toISOString(),
      packs: packs.map((p) => ({
        name: p.name,
        version: p.version ?? '1.0.0',
        displayName: p.displayName ?? p.name,
        description: '',
        author: 'JamesDAdams',
        tags: ['community-pack'],
        downloadUrl: `https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/packs/${p.name}.json`,
        updatedAt: new Date().toISOString(),
      })),
    })

    const jsonResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })

    it('hub.searchUi filters the in-memory snapshot without any network call', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () =>
        jsonResponse(buildIndexPayload([{ name: 'coucou' }, { name: 'devops-k8s' }])),
      )
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      // Startup prefetch populates the snapshot exactly once.
      await vi.waitFor(() => expect(getRegistrySnapshot()).toBeDefined())
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      const callsAfterPrefetch = fetchSpy.mock.calls.length

      const searchUiRpc = rpc(calls, 'hub.searchUi')

      const first = await searchUiRpc({ value: 'coucou' })
      const second = await searchUiRpc({ value: 'devops' })
      const third = await searchUiRpc({ value: '' })

      expect(fetchSpy.mock.calls.length).toBe(callsAfterPrefetch)
      expect(first.count).toBe(1)
      expect(second.count).toBe(1)
      expect(third.count).toBe(2)
    })

    it('hub.searchUi fetches once when no snapshot is available yet', async () => {
      resetRegistrySnapshot()
      const fetchSpy = vi.fn().mockImplementation(async () => jsonResponse(buildIndexPayload([{ name: 'alpha' }])))
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      resetRegistrySnapshot()
      const before = fetchSpy.mock.calls.length

      const searchUiRpc = rpc(calls, 'hub.searchUi')
      const res = await searchUiRpc({ value: 'alpha' })

      expect(fetchSpy.mock.calls.length).toBe(before + 1)
      expect(res.count).toBe(1)
      expect(getRegistrySnapshot()).toBeDefined()
    })

    it('shows the last refresh timestamp and total pack count in the marketplace content', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () =>
        jsonResponse(buildIndexPayload([{ name: 'alpha' }, { name: 'beta' }])),
      )
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const fetchRegistryRpc = rpc(calls, 'hub.fetchRegistry')
      const res = await fetchRegistryRpc({ forceRefresh: true })

      const serialized = JSON.stringify(res.content)
      expect(serialized).toContain('Last refreshed at')
      expect(serialized).toContain('Dernier rafraîchissement à')
      expect(serialized).toMatch(/\(2 packs · 1 registry\)/)

      const published = JSON.stringify(mockContext.publish.mock.calls)
      expect(published).toContain('Last refreshed at')
    })

    it('notifies an error and keeps the last snapshot when the refresh fetch fails', async () => {
      let shouldFail = false
      const fetchSpy = vi.fn().mockImplementation(async () =>
        shouldFail
          ? { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}), text: async () => '' }
          : jsonResponse(buildIndexPayload([{ name: 'alpha' }])),
      )
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const fetchRegistryRpc = rpc(calls, 'hub.fetchRegistry')
      await fetchRegistryRpc({ forceRefresh: true })
      expect(getRegistrySnapshot()?.packs).toHaveLength(1)

      shouldFail = true
      const initPanelRpc = rpc(calls, 'initPanel')
      const res = await initPanelRpc({ panelId: 'community-hub-panel' })

      // Snapshot is preserved so the user still sees the previous list.
      expect(getRegistrySnapshot()?.packs).toHaveLength(1)
      expect(JSON.stringify(res.content)).toContain('Refresh failed')

      const notifyCalls = mockContext.notify.mock.calls as Array<[{ level?: string }]>
      expect(notifyCalls.some((c) => c[0]?.level === 'error')).toBe(true)
    })

    it('re-fetches and republishes the marketplace when a published pack PR is merged', async () => {
      let packName = 'alpha'
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/pulls/')) {
          return jsonResponse({ number: 42, merged: true, state: 'closed', mergeable_state: 'clean' })
        }
        if (String(url).includes('check-runs') || String(url).includes('/commits/')) {
          return jsonResponse({ check_runs: [], state: 'success' })
        }
        return jsonResponse(buildIndexPayload([{ name: packName }]))
      })
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const fetchRegistryRpc = rpc(calls, 'hub.fetchRegistry')
      await fetchRegistryRpc({ forceRefresh: true })
      expect(getRegistrySnapshot()?.packs.map((p) => p.name)).toEqual(['alpha'])

      // The registry now contains the newly merged pack.
      packName = 'coucou-edited'
      mockContext.publish.mockClear()
      const before = fetchSpy.mock.calls.length

      const checkPrStatusRpc = rpc(calls, 'hub.checkPrStatus')
      await checkPrStatusRpc({ prNumber: 42 }, { workdir: tempWorkdir })

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(before)
      expect(getRegistrySnapshot()?.packs.map((p) => p.name)).toEqual(['coucou-edited'])

      const publishedContent = JSON.stringify(
        mockContext.publish.mock.calls.filter((c) => c[1] === 'content'),
      )
      expect(publishedContent).toContain('coucou-edited')
    })

    it('formatRefreshLabel renders an HH:MM:SS stamp with the pack and registry counts', () => {
      const label = formatRefreshLabel('2026-09-25T16:35:37.958Z', 4, 2)
      expect(label).toMatch(/^Last refreshed at \d{2}:\d{2}:\d{2} \(4 packs · 2 registries\)$/)
      expect(formatRefreshLabel(undefined, 0, 0)).toBe('Last refreshed at --:--:-- (0 packs · 0 registries)')
      expect(formatRefreshLabel(new Date().toISOString(), 1, 1)).toContain('(1 pack · 1 registry)')
    })

    it('setRegistrySnapshot and resetRegistrySnapshot manage the cached index', () => {
      resetRegistrySnapshot()
      expect(getRegistrySnapshot()).toBeUndefined()

      const index: RegistryIndex = { version: 1, packs: [] }
      setRegistrySnapshot(index)
      expect(getRegistrySnapshot()).toBe(index)

      resetRegistrySnapshot()
      expect(getRegistrySnapshot()).toBeUndefined()
    })
  })

  // ==========================================================================
  // Criteria 10 to 19: Local Inventory, Markdown Agent Formats, GitHub Token & PR
  // ==========================================================================
  describe('Pack Publisher & Extended Local Inventory', () => {
    it('scans .agent.md, .command.md, skills folder and config.json mcp servers', async () => {
      const projectWfDir = join(tempWorkdir, '.openfox', 'workflows')
      const projectAgentsDir = join(tempWorkdir, '.openfox', 'agents')
      const projectSkillsDir = join(tempWorkdir, '.openfox', 'skills', 'Ponytail')
      const projectCmdDir = join(tempWorkdir, '.openfox', 'commands')
      const projectConfigFile = join(tempWorkdir, '.openfox', 'config.json')

      await mkdir(projectWfDir, { recursive: true })
      await mkdir(projectAgentsDir, { recursive: true })
      await mkdir(projectSkillsDir, { recursive: true })
      await mkdir(projectCmdDir, { recursive: true })

      await writeFile(
        join(projectWfDir, 'us-to-mr.workflow.json'),
        JSON.stringify({ metadata: { id: 'us-to-mr', name: 'US to MR' }, entryStep: 's1', steps: [] }),
      )
      // .agent.md with frontmatter
      await writeFile(
        join(projectAgentsDir, 'git_agent.agent.md'),
        '---\nid: git_agent\nname: Git Agent\ndescription: Git specialist\nsubagent: true\n---\nYou are a git agent.',
      )
      // .command.md
      await writeFile(
        join(projectCmdDir, 'docs.command.md'),
        '---\nid: docs\nname: Docs Lookup\n---\n/context7:docs',
      )
      // Skill folder with SKILL.md
      await writeFile(
        join(projectSkillsDir, 'SKILL.md'),
        '---\nname: Ponytail\ndescription: Minimal solutions\n---\nBe minimal.',
      )
      // config.json with mcpServers
      await writeFile(
        projectConfigFile,
        JSON.stringify({ mcpServers: { gitMcp: { transport: 'stdio', command: 'npx' } } }),
      )

      const inventory = await listLocalItems(tempWorkdir, tempConfigDir)
      expect(inventory.workflows.some((w) => w.id === 'us-to-mr')).toBe(true)
      expect(inventory.subAgents.some((sa) => sa.id === 'git_agent')).toBe(true)
      expect(inventory.skills.some((sk) => sk.id === 'Ponytail')).toBe(true)
      expect(inventory.commands.some((c) => c.id === 'docs')).toBe(true)
      expect(inventory.mcpServers.some((m) => m.id === 'gitMcp')).toBe(true)
    })

    it('verifies GitHub Personal Access Token via verifyGithubToken', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({ login: 'JamesDAdams' }),
      }))

      const res = await verifyGithubToken('ghp_test_token', mockFetch as never)
      expect(res.valid).toBe(true)
      expect(res.username).toBe('JamesDAdams')
    })

    it('builds a custom pack with auto-derived slug <username>-<displayname>', async () => {
      const projectAgentsDir = join(tempWorkdir, '.openfox', 'agents')
      await mkdir(projectAgentsDir, { recursive: true })
      await writeFile(
        join(projectAgentsDir, 'git_agent.agent.md'),
        '---\nid: git_agent\nname: Git Agent\n---\nPrompt body',
      )

      const pack = await buildCustomPack({
        workdir: tempWorkdir,
        configDir: tempConfigDir,
        metadata: {
          author: 'JamesDAdams',
          displayName: 'Fullstack PR Reviewer',
          version: '1.0.0',
        },
        selected: {
          agents: ['git_agent'],
        },
      })

      expect(pack.name).toBe('jamesdadams-fullstack-pr-reviewer')
      expect(pack.author).toBe('JamesDAdams')
      expect(pack.contents.agents).toHaveLength(1)
      expect(pack.contents.agents?.[0]?.prompt).toContain('Prompt body')
    })

    it('publishes pack to GitHub with publishPackToGitHub and creates PR', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/user')) {
          return { ok: true, json: async () => ({ login: 'JamesDAdams' }) }
        }
        if (url.includes('/git/ref/heads/main')) {
          return { ok: true, json: async () => ({ object: { sha: 'base_sha' } }) }
        }
        if (url.endsWith('/forks')) {
          return { ok: true, json: async () => ({ full_name: 'JamesDAdams/openfox-community' }) }
        }
        if (url.endsWith('/git/refs')) {
          return { ok: true, json: async () => ({ ref: 'refs/heads/pack-branch' }) }
        }
        if (url.includes('/contents/')) {
          return {
            ok: true,
            json: async () => ({
              sha: 'index_sha',
              content: Buffer.from(JSON.stringify({ version: 1, packs: [] })).toString('base64'),
            }),
          }
        }
        if (url.endsWith('/pulls')) {
          return {
            ok: true,
            json: async () => ({
              number: 99,
              html_url: 'https://github.com/JamesDAdams/openfox-community/pull/99',
            }),
          }
        }
        return { ok: true, json: async () => ({}) }
      })

      const testPack: PackManifest = {
        schemaVersion: 1,
        name: 'jamesdadams-my-pack',
        version: '1.0.0',
        contents: {
          workflows: [
            { id: 'w1', name: 'W1', description: '', entryStep: 's1', steps: [{ id: 's1', name: 'S1' }] },
          ],
        },
      }

      const result = await publishPackToGitHub({
        token: 'ghp_token',
        pack: testPack,
        fetchFn: mockFetch as never,
      })

      expect(result.success).toBe(true)
      expect(result.prNumber).toBe(99)
      expect(result.prUrl).toBe('https://github.com/JamesDAdams/openfox-community/pull/99')
    })

    it('supplies existing file sha when updating/editing an existing pack file', async () => {
      let putBody: any = null
      const mockFetch = vi.fn().mockImplementation(async (url: string, options?: any) => {
        if (url.endsWith('/user')) {
          return { ok: true, json: async () => ({ login: 'JamesDAdams' }) }
        }
        if (url.includes('/git/ref/heads/main')) {
          return { ok: true, json: async () => ({ object: { sha: 'base_sha' } }) }
        }
        if (url.endsWith('/forks')) {
          return { ok: true, json: async () => ({ full_name: 'JamesDAdams/openfox-community' }) }
        }
        if (url.endsWith('/git/refs')) {
          return { ok: true, json: async () => ({ ref: 'refs/heads/pack-branch' }) }
        }
        if (url.includes('/contents/packs/existing-pack.json') && options?.method === 'PUT') {
          putBody = JSON.parse(options.body)
          return { ok: true, json: async () => ({ content: {} }) }
        }
        if (url.includes('/contents/packs/existing-pack.json')) {
          return {
            ok: true,
            json: async () => ({
              sha: 'blob_existing_sha_123',
              content: Buffer.from(
                JSON.stringify({ schemaVersion: 1, name: 'existing-pack', version: '1.0.0', author: 'JamesDAdams', contents: {} }),
              ).toString('base64'),
            }),
          }
        }
        if (url.endsWith('/pulls')) {
          return {
            ok: true,
            json: async () => ({
              number: 101,
              html_url: 'https://github.com/JamesDAdams/openfox-community/pull/101',
            }),
          }
        }
        return { ok: true, json: async () => ({}) }
      })

      const testPack: PackManifest = {
        schemaVersion: 1,
        name: 'existing-pack',
        version: '1.0.1',
        author: 'JamesDAdams',
        contents: {},
      }

      const result = await publishPackToGitHub({
        token: 'ghp_token',
        pack: testPack,
        fetchFn: mockFetch as never,
      })

      expect(result.success).toBe(true)
      expect(putBody).toBeTruthy()
      expect(putBody.sha).toBe('blob_existing_sha_123')
    })

    it('recursively resolves workflow dependencies: workflow -> agents/subagents -> nested subagents -> skills -> MCP tools', async () => {
      const projectWfDir = join(tempWorkdir, '.openfox', 'workflows')
      const projectAgentsDir = join(tempWorkdir, '.openfox', 'agents')
      const projectSkillsDir = join(tempWorkdir, '.openfox', 'skills', 'G2S', 'jira-workflow')
      const projectGitSkillDir = join(tempWorkdir, '.openfox', 'skills', 'G2S', 'git-commit-push')
      const projectConfigFile = join(tempWorkdir, '.openfox', 'config.json')

      await mkdir(projectWfDir, { recursive: true })
      await mkdir(projectAgentsDir, { recursive: true })
      await mkdir(projectSkillsDir, { recursive: true })
      await mkdir(projectGitSkillDir, { recursive: true })

      // 1. Workflow with agentId and subAgentType steps
      await writeFile(
        join(projectWfDir, 'us-to-mr.workflow.json'),
        JSON.stringify({
          metadata: { id: 'us-to-mr', name: 'US to MR' },
          entryStep: 'jira_setup',
          steps: [
            {
              id: 'jira_setup',
              type: 'sub_agent',
              subAgentType: 'jira_agent',
            },
            {
              id: 'git_setup',
              type: 'sub_agent',
              subAgentType: 'git_agent',
            },
            {
              id: 'run_tests',
              type: 'agent',
              agentId: 'tester',
            },
          ],
        }),
      )

      // 2. Jira Agent using Jira MCP tool and loading jira-workflow skill
      await writeFile(
        join(projectAgentsDir, 'jira_agent.agent.md'),
        `---
id: jira_agent
name: Jira Agent
subagent: true
allowedTools:
  - load_skill
  - Jira_jira_get_issue
  - Jira_jira_assign_issue
---
Load the \`jira-workflow\` skill via load_skill.`,
      )

      // 3. Git Agent loading git-commit-push skill
      await writeFile(
        join(projectAgentsDir, 'git_agent.agent.md'),
        `---
id: git_agent
name: Git Agent
subagent: true
allowedTools:
  - run_command
  - load_skill
  - __mcp_none__
---
Load the \`git-commit-push\` skill via load_skill.`,
      )

      // 4. Tester Agent delegating to sub-agents via call_sub_agent in prompt
      await writeFile(
        join(projectAgentsDir, 'tester.agent.md'),
        `---
id: tester
name: Tester Agent
subagent: false
allowedTools:
  - run_command
  - call_sub_agent
---
Delegate to \`e2e_tester\` sub-agent via call_sub_agent.`,
      )

      // 5. Nested e2e_tester subagent
      await writeFile(
        join(projectAgentsDir, 'e2e_tester.agent.md'),
        `---
id: e2e_tester
name: E2E Tester
subagent: true
allowedTools:
  - run_command
---
Run tests.`,
      )

      // 6. Skills
      await writeFile(join(projectSkillsDir, 'SKILL.md'), '# Jira Workflow Skill')
      await writeFile(join(projectGitSkillDir, 'SKILL.md'), '# Git Commit Push Skill')

      // 7. MCP server Jira in config.json
      await writeFile(
        projectConfigFile,
        JSON.stringify({
          mcpServers: {
            Jira: {
              transport: 'stdio',
              command: 'uvx',
              args: ['mcp-atlassian'],
            },
          },
        }),
      )

      // Import resolveComponentDependencies
      const { resolveComponentDependencies } = await import('./publisher.js')
      const deps = await resolveComponentDependencies('workflow', 'us-to-mr', tempWorkdir, tempConfigDir)

      const depKeys = deps.map((d) => `${d.type}:${d.id}`)
      // Workflow agents and subagents resolved
      expect(depKeys).toContain('subagent:jira_agent')
      expect(depKeys).toContain('subagent:git_agent')
      expect(depKeys).toContain('agent:tester')
      // Nested subagent called from tester prompt
      expect(depKeys).toContain('subagent:e2e_tester')
      // Skills loaded by agents
      expect(depKeys).toContain('skill:G2S/jira-workflow')
      expect(depKeys).toContain('skill:G2S/git-commit-push')
      // MCP servers used by tools
      expect(depKeys).toContain('mcp:Jira')
    })

    it('generates a visual declarative preview node for PackManifest (buildPackPreviewNode)', async () => {
      const { buildPackPreviewNode } = await import('./ui.js')
      const samplePack: PackManifest = {
        schemaVersion: 1,
        name: 'jamesdadams-custom-pack',
        version: '1.0.0',
        displayName: 'Custom Pack',
        description: 'A rich preview pack test',
        author: 'JamesDAdams',
        tags: ['community-pack'],
        contents: {
          workflows: [
            { id: 'us-to-mr', name: 'US to MR', description: 'Full workflow', entryStep: 's1', steps: [] },
          ],
          agents: [
            { id: 'tester', name: 'Tester', description: 'Test orchestrator', prompt: 'test' },
          ],
          subAgents: [
            { id: 'jira_agent', name: 'Jira Agent', description: 'Jira operations', prompt: 'jira', subagent: true },
          ],
          skills: [
            { id: 'G2S/jira-workflow', name: 'jira-workflow', description: 'Jira skill', prompt: 'skill' },
          ],
          mcpServers: {
            Jira: { transport: 'stdio', command: 'uvx' },
          },
        },
      }

      const previewNode = buildPackPreviewNode(samplePack)
      expect(previewNode.type).toBe('card')
      if (previewNode.type === 'card') {
        const title = previewNode.title as { en: string; fr: string }
        expect(title.en).toContain('Custom Pack')
        expect(title.en).toContain('v1.0.0')

        // Check for raw JSON accordion in children
        const children = previewNode.children ?? []
        const detailsNode = children.find(
          (c) => c.type === 'details' && typeof c.title === 'object' && c.title.en.includes('Raw PackManifest JSON'),
        )
        expect(detailsNode).toBeDefined()
      }
    })

    it('resets selected checkboxes when opening publish panel or calling resetPublishState', async () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const toggleRpc = (calls['rpc:hub.toggleComponent'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await toggleRpc({ type: 'workflow', id: 'my-wf', value: true })

      // initPanel on publish panel should reset state
      const initPanelRpc = (calls['rpc:initPanel'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const initRes = await initPanelRpc({ panelId: 'community-hub-publish-panel' })
      expect(initRes.ok).toBe(true)
      expect(initRes.content).toBeDefined()
    })

    it('disables publish button when token, displayName, or description are missing', async () => {
      const { buildPublishPanelContent } = await import('./ui.js')
      const panelIncomplete = buildPublishPanelContent(
        { workflows: [], agents: [], subAgents: [], skills: [], commands: [], mcpServers: [] },
        '',
        '',
        {},
        {},
        undefined,
        '',
        '',
      )

      // Find the publish button in the footer stack
      const footerStack = panelIncomplete.find(
        (node) => node.type === 'stack' && node.direction === 'row' && node.justify === 'end',
      )
      expect(footerStack).toBeDefined()
      if (footerStack && footerStack.type === 'stack') {
        const publishBtn = footerStack.children.find(
          (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en.includes('Publish Pack'),
        )
        expect(publishBtn).toBeDefined()
        if (publishBtn && publishBtn.type === 'button') {
          expect(publishBtn.disabled).toBe(true)
        }
      }

      // Now with valid token, username, displayName, description
      const panelComplete = buildPublishPanelContent(
        { workflows: [], agents: [], subAgents: [], skills: [], commands: [], mcpServers: [] },
        'ghp_valid_token_123',
        'JamesDAdams',
        {},
        {},
        undefined,
        'My Great Pack',
        'Useful pack description',
      )
      const completeFooter = panelComplete.find(
        (node) => node.type === 'stack' && node.direction === 'row' && node.justify === 'end',
      )
      if (completeFooter && completeFooter.type === 'stack') {
        const publishBtn = completeFooter.children.find(
          (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en.includes('Publish Pack'),
        )
        expect(publishBtn).toBeDefined()
        if (publishBtn && publishBtn.type === 'button') {
          expect(publishBtn.disabled).toBe(false)
        }
      }
    })

    it('checks GitHub PR status with check-runs and commit statuses', async () => {
      const { checkGithubPrStatus } = await import('./publisher.js')
      const { buildLiveTrackingCard } = await import('./ui.js')

      const mockFetchMerged = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/pulls/')) {
          return {
            ok: true,
            json: async () => ({
              state: 'closed',
              merged: true,
              merged_at: '2026-09-25T12:00:00Z',
              head: { sha: 'commit_sha_123' },
            }),
          }
        }
        return { ok: true, json: async () => ({}) }
      })

      const statusRes = await checkGithubPrStatus({
        token: 'ghp_token',
        prNumber: 42,
        fetchFn: mockFetchMerged as never,
      })

      expect(statusRes.merged).toBe(true)
      expect(statusRes.state).toBe('merged')
      expect(statusRes.checksStatus).toBe('success')

      const trackingCard = buildLiveTrackingCard({
        state: 'merged',
        prNumber: 42,
        prUrl: 'https://github.com/JamesDAdams/openfox-community/pull/42',
        packName: 'my-merged-pack',
        merged: true,
        checksStatus: 'success',
        lastCheckedAt: new Date().toISOString(),
      })

      expect(trackingCard.type).toBe('card')
      if (trackingCard.type === 'card') {
        expect(trackingCard.tone).toBe('success')
      }
    })

    it('renders live tracking card in creating and error states', async () => {
      const { buildLiveTrackingCard } = await import('./ui.js')

      // Creating state
      const creatingCard = buildLiveTrackingCard({
        state: 'creating',
        prNumber: 0,
        prUrl: '',
        packName: 'pending-pack',
        checksStatus: 'pending',
        merged: false,
        lastCheckedAt: new Date().toISOString(),
      })

      expect(creatingCard.type).toBe('card')
      if (creatingCard.type === 'card') {
        expect(creatingCard.tone).toBe('info')
        const title = creatingCard.title as { en: string; fr: string }
        expect(title.en).toContain('Creating PR')
      }

      // Error state
      const errorCard = buildLiveTrackingCard({
        state: 'error',
        prNumber: 99,
        prUrl: 'https://github.com/JamesDAdams/openfox-community/pull/99',
        packName: 'failed-pack',
        checksStatus: 'failure',
        merged: false,
        errorMessage: 'Validation checks failed on GitHub Actions.',
        lastCheckedAt: new Date().toISOString(),
      })

      expect(errorCard.type).toBe('card')
      if (errorCard.type === 'card') {
        expect(errorCard.tone).toBe('danger')
        const title = errorCard.title as { en: string; fr: string }
        expect(title.en).toContain('Publication Error')
      }
    })

    it('handles publication errors and renders error status in UI via hub.publishPackPr', async () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const publishPrRpc = (calls['rpc:hub.publishPackPr'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const result = await publishPrRpc({
        token: '', // Empty token will cause error
        displayName: 'Test Failure',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Access Token is required')
      expect(result.status.state).toBe('error')
    })

    it('increments patch version with incrementPatchVersion', async () => {
      const { incrementPatchVersion } = await import('./publisher.js')
      expect(incrementPatchVersion('1.0.0')).toBe('1.0.1')
      expect(incrementPatchVersion('1.2.9')).toBe('1.2.10')
      expect(incrementPatchVersion('2.1')).toBe('2.1.1')
      expect(incrementPatchVersion('3')).toBe('3.0.1')
      expect(incrementPatchVersion('v1.0.4')).toBe('1.0.5')
    })

    it('extracts pack author username with getPackAuthorUsername', async () => {
      const { getPackAuthorUsername } = await import('./publisher.js')
      expect(getPackAuthorUsername({ name: 'custom', version: '1.0.0', author: '@JamesDAdams' } as any)).toBe('JamesDAdams')
      expect(getPackAuthorUsername({ name: 'custom', version: '1.0.0', author: { name: 'Alice', url: 'https://github.com/alice' } } as any)).toBe('alice')
      expect(getPackAuthorUsername({ name: 'bob-my-pack', version: '1.0.0', author: { name: 'Bob Smith' } } as any)).toBe('bob')
    })

    it('renders edit button enabled for author and disabled with tooltip for non-author', async () => {
      const { buildPackCardNode } = await import('./ui.js')
      const packEntry: any = {
        name: 'alice-cool-pack',
        version: '1.0.0',
        displayName: 'Cool Pack',
        description: 'A great pack',
        author: { name: 'Alice', url: 'https://github.com/alice' },
        downloadUrl: 'https://example.com/pack.json',
      }

      // 1. Logged in as non-author
      const cardNonAuthor = buildPackCardNode(packEntry, 'charlie')
      const actionStackNonAuthor = (cardNonAuthor as any).children.find(
        (c: any) => c.type === 'stack' && c.direction === 'row',
      )
      const editBtnNonAuthor = actionStackNonAuthor.children.find(
        (b: any) => b.type === 'button' && (b.label?.en === 'Edit' || b.label?.fr === 'Modifier'),
      )
      expect(editBtnNonAuthor).toBeDefined()
      expect(editBtnNonAuthor.disabled).toBe(true)
      expect(editBtnNonAuthor.title?.fr).toContain("Vous ne pouvez pas modifier ce paquet, parce que vous n'êtes pas l'auteur")

      // 2. Logged in as author
      const cardAuthor = buildPackCardNode(packEntry, 'alice')
      const actionStackAuthor = (cardAuthor as any).children.find(
        (c: any) => c.type === 'stack' && c.direction === 'row',
      )
      const editBtnAuthor = actionStackAuthor.children.find(
        (b: any) => b.type === 'button' && (b.label?.en === 'Edit' || b.label?.fr === 'Modifier'),
      )
      expect(editBtnAuthor).toBeDefined()
      expect(editBtnAuthor.disabled).toBe(false)
      expect(editBtnAuthor.title?.fr).toContain('Modifier ce pack')
    })

    it('shows a Commands badge on the pack card', async () => {
      const { buildPackCardNode } = await import('./ui.js')
      const packEntry: any = {
        name: 'devops-k8s',
        version: '1.0.0',
        displayName: 'DevOps Kubernetes & Docker',
        description: 'K8s and Docker helpers',
        author: { name: 'JamesDAdams' },
        downloadUrl: 'https://example.com/pack.json',
        contentsSummary: {
          workflows: ['k8s-audit'],
          agents: ['docker-expert'],
          skills: ['dockerfile-best-practices'],
          commands: ['k8s-audit'],
        },
      }

      const card = buildPackCardNode(packEntry, 'alice')
      const badgeStack = (card as any).children.find(
        (c: any) => c.type === 'stack' && c.direction === 'row' && c.children.every((k: any) => k.type === 'badge'),
      )
      expect(badgeStack).toBeDefined()
      expect(badgeStack.children.map((b: any) => b.label.en)).toEqual([
        '1 Workflow',
        '1 Agent',
        '1 Skill',
        '1 Command',
      ])
      expect(badgeStack.children.at(-1).tone).toBe('neutral')
      expect(badgeStack.children.at(-1).label.fr).toBe('1 Commande')

      const pluralCard = buildPackCardNode(
        { ...packEntry, contentsSummary: { ...packEntry.contentsSummary, commands: ['a', 'b'] } } as any,
        'alice',
      )
      const pluralStack = (pluralCard as any).children.find(
        (c: any) => c.type === 'stack' && c.direction === 'row' && c.children.every((k: any) => k.type === 'badge'),
      )
      expect(pluralStack.children.at(-1).label.en).toBe('2 Commands')
      expect(pluralStack.children.at(-1).label.fr).toBe('2 Commandes')
    })

    it('clears all fields on fresh openPublishPanel call', async () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const detailsRpc = (calls['rpc:hub.onDetailsChange'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await detailsRpc({ field: 'displayName', value: 'Previous Stale Name' })

      const toggleRpc = (calls['rpc:hub.toggleComponent'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await toggleRpc({ type: 'workflow', id: 'prev-wf', value: true })

      // Open fresh publish panel
      const openPublishRpc = (calls['rpc:hub.openPublishPanel'] as Array<(params?: any, ctx?: any) => Promise<any>>)[0]!
      const res = await openPublishRpc()

      expect(res.ok).toBe(true)
      const content = res.content as any[]
      const packDetailsCard = content.find((c) => c.title?.en?.includes('Pack Details'))
      expect(packDetailsCard).toBeDefined()
      const nameInput = packDetailsCard.children.find((c: any) => c.id === 'pack-display-name')
      expect(nameInput.defaultValue).toBe('')
      const descInput = packDetailsCard.children.find((c: any) => c.id === 'pack-description')
      expect(descInput.defaultValue).toBe('')
    })

    it('always resets previous state when opening publish panel via initPanel', async () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const detailsRpc = (calls['rpc:hub.onDetailsChange'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await detailsRpc({ field: 'displayName', value: 'Old Pack Name' })
      await detailsRpc({ field: 'description', value: 'Old Pack Description' })

      const toggleRpc = (calls['rpc:hub.toggleComponent'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await toggleRpc({ type: 'workflow', id: 'old-wf', value: true })

      // Calling initPanel for the publish panel without keepEditState must reset all selections and inputs
      const initPanelRpc = (calls['rpc:initPanel'] as Array<(params?: any, ctx?: any) => Promise<any>>)[0]!
      const res = await initPanelRpc({ panelId: 'community-hub-publish-panel' })

      expect(res.ok).toBe(true)
      const content = res.content as any[]
      const packDetailsCard = content.find((c) => c.title?.en?.includes('Pack Details'))
      const nameInput = packDetailsCard.children.find((c: any) => c.id === 'pack-display-name')
      expect(nameInput.defaultValue).toBe('')
      const descInput = packDetailsCard.children.find((c: any) => c.id === 'pack-description')
      expect(descInput.defaultValue).toBe('')
    })

    it('handles pack editing flow and pre-filling with version bump via hub.editPack', async () => {
      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      mockContext.storage.get = (key: string) => {
        if (key === 'github_username') return 'JamesDAdams'
        if (key === 'github_token') return 'ghp_token_123'
        return undefined
      }

      register(registry as never)
      finishRegistration()

      const editRpc = (calls['rpc:hub.editPack'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!

      // Mock inspectPack result by passing raw json
      const mockPackManifest = {
        schemaVersion: 1,
        name: 'jamesdadams-my-pack',
        version: '1.2.0',
        displayName: 'My Pack',
        description: 'Pack description',
        author: 'JamesDAdams',
        contents: {
          workflows: [{ id: 'wf1', name: 'WF 1', description: '', entryStep: 's1', steps: [] }],
          mcpServers: {
            testMcp: {
              transport: 'stdio',
              command: 'node',
              args: ['index.js'],
              env: { API_KEY: '${API_KEY}' },
            },
          },
        },
      }

      const res = await editRpc({
        packName: 'jamesdadams-my-pack',
        downloadUrl: JSON.stringify(mockPackManifest),
      })

      expect(res.ok).toBe(true)
      expect(res.version).toBe('1.2.1') // Auto-incremented patch version!
      const content = res.content as any[]
      const packDetailsCard = content.find((c) => c.title?.en?.includes('Pack Details'))
      expect(packDetailsCard).toBeDefined()
      const nameInput = packDetailsCard.children.find((c: any) => c.id === 'pack-display-name')
      expect(nameInput.defaultValue).toBe('My Pack')
      const descInput = packDetailsCard.children.find((c: any) => c.id === 'pack-description')
      expect(descInput.defaultValue).toBe('Pack description')
    })
  })

  // ==========================================================================
  // Criteria 5, 7, 8, 9, 10, 12, 13, 16, 18: Plugin Registration & Safe Context Execution
  // ==========================================================================
  describe('Plugin Extension Points & Safe Context Execution', () => {
    it('registers settings, settingsTab, tools, UI actions, UI panels, and RPC handlers', () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      // Settings & Settings Tab
      expect(calls.settings).toHaveLength(1)
      expect(calls.settingsTab).toHaveLength(1)
      expect((calls.settingsTab[0] as { id: string }).id).toBe('community-hub-tab')

      // Tools: hub_search, hub_install, hub_export
      expect(calls.tool).toHaveLength(3)
      const toolNames = (calls.tool as Array<{ name: string }>).map((t) => t.name)
      expect(toolNames).toContain('hub_search')
      expect(toolNames).toContain('hub_install')
      expect(toolNames).toContain('hub_export')

      // UI: Action, Marketplace Panel, Publish Panel
      expect(calls.uiAction).toHaveLength(1)
      expect(calls.uiPanel).toHaveLength(2)
      const panelIds = (calls.uiPanel as Array<{ id: string }>).map((p) => p.id)
      expect(panelIds).toContain('community-hub-panel')
      expect(panelIds).toContain('community-hub-publish-panel')

      // No command: the plugin must not inject anything into the user's commands list.
      expect(calls.command).toBeUndefined()

      // RPC methods
      expect(calls['rpc:hub.fetchRegistry']).toHaveLength(1)
      expect(calls['rpc:hub.inspectPack']).toHaveLength(1)
      expect(calls['rpc:hub.installPack']).toHaveLength(1)
      expect(calls['rpc:hub.exportPack']).toHaveLength(1)
      expect(calls['rpc:hub.search']).toHaveLength(1)
      expect(calls['rpc:hub.searchUi']).toHaveLength(1)
      expect(calls['rpc:hub.listLocalItems']).toHaveLength(1)
      expect(calls['rpc:hub.openPublishPanel']).toHaveLength(1)
      expect(calls['rpc:hub.previewPack']).toHaveLength(1)
      expect(calls['rpc:hub.publishPackPr']).toHaveLength(1)
      expect(calls['rpc:hub.openPanel']).toHaveLength(1)
    })

    it('preserves original pack slug when editing pack even if displayName is changed', async () => {
      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      mockContext.storage.get = (key: string) => {
        if (key === 'github_username') return 'JamesDAdams'
        if (key === 'github_token') return 'ghp_token_123'
        return undefined
      }

      register(registry as never)
      finishRegistration()

      const editRpc = (calls['rpc:hub.editPack'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const mockPackManifest = {
        schemaVersion: 1,
        name: 'jamesdadams-my-original-pack',
        version: '1.0.0',
        displayName: 'Original Display Name',
        description: 'Original description',
        author: 'JamesDAdams',
        contents: {
          workflows: [{ id: 'wf1', name: 'WF 1', description: '', entryStep: 's1', steps: [] }],
        },
      }

      await editRpc({
        packName: 'jamesdadams-my-original-pack',
        downloadUrl: JSON.stringify(mockPackManifest),
      })

      // Change the display name
      const detailsRpc = (calls['rpc:hub.onDetailsChange'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      await detailsRpc({ field: 'displayName', value: 'Completely Changed Display Name' })

      // Preview the edited pack
      const previewRpc = (calls['rpc:hub.previewPack'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const previewRes = await previewRpc({})

      // The slug/name must still be the original pack slug to prevent creating duplicate packs!
      expect(previewRes.name).toBe('jamesdadams-my-original-pack')
      expect(previewRes.displayName).toBe('Completely Changed Display Name')
      expect(previewRes.version).toBe('1.0.1')
    })
  })

  // ==========================================================================
  // C3 & C4: Settings (read-only official registry) and multi-registry fetch
  // ==========================================================================
  describe('Multi-registry: settings, URL resolution, merge and failures', () => {
    const PRIVATE_REGISTRY = 'https://private.example/index.json'

    interface RpcResult {
      content?: unknown
      count?: number
      invalidate?: string[]
      ok?: boolean
      packs?: Array<Record<string, unknown>>
      registries?: string[]
      scope?: string
      text?: { en: string; fr: string }
      tone?: string
    }
    type RpcHandler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<RpcResult>

    const rpc = (calls: Record<string, unknown[]>, method: string): RpcHandler =>
      (calls[`rpc:${method}`] as RpcHandler[])[0]!

    const buildIndexPayload = (packs: Array<{ name: string; version?: string }>) => ({
      version: 1,
      name: 'Registry',
      updatedAt: new Date().toISOString(),
      packs: packs.map((p) => ({
        name: p.name,
        version: p.version ?? '1.0.0',
        displayName: p.name,
        description: '',
        author: 'JamesDAdams',
        tags: ['community-pack'],
        downloadUrl: `https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/packs/${p.name}.json`,
      })),
    })

    const jsonResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })

    const failResponse = () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
      text: async () => '',
    })

    it('declares a read-only official registry and one registries list, without a default scope', () => {
      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const schema = (calls['settings'] as Array<{ fields: Array<Record<string, unknown>> }>)[0]!
      const keys = schema.fields.map((field) => field['key'])
      expect(keys).toEqual([
        'officialRegistryUrl',
        'officialRegistryToken',
        'officialRegistryAccount',
        'registries',
      ])
      expect(keys).not.toContain('defaultScope')
      expect(keys).not.toContain('registryUrl')
      // The two legacy token fields and the extra-registries textarea are gone.
      expect(keys).not.toContain('githubToken')
      expect(keys).not.toContain('gitlabToken')
      expect(keys).not.toContain('extraRegistries')

      const official = schema.fields.find((field) => field['key'] === 'officialRegistryUrl')!
      expect(official['readOnly']).toBe(true)
      expect(official['default']).toBe(DEFAULT_REGISTRY_URL)

      // The official registry has its own token input, linked to GitHub.
      const officialToken = schema.fields.find((field) => field['key'] === 'officialRegistryToken')!
      expect(officialToken['type']).toBe('password')
      expect(officialToken['secret']).toBe(true)
      expect(officialToken['scope']).toBe('global')
      expect((officialToken['label'] as { en: string }).en).toBe('Official Registry Token')
      expect((officialToken['label'] as { fr: string }).fr).toBe('Jeton du registre officiel')
      expect((officialToken['description'] as { en: string }).en).toContain('rate limits')
      expect((officialToken['description'] as { fr: string }).fr).toContain('registre officiel')
      expect(officialToken['linkButton']).toEqual({
        label: { en: 'Generate a token', fr: 'Générer un jeton' },
        href: 'https://github.com/settings/tokens/new',
      })

      const registries = schema.fields.find((field) => field['key'] === 'registries')!
      expect(registries['type']).toBe('list')
      expect(registries['default']).toBe('[]')
      expect(registries['scope']).toBe('global')
      expect((registries['addLabel'] as { en: string }).en).toBe('Add registry')
      expect((registries['removeLabel'] as { fr: string }).fr).toBe('Supprimer le registre')
      expect((registries['description'] as { en: string }).en).toContain('registry URL')
      expect((registries['description'] as { fr: string }).fr).toContain('URL du registre')

      // One row per registry: source, URL, token — in that order.
      const itemFields = registries['itemFields'] as Array<Record<string, unknown>>
      expect(itemFields.map((field) => field['key'])).toEqual(['source', 'url', 'token'])

      const source = itemFields[0]!
      expect(source['type']).toBe('select')
      expect(source['default']).toBe('github')
      expect((source['options'] as Array<{ value: string }>).map((option) => option.value)).toEqual([
        'github',
        'gitlab',
      ])

      expect(itemFields[1]!['type']).toBe('text')

      const token = itemFields[2]!
      expect(token['type']).toBe('password')
      expect(token['secret']).toBe(true)
      expect((token['label'] as { en: string }).en).toBe('Personal Access Token')
      expect((token['label'] as { fr: string }).fr).toBe('Jeton d’accès personnel')

      // The token input links to the provider's token page: static for GitHub,
      // derived from the registry origin for a (possibly self-hosted) GitLab.
      const linkButton = token['linkButton'] as {
        href: string
        hrefByField: string
        hrefByValue: Record<string, string>
        label: { en: string; fr: string }
      }
      expect(linkButton.hrefByField).toBe('source')
      expect(linkButton.hrefByValue['github']).toBe('https://github.com/settings/tokens/new')
      expect(linkButton.hrefByValue['gitlab']).toBe('{{url.origin}}/-/user_settings/personal_access_tokens')
      expect(linkButton.href).toBe('https://github.com/settings/tokens/new')
      expect(linkButton.label.en).toBe('Generate a token')
      expect(linkButton.label.fr).toBe('Générer un jeton')

      // Earlier versions kept the token in the plugin storage: the field is
      // backed by that same row, so an existing token surfaces as the mask.
      expect(officialToken['storageKey']).toBe('github_token')

      // The token is verified and the account it belongs to is displayed.
      const account = schema.fields.find((field) => field['key'] === 'officialRegistryAccount')!
      expect(account['type']).toBe('status')
      expect(account['rpcMethod']).toBe('hub.accountStatus')
      expect(account['scope']).toBe('global')
      expect((account['label'] as { en: string }).en).toBe('GitHub account')
      expect((account['label'] as { fr: string }).fr).toBe('Compte GitHub')
    })

    it('hub.accountStatus reports the verified GitHub account of the token', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () => jsonResponse({ login: 'JamesDAdams' }))
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { officialRegistryToken: 'ghp_official_token' },
      })
      register(registry as never)
      finishRegistration()

      const status = await rpc(calls, 'hub.accountStatus')({})

      expect(status).toEqual({
        text: { en: 'Signed in as @JamesDAdams', fr: 'Connecté en tant que @JamesDAdams' },
        tone: 'success',
      })
      expect(mockContext.storage.set).toHaveBeenCalledWith('github_username', 'JamesDAdams')
    })

    it('hub.accountStatus reports a rejected token', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () => failResponse())
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { officialRegistryToken: 'ghp_bad_token' },
      })
      register(registry as never)
      finishRegistration()

      const status = await rpc(calls, 'hub.accountStatus')({})

      expect(status?.['tone']).toBe('danger')
      expect(status?.['text']).toMatchObject({ en: expect.stringContaining('Token rejected by GitHub') })
      expect(status?.['text']).toMatchObject({ fr: expect.stringContaining('Jeton refusé par GitHub') })
      expect(mockContext.storage.set).not.toHaveBeenCalled()
    })

    it('hub.accountStatus stays neutral without a token and never calls GitHub', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () => jsonResponse(buildIndexPayload([])))
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const status = await rpc(calls, 'hub.accountStatus')({})

      expect(status).toEqual({
        text: { en: 'No token configured', fr: 'Aucun jeton configuré' },
        tone: 'neutral',
      })
      const urls = fetchSpy.mock.calls.map((call) => String(call[0]))
      expect(urls.some((url) => url.includes('api.github.com/user'))).toBe(false)
    })

    it('resolveRegistryUrls keeps the official registry first, dedupes and drops invalid entries', () => {
      const resolved = resolveRegistryUrls(
        'https://official.example/index.json',
        'https://private.example/a.json\n\n  https://private.example/a.json \nnot-a-url\nftp://nope\nhttps://official.example/index.json\nhttps://second.example/b.json',
      )
      expect(resolved).toEqual([
        'https://official.example/index.json',
        'https://private.example/a.json',
        'https://second.example/b.json',
      ])
      expect(resolveRegistryUrls('https://official.example/index.json', '')).toEqual([
        'https://official.example/index.json',
      ])
    })

    it('registryLabel names the GitHub repository or the host', () => {
      expect(registryLabel('https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json')).toBe(
        'JamesDAdams/openfox-community',
      )
      expect(registryLabel('https://private.example/index.json')).toBe('private.example')
    })

    it('fetchRegistries merges every registry in order, first registry wins duplicates', async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        const target = String(url)
        if (target.includes('private.example')) {
          return jsonResponse(buildIndexPayload([{ name: 'alpha' }, { name: 'private-pack' }]))
        }
        return jsonResponse(buildIndexPayload([{ name: 'alpha' }, { name: 'official-pack' }]))
      })

      const { index, registries, failures } = await fetchRegistries([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY], {
        fetchFn: fetchSpy as never,
      })

      expect(registries).toEqual([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY])
      expect(failures).toEqual([])
      expect(index.packs.map((p) => p.name)).toEqual(['alpha', 'official-pack', 'private-pack'])
      expect(index.packs.find((p) => p.name === 'alpha')?.registryLabel).toBe('JamesDAdams/openfox-community')
      expect(index.packs.find((p) => p.name === 'private-pack')?.registryLabel).toBe('private.example')
    })

    it('fetchRegistries keeps reachable registries and reports the failing one', async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('private.example')) return failResponse()
        return jsonResponse(buildIndexPayload([{ name: 'alpha' }]))
      })

      const { index, failures } = await fetchRegistries([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY], {
        fetchFn: fetchSpy as never,
      })

      expect(index.packs.map((p) => p.name)).toEqual(['alpha'])
      expect(failures).toHaveLength(1)
      expect(failures[0]?.registryUrl).toBe(PRIVATE_REGISTRY)
    })

    it('fetchRegistries throws only when every registry fails', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () => failResponse())
      await expect(
        fetchRegistries([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY], { fetchFn: fetchSpy as never }),
      ).rejects.toThrow(/All registries failed/)
    })

    it('hub.fetchRegistry fetches every configured registry and shows the origin badge', async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('private.example')) {
          return jsonResponse(buildIndexPayload([{ name: 'alpha' }, { name: 'private-pack' }]))
        }
        return jsonResponse(buildIndexPayload([{ name: 'alpha' }, { name: 'official-pack' }]))
      })
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { extraRegistries: PRIVATE_REGISTRY },
      })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.fetchRegistry')({ forceRefresh: true })

      expect(res.packs?.map((p) => p['name'])).toEqual(['alpha', 'official-pack', 'private-pack'])
      expect(res.registries).toEqual([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY])
      expect(getLastRegistryUrls()).toEqual([DEFAULT_REGISTRY_URL, PRIVATE_REGISTRY])

      const serialized = JSON.stringify(res.content)
      expect(serialized).toContain('2 registries')
      expect(serialized).toContain('Registry: private.example')
      expect(serialized).toContain('Private & additional registries')
      expect(serialized).toContain('Registres privés & supplémentaires')
    })

    it('surfaces a warning and keeps the other packs when one registry is unreachable', async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('private.example')) return failResponse()
        return jsonResponse(buildIndexPayload([{ name: 'alpha' }]))
      })
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, mockContext, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { extraRegistries: PRIVATE_REGISTRY },
      })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.fetchRegistry')({ forceRefresh: true })

      expect(res.packs?.map((p) => p['name'])).toEqual(['alpha'])
      expect(getRegistryWarnings()).toHaveLength(1)

      const serialized = JSON.stringify(res.content)
      expect(serialized).toContain('Registries unavailable')
      expect(serialized).toContain('private.example')
      expect(serialized).not.toContain('Refresh failed')

      // No error notification for a partial failure, the reachable registry still renders.
      const notifyCalls = mockContext.notify.mock.calls as Array<[{ level?: string }]>
      expect(notifyCalls.every((call) => call[0]?.level !== 'error')).toBe(true)
    })

    it('installs into the project scope when no scope is given', async () => {
      const packManifest = {
        schemaVersion: 1,
        name: 'alpha',
        version: '1.0.0',
        contents: { skills: [{ id: 'sk1', name: 'SK1', description: '', prompt: 'Do it' }] },
      }
      const fetchSpy = vi.fn().mockImplementation(async (url: string) =>
        String(url).includes('/packs/') ? jsonResponse(packManifest) : jsonResponse(buildIndexPayload([{ name: 'alpha' }])),
      )
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.installPack')(
        { source: 'https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/packs/alpha.json' },
        { workdir: tempWorkdir },
      )

      expect(res.scope).toBe('project')
      const installed = await readFile(join(tempWorkdir, '.openfox', 'skills', 'sk1', 'SKILL.md'), 'utf8')
      expect(installed).toContain('Do it')
      expect(res.invalidate).toEqual(['skills'])
    })

    it('reports every item kind it wrote so the client can refresh without a restart', async () => {
      const packManifest = {
        schemaVersion: 1,
        name: 'full',
        version: '1.0.0',
        contents: {
          workflows: [
            {
              id: 'wf1',
              name: 'WF1',
              description: '',
              entryStep: 'start',
              steps: [{ id: 'start', name: 'Start', type: 'agent', agentMode: 'ag1' }],
            },
          ],
          agents: [{ id: 'ag1', name: 'AG1', description: '', prompt: 'Do it' }],
          skills: [{ id: 'sk1', name: 'SK1', description: '', prompt: 'Do it' }],
          commands: [{ id: 'cmd1', name: 'CMD1', prompt: '/run-workflow wf1' }],
          mcpServers: { srv1: { transport: 'stdio', command: 'npx' } },
        },
      }
      const fetchSpy = vi.fn().mockImplementation(async (url: string) =>
        String(url).includes('/packs/') ? jsonResponse(packManifest) : jsonResponse(buildIndexPayload([{ name: 'full' }])),
      )
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({ configDir: tempConfigDir })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.installPack')(
        { source: 'https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/packs/full.json' },
        { workdir: tempWorkdir },
      )

      expect(res.invalidate).toEqual(['workflows', 'agents', 'skills', 'commands', 'mcpServers'])
    })
  })

  describe('Multi-Registry Selection & Settings Token Flow', () => {
    it('Criterion 1: parses GitHub and GitLab registry configurations with custom tokens', async () => {
      const { parseRegistryConfigs, resolveRegistryConfigs, detectRegistryType } = await import('./registry.js')

      expect(detectRegistryType('https://gitlab.com/group/repo/-/raw/main/index.json')).toBe('gitlab')
      expect(detectRegistryType('https://raw.githubusercontent.com/owner/repo/main/index.json')).toBe('github')

      const configsFromLines = parseRegistryConfigs(
        'github https://raw.githubusercontent.com/custom/gh-reg/main/index.json ghp_gh_token\n' +
        'gitlab https://gitlab.com/custom/gl-reg/-/raw/main/index.json glpat_gl_token\n' +
        'https://raw.githubusercontent.com/fallback/reg/main/index.json',
        { githubToken: 'ghp_default', gitlabToken: 'glpat_default' },
      )

      expect(configsFromLines).toHaveLength(4) // 1 official + 3 extra
      expect(configsFromLines[0]?.type).toBe('github')
      expect(configsFromLines[0]?.token).toBe('ghp_default')

      expect(configsFromLines[1]?.type).toBe('github')
      expect(configsFromLines[1]?.token).toBe('ghp_gh_token')

      expect(configsFromLines[2]?.type).toBe('gitlab')
      expect(configsFromLines[2]?.token).toBe('glpat_gl_token')

      expect(configsFromLines[3]?.type).toBe('github')
      expect(configsFromLines[3]?.token).toBe('ghp_default')

      // Test JSON array configuration
      const configsFromJson = parseRegistryConfigs(
        JSON.stringify([
          { type: 'gitlab', url: 'https://gitlab.example.com/index.json', token: 'glpat_json' },
          { type: 'github', url: 'https://raw.githubusercontent.com/json/reg/main/index.json' },
        ]),
        { githubToken: 'ghp_default', gitlabToken: 'glpat_default' },
      )
      expect(configsFromJson).toHaveLength(3)
      expect(configsFromJson[1]?.type).toBe('gitlab')
      expect(configsFromJson[1]?.token).toBe('glpat_json')
      expect(configsFromJson[2]?.token).toBe('ghp_default')

      const resolved = resolveRegistryConfigs({
        githubToken: 'ghp_resolved',
        gitlabToken: 'glpat_resolved',
        extraRegistries: 'https://raw.githubusercontent.com/extra/reg/main/index.json',
      })
      expect(resolved).toHaveLength(2)
      expect(resolved[0]?.token).toBe('ghp_resolved')
      expect(resolved[1]?.token).toBe('ghp_resolved')
    })

    it('Criterion 2: removes Personal Access Token input card from Share & Publish panel', async () => {
      const { buildPublishPanelContent } = await import('./ui.js')
      const panel = buildPublishPanelContent(
        { workflows: [], agents: [], subAgents: [], skills: [], commands: [], mcpServers: [] },
        '',
        'alice',
        {},
        {},
        undefined,
        'My Pack',
        'Description',
      )

      const serialized = JSON.stringify(panel)
      expect(serialized).not.toContain('github-token')
      expect(serialized).not.toContain('1. GitHub Authentication & Verification')
      expect(serialized).not.toContain('Generate Token on GitHub')
      expect(serialized).toContain('1. Pack Details')
      expect(serialized).toContain('2. Select Components to Include')
    })

    it('Criterion 3: disables Share a Pack button with explanation when no access token is configured', async () => {
      const { buildMarketplaceContent } = await import('./ui.js')

      // Without access token
      const noTokenContent = buildMarketplaceContent([], '', '', {}, { hasAccessToken: false })
      const noTokenSerialized = JSON.stringify(noTokenContent)

      expect(noTokenSerialized).toContain('Access Token Required to Publish')
      expect(noTokenSerialized).toContain('Personal Access Token in Settings')

      const headerStack = noTokenContent.find((node) => node.type === 'stack')
      expect(headerStack).toBeDefined()
      if (headerStack && headerStack.type === 'stack') {
        const rightStack = headerStack.children[1]
        if (rightStack && rightStack.type === 'stack') {
          const shareBtn = rightStack.children.find(
            (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en.includes('Share a Pack'),
          )
          expect(shareBtn).toBeDefined()
          if (shareBtn && shareBtn.type === 'button') {
            expect(shareBtn.disabled).toBe(true)
            expect((shareBtn.title as { en: string }).en).toContain('Configure an Access Token')
          }
        }
      }

      // With access token
      const tokenContent = buildMarketplaceContent([], '', '', {}, { hasAccessToken: true })
      const tokenSerialized = JSON.stringify(tokenContent)
      expect(tokenSerialized).not.toContain('Access Token Required to Publish')

      const tokenHeaderStack = tokenContent.find((node) => node.type === 'stack')
      if (tokenHeaderStack && tokenHeaderStack.type === 'stack') {
        const rightStack = tokenHeaderStack.children[1]
        if (rightStack && rightStack.type === 'stack') {
          const shareBtn = rightStack.children.find(
            (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en.includes('Share a Pack'),
          )
          expect(shareBtn).toBeDefined()
          if (shareBtn && shareBtn.type === 'button') {
            expect(shareBtn.disabled).toBe(false)
          }
        }
      }
    })

    it('Criterion 4: disables Edit button on pack cards when no access token is configured', async () => {
      const { buildPackCardNode } = await import('./ui.js')
      const pack: RegistryIndexEntry = {
        name: 'alice-cool-pack',
        version: '1.0.0',
        displayName: 'Cool Pack',
        description: 'Test pack',
        author: 'alice',
        downloadUrl: 'https://raw.githubusercontent.com/alice/packs/main/cool.json',
      }

      // No token configured: Edit button must be disabled even for the author
      const cardNoToken = buildPackCardNode(pack, 'alice', { hasAccessToken: false })
      expect(cardNoToken.type).toBe('card')
      if (cardNoToken.type === 'card') {
        const footerNoToken = cardNoToken.children.find(
          (node) => node.type === 'stack' && node.direction === 'row' && node.children.some((c) => c.type === 'button' && typeof c.label === 'object' && c.label.en === 'Edit'),
        )
        expect(footerNoToken).toBeDefined()
        if (footerNoToken && footerNoToken.type === 'stack') {
          const editBtn = footerNoToken.children.find(
            (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en === 'Edit',
          )
          expect(editBtn).toBeDefined()
          if (editBtn && editBtn.type === 'button') {
            expect(editBtn.disabled).toBe(true)
            expect((editBtn.title as { en: string }).en).toContain('Configure an Access Token in Settings')
          }
        }
      }

      // Token configured and isAuthor: Edit button enabled
      const cardWithToken = buildPackCardNode(pack, 'alice', { hasAccessToken: true })
      expect(cardWithToken.type).toBe('card')
      if (cardWithToken.type === 'card') {
        const footerWithToken = cardWithToken.children.find(
          (node) => node.type === 'stack' && node.direction === 'row' && node.children.some((c) => c.type === 'button' && typeof c.label === 'object' && c.label.en === 'Edit'),
        )
        expect(footerWithToken).toBeDefined()
        if (footerWithToken && footerWithToken.type === 'stack') {
          const editBtn = footerWithToken.children.find(
            (c) => c.type === 'button' && typeof c.label === 'object' && c.label.en === 'Edit',
          )
          expect(editBtn).toBeDefined()
          if (editBtn && editBtn.type === 'button') {
            expect(editBtn.disabled).toBe(false)
            expect((editBtn.title as { en: string }).en).toBe('Edit this pack')
          }
        }
      }
    })

    it('Criterion 5: renders target registry select only when multiple registries exist, and handles selection change', async () => {
      const { buildPublishPanelContent } = await import('./ui.js')

      // Single registry: no select
      const panelSingle = buildPublishPanelContent(
        { workflows: [], agents: [], subAgents: [], skills: [], commands: [], mcpServers: [] },
        'token',
        'alice',
        {},
        {},
        undefined,
        'Name',
        'Desc',
        undefined,
        '1.0.0',
        [DEFAULT_REGISTRY_URL],
      )

      const detailsCardSingle = panelSingle.find(
        (c) => c.type === 'card' && typeof c.title === 'object' && c.title.en.includes('Pack Details'),
      )
      expect(detailsCardSingle).toBeDefined()
      if (detailsCardSingle && detailsCardSingle.type === 'card') {
        const selectNode = detailsCardSingle.children.find(
          (child) => child.type === 'select' && child.id === 'pack-target-registry',
        )
        expect(selectNode).toBeUndefined()
      }

      // Multiple registries: select is rendered with options
      const multiRegistries = [
        DEFAULT_REGISTRY_URL,
        'https://raw.githubusercontent.com/my-org/my-private-registry/main/index.json',
      ]
      const panelMulti = buildPublishPanelContent(
        { workflows: [], agents: [], subAgents: [], skills: [], commands: [], mcpServers: [] },
        'token',
        'alice',
        {},
        {},
        undefined,
        'Name',
        'Desc',
        undefined,
        '1.0.0',
        multiRegistries,
        multiRegistries[1],
      )

      const detailsCardMulti = panelMulti.find(
        (c) => c.type === 'card' && typeof c.title === 'object' && c.title.en.includes('Pack Details'),
      )
      expect(detailsCardMulti).toBeDefined()
      if (detailsCardMulti && detailsCardMulti.type === 'card') {
        const selectNode = detailsCardMulti.children.find(
          (child) => child.type === 'select' && child.id === 'pack-target-registry',
        )
        expect(selectNode).toBeDefined()
        if (selectNode && selectNode.type === 'select') {
          expect(selectNode.defaultValue).toBe(multiRegistries[1])
          expect(selectNode.options).toHaveLength(2)
          expect(selectNode.options[0]?.value).toBe(DEFAULT_REGISTRY_URL)
          expect(selectNode.options[1]?.value).toBe(multiRegistries[1])
        }
      }

      // Test RPC hub.onDetailsChange updates targetRegistry
      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: {
          githubToken: 'ghp_valid_token',
          extraRegistries: 'https://raw.githubusercontent.com/my-org/my-private-registry/main/index.json',
        },
      })
      register(registry as never)
      finishRegistration()

      const onDetailsRpc = (calls['rpc:hub.onDetailsChange'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const updateRes = await onDetailsRpc(
        { field: 'targetRegistry', value: 'https://raw.githubusercontent.com/my-org/my-private-registry/main/index.json' },
        { workdir: tempWorkdir },
      )
      expect(updateRes.ok).toBe(true)
      const serialized = JSON.stringify(updateRes.content)
      expect(serialized).toContain('my-org/my-private-registry')
    })

    it('Criterion 6: publishes pack and checks status using the selected target registry repository and token', async () => {
      const privateRegistryUrl = 'https://raw.githubusercontent.com/my-org/my-private-registry/main/index.json'
      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: {
          githubToken: 'ghp_secret_token_123',
          extraRegistries: privateRegistryUrl,
        },
      })
      register(registry as never)
      finishRegistration()

      const requestedUrls: string[] = []
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url)
        requestedUrls.push(urlStr)

        if (urlStr.includes('/user')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ login: 'myuser' }),
          }
        }
        if (urlStr.includes('/git/ref/heads/main')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ object: { sha: 'sha-main-123' } }),
          }
        }
        if (urlStr.includes('/contents/')) {
          if (init?.method === 'PUT') {
            return {
              ok: true,
              status: 201,
              json: async () => ({ content: { sha: 'sha-blob-123' } }),
            }
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
          }
        }
        if (urlStr.includes('/git/refs')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ ref: 'refs/heads/new-branch' }),
          }
        }
        if (urlStr.includes('/pulls')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ html_url: 'https://github.com/my-org/my-private-registry/pull/77', number: 77 }),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        }
      })
      vi.stubGlobal('fetch', fetchMock)

      const publishPrRpc = (calls['rpc:hub.publishPackPr'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const publishRes = await publishPrRpc(
        {
          targetRegistry: privateRegistryUrl,
          displayName: 'Private Pack',
          description: 'A private pack for my org',
        },
        { workdir: tempWorkdir },
      )

      expect(publishRes.success).toBe(true)
      expect(publishRes.prNumber).toBe(77)
      expect(publishRes.status.targetRepo).toBe('my-org/my-private-registry')

      // Verify PR creation request targeted my-org/my-private-registry
      const prCall = requestedUrls.find((u) => u.includes('/repos/my-org/my-private-registry/pulls'))
      expect(prCall).toBeDefined()

      // Verify checkPrStatus targets my-org/my-private-registry
      const checkPrRpc = (calls['rpc:hub.checkPrStatus'] as Array<(params: Record<string, unknown>, ctx?: any) => Promise<any>>)[0]!
      const checkRes = await checkPrRpc({ prNumber: 77 }, { workdir: tempWorkdir })
      expect(checkRes.targetRepo).toBe('my-org/my-private-registry')
      expect(checkRes.prUrl).toContain('my-org/my-private-registry/pull/77')
    })
  })

  // ==========================================================================
  // Registries list settings: one row per registry (source + URL + token)
  // ==========================================================================
  describe('Registries list settings', () => {
    const GITHUB_REGISTRY = 'https://raw.githubusercontent.com/me/gh-registry/main/index.json'
    const GITLAB_REGISTRY = 'https://gitlab.com/me/gl-registry/-/raw/main/index.json'

    type RpcHandler = (
      params: Record<string, unknown>,
      ctx?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>

    const rpc = (calls: Record<string, unknown[]>, method: string): RpcHandler =>
      (calls[`rpc:${method}`] as RpcHandler[])[0]!

    const row = (source: string, url: string, token?: string) => ({
      source,
      url,
      ...(token ? { token } : {}),
    })

    it('parses rows into configs, one token per row, official registry first', async () => {
      const { configsFromRegistryRows, parseRegistryRows } = await import('./registry.js')

      const rows = parseRegistryRows(
        JSON.stringify([
          row('github', GITHUB_REGISTRY, 'ghp_row_token'),
          row('gitlab', GITLAB_REGISTRY, 'glpat_row_token'),
          row('github', 'not-a-url', 'ignored'),
        ]),
      )
      expect(rows).toEqual([
        { source: 'github', url: GITHUB_REGISTRY, token: 'ghp_row_token' },
        { source: 'gitlab', url: GITLAB_REGISTRY, token: 'glpat_row_token' },
      ])

      const configs = configsFromRegistryRows(rows, { officialUrl: DEFAULT_REGISTRY_URL })
      expect(configs).toEqual([
        {
          type: 'github',
          url: DEFAULT_REGISTRY_URL,
          label: 'JamesDAdams/openfox-community',
          token: 'ghp_row_token',
        },
        { type: 'github', url: GITHUB_REGISTRY, label: 'me/gh-registry', token: 'ghp_row_token' },
        { type: 'gitlab', url: GITLAB_REGISTRY, label: 'gitlab:me/gl-registry', token: 'glpat_row_token' },
      ])
    })

    it('ignores malformed list values instead of throwing', async () => {
      const { parseRegistryRows } = await import('./registry.js')
      expect(parseRegistryRows('')).toEqual([])
      expect(parseRegistryRows('{not-json')).toEqual([])
      expect(parseRegistryRows('{"a":1}')).toEqual([])
      expect(parseRegistryRows('[1,"x",null]')).toEqual([])
      expect(parseRegistryRows(undefined)).toEqual([])
    })

    it('lends the official registry the token of the first row of its own type', async () => {
      const { configsFromRegistryRows } = await import('./registry.js')

      const configs = configsFromRegistryRows(
        [
          { source: 'gitlab', url: GITLAB_REGISTRY, token: 'glpat_row_token' },
          { source: 'github', url: GITHUB_REGISTRY, token: 'ghp_row_token' },
        ],
        { officialUrl: DEFAULT_REGISTRY_URL },
      )

      expect(configs[0]).toEqual({
        type: 'github',
        url: DEFAULT_REGISTRY_URL,
        label: 'JamesDAdams/openfox-community',
        token: 'ghp_row_token',
      })
    })

    it('prefers the official registry token over the rows and the legacy token', async () => {
      const { configsFromRegistryRows } = await import('./registry.js')

      const configs = configsFromRegistryRows(
        [
          { source: 'github', url: GITHUB_REGISTRY, token: 'ghp_row_token' },
          { source: 'gitlab', url: GITLAB_REGISTRY, token: 'glpat_row_token' },
        ],
        {
          officialUrl: DEFAULT_REGISTRY_URL,
          officialToken: 'ghp_official_token',
          githubToken: 'ghp_legacy',
          gitlabToken: 'glpat_legacy',
        },
      )

      expect(configs[0]).toEqual({
        type: 'github',
        url: DEFAULT_REGISTRY_URL,
        label: 'JamesDAdams/openfox-community',
        token: 'ghp_official_token',
      })
      expect(configs[1]).toEqual({ type: 'github', url: GITHUB_REGISTRY, label: 'me/gh-registry', token: 'ghp_row_token' })
      expect(configs[2]).toEqual({
        type: 'gitlab',
        url: GITLAB_REGISTRY,
        label: 'gitlab:me/gl-registry',
        token: 'glpat_row_token',
      })
    })

    it('authenticates the official registry with its own declared token', async () => {
      const callsSeen: Array<{ url: string; headers: Record<string, string> }> = []
      const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        callsSeen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: 1, name: 'Registry', packs: [] }),
        }
      })
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { officialRegistryToken: 'ghp_official_token', registries: '[]' },
      })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.fetchRegistry')({ forceRefresh: true })

      expect(res.registries).toEqual([DEFAULT_REGISTRY_URL])
      const officialCall = callsSeen.find((call) => call.url.includes('JamesDAdams/openfox-community'))
      expect(officialCall?.headers['Authorization']).toBe('Bearer ghp_official_token')
    })

    it('falls back to the legacy tokens for rows without one, and skips the official duplicate', async () => {
      const { configsFromRegistryRows } = await import('./registry.js')

      const configs = configsFromRegistryRows(
        [
          { source: 'github', url: DEFAULT_REGISTRY_URL },
          { source: 'github', url: GITHUB_REGISTRY },
          { source: 'gitlab', url: GITLAB_REGISTRY },
        ],
        { officialUrl: DEFAULT_REGISTRY_URL, githubToken: 'ghp_legacy', gitlabToken: 'glpat_legacy' },
      )

      expect(configs).toEqual([
        {
          type: 'github',
          url: DEFAULT_REGISTRY_URL,
          label: 'JamesDAdams/openfox-community',
          token: 'ghp_legacy',
        },
        { type: 'github', url: GITHUB_REGISTRY, label: 'me/gh-registry', token: 'ghp_legacy' },
        { type: 'gitlab', url: GITLAB_REGISTRY, label: 'gitlab:me/gl-registry', token: 'glpat_legacy' },
      ])
    })

    it('authenticates each registry with its own row token', async () => {
      const callsSeen: Array<{ url: string; headers: Record<string, string> }> = []
      const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        callsSeen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: 1, name: 'Registry', packs: [] }),
        }
      })
      vi.stubGlobal('fetch', fetchSpy)

      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: {
          registries: JSON.stringify([
            row('github', GITHUB_REGISTRY, 'ghp_row_token'),
            row('gitlab', GITLAB_REGISTRY, 'glpat_row_token'),
          ]),
        },
      })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.fetchRegistry')({ forceRefresh: true })

      expect(res.registries).toEqual([DEFAULT_REGISTRY_URL, GITHUB_REGISTRY, GITLAB_REGISTRY])

      const githubCall = callsSeen.find((call) => call.url.includes('me/gh-registry'))
      expect(githubCall?.headers['Authorization']).toBe('Bearer ghp_row_token')

      const gitlabCall = callsSeen.find((call) => call.url.includes('me/gl-registry'))
      expect(gitlabCall?.headers['PRIVATE-TOKEN']).toBe('glpat_row_token')
      expect(gitlabCall?.headers['Authorization']).toBe('Bearer glpat_row_token')
    })

    it('publishes to a registry with the token of the matching row', async () => {
      const privateRegistryUrl = 'https://raw.githubusercontent.com/my-org/my-private-registry/main/index.json'
      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: {
          registries: JSON.stringify([row('github', privateRegistryUrl, 'ghp_row_token')]),
        },
      })
      register(registry as never)
      finishRegistration()

      const authorizations: string[] = []
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = String(url)
        const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization']
        if (auth) authorizations.push(auth)

        if (urlStr.includes('/user')) {
          return { ok: true, status: 200, json: async () => ({ login: 'myuser' }) }
        }
        if (urlStr.includes('/git/ref/heads/main')) {
          return { ok: true, status: 200, json: async () => ({ object: { sha: 'sha-main-123' } }) }
        }
        if (urlStr.includes('/contents/')) {
          return init?.method === 'PUT'
            ? { ok: true, status: 201, json: async () => ({ content: { sha: 'sha-blob-123' } }) }
            : { ok: false, status: 404, json: async () => ({}) }
        }
        if (urlStr.includes('/git/refs')) {
          return { ok: true, status: 201, json: async () => ({ ref: 'refs/heads/new-branch' }) }
        }
        if (urlStr.includes('/pulls')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ html_url: 'https://github.com/my-org/my-private-registry/pull/88', number: 88 }),
          }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchMock)

      const publishRes = await rpc(calls, 'hub.publishPackPr')(
        {
          targetRegistry: privateRegistryUrl,
          displayName: 'Private Pack',
          description: 'A private pack for my org',
        },
        { workdir: tempWorkdir },
      )

      expect(publishRes.success).toBe(true)
      expect(publishRes.prNumber).toBe(88)
      expect(authorizations.length).toBeGreaterThan(0)
      expect(authorizations.every((value) => value === 'Bearer ghp_row_token')).toBe(true)
    })

    it('keeps reading the legacy extraRegistries setting when the list is empty', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: 1, name: 'Registry', packs: [] }),
      }))
      vi.stubGlobal('fetch', fetchSpy)

      const privateRegistryUrl = 'https://raw.githubusercontent.com/me/legacy-registry/main/index.json'
      const { registry, calls, finishRegistration } = createMockRegistry({
        configDir: tempConfigDir,
        settings: { registries: '[]', extraRegistries: privateRegistryUrl, githubToken: 'ghp_legacy' },
      })
      register(registry as never)
      finishRegistration()

      const res = await rpc(calls, 'hub.fetchRegistry')({ forceRefresh: true })

      expect(res.registries).toEqual([DEFAULT_REGISTRY_URL, privateRegistryUrl])
      const legacyCall = (fetchSpy.mock.calls as Array<[string, RequestInit | undefined]>).find(([url]) =>
        String(url).includes('me/legacy-registry'),
      )
      expect((legacyCall?.[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_legacy')
    })
  })
})
