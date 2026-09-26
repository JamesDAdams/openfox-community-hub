import type {
  PluginRegistry,
  PluginToolContext,
} from '../../../../src/plugin/index.js'
import {
  createHubExportTool,
  createHubInstallTool,
  createHubSearchTool,
} from './tools.js'
import {
  DEFAULT_REGISTRY_URL,
  configsFromRegistryRows,
  detectRegistryType,
  fetchRegistries,
  inspectPack,
  parseRegistryConfigs,
  parseRegistryRows,
  searchPacks,
  type RegistryFailure,
} from './registry.js'
import { installPack, installedItemKinds } from './installer.js'
import { exportPack } from './bundler.js'
import {
  buildMarketplaceContent,
  buildPublishPanelContent,
  hubPublishPanel,
  hubSettingsSchema,
  hubSettingsTab,
  hubUiAction,
  hubUiPanel,
} from './ui.js'
import {
  buildCustomPack,
  checkGithubPrStatus,
  getGithubRepoFromRegistryUrl,
  getPackAuthorUsername,
  incrementPatchVersion,
  listLocalItems,
  publishPackToGitHub,
  resolveComponentDependencies,
  verifyRegistryToken,
  type PublishStatus,
} from './publisher.js'
import type { InstallScope, PackManifest, RegistryConfig, RegistryIndex, RegistryIndexEntry, RegistryRow } from './types.js'
import type { DeclarativeNode } from '../../../../src/plugin/index.js'

export * from './types.js'
export * from './schema.js'
export * from './bundler.js'
export * from './installer.js'
export * from './registry.js'
export * from './publisher.js'
export * from './tools.js'
export * from './ui.js'

let selectedComponentsMap: Record<string, boolean> = {}
let mcpCustomConfigsMap: Record<string, { args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }> = {}
let packDisplayName = ''
let packDescription = ''
let packVersion = '1.0.0'
let editingPackName = ''
let selectedTargetRegistry = DEFAULT_REGISTRY_URL
let activePublishStatus: PublishStatus | undefined = undefined
let pollingTimer: ReturnType<typeof setInterval> | undefined = undefined
let registrySnapshot: RegistryIndex | undefined = undefined
let lastRefreshedAt: string | undefined = undefined
let lastRefreshError: string | undefined = undefined
let registryWarnings: RegistryFailure[] = []
let lastRegistryUrls: string[] = [DEFAULT_REGISTRY_URL]

export function formatRegistryFailures(failures: RegistryFailure[]): string {
  return failures.map((failure) => `${failure.registryUrl} (${failure.error})`).join(' · ')
}

export function getRegistryWarnings(): RegistryFailure[] {
  return registryWarnings
}

export function getLastRegistryUrls(): string[] {
  return lastRegistryUrls
}

export function getRegistrySnapshot(): RegistryIndex | undefined {
  return registrySnapshot
}

export function getLastRefreshedAt(): string | undefined {
  return lastRefreshedAt
}

export function getSelectedTargetRegistry(): string {
  return selectedTargetRegistry
}

export function setSelectedTargetRegistry(url: string): void {
  selectedTargetRegistry = url
}

export function setRegistrySnapshot(index: RegistryIndex | undefined, refreshedAt?: string, error?: string): void {
  registrySnapshot = index
  lastRefreshedAt = refreshedAt ?? (index ? new Date().toISOString() : undefined)
  lastRefreshError = error
}

export function resetRegistrySnapshot(): void {
  registrySnapshot = undefined
  lastRefreshedAt = undefined
  lastRefreshError = undefined
  registryWarnings = []
  lastRegistryUrls = [DEFAULT_REGISTRY_URL]
}

export function formatRefreshLabel(
  refreshedAt: string | undefined,
  packCount: number,
  registryCount: number = 1,
): string {
  const time = refreshedAt
    ? new Date(refreshedAt).toTimeString().slice(0, 8)
    : '--:--:--'
  return `Last refreshed at ${time} (${packCount} pack${packCount === 1 ? '' : 's'} · ${registryCount} registr${registryCount === 1 ? 'y' : 'ies'})`
}

export function stopStatusPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = undefined
  }
}

export function resetPublishState(): void {
  selectedComponentsMap = {}
  mcpCustomConfigsMap = {}
  packDisplayName = ''
  packDescription = ''
  packVersion = '1.0.0'
  editingPackName = ''
  selectedTargetRegistry = DEFAULT_REGISTRY_URL
  activePublishStatus = undefined
  stopStatusPolling()
}

