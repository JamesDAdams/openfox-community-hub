import type {
  PackManifest,
  RegistryIndex,
  RegistryIndexEntry,
  EnvRequirement,
  RegistryConfig,
  RegistryRow,
  RegistryType,
} from './types.js'
import { validatePackManifest, validateRegistryIndex } from './schema.js'

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/JamesDAdams/openfox-community/main/index.json'

export function clearRegistryCache(): void {
  // no-op, live fetching always
}

const GITHUB_REF_PREFIXES = ['refs/heads/', 'refs/tags/']

// GitHub's "Raw" button emits `refs/heads/<branch>/<path>`, which must not be read as branch "refs".
export function splitGithubRefAndPath(rest: string): { ref: string; path: string } | null {
  const cleaned = (rest.split('?')[0] ?? rest).replace(/^\/+/, '')
  for (const prefix of GITHUB_REF_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      const remainder = cleaned.slice(prefix.length)
      const slash = remainder.indexOf('/')
      if (slash <= 0) return null
      return { ref: remainder.slice(0, slash), path: remainder.slice(slash + 1) }
    }
  }

  const slash = cleaned.indexOf('/')
  if (slash <= 0) return null
  return { ref: cleaned.slice(0, slash), path: cleaned.slice(slash + 1) }
}

export function getGithubApiUrl(url: string): { apiUrl: string; owner: string; repo: string; path: string; ref: string } | null {
  const trimmed = url.trim()
  const rawMatch = trimmed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/)
  const githubMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/)
  const match = rawMatch ?? githubMatch
  if (!match || !match[1] || !match[2] || !match[3]) return null

  const split = splitGithubRefAndPath(match[3])
  if (!split) return null

  const owner = match[1]
  const repo = match[2]
  return {
    apiUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${split.path}?ref=${split.ref}`,
    owner,
    repo,
    path: split.path,
    ref: split.ref,
  }
}

function parseGithubContentsPayload(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === 'object' &&
    'content' in parsed &&
    typeof (parsed as { content: unknown }).content === 'string' &&
    (parsed as { encoding?: string }).encoding === 'base64'
  ) {
    return JSON.parse(Buffer.from((parsed as { content: string }).content, 'base64').toString('utf8'))
  }
  return parsed
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (typeof response.json === 'function') {
    try {
      return parseGithubContentsPayload(await response.json())
    } catch {
      // fall through to text parsing
    }
  }
  const text = typeof response.text === 'function' ? await response.text() : ''
  return JSON.parse(text)
}

export function detectRegistryType(url: string): RegistryType {
  return /gitlab/i.test(url) ? 'gitlab' : 'github'
}

export async function fetchJsonDirect(
  url: string,
  options: { fetchFn?: typeof fetch; token?: string } = {},
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const token = options.token?.trim()

  const gh = getGithubApiUrl(url)
  if (gh) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'OpenFox-Community-Hub-Plugin',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    try {
      const apiRes = await fetchFn(gh.apiUrl, { cache: 'no-store', headers })
      if (apiRes.ok) {
        return await readJsonResponse(apiRes)
      }
    } catch {
      // fall back to the raw CDN URL below
    }
  }

  const headers: Record<string, string> = {}
  if (token) {
    if (detectRegistryType(url) === 'gitlab') {
      headers['PRIVATE-TOKEN'] = token
      headers['Authorization'] = `Bearer ${token}`
    } else {
      headers['Authorization'] = `Bearer ${token}`
    }
  }

  const response = await fetchFn(url, { cache: 'no-store', headers })
  if (!response.ok) {
    throw new Error(`Failed to fetch from ${url}: ${response.status} ${response.statusText}`)
  }

  return await readJsonResponse(response)
}

export function normalizePackUrl(sourceUrl: string): string {
  let url = sourceUrl.trim()

  // Convert GitHub blob URL to raw URL:
  // e.g., https://github.com/user/repo/blob/main/pack.json -> https://raw.githubusercontent.com/user/repo/main/pack.json
  if (url.includes('github.com/') && url.includes('/blob/')) {
    url = url
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace('/blob/', '/')
  }

  // Convert GitHub Gist web URL to raw:
  // e.g., https://gist.github.com/user/12345 -> https://gist.githubusercontent.com/user/12345/raw
  if (url.includes('gist.github.com/') && !url.includes('gist.githubusercontent.com') && !url.endsWith('/raw')) {
    url = `${url}/raw`
  }

  return url
}

export interface FetchRegistryOptions {
  registryUrl?: string
  forceRefresh?: boolean
  cacheTtlMs?: number
  fetchFn?: typeof fetch
  token?: string
}

export function parseRegistryConfigs(
  extra: string | undefined | null,
  defaults: { officialUrl?: string; githubToken?: string; gitlabToken?: string } = {},
): RegistryConfig[] {
  const result: RegistryConfig[] = []
  const seen = new Set<string>()

  const officialUrl = defaults.officialUrl ?? DEFAULT_REGISTRY_URL
  if (officialUrl) {
    const trimmed = officialUrl.trim()
    if (trimmed && /^https?:\/\//i.test(trimmed)) {
      const type = detectRegistryType(trimmed)
      const token = type === 'gitlab' ? defaults.gitlabToken : defaults.githubToken
      result.push({
        type,
        url: trimmed,
        label: registryLabel(trimmed),
        ...(token ? { token } : {}),
      })
      seen.add(trimmed)
    }
  }

  const rawExtra = String(extra ?? '').trim()
  if (!rawExtra) return result

  // 1. Try parsing JSON array
  if (rawExtra.startsWith('[') && rawExtra.endsWith(']')) {
    try {
      const parsed = JSON.parse(rawExtra) as Array<Record<string, unknown>>
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'object' && item !== null && typeof item['url'] === 'string') {
            const url = item['url'].trim()
            if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue
            seen.add(url)
            const type: RegistryType =
              item['type'] === 'gitlab' || item['type'] === 'github'
                ? item['type']
                : detectRegistryType(url)
            const token =
              typeof item['token'] === 'string' && item['token'].trim()
                ? item['token'].trim()
                : type === 'gitlab'
                  ? defaults.gitlabToken
                  : defaults.githubToken
            result.push({
              type,
              url,
              label: typeof item['label'] === 'string' ? item['label'] : registryLabel(url),
              ...(token ? { token } : {}),
            })
          }
        }
        return result
      }
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  // 2. Line by line parsing:
  // - https://...
  // - github https://... [token]
  // - gitlab https://... [token]
  const lines = rawExtra.split(/[\r\n]+/)
  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue

    const tokens = trimmedLine.split(/\s+/)
    let type: RegistryType | undefined
    let url: string
    let token: string | undefined

    if (tokens[0]?.toLowerCase() === 'github' || tokens[0]?.toLowerCase() === 'gitlab') {
      type = tokens[0].toLowerCase() as RegistryType
      url = tokens[1] ?? ''
      token = tokens[2]
    } else {
      url = tokens[0] ?? ''
      token = tokens[1]
      type = detectRegistryType(url)
    }

    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)

    const resolvedToken = token || (type === 'gitlab' ? defaults.gitlabToken : defaults.githubToken)
    result.push({
      type: type ?? detectRegistryType(url),
      url,
      label: registryLabel(url),
      ...(resolvedToken ? { token: resolvedToken } : {}),
    })
  }

  return result
}

export function resolveRegistryConfigs(options: {
  officialUrl?: string
  githubToken?: string
  gitlabToken?: string
  extraRegistries?: string | undefined | null
}): RegistryConfig[] {
  return parseRegistryConfigs(options.extraRegistries, {
    officialUrl: options.officialUrl ?? DEFAULT_REGISTRY_URL,
    githubToken: options.githubToken,
    gitlabToken: options.gitlabToken,
  })
}

/** Parses the `registries` list setting (a JSON array string of { source, url, token }). */
export function parseRegistryRows(raw: unknown): RegistryRow[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const rows: RegistryRow[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const url = typeof record['url'] === 'string' ? record['url'].trim() : ''
    if (!url || !/^https?:\/\//i.test(url)) continue
    const source = record['source']
    const type: RegistryType =
      source === 'github' || source === 'gitlab' ? source : detectRegistryType(url)
    const token = typeof record['token'] === 'string' ? record['token'].trim() : ''
    rows.push({ source: type, url, ...(token ? { token } : {}) })
  }
  return rows
}

/**
 * Builds the registry configs from the official registry plus the configured
 * rows. The official registry uses its own token, falling back to the token of
 * the first row of its own type; a row without a token falls back to the legacy
 * per-provider token.
 */
export function configsFromRegistryRows(
  rows: RegistryRow[],
  options: { officialUrl?: string; officialToken?: string; githubToken?: string; gitlabToken?: string } = {},
): RegistryConfig[] {
  const result: RegistryConfig[] = []
  const seen = new Set<string>()
  const legacyToken = (type: RegistryType): string =>
    (type === 'gitlab' ? options.gitlabToken : options.githubToken)?.trim() ?? ''
  const tokenForType = (type: RegistryType): string =>
    rows.find((row) => row.source === type && row.token)?.token ?? legacyToken(type)

  const officialUrl = (options.officialUrl ?? DEFAULT_REGISTRY_URL).trim()
  if (officialUrl) {
    const type = detectRegistryType(officialUrl)
    const token = options.officialToken?.trim() || tokenForType(type)
    seen.add(officialUrl)
    result.push({
      type,
      url: officialUrl,
      label: registryLabel(officialUrl),
      ...(token ? { token } : {}),
    })
  }

  for (const row of rows) {
    if (seen.has(row.url)) continue
    seen.add(row.url)
    const token = row.token ?? legacyToken(row.source)
    result.push({
      type: row.source,
      url: row.url,
      label: registryLabel(row.url),
      ...(token ? { token } : {}),
    })
  }

  return result
}

export function normalizeRegistryUrlList(urls: Array<string | RegistryConfig | undefined | null>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    if (typeof raw === 'object' && raw !== null && 'url' in raw) {
      const trimmed = String(raw.url ?? '').trim()
      if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed)
        result.push(trimmed)
      }
      continue
    }
    for (const candidate of String(raw ?? '').split(/[\n,]+/)) {
      const trimmed = candidate.trim()
      if (!trimmed || !/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  return result
}

export function resolveRegistryUrls(officialUrl: string, extra: string | undefined | null): string[] {
  return normalizeRegistryUrlList([officialUrl, extra])
}

export function registryLabel(url: string): string {
  const github = url.match(/^https?:\/\/(?:raw\.)?github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/i)
  if (github?.[1] && github[2]) return `${github[1]}/${github[2]}`
  const gitlab = url.match(/^https?:\/\/(?:www\.)?gitlab\.com\/([^/]+)\/([^/]+)/i)
  if (gitlab?.[1] && gitlab[2]) return `gitlab:${gitlab[1]}/${gitlab[2]}`
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface RegistryFailure {
  registryUrl: string
  error: string
}

export interface MergedRegistryResult {
  index: RegistryIndex
  registries: string[]
  failures: RegistryFailure[]
}

export async function fetchRegistry(
  options: FetchRegistryOptions = {},
): Promise<RegistryIndex> {
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL
  const data = await fetchJsonDirect(registryUrl, {
    fetchFn: options.fetchFn,
    token: options.token,
  })
  return validateRegistryIndex(data)
}

export async function fetchRegistries(
  urlsOrConfigs: Array<string | RegistryConfig>,
  options: { fetchFn?: typeof fetch; token?: string; forceRefresh?: boolean } = {},
): Promise<MergedRegistryResult> {
  const configs: RegistryConfig[] = []
  const seen = new Set<string>()

  for (const item of urlsOrConfigs) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed)
        configs.push({
          type: detectRegistryType(trimmed),
          url: trimmed,
          label: registryLabel(trimmed),
          token: options.token,
        })
      }
    } else if (item && typeof item === 'object' && item.url) {
      const trimmed = item.url.trim()
      if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed)
        configs.push({
          type: item.type ?? detectRegistryType(trimmed),
          url: trimmed,
          label: item.label ?? registryLabel(trimmed),
          token: item.token ?? options.token,
        })
      }
    }
  }

  const registries = configs.map((c) => c.url)
  if (registries.length === 0) {
    throw new Error('No registry URL configured.')
  }

  const settled = await Promise.allSettled(
    configs.map(async (config) => ({
      config,
      index: await fetchRegistry({
        registryUrl: config.url,
        forceRefresh: options.forceRefresh ?? true,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        token: config.token ?? options.token,
      }),
    })),
  )

  const failures: RegistryFailure[] = []
  const packs: RegistryIndexEntry[] = []
  const seenNames = new Set<string>()

  settled.forEach((result, position) => {
    const config = configs[position] as RegistryConfig
    const registryUrl = config.url
    if (result.status === 'rejected') {
      failures.push({
        registryUrl,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
      return
    }

    for (const pack of result.value.index.packs) {
      const key = pack.name.toLowerCase()
      if (seenNames.has(key)) continue
      seenNames.add(key)
      packs.push({
        ...pack,
        registryUrl,
        registryLabel: config.label ?? registryLabel(registryUrl),
        registryType: config.type,
      })
    }
  })

  if (packs.length === 0 && failures.length === registries.length) {
    throw new Error(
      `All registries failed: ${failures.map((failure) => `${failure.registryUrl} (${failure.error})`).join(' · ')}`,
    )
  }

  return {
    index: { version: 1, name: 'OpenFox Community Registries', packs },
    registries,
    failures,
  }
}

export interface InspectedPackResult {
  manifest: PackManifest
  summary: {
    workflowCount: number
    agentCount: number
    skillCount: number
    commandCount: number
    mcpCount: number
    mcpServers: string[]
  }
  requiredSecrets: EnvRequirement[]
}

export async function inspectPack(
  source: string | unknown,
  options: { fetchFn?: typeof fetch; token?: string } | (typeof fetch) = globalThis.fetch,
): Promise<InspectedPackResult> {
  const fetchFn = typeof options === 'function' ? options : (options?.fetchFn ?? globalThis.fetch)
  const token = typeof options === 'object' ? options.token : undefined

  let manifestData: unknown

  if (typeof source === 'string') {
    const trimmed = source.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      manifestData = JSON.parse(trimmed)
    } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = normalizePackUrl(trimmed)
      manifestData = await fetchJsonDirect(url, { fetchFn, token })
    } else {
      throw new Error(`Invalid source format: expected JSON string or HTTP(S) URL.`)
    }
  } else {
    manifestData = source
  }

  const manifest = validatePackManifest(manifestData)

  const workflows = manifest.contents.workflows ?? []
  const agents = [
    ...(manifest.contents.agents ?? []),
    ...(manifest.contents.subAgents ?? []),
  ]
  const skills = manifest.contents.skills ?? []
  const commands = manifest.contents.commands ?? []
  const mcpServersRecord = manifest.contents.mcpServers ?? {}
  const mcpServers = Object.keys(mcpServersRecord)

  const requiredSecrets: EnvRequirement[] = []
  for (const srvConf of Object.values(mcpServersRecord)) {
    if (srvConf.envRequirements) {
      for (const req of srvConf.envRequirements) {
        if (!requiredSecrets.some((r) => r.key === req.key)) {
          requiredSecrets.push(req)
        }
      }
    }
  }

  return {
    manifest,
    summary: {
      workflowCount: workflows.length,
      agentCount: agents.length,
      skillCount: skills.length,
      commandCount: commands.length,
      mcpCount: mcpServers.length,
      mcpServers,
    },
    requiredSecrets,
  }
}

export function searchPacks(
  registry: RegistryIndex,
  query: string,
  options: { tag?: string } = {},
): RegistryIndexEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const tagFilter = options.tag?.toLowerCase()

  return registry.packs.filter((pack) => {
    if (tagFilter && !pack.tags?.some((t) => t.toLowerCase() === tagFilter)) {
      return false
    }

    if (terms.length === 0) {
      return true
    }

    const name = pack.name.toLowerCase()
    const dispName =
      typeof pack.displayName === 'string'
        ? pack.displayName.toLowerCase()
        : (pack.displayName?.['en'] ?? '').toLowerCase()
    const desc =
      typeof pack.description === 'string'
        ? pack.description.toLowerCase()
        : (pack.description?.['en'] ?? '').toLowerCase()
    const tags = pack.tags?.map((t) => t.toLowerCase()) ?? []
    const author =
      typeof pack.author === 'string'
        ? pack.author.toLowerCase()
        : (pack.author?.name ?? '').toLowerCase()

    return terms.every(
      (term) =>
        name.includes(term) ||
        dispName.includes(term) ||
        desc.includes(term) ||
        author.includes(term) ||
        tags.some((t) => t.includes(term)),
    )
  })
}