export function register(registry: PluginRegistry): void {
  // CRITICAL: Capture context and runtime at registration time
  // Do NOT access registry.context later in RPC or tool handlers as registry.context
  // is only accessible while register() runs.
  const context = registry.context
  const runtime = registry.runtime

  const getSettings = () => context.settings('global')

  // Legacy settings (no longer declared in the schema) still back an existing
  // install: they are read as fallbacks, never written.
  const getLegacyToken = (settingKey: string, storageKey: string): string => {
    const s = getSettings()
    if (typeof s[settingKey] === 'string' && s[settingKey].trim()) {
      return s[settingKey].trim()
    }
    const stored = context.storage.get(storageKey)
    return typeof stored === 'string' ? stored.trim() : ''
  }

  const getGithubToken = (): string => getLegacyToken('githubToken', 'github_token')

  const getGitlabToken = (): string => getLegacyToken('gitlabToken', 'gitlab_token')

  /** Token declared for the official registry (falls back to the legacy one). */
  const getOfficialRegistryToken = (): string => {
    const s = getSettings()
    const declared = s['officialRegistryToken']
    if (typeof declared === 'string' && declared.trim()) return declared.trim()
    return getGithubToken()
  }

  /** Configured rows, falling back to the legacy `extraRegistries` textarea. */
  const getRegistryRows = (): RegistryRow[] => {
    const s = getSettings()
    const rows = parseRegistryRows(typeof s['registries'] === 'string' ? s['registries'] : '')
    if (rows.length > 0) return rows
    const legacy = typeof s['extraRegistries'] === 'string' ? s['extraRegistries'] : ''
    return parseRegistryConfigs(legacy, {
      officialUrl: '',
      githubToken: getGithubToken(),
      gitlabToken: getGitlabToken(),
    }).map((config) => ({
      source: config.type,
      url: config.url,
      ...(config.token ? { token: config.token } : {}),
    }))
  }

  const getRegistryConfigs = (): RegistryConfig[] => {
    return configsFromRegistryRows(getRegistryRows(), {
      officialUrl: DEFAULT_REGISTRY_URL,
      officialToken: getOfficialRegistryToken(),
      githubToken: getGithubToken(),
      gitlabToken: getGitlabToken(),
    })
  }

  const getRegistryUrls = (): string[] => getRegistryConfigs().map((c) => c.url)

  const hasConfiguredToken = (): boolean => getRegistryConfigs().some((c) => Boolean(c.token))

  /** Token of the row matching the URL, else of the first row of the same type. */
  const getTokenForRegistry = (registryUrl?: string): string => {
    const targetUrl = registryUrl || selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const configs = getRegistryConfigs()
    const found = configs.find((c) => c.url.toLowerCase() === targetUrl.toLowerCase())
    if (found?.token) return found.token
    const type = found?.type ?? detectRegistryType(targetUrl)
    return configs.find((c) => c.type === type && c.token)?.token ?? ''
  }

  const getUsernameForRegistry = async (registryUrl?: string): Promise<string> => {
    const targetUrl = registryUrl || selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const token = getTokenForRegistry(targetUrl)
    if (!token) return ''
    const isGitlab = /gitlab/i.test(targetUrl)
    const storageKey = isGitlab ? 'gitlab_username' : 'github_username'
    let username = String(context.storage.get(storageKey) ?? '')
    if (!username && token) {
      const verified = await verifyRegistryToken(token, isGitlab ? 'gitlab' : 'github')
      if (verified.valid && verified.username) {
        username = verified.username
        context.storage.set(storageKey, username)
      }
    }
    return username
  }

  const getConfigDir = (): string => {
    return runtime.configDirectory
  }

  const publishMarketplace = (packs: RegistryIndexEntry[], search: string): DeclarativeNode[] => {
    const username = String(context.storage.get('github_username') ?? context.storage.get('gitlab_username') ?? '')
    const content = buildMarketplaceContent(
      packs,
      search,
      username,
      {
        refreshedAt: lastRefreshedAt,
        totalPacks: registrySnapshot?.packs.length ?? packs.length,
        error: lastRefreshError,
        ...(registryWarnings.length > 0
          ? { warning: `Registries unavailable: ${formatRegistryFailures(registryWarnings)}` }
          : {}),
        registries: lastRegistryUrls,
      },
      {
        hasAccessToken: hasConfiguredToken(),
      },
    )
    context.publish(hubUiPanel.id, 'content', content)
    context.publish(hubSettingsTab.id, 'content', content)
    return content
  }

  const loadRegistry = async (options: { forceRefresh?: boolean } = {}): Promise<RegistryIndex> => {
    const configs = getRegistryConfigs()
    const { index, registries, failures } = await fetchRegistries(configs, {
      token: getGithubToken(),
      forceRefresh: options.forceRefresh ?? true,
    })
    lastRegistryUrls = registries
    registryWarnings = failures
    setRegistrySnapshot(index, new Date().toISOString())
    return index
  }

  const refreshMarketplace = async (options: { forceRefresh?: boolean; search?: string } = {}): Promise<DeclarativeNode[]> => {
    try {
      const data = await loadRegistry({ forceRefresh: options.forceRefresh ?? true })
      context.publish(hubUiPanel.id, 'registry', data)
      return publishMarketplace(data.packs, options.search ?? '')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastRefreshError = message
      context.notify({
        title: { en: 'Registry refresh failed', fr: 'Échec du rafraîchissement du registre' },
        body: { en: message, fr: message },
        level: 'error',
      })
      return publishMarketplace(registrySnapshot?.packs ?? [], options.search ?? '')
    }
  }

  const updatePanelUi = async (workdir: string, configDir: string, previewManifest?: PackManifest) => {
    const inventory = await listLocalItems(workdir, configDir)
    const targetRegistry = selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const token = getTokenForRegistry(targetRegistry)
    const username = await getUsernameForRegistry(targetRegistry)

    const panelContent = buildPublishPanelContent(
      inventory,
      token,
      username,
      selectedComponentsMap,
      mcpCustomConfigsMap,
      previewManifest,
      packDisplayName,
      packDescription,
      activePublishStatus,
      packVersion,
      getRegistryConfigs(),
      selectedTargetRegistry,
    )
    context.publish(hubPublishPanel.id, 'content', panelContent)
    return panelContent
  }

  // 1. Settings & Settings Tab
  registry.registerSettings(hubSettingsSchema)
  registry.registerSettingsTab(hubSettingsTab)

  // 2. Tools
  registry.registerTool(createHubSearchTool(getRegistryUrls, getGithubToken))
  registry.registerTool(createHubInstallTool(getConfigDir, getRegistryUrls, getGithubToken))
  registry.registerTool(createHubExportTool(getConfigDir))

  // 3. UI Actions & Panels
  registry.registerUiAction(hubUiAction)
  registry.registerUiPanel(hubUiPanel)
  registry.registerUiPanel(hubPublishPanel)

  // Asynchronously fetch registry on startup to pre-populate panel & settings tab
  void refreshMarketplace({ forceRefresh: true }).catch(() => {
    // ignore
  })

  // 4. RPC Methods (All use captured 'context' and 'runtime')
  registry.registerRpc('hub.fetchRegistry', async (params: Record<string, unknown>) => {
    const explicitUrl = typeof params['registryUrl'] === 'string' ? params['registryUrl'].trim() : ''
    const configs = explicitUrl ? [explicitUrl] : getRegistryConfigs()
    const { index, registries, failures } = await fetchRegistries(configs)
    lastRegistryUrls = registries
    registryWarnings = failures
    setRegistrySnapshot(index, new Date().toISOString())
    const updatedContent = publishMarketplace(index.packs, '')
    context.publish(hubUiPanel.id, 'registry', index)
    return { ok: true, content: updatedContent, packs: index.packs, registry: index, registries }
  })

  // Settings → Plugins → Community Hub: verify the official registry token and
  // show the GitHub account it belongs to.
  registry.registerRpc('hub.accountStatus', async () => {
    const token = getOfficialRegistryToken()
    if (!token) {
      return {
        text: { en: 'No token configured', fr: 'Aucun jeton configuré' },
        tone: 'neutral',
      }
    }

    const verified = await verifyRegistryToken(token, 'github')
    if (!verified.valid || !verified.username) {
      const detail = verified.error ? ` (${verified.error})` : ''
      return {
        text: {
          en: `Token rejected by GitHub${detail}`,
          fr: `Jeton refusé par GitHub${detail}`,
        },
        tone: 'danger',
      }
    }

    context.storage.set('github_username', verified.username)
    return {
      text: {
        en: `Signed in as @${verified.username}`,
        fr: `Connecté en tant que @${verified.username}`,
      },
      tone: 'success',
    }
  })

  registry.registerRpc('hub.inspectPack', async (params: Record<string, unknown>) => {
    const source = params['source']
    if (!source) {
      throw new Error("Missing 'source' parameter (URL, JSON string, or object).")
    }
    return await inspectPack(source, { token: getGithubToken() })
  })

  registry.registerRpc('hub.installPack', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const pack = params['pack'] ?? params['source']
    if (!pack) {
      throw new Error("Missing 'pack' or 'source' parameter.")
    }

    let packData = pack
    if (typeof pack === 'string') {
      const inspected = await inspectPack(pack, { token: getGithubToken() })
      packData = inspected.manifest
    }

    const scope = (params['scope'] as InstallScope) ?? 'project'
    const envValues = (params['envValues'] as Record<string, string>) ?? {}
    const overwrite = params['overwrite'] !== false

    const result = await installPack(packData, {
      scope,
      workdir: toolContext?.workdir ?? process.cwd(),
      configDir: getConfigDir(),
      envValues,
      overwrite,
    })

    context.notify({
      title: {
        en: `Installed ${result.packName}`,
        fr: `${result.packName} installé`,
      },
      body: {
        en: `Pack v${result.packVersion} installed in ${result.scope} scope.`,
        fr: `Pack v${result.packVersion} installé dans le scope ${result.scope}.`,
      },
      level: 'success',
    })

    return { ...result, invalidate: installedItemKinds(result) }
  })

  registry.registerRpc('hub.exportPack', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const workflowId = String(params['workflowId'] ?? '')
    if (!workflowId) {
      throw new Error("Missing 'workflowId' parameter.")
    }

    const name = params['name'] ? String(params['name']) : undefined
    const version = params['version'] ? String(params['version']) : undefined
    const author = params['author'] ? String(params['author']) : undefined
    const description = params['description'] ? String(params['description']) : undefined

    return await exportPack({
      workflowId,
      workdir: toolContext?.workdir ?? process.cwd(),
      configDir: getConfigDir(),
      packMetadata: {
        name,
        version,
        author,
        description,
      },
    })
  })

  registry.registerRpc('hub.search', async (params: Record<string, unknown>) => {
    const query = String(params['query'] ?? '')
    const tag = params['tag'] ? String(params['tag']) : undefined
    const explicitUrl = typeof params['registryUrl'] === 'string' ? params['registryUrl'].trim() : ''
    const { index, registries, failures } = await fetchRegistries(explicitUrl ? [explicitUrl] : getRegistryConfigs(), {
      token: getGithubToken(),
    })
    lastRegistryUrls = registries
    registryWarnings = failures
    setRegistrySnapshot(index, new Date().toISOString())
    return searchPacks(index, query, { tag })
  })

  registry.registerRpc('hub.searchUi', async (params: Record<string, unknown>) => {
    const query = String(params['value'] ?? params['query'] ?? '')
    // Filter the in-memory snapshot: typing must never trigger a network round-trip.
    const reg = registrySnapshot ?? (await loadRegistry({ forceRefresh: true }))
    const filtered = searchPacks(reg, query)
    const updatedContent = publishMarketplace(filtered, query)
    return { ok: true, count: filtered.length, content: updatedContent }
  })

  registry.registerRpc('initPanel', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const panelId = String(params['panelId'] ?? '')
    if (panelId === hubPublishPanel.id) {
      if (!editingPackName) {
        resetPublishState()
      }
    }
    const workdir = toolContext?.workdir ?? process.cwd()

    if (panelId === hubUiPanel.id || panelId === hubSettingsTab.id || panelId === 'community-hub-tab' || !panelId) {
      const mContent = await refreshMarketplace({ forceRefresh: true })
      return { ok: true, content: mContent }
    }

    const panelContent = await updatePanelUi(workdir, getConfigDir())
    return { ok: true, content: panelContent }
  })

  registry.registerRpc('hub.listLocalItems', async (_params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const workdir = toolContext?.workdir ?? process.cwd()
    const panelContent = await updatePanelUi(workdir, getConfigDir())
    const inventory = await listLocalItems(workdir, getConfigDir())
    return { inventory, content: panelContent }
  })

  registry.registerRpc('hub.openPublishPanel', async (_params: Record<string, unknown>, toolContext: PluginToolContext) => {
    resetPublishState()
    const workdir = toolContext?.workdir ?? process.cwd()

    if (!hasConfiguredToken()) {
      context.notify({
        title: { en: 'Access Token Required', fr: 'Jeton d’accès Requis' },
        body: {
          en: 'Configure a GitHub or GitLab Access Token in Settings → Plugins → Community Hub to publish packs.',
          fr: 'Configurez un Jeton d’accès GitHub ou GitLab dans Réglages → Plugins → Hub Communautaire pour publier des packs.',
        },
        level: 'warning',
      })
    }

    const panelContent = await updatePanelUi(workdir, getConfigDir())
    context.publish(hubPublishPanel.id, 'open', true)
    return { ok: true, openPanel: hubPublishPanel.id, content: panelContent }
  })

  registry.registerRpc('hub.editPack', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const packName = String(params['packName'] ?? '')
    const downloadUrl = String(params['downloadUrl'] ?? '')

    if (!packName && !downloadUrl) {
      throw new Error("Missing 'packName' or 'downloadUrl' parameter.")
    }

    if (!hasConfiguredToken()) {
      context.notify({
        title: { en: 'Access Token Required', fr: 'Jeton d’accès Requis' },
        body: {
          en: 'Configure an Access Token in Settings → Plugins → Community Hub to edit packs.',
          fr: 'Configurez un Jeton d’accès dans Réglages → Plugins → Hub Communautaire pour modifier des packs.',
        },
        level: 'error',
      })
      throw new Error('Configure an Access Token in Settings to edit packs.')
    }

    const targetRegistry = selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const token = getTokenForRegistry(targetRegistry)
    const username = await getUsernameForRegistry(targetRegistry)

    let manifest: PackManifest
    if (downloadUrl) {
      const inspected = await inspectPack(downloadUrl, { token })
      manifest = inspected.manifest
    } else {
      const { index } = await fetchRegistries(getRegistryConfigs(), { token })
      const match = index.packs.find((p) => p.name.toLowerCase() === packName.toLowerCase())
      if (!match) throw new Error(`Pack '${packName}' not found in registry.`)
      const inspected = await inspectPack(match.downloadUrl, { token })
      manifest = inspected.manifest
    }

    const authorUsername = getPackAuthorUsername(manifest)
    if (
      !username ||
      (authorUsername &&
        authorUsername.toLowerCase() !== username.toLowerCase() &&
        !manifest.name.toLowerCase().startsWith(`${username.toLowerCase()}-`))
    ) {
      context.notify({
        title: { en: 'Unauthorized', fr: 'Non autorisé' },
        body: {
          en: `You cannot edit this pack because you are not the author (author: @${authorUsername || 'unknown'}).`,
          fr: `Vous ne pouvez pas modifier ce paquet, parce que vous n'êtes pas l'auteur (auteur : @${authorUsername || 'inconnu'}).`,
        },
        level: 'error',
      })
      throw new Error(`You cannot edit this pack because you are not the author.`)
    }

    // Reset and prepare editing state
    resetPublishState()
    editingPackName = manifest.name
    packVersion = incrementPatchVersion(manifest.version || '1.0.0')
    packDisplayName =
      typeof manifest.displayName === 'string'
        ? manifest.displayName
        : manifest.displayName?.en ?? manifest.name
    packDescription =
      typeof manifest.description === 'string'
        ? manifest.description
        : manifest.description?.en ?? ''

    // Pre-select components included in this pack
    for (const w of manifest.contents.workflows ?? []) {
      selectedComponentsMap[`wf:${w.id}`] = true
    }
    for (const a of manifest.contents.agents ?? []) {
      selectedComponentsMap[`ag:${a.id}`] = true
    }
    for (const sa of manifest.contents.subAgents ?? []) {
      selectedComponentsMap[`sa:${sa.id}`] = true
    }
    for (const sk of manifest.contents.skills ?? []) {
      selectedComponentsMap[`sk:${sk.id}`] = true
    }
    for (const cmd of manifest.contents.commands ?? []) {
      selectedComponentsMap[`cmd:${cmd.id}`] = true
    }
    for (const [srvName, conf] of Object.entries(manifest.contents.mcpServers ?? {})) {
      selectedComponentsMap[`mcp:${srvName}`] = true
      mcpCustomConfigsMap[srvName] = {
        args: conf.args,
        url: conf.url,
        headers: conf.headers,
        env: conf.env,
      }
    }

    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()

    const panelContent = await updatePanelUi(workdir, configDir)
    context.publish(hubPublishPanel.id, 'open', true)

    context.notify({
      title: { en: 'Pack Loaded for Editing', fr: 'Pack Chargé pour Modification' },
      body: {
        en: `Editing '${manifest.name}' with auto-incremented version v${packVersion}.`,
        fr: `Modification de '${manifest.name}' avec la version incrémentée v${packVersion}.`,
      },
      level: 'info',
    })

    return { ok: true, version: packVersion, openPanel: hubPublishPanel.id, content: panelContent }
  })

  registry.registerRpc('hub.onDetailsChange', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const field = String(params['field'] ?? '')
    const val = String(params['value'] ?? '')
    if (field === 'displayName') packDisplayName = val
    if (field === 'description') packDescription = val
    if (field === 'targetRegistry') selectedTargetRegistry = val

    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()
    const panelContent = await updatePanelUi(workdir, configDir)
    return { ok: true, content: panelContent }
  })

  registry.registerRpc('hub.toggleComponent', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const type = String(params['type'] ?? '')
    const id = String(params['id'] ?? '')
    const prefix = type === 'workflow' ? 'wf' : type === 'agent' ? 'ag' : type === 'subagent' ? 'sa' : type === 'skill' ? 'sk' : type === 'command' ? 'cmd' : 'mcp'
    const key = `${prefix}:${id}`

    // If client supplied explicit value/checked use it, otherwise toggle current state
    const isChecked = params['value'] !== undefined
      ? (params['value'] === 'true' || params['value'] === true)
      : !selectedComponentsMap[key]

    selectedComponentsMap[key] = isChecked

    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()

    // Automatic dependency resolution when a component is checked
    if (isChecked) {
      try {
        const deps = await resolveComponentDependencies(type, id, workdir, configDir)
        for (const dep of deps) {
          const depPrefix = dep.type === 'workflow' ? 'wf' : dep.type === 'agent' ? 'ag' : dep.type === 'subagent' ? 'sa' : dep.type === 'skill' ? 'sk' : dep.type === 'command' ? 'cmd' : 'mcp'
          const depKey = `${depPrefix}:${dep.id}`
          selectedComponentsMap[depKey] = true
        }
      } catch {
        // ignore resolution failure
      }
    }

    const panelContent = await updatePanelUi(workdir, configDir)
    return { selected: isChecked, content: panelContent }
  })

  registry.registerRpc('hub.onMcpConfigChange', async (params: Record<string, unknown>) => {
    const mcpId = String(params['mcpId'] ?? '')
    const field = String(params['field'] ?? '')
    const rawVal = String(params['value'] ?? '')

    const currentConf = mcpCustomConfigsMap[mcpId] ?? {}
    if (field === 'args') {
      try {
        if (rawVal.trim().startsWith('[') && rawVal.trim().endsWith(']')) {
          currentConf.args = JSON.parse(rawVal) as string[]
        } else {
          currentConf.args = rawVal.split('\n').map((s) => s.trim()).filter(Boolean)
        }
      } catch {
        currentConf.args = rawVal.split('\n').map((s) => s.trim()).filter(Boolean)
      }
    } else if (field === 'url') {
      currentConf.url = rawVal.trim()
    } else if (field === 'headers') {
      const headersMap: Record<string, string> = {}
      const entries = rawVal.includes('\n') ? rawVal.split('\n') : rawVal.split(',')
      for (const line of entries) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim()
          const v = trimmed.slice(eqIdx + 1).trim()
          if (k) headersMap[k] = v
        }
      }
      currentConf.headers = headersMap
    } else if (field === 'env') {
      const envMap: Record<string, string> = {}
      // Support newline separated lines or comma separated
      const entries = rawVal.includes('\n') ? rawVal.split('\n') : rawVal.split(',')
      for (const line of entries) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim()
          const v = trimmed.slice(eqIdx + 1).trim()
          if (k) envMap[k] = v
        }
      }
      currentConf.env = envMap
    }
    mcpCustomConfigsMap[mcpId] = currentConf

    return { ok: true }
  })

  registry.registerRpc('hub.previewPack', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()
    const targetRegistry = selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const username = await getUsernameForRegistry(targetRegistry)

    const author = username || String(params['author'] ?? 'Community')
    const displayName = String(params['displayName'] ?? packDisplayName ?? params['name'] ?? 'Custom Pack')
    const version = String(params['version'] ?? packVersion ?? '1.0.0')
    const description = params['description'] ? String(params['description']) : packDescription || undefined

    const packSlug = editingPackName || `${author}-${displayName}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')

    const selected: Parameters<typeof buildCustomPack>[0]['selected'] = {
      workflows: [],
      agents: [],
      subAgents: [],
      skills: [],
      commands: [],
      mcpServers: [],
    }

    for (const [key, isSelected] of Object.entries(selectedComponentsMap)) {
      if (isSelected) {
        const [prefix, ...rest] = key.split(':')
        const id = rest.join(':')
        if (prefix === 'wf' || prefix === 'wo') selected.workflows?.push(id)
        else if (prefix === 'ag') selected.agents?.push(id)
        else if (prefix === 'sa' || prefix === 'su') selected.subAgents?.push(id)
        else if (prefix === 'sk') selected.skills?.push(id)
        else if (prefix === 'cmd' || prefix === 'co') selected.commands?.push(id)
        else if (prefix === 'mcp' || prefix === 'mc') selected.mcpServers?.push(id)
      }
    }

    const previewManifest = await buildCustomPack({
      workdir,
      configDir,
      metadata: {
        name: packSlug,
        version,
        displayName,
        description,
        author,
      },
      selected,
      mcpCustomConfigs: mcpCustomConfigsMap,
    })

    await updatePanelUi(workdir, configDir, previewManifest)

    context.notify({
      title: { en: 'Preview Ready', fr: 'Aperçu Prêt' },
      body: {
        en: `Generated preview for '${previewManifest.name}'.`,
        fr: `Aperçu généré pour '${previewManifest.name}'.`,
      },
      level: 'info',
    })

    return previewManifest
  })

  const pollPrStatus = (prNum: number, targetRepo: string, workdir: string, configDir: string) => {
    stopStatusPolling()
    let attempts = 0
    const maxAttempts = 36 // ~3 minutes (every 5 seconds)

    pollingTimer = setInterval(async () => {
      attempts++
      if (attempts > maxAttempts || !activePublishStatus || activePublishStatus.prNumber !== prNum) {
        stopStatusPolling()
        return
      }

      try {
        const token = getTokenForRegistry(selectedTargetRegistry)
        const checkResult = await checkGithubPrStatus({
          token,
          prNumber: prNum,
          targetRepo,
        })

        if (activePublishStatus && activePublishStatus.prNumber === prNum) {
          activePublishStatus.state = checkResult.state
          activePublishStatus.merged = checkResult.merged
          activePublishStatus.checksStatus = checkResult.checksStatus
          activePublishStatus.errorMessage = checkResult.errorMessage
          activePublishStatus.lastCheckedAt = new Date().toISOString()
        }

        await updatePanelUi(workdir, configDir)

        if (checkResult.merged) {
          stopStatusPolling()
          // The registry index is rebuilt right after the merge; pull it so the
          // edited pack shows up without the user clicking Refresh.
          await refreshMarketplace({ forceRefresh: true })
          context.notify({
            title: {
              en: `Pack Merged (#${prNum})`,
              fr: `Pack Fusionné (#${prNum})`,
            },
            body: {
              en: `Pull Request #${prNum} was automatically validated and merged into main!`,
              fr: `La Pull Request #${prNum} a été validée et fusionnée automatiquement sur main !`,
            },
            level: 'success',
          })
        } else if (checkResult.state === 'error') {
          stopStatusPolling()
        }
      } catch {
        // Continue polling on transient network error
      }
    }, 5000)
  }

  registry.registerRpc('hub.publishPackPr', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const targetRegistry = String(params['targetRegistry'] ?? selectedTargetRegistry ?? DEFAULT_REGISTRY_URL)
    const token = String(params['token'] ?? params['githubToken'] ?? getTokenForRegistry(targetRegistry) ?? '').trim()
    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()

    stopStatusPolling()

    const targetRepo = getGithubRepoFromRegistryUrl(targetRegistry) || 'JamesDAdams/openfox-community'
    const authorParam = params['author'] ? String(params['author']) : ''
    const displayName = String(params['displayName'] ?? packDisplayName ?? params['name'] ?? 'Custom Pack')

    if (!token) {
      const errorMessage = `An Access Token is required to publish to ${targetRegistry}. Please configure it in Settings → Plugins → Community Hub.`
      activePublishStatus = {
        state: 'error',
        prNumber: 0,
        prUrl: '',
        packName: displayName || 'custom-pack',
        targetRepo,
        checksStatus: 'failure',
        merged: false,
        errorMessage,
        lastCheckedAt: new Date().toISOString(),
      }
      const panelContent = await updatePanelUi(workdir, configDir)
      context.notify({
        title: { en: 'Publication Failed', fr: 'Échec de la Publication' },
        body: { en: errorMessage, fr: errorMessage },
        level: 'error',
      })
      return { success: false, error: errorMessage, status: activePublishStatus, content: panelContent }
    }

    let packToPublish: PackManifest

    // 1. Immediately display live tracking card in "creating" state
    activePublishStatus = {
      state: 'creating',
      prNumber: 0,
      prUrl: '',
      packName: displayName || 'custom-pack',
      targetRepo,
      checksStatus: 'pending',
      merged: false,
      lastCheckedAt: new Date().toISOString(),
    }
    await updatePanelUi(workdir, configDir)

    try {
      if (params['pack']) {
        packToPublish = params['pack'] as PackManifest
      } else {
        const username = await getUsernameForRegistry(targetRegistry)
        const author = authorParam || username || 'Community'
        const version = String(params['version'] ?? packVersion ?? '1.0.0')
        const description = params['description'] ? String(params['description']) : packDescription || undefined

        const packSlug =
          editingPackName ||
          `${author}-${displayName}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')

        const selected: Parameters<typeof buildCustomPack>[0]['selected'] = {
          workflows: [],
          agents: [],
          subAgents: [],
          skills: [],
          commands: [],
          mcpServers: [],
        }

        for (const [key, isSelected] of Object.entries(selectedComponentsMap)) {
          if (isSelected) {
            const [prefix, ...rest] = key.split(':')
            const id = rest.join(':')
            if (prefix === 'wf' || prefix === 'wo') selected.workflows?.push(id)
            else if (prefix === 'ag') selected.agents?.push(id)
            else if (prefix === 'sa' || prefix === 'su') selected.subAgents?.push(id)
            else if (prefix === 'sk') selected.skills?.push(id)
            else if (prefix === 'cmd' || prefix === 'co') selected.commands?.push(id)
            else if (prefix === 'mcp' || prefix === 'mc') selected.mcpServers?.push(id)
          }
        }

        packToPublish = await buildCustomPack({
          workdir,
          configDir,
          metadata: {
            name: packSlug,
            version,
            displayName,
            description,
            author,
          },
          selected,
          mcpCustomConfigs: mcpCustomConfigsMap,
        })
      }

      const result = await publishPackToGitHub({
        token,
        pack: packToPublish,
        targetRepo,
      })

      activePublishStatus = {
        state: 'validating',
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        branch: result.branch,
        packName: packToPublish.name,
        targetRepo,
        checksStatus: 'pending',
        merged: false,
        lastCheckedAt: new Date().toISOString(),
      }

      const panelContent = await updatePanelUi(workdir, configDir)

      context.notify({
        title: {
          en: `Pull Request Created (#${result.prNumber})`,
          fr: `Pull Request Créée (#${result.prNumber})`,
        },
        body: {
          en: `PR for '${packToPublish.name}' opened on ${targetRepo}.`,
          fr: `PR pour '${packToPublish.name}' ouverte sur ${targetRepo}.`,
        },
        level: 'success',
      })

      // Start automatic status polling in background
      pollPrStatus(result.prNumber, targetRepo, workdir, configDir)

      return { ...result, status: activePublishStatus, content: panelContent }
    } catch (err) {
      const errorMessage = (err as Error).message || String(err)
      activePublishStatus = {
        state: 'error',
        prNumber: 0,
        prUrl: '',
        packName: displayName || 'custom-pack',
        targetRepo,
        checksStatus: 'failure',
        merged: false,
        errorMessage,
        lastCheckedAt: new Date().toISOString(),
      }

      const panelContent = await updatePanelUi(workdir, configDir)

      context.notify({
        title: {
          en: 'Publication Failed',
          fr: 'Échec de la Publication',
        },
        body: {
          en: errorMessage,
          fr: errorMessage,
        },
        level: 'error',
      })

      return { success: false, error: errorMessage, status: activePublishStatus, content: panelContent }
    }
  })

  registry.registerRpc('hub.checkPrStatus', async (params: Record<string, unknown>, toolContext: PluginToolContext) => {
    const prNum = Number(params['prNumber'] ?? activePublishStatus?.prNumber)
    if (!prNum) {
      throw new Error('No PR number provided to check status.')
    }

    const targetRegistry = selectedTargetRegistry || DEFAULT_REGISTRY_URL
    const token = getTokenForRegistry(targetRegistry)
    const targetRepo = activePublishStatus?.targetRepo || getGithubRepoFromRegistryUrl(targetRegistry) || 'JamesDAdams/openfox-community'
    const workdir = toolContext?.workdir ?? process.cwd()
    const configDir = getConfigDir()

    try {
      const checkResult = await checkGithubPrStatus({
        token,
        prNumber: prNum,
        targetRepo,
      })

      if (activePublishStatus && activePublishStatus.prNumber === prNum) {
        activePublishStatus.state = checkResult.state
        activePublishStatus.merged = checkResult.merged
        activePublishStatus.checksStatus = checkResult.checksStatus
        activePublishStatus.errorMessage = checkResult.errorMessage
        activePublishStatus.lastCheckedAt = new Date().toISOString()
      } else {
        activePublishStatus = {
          state: checkResult.state,
          prNumber: prNum,
          prUrl: `https://github.com/${targetRepo}/pull/${prNum}`,
          packName: packDisplayName || 'custom-pack',
          targetRepo,
          checksStatus: checkResult.checksStatus,
          merged: checkResult.merged,
          errorMessage: checkResult.errorMessage,
          lastCheckedAt: new Date().toISOString(),
        }
      }

      if (checkResult.merged) {
        stopStatusPolling()
        await refreshMarketplace({ forceRefresh: true })
        context.notify({
          title: {
            en: `Pack Merged (#${prNum})`,
            fr: `Pack Fusionné (#${prNum})`,
          },
          body: {
            en: `Pull Request #${prNum} was automatically validated and merged into main!`,
            fr: `La Pull Request #${prNum} a été validée et fusionnée automatiquement sur main !`,
          },
          level: 'success',
        })
      } else if (checkResult.state === 'error') {
        stopStatusPolling()
      }
    } catch (err) {
      if (activePublishStatus) {
        activePublishStatus.errorMessage = (err as Error).message
        activePublishStatus.lastCheckedAt = new Date().toISOString()
      }
    }

    const panelContent = await updatePanelUi(workdir, configDir)
    return { ...activePublishStatus, content: panelContent }
  })

  registry.registerRpc('hub.openPanel', async () => {
    context.publish(hubUiPanel.id, 'open', true)
    return { ok: true }
  })
}

export default { register }
