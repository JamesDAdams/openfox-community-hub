import type {
  DeclarativeNode,
  LocalizedString,
  PluginSettingsSchema,
  PluginSettingsTab,
  PluginUiAction,
  PluginUiPanel,
} from '../../../../src/plugin/index.js'
import { DEFAULT_REGISTRY_URL, registryLabel } from './registry.js'
import type { PackManifest, RegistryConfig, RegistryIndexEntry } from './types.js'
import { getPackAuthorUsername, type LocalInventory, type LocalItemInfo, type PublishStatus } from './publisher.js'

function toLocalizedString(val?: string | LocalizedString): LocalizedString {
  if (!val) return { en: '', fr: '' }
  if (typeof val === 'string') return { en: val, fr: val }
  return { en: val.en ?? '', fr: val.fr ?? val.en ?? '' }
}

export function buildLiveTrackingCard(status: PublishStatus): DeclarativeNode {
  const isCreating = status.state === 'creating'
  const isMerged = status.state === 'merged' || status.merged === true
  const isError = status.state === 'error' || status.checksStatus === 'failure'

  const tone = isMerged ? 'success' : isError ? 'danger' : 'info'

  const checkStatusLabel = isCreating
    ? '⏳ Waiting for Pull Request creation...'
    : isMerged
      ? '✓ Validation Checks Passed'
      : status.checksStatus === 'in_progress'
        ? '⏳ Running GitHub Actions Tests...'
        : isError
          ? '✗ Validation Checks Failed'
          : '⏳ Queued GitHub Actions Tests...'

  const mergeStatusLabel = isCreating
    ? '⏳ Waiting for CI validation...'
    : isMerged
      ? '🎉 Automatically Merged into main!'
      : isError
        ? '✗ Auto-Merge Blocked'
        : '⏳ Waiting for CI checks to pass before Auto-Merge...'

  const timeStr = status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleTimeString() : ''

  const titleEn = isCreating
    ? `🚀 Publishing '${status.packName}' (Creating PR)...`
    : isMerged
      ? `🎉 Pack '${status.packName}' Merged!`
      : isError
        ? `⚠️ Publication Error for '${status.packName}'`
        : `🚀 Publishing '${status.packName}' (Live Tracking)`

  const titleFr = isCreating
    ? `🚀 Publication de '${status.packName}' (Création de la PR)...`
    : isMerged
      ? `🎉 Pack '${status.packName}' Fusionné !`
      : isError
        ? `⚠️ Erreur de publication pour '${status.packName}'`
        : `🚀 Publication de '${status.packName}' (Suivi en direct)`

  const subtitleEn = isCreating
    ? `Creating branch and Pull Request on GitHub... ${timeStr ? `· ${timeStr}` : ''}`
    : status.prNumber
      ? `PR #${status.prNumber} ${timeStr ? `· Checked at ${timeStr}` : ''}`
      : `Preparing Pull Request... ${timeStr ? `· ${timeStr}` : ''}`

  const subtitleFr = isCreating
    ? `Création de la branche et de la Pull Request sur GitHub... ${timeStr ? `· ${timeStr}` : ''}`
    : status.prNumber
      ? `PR #${status.prNumber} ${timeStr ? `· Vérifié à ${timeStr}` : ''}`
      : `Préparation de la Pull Request... ${timeStr ? `· ${timeStr}` : ''}`

  return {
    type: 'card',
    tone,
    title: { en: titleEn, fr: titleFr },
    subtitle: { en: subtitleEn, fr: subtitleFr },
    className: isMerged
      ? 'border-accent-success/60 bg-accent-success/10 p-3 mb-2 space-y-2'
      : isError
        ? 'border-accent-error/60 bg-accent-error/10 p-3 mb-2 space-y-2'
        : 'border-accent-primary/60 bg-accent-primary/10 p-3 mb-2 space-y-2',
    children: [
      {
        type: 'stack',
        direction: 'row',
        align: 'center',
        justify: 'between',
        gap: 'sm',
        children: [
          {
            type: 'text',
            text: {
              en: isCreating
                ? '🔗 Pull Request: Creating...'
                : status.prNumber
                  ? `🔗 Pull Request: #${status.prNumber}`
                  : '🔗 Pull Request: Initializing...',
              fr: isCreating
                ? '🔗 Pull Request : En cours de création...'
                : status.prNumber
                  ? `🔗 Pull Request : #${status.prNumber}`
                  : '🔗 Pull Request : Initialisation...',
            },
            className: 'font-semibold text-xs text-text-primary',
          },
          ...(status.prUrl
            ? [
                {
                  type: 'button' as const,
                  label: {
                    en: 'Open on GitHub ↗',
                    fr: 'Ouvrir sur GitHub ↗',
                  },
                  variant: 'pill' as const,
                  icon: 'external',
                  onActivate: {
                    kind: 'openUrl' as const,
                    url: status.prUrl,
                  },
                },
              ]
            : [
                {
                  type: 'badge' as const,
                  label: { en: isCreating ? 'Creating...' : 'Pending', fr: isCreating ? 'Création...' : 'En attente' },
                  tone: 'info' as const,
                },
              ]),
        ],
      },
      {
        type: 'keyValue',
        items: [
          {
            key: { en: '1. Pull Request', fr: '1. Pull Request' },
            value: isCreating
              ? 'Creating branch and committing pack manifest...'
              : status.prNumber
                ? `Created on branch ${status.branch ?? 'pack-branch'} (PR #${status.prNumber})`
                : 'Branch creation pending...',
          },
          {
            key: { en: '2. CI Validation', fr: '2. Validation CI' },
            value: checkStatusLabel,
          },
          {
            key: { en: '3. Auto-Merge', fr: '3. Auto-Merge' },
            value: mergeStatusLabel,
          },
        ],
      },
      ...(status.errorMessage
        ? [
            {
              type: 'text' as const,
              text: { en: `❌ ${status.errorMessage}`, fr: `❌ ${status.errorMessage}` },
              className: 'text-xs text-accent-error font-medium mt-1',
            },
          ]
        : []),
      {
        type: 'stack',
        direction: 'row',
        justify: 'end',
        gap: 'xs',
        className: 'mt-2 pt-2 border-t border-border/30',
        children: [
          {
            type: 'button',
            label: {
              en: isMerged ? '✓ Completed' : isCreating ? '⏳ Creating...' : '🔄 Refresh Live Status',
              fr: isMerged ? '✓ Terminé' : isCreating ? '⏳ Création...' : '🔄 Actualiser le statut',
            },
            variant: isMerged ? 'ghost' : 'default',
            icon: 'refresh',
            disabled: isMerged || isCreating,
            onActivate: {
              kind: 'rpc',
              method: 'hub.checkPrStatus',
              params: { prNumber: status.prNumber },
            },
          },
        ],
      },
    ],
  }
}

export function buildPackPreviewNode(pack: PackManifest): DeclarativeNode {
  const authorName =
    typeof pack.author === 'string'
      ? pack.author
      : pack.author?.name ?? 'Community'

  const contents = pack.contents ?? {}
  const workflows = contents.workflows ?? []
  const agents = contents.agents ?? []
  const subAgents = contents.subAgents ?? []
  const skills = contents.skills ?? []
  const commands = contents.commands ?? []
  const mcpServers = Object.entries(contents.mcpServers ?? {})

  const contentsBadges: { label: LocalizedString; tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' }[] = []
  if (workflows.length > 0) {
    contentsBadges.push({
      label: {
        en: `${workflows.length} Workflow${workflows.length > 1 ? 's' : ''}`,
        fr: `${workflows.length} Workflow${workflows.length > 1 ? 's' : ''}`,
      },
      tone: 'success',
    })
  }
  if (agents.length > 0) {
    contentsBadges.push({
      label: {
        en: `${agents.length} Agent${agents.length > 1 ? 's' : ''}`,
        fr: `${agents.length} Agent${agents.length > 1 ? 's' : ''}`,
      },
      tone: 'info',
    })
  }
  if (subAgents.length > 0) {
    contentsBadges.push({
      label: {
        en: `${subAgents.length} Sub-agent${subAgents.length > 1 ? 's' : ''}`,
        fr: `${subAgents.length} Sous-agent${subAgents.length > 1 ? 's' : ''}`,
      },
      tone: 'info',
    })
  }
  if (skills.length > 0) {
    contentsBadges.push({
      label: {
        en: `${skills.length} Skill${skills.length > 1 ? 's' : ''}`,
        fr: `${skills.length} Compétence${skills.length > 1 ? 's' : ''}`,
      },
      tone: 'danger',
    })
  }
  if (mcpServers.length > 0) {
    contentsBadges.push({
      label: {
        en: `${mcpServers.length} MCP`,
        fr: `${mcpServers.length} MCP`,
      },
      tone: 'warning',
    })
  }
  if (commands.length > 0) {
    contentsBadges.push({
      label: {
        en: `${commands.length} Command${commands.length > 1 ? 's' : ''}`,
        fr: `${commands.length} Commande${commands.length > 1 ? 's' : ''}`,
      },
      tone: 'neutral' as const,
    })
  }

  const detailsItems: { key: LocalizedString; value: string }[] = []
  if (workflows.length > 0) {
    detailsItems.push({
      key: { en: 'Workflows', fr: 'Workflows' },
      value: workflows.map((w) => `${w.name} (${w.id})`).join(', '),
    })
  }
  if (agents.length > 0) {
    detailsItems.push({
      key: { en: 'Agents', fr: 'Agents' },
      value: agents.map((a) => `${a.name} (${a.id})`).join(', '),
    })
  }
  if (subAgents.length > 0) {
    detailsItems.push({
      key: { en: 'Sub-agents', fr: 'Sous-agents' },
      value: subAgents.map((sa) => `${sa.name} (${sa.id})`).join(', '),
    })
  }
  if (skills.length > 0) {
    detailsItems.push({
      key: { en: 'Skills', fr: 'Compétences' },
      value: skills.map((s) => s.name || s.id).join(', '),
    })
  }
  if (mcpServers.length > 0) {
    detailsItems.push({
      key: { en: 'MCP Servers', fr: 'Serveurs MCP' },
      value: mcpServers.map(([name, conf]) => `${name} (${conf.transport})`).join(', '),
    })
  }
  if (commands.length > 0) {
    detailsItems.push({
      key: { en: 'Commands', fr: 'Commandes' },
      value: commands.map((c) => c.prompt || c.name || c.id).join(', '),
    })
  }

  const totalCount =
    workflows.length + agents.length + subAgents.length + skills.length + mcpServers.length + commands.length

  const displayName = typeof pack.displayName === 'string' ? pack.displayName : pack.displayName?.en ?? pack.name

  return {
    type: 'card',
    title: {
      en: `👁️ Pack Preview: ${displayName} (v${pack.version})`,
      fr: `👁️ Aperçu du Pack : ${displayName} (v${pack.version})`,
    },
    subtitle: {
      en: `Slug: ${pack.name} · Author: @${authorName} · ${totalCount} component${totalCount > 1 ? 's' : ''}`,
      fr: `Slug : ${pack.name} · Auteur : @${authorName} · ${totalCount} composant${totalCount > 1 ? 's' : ''}`,
    },
    className: 'border-accent-primary/60 bg-accent-primary/5 shadow-md space-y-3',
    children: [
      ...(pack.description
        ? [
            {
              type: 'text' as const,
              text: toLocalizedString(pack.description),
              className: 'text-sm font-medium text-text-primary',
            },
          ]
        : []),
      ...(contentsBadges.length > 0
        ? [
            {
              type: 'stack' as const,
              direction: 'row' as const,
              gap: 'xs' as const,
              className: 'flex-wrap my-1',
              children: contentsBadges.map((b) => ({
                type: 'badge' as const,
                label: b.label,
                tone: b.tone,
              })),
            },
          ]
        : [
            {
              type: 'text' as const,
              text: {
                en: '⚠️ No components currently selected.',
                fr: '⚠️ Aucun composant sélectionné actuellement.',
              },
              muted: true,
            },
          ]),
      ...(detailsItems.length > 0
        ? [
            {
              type: 'details' as const,
              title: {
                en: `🔍 Included Components & Details (${totalCount})`,
                fr: `🔍 Composants & Détails Inclus (${totalCount})`,
              },
              defaultOpen: true,
              children: [
                {
                  type: 'keyValue' as const,
                  items: detailsItems,
                },
              ],
            },
          ]
        : []),
      {
        type: 'details' as const,
        title: {
          en: '📄 Raw PackManifest JSON (Technical Inspection)',
          fr: '📄 JSON Brut PackManifest (Inspection Technique)',
        },
        defaultOpen: false,
        className: 'mt-2 border-t border-border/40 pt-2',
        children: [
          {
            type: 'text' as const,
            text: {
              en: JSON.stringify(pack, null, 2),
              fr: JSON.stringify(pack, null, 2),
            },
            className:
              'font-mono text-[11px] bg-bg-primary p-2.5 rounded border border-border whitespace-pre overflow-x-auto select-all max-h-60',
          },
        ],
      },
    ],
  }
}

export function buildPackCardNode(
  pack: RegistryIndexEntry,
  currentUsername: string = '',
  options: { showOrigin?: boolean; hasAccessToken?: boolean } = {},
): DeclarativeNode {
  const authorName =
    typeof pack.author === 'string'
      ? pack.author
      : pack.author?.name ?? 'Community'

  const authorUsername = getPackAuthorUsername(pack)
  const isAuthor = Boolean(
    currentUsername &&
    authorUsername &&
    (authorUsername.toLowerCase() === currentUsername.toLowerCase() ||
      pack.name.toLowerCase().startsWith(`${currentUsername.toLowerCase()}-`)),
  )

  const hasAccessToken = options.hasAccessToken !== false
  const canEdit = hasAccessToken && isAuthor

  const editTooltip = !hasAccessToken
    ? {
        en: 'Configure an Access Token in Settings → Plugins → Community Hub to edit packs.',
        fr: 'Configurez un Jeton d’accès dans Réglages → Plugins → Hub Communautaire pour modifier des packs.',
      }
    : isAuthor
      ? {
          en: 'Edit this pack',
          fr: 'Modifier ce pack',
        }
      : {
          en: "You cannot edit this pack because you are not the author.",
          fr: "Vous ne pouvez pas modifier ce paquet, parce que vous n'êtes pas l'auteur.",
        }

  const summary = pack.contentsSummary ?? {}

  const contentsBadges: { label: LocalizedString; tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' }[] = []
  if (options.showOrigin && pack.registryLabel) {
    contentsBadges.push({
      label: {
        en: `Registry: ${pack.registryLabel}`,
        fr: `Registre : ${pack.registryLabel}`,
      },
      tone: 'neutral',
    })
  }
  if (summary.workflows && summary.workflows.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.workflows.length} Workflow${summary.workflows.length > 1 ? 's' : ''}`,
        fr: `${summary.workflows.length} Workflow${summary.workflows.length > 1 ? 's' : ''}`,
      },
      tone: 'success',
    })
  }
  if (summary.agents && summary.agents.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.agents.length} Agent${summary.agents.length > 1 ? 's' : ''}`,
        fr: `${summary.agents.length} Agent${summary.agents.length > 1 ? 's' : ''}`,
      },
      tone: 'info',
    })
  }
  if (summary.subAgents && summary.subAgents.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.subAgents.length} Sub-agent${summary.subAgents.length > 1 ? 's' : ''}`,
        fr: `${summary.subAgents.length} Sous-agent${summary.subAgents.length > 1 ? 's' : ''}`,
      },
      tone: 'info',
    })
  }
  if (summary.skills && summary.skills.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.skills.length} Skill${summary.skills.length > 1 ? 's' : ''}`,
        fr: `${summary.skills.length} Compétence${summary.skills.length > 1 ? 's' : ''}`,
      },
      tone: 'danger',
    })
  }
  if (summary.mcpServers && summary.mcpServers.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.mcpServers.length} MCP`,
        fr: `${summary.mcpServers.length} MCP`,
      },
      tone: 'warning',
    })
  }
  if (summary.commands && summary.commands.length > 0) {
    contentsBadges.push({
      label: {
        en: `${summary.commands.length} Command${summary.commands.length > 1 ? 's' : ''}`,
        fr: `${summary.commands.length} Commande${summary.commands.length > 1 ? 's' : ''}`,
      },
      tone: 'neutral',
    })
  }

  const detailsItems: { key: LocalizedString; value: string }[] = []
  if (summary.workflows && summary.workflows.length > 0) {
    detailsItems.push({
      key: { en: 'Workflows', fr: 'Workflows' },
      value: summary.workflows.join(', '),
    })
  }
  if (summary.agents && summary.agents.length > 0) {
    detailsItems.push({
      key: { en: 'Agents', fr: 'Agents' },
      value: summary.agents.join(', '),
    })
  }
  if (summary.subAgents && summary.subAgents.length > 0) {
    detailsItems.push({
      key: { en: 'Sub-agents', fr: 'Sous-agents' },
      value: summary.subAgents.join(', '),
    })
  }
  if (summary.skills && summary.skills.length > 0) {
    detailsItems.push({
      key: { en: 'Skills', fr: 'Compétences' },
      value: summary.skills.join(', '),
    })
  }
  if (summary.mcpServers && summary.mcpServers.length > 0) {
    detailsItems.push({
      key: { en: 'MCP Servers', fr: 'Serveurs MCP' },
      value: summary.mcpServers.join(', '),
    })
  }
  if (summary.commands && summary.commands.length > 0) {
    detailsItems.push({
      key: { en: 'Commands', fr: 'Commandes' },
      value: summary.commands.join(', '),
    })
  }

  return {
    type: 'card',
    title: toLocalizedString(pack.displayName ?? pack.name),
    subtitle: {
      en: `v${pack.version} · by ${authorName}`,
      fr: `v${pack.version} · par ${authorName}`,
    },
    children: [
      {
        type: 'text',
        text: toLocalizedString(pack.description),
      },
      ...(contentsBadges.length > 0
        ? [
            {
              type: 'stack' as const,
              direction: 'row' as const,
              gap: 'xs' as const,
              children: contentsBadges.map((b) => ({
                type: 'badge' as const,
                label: b.label,
                tone: b.tone,
              })),
            },
          ]
        : []),
      ...(detailsItems.length > 0
        ? [
            {
              type: 'details' as const,
              title: {
                en: '🔍 Included components & dependencies',
                fr: '🔍 Composants & dépendances inclus',
              },
              children: [
                {
                  type: 'keyValue' as const,
                  items: detailsItems,
                },
              ],
            },
          ]
        : []),
      { type: 'divider' },
      {
        type: 'stack',
        direction: 'row',
        gap: 'sm',
        children: [
          {
            type: 'button',
            label: {
              en: 'Install (Project .openfox/)',
              fr: 'Installer (Projet .openfox/)',
            },
            variant: 'primary',
            icon: 'download',
            onActivate: {
              kind: 'rpc',
              method: 'hub.installPack',
              params: {
                source: pack.downloadUrl,
                scope: 'project',
              },
            },
          },
          {
            type: 'button',
            label: {
              en: 'Install (Global)',
              fr: 'Installer (Global)',
            },
            variant: 'default',
            onActivate: {
              kind: 'rpc',
              method: 'hub.installPack',
              params: {
                source: pack.downloadUrl,
                scope: 'global',
              },
            },
          },
          {
            type: 'button',
            label: {
              en: 'Edit',
              fr: 'Modifier',
            },
            title: editTooltip,
            variant: 'default',
            icon: 'gear',
            disabled: !canEdit,
            onActivate: {
              kind: 'rpc',
              method: 'hub.editPack',
              params: {
                packName: pack.name,
                downloadUrl: pack.downloadUrl,
              },
            },
          },
        ],
      },
    ],
  }
}

export interface MarketplaceRefreshInfo {
  refreshedAt?: string
  totalPacks?: number
  error?: string
  warning?: string
  registries?: string[]
}

function formatRefreshTime(refreshedAt?: string): string {
  if (!refreshedAt) return '--:--:--'
  return new Date(refreshedAt).toTimeString().slice(0, 8)
}

export function buildPrivateRegistriesDetails(registries: string[] = []): DeclarativeNode {
  const listItems = registries.map((url) => ({ key: { en: 'Registry', fr: 'Registre' }, value: url }))

  return {
    type: 'details',
    title: {
      en: '🔐 Private & additional registries',
      fr: '🔐 Registres privés & supplémentaires',
    },
    className: 'mb-4',
    children: [
      ...(listItems.length > 0 ? [{ type: 'keyValue' as const, items: listItems }] : []),
      {
        type: 'text',
        text: {
          en: 'A registry is any Git repository exposing a static index.json. Create a repo, add an index.json (schema v1) plus one JSON file per pack under packs/, then paste the raw URL of index.json in Settings → Plugins → Community Hub → Additional registries (one URL per line). Private repositories work too: the GitHub token above is used to read them.',
          fr: 'Un registre est un simple dépôt Git exposant un index.json statique. Créez un dépôt, ajoutez un index.json (schéma v1) et un fichier JSON par pack dans packs/, puis collez l’URL brute de index.json dans Réglages → Plugins → Hub Communautaire → Registres supplémentaires (une URL par ligne). Les dépôts privés fonctionnent aussi : le jeton GitHub ci-dessus sert à les lire.',
        },
        className: 'text-xs text-text-muted',
      },
      {
        type: 'text',
        text: {
          en: 'index.json — { "version": 1, "name": "My private registry", "updatedAt": "2026-01-01T00:00:00.000Z", "packs": [ { "name": "my-pack", "version": "1.0.0", "displayName": "My pack", "description": "What it does", "author": "me", "tags": ["private"], "downloadUrl": "https://raw.githubusercontent.com/<owner>/<repo>/main/packs/my-pack.json" } ] }',
          fr: 'index.json — { "version": 1, "name": "Mon registre privé", "updatedAt": "2026-01-01T00:00:00.000Z", "packs": [ { "name": "my-pack", "version": "1.0.0", "displayName": "Mon pack", "description": "Ce qu’il fait", "author": "moi", "tags": ["private"], "downloadUrl": "https://raw.githubusercontent.com/<owner>/<repo>/main/packs/my-pack.json" } ] }',
        },
        className: 'font-mono text-[11px] bg-bg-primary p-2.5 rounded border border-border whitespace-pre-wrap select-all',
      },
      {
        type: 'text',
        text: {
          en: 'A pack file is the JSON produced by hub_export / the "Share a Pack" panel. Full walkthrough: github.com/JamesDAdams/openfox-community#-how-to-submit-a-pack',
          fr: 'Un fichier de pack est le JSON produit par hub_export / le panneau « Partager un Pack ». Guide complet : github.com/JamesDAdams/openfox-community#-how-to-submit-a-pack',
        },
        className: 'text-xs text-text-muted',
      },
    ],
  }
}

export function buildMarketplaceContent(
  packs: RegistryIndexEntry[] = [],
  currentSearch: string = '',
  currentUsername: string = '',
  refreshInfo: MarketplaceRefreshInfo = {},
  options: { hasAccessToken?: boolean } = {},
): DeclarativeNode[] {
  const totalPacks = refreshInfo.totalPacks ?? packs.length
  const registries = refreshInfo.registries ?? []
  const registryCount = registries.length
  const hasAccessToken = options.hasAccessToken !== false

  const refreshLabel = {
    en: `Last refreshed at ${formatRefreshTime(refreshInfo.refreshedAt)} (${totalPacks} pack${totalPacks === 1 ? '' : 's'} · ${registryCount} registr${registryCount === 1 ? 'y' : 'ies'})`,
    fr: `Dernier rafraîchissement à ${formatRefreshTime(refreshInfo.refreshedAt)} (${totalPacks} pack${totalPacks === 1 ? '' : 's'} · ${registryCount} registre${registryCount === 1 ? '' : 's'})`,
  }

  const shareTooltip = !hasAccessToken
    ? {
        en: 'Configure an Access Token in Settings → Plugins → Community Hub to share and publish packs.',
        fr: 'Configurez un Jeton d’accès dans Réglages → Plugins → Hub Communautaire pour pouvoir partager et publier des packs.',
      }
    : undefined

  return [
    ...(!hasAccessToken
      ? [
          {
            type: 'callout' as const,
            tone: 'warning' as const,
            icon: 'key',
            title: {
              en: 'Access Token Required to Publish',
              fr: 'Jeton d’accès Requis pour Publier',
            },
            text: {
              en: 'To publish or edit packs, configure a GitHub or GitLab Personal Access Token in Settings → Plugins → Community Hub.',
              fr: 'Pour publier ou modifier des packs, configurez un Jeton d’accès personnel GitHub ou GitLab dans Réglages → Plugins → Hub Communautaire.',
            },
          },
        ]
      : []),
    {
      type: 'stack',
      direction: 'row',
      align: 'center',
      justify: 'between',
      gap: 'sm',
      className: 'mb-4',
      children: [
        {
          type: 'stack',
          direction: 'column',
          gap: 'none',
          className: 'shrink-0',
          children: [
            {
              type: 'text',
              text: {
                en: `Available Community Packs (${packs.length})`,
                fr: `Packs Communautaires Disponibles (${packs.length})`,
              },
              className: 'font-semibold text-text-primary text-sm shrink-0',
            },
            {
              type: 'text',
              text: refreshLabel,
              muted: true,
              className: 'text-xs text-text-muted',
            },
            ...(refreshInfo.error
              ? [
                  {
                    type: 'text' as const,
                    text: {
                      en: `⚠ Refresh failed: ${refreshInfo.error}`,
                      fr: `⚠ Échec du rafraîchissement : ${refreshInfo.error}`,
                    },
                    className: 'text-xs text-accent-error',
                  },
                ]
              : []),
            ...(refreshInfo.warning
              ? [
                  {
                    type: 'text' as const,
                    text: {
                      en: `⚠ ${refreshInfo.warning}`,
                      fr: `⚠ ${refreshInfo.warning}`,
                    },
                    className: 'text-xs text-accent-warning',
                  },
                ]
              : []),
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          align: 'center',
          gap: 'xs',
          className: 'min-w-0 flex-1 justify-end',
          children: [
            {
              type: 'button',
              label: { en: '', fr: '' },
              variant: 'ghost',
              icon: 'refresh',
              onActivate: {
                kind: 'rpc',
                method: 'hub.fetchRegistry',
                params: { forceRefresh: true },
              },
            },
            {
              type: 'input',
              id: 'hub-search-input',
              defaultValue: currentSearch,
              placeholder: { en: 'Search packs...', fr: 'Rechercher un pack...' },
              onChange: {
                kind: 'rpc',
                method: 'hub.searchUi',
              },
            },
            {
              type: 'button',
              label: {
                en: 'Share a Pack',
                fr: 'Partager un Pack',
              },
              variant: 'primary',
              icon: 'upload',
              disabled: !hasAccessToken,
              title: shareTooltip,
              onActivate: {
                kind: 'rpc',
                method: 'hub.openPublishPanel',
              },
            },
          ],
        },
      ],
    },
    ...(packs.length === 0
      ? [
          {
            type: 'text' as const,
            text: {
              en: 'No community packs available yet or loading from GitHub...',
              fr: 'Aucun pack communautaire disponible ou chargement depuis GitHub...',
            },
            muted: true,
            className: 'py-8 text-center text-sm text-text-muted',
          },
        ]
      : packs.map((p) =>
          buildPackCardNode(p, currentUsername, {
            showOrigin: registryCount > 1,
            hasAccessToken,
          }),
        )),
    buildPrivateRegistriesDetails(registries),
  ]
}

export function buildPublishPanelContent(
  inventory: LocalInventory = {
    workflows: [],
    agents: [],
    subAgents: [],
    skills: [],
    commands: [],
    mcpServers: [],
  },
  _token: string = '',
  username: string = '',
  selectedMap: Record<string, boolean> = {},
  mcpCustomConfigs: Record<string, { args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }> = {},
  previewPack?: PackManifest,
  displayName: string = '',
  description: string = '',
  publishStatus?: PublishStatus,
  version: string = '1.0.0',
  registries: Array<string | RegistryConfig> = [DEFAULT_REGISTRY_URL],
  selectedRegistry: string = DEFAULT_REGISTRY_URL,
): DeclarativeNode[] {
  const authorDisplay = username ? `@${username}` : '(Configured in settings)'
  const canPublish = Boolean(displayName.trim() && description.trim())

  // Count active selections per section to dynamically expand if items are selected
  const hasSelectedWf = inventory.workflows.some((w) => selectedMap[`wf:${w.id}`])
  const hasSelectedAg = inventory.agents.some((a) => selectedMap[`ag:${a.id}`]) || inventory.subAgents.some((sa) => selectedMap[`sa:${sa.id}`])
  const hasSelectedSk = inventory.skills.some((sk) => selectedMap[`sk:${sk.id}`])
  const hasSelectedCmd = inventory.commands.some((cmd) => selectedMap[`cmd:${cmd.id}`])
  const hasSelectedMcp = inventory.mcpServers.some((mcp) => selectedMap[`mcp:${mcp.id}`])

  // Group skills by folder/group
  const groupedSkills = new Map<string, LocalItemInfo[]>()
  const rootSkills: LocalItemInfo[] = []

  for (const sk of inventory.skills) {
    if (sk.group) {
      const list = groupedSkills.get(sk.group) ?? []
      list.push(sk)
      groupedSkills.set(sk.group, list)
    } else {
      rootSkills.push(sk)
    }
  }

  const skillChildren: DeclarativeNode[] = [
    ...Array.from(groupedSkills.entries()).map(([groupName, skillsInGroup]) => {
      const groupHasSelected = skillsInGroup.some((sk) => selectedMap[`sk:${sk.id}`])
      return {
        type: 'details' as const,
        title: {
          en: `📁 ${groupName} (${skillsInGroup.length} skill${skillsInGroup.length > 1 ? 's' : ''})`,
          fr: `📁 ${groupName} (${skillsInGroup.length} compétence${skillsInGroup.length > 1 ? 's' : ''})`,
        },
        defaultOpen: groupHasSelected,
        className: 'ml-2 border-l border-border/50 pl-3 my-1',
        children: skillsInGroup.map((sk) => ({
          type: 'stack' as const,
          direction: 'row' as const,
          align: 'center' as const,
          gap: 'xs' as const,
          className: 'py-1 border-b border-border/20 flex-nowrap min-w-0',
          children: [
            {
              type: 'input' as const,
              id: `sel-sk-${sk.id}`,
              inputType: 'checkbox' as const,
              defaultChecked: Boolean(selectedMap[`sk:${sk.id}`]),
              onChange: {
                kind: 'rpc' as const,
                method: 'hub.toggleComponent',
                params: { type: 'skill', id: sk.id },
              },
            },
            {
              type: 'badge' as const,
              label: { en: 'Skill', fr: 'Skill' },
              tone: 'danger' as const,
              className: 'whitespace-nowrap shrink-0',
            },
            {
              type: 'text' as const,
              text: { en: sk.id.split('/').pop() ?? sk.name, fr: sk.id.split('/').pop() ?? sk.name },
              className: 'font-medium text-xs whitespace-nowrap shrink-0',
            },
            ...(sk.description
              ? [
                  {
                    type: 'text' as const,
                    text: { en: `- ${sk.description}`, fr: `- ${sk.description}` },
                    muted: true,
                    className: 'text-xs text-text-muted truncate min-w-0 flex-1',
                  },
                ]
              : []),
          ],
        })),
      }
    }),
    ...rootSkills.map((sk) => ({
      type: 'stack' as const,
      direction: 'row' as const,
      align: 'center' as const,
      gap: 'xs' as const,
      className: 'py-1 border-b border-border/40 flex-nowrap min-w-0',
      children: [
        {
          type: 'input' as const,
          id: `sel-sk-${sk.id}`,
          inputType: 'checkbox' as const,
          defaultChecked: Boolean(selectedMap[`sk:${sk.id}`]),
          onChange: {
            kind: 'rpc' as const,
            method: 'hub.toggleComponent',
            params: { type: 'skill', id: sk.id },
          },
        },
        {
          type: 'badge' as const,
          label: { en: 'Skill', fr: 'Skill' },
          tone: 'danger' as const,
          className: 'whitespace-nowrap shrink-0',
        },
        {
          type: 'text' as const,
          text: { en: `${sk.name} (${sk.id})`, fr: `${sk.name} (${sk.id})` },
          className: 'font-medium text-xs whitespace-nowrap shrink-0',
        },
        ...(sk.description
          ? [
              {
                type: 'text' as const,
                text: { en: `- ${sk.description}`, fr: `- ${sk.description}` },
                muted: true,
                className: 'text-xs text-text-muted truncate min-w-0 flex-1',
              },
            ]
          : []),
      ],
    })),
  ]

  const registryOptions = registries.map((r) => {
    const url = typeof r === 'string' ? r : r.url
    const typePrefix = typeof r === 'object' && r.type === 'gitlab' ? 'GitLab: ' : ''
    const lbl = typeof r === 'string' ? registryLabel(r) : (r.label ?? registryLabel(url))
    const isOfficial = url === DEFAULT_REGISTRY_URL
    return {
      value: url,
      label: {
        en: `${typePrefix}${lbl}${isOfficial ? ' (Official)' : ''}`,
        fr: `${typePrefix}${lbl}${isOfficial ? ' (Officiel)' : ''}`,
      },
    }
  })

  return [
    ...(publishStatus ? [buildLiveTrackingCard(publishStatus)] : []),
    {
      type: 'card',
      title: {
        en: '1. Pack Details',
        fr: '1. Détails du Pack',
      },
      subtitle: {
        en: 'Specify the target registry, display name, version, and description.',
        fr: 'Spécifiez le registre de destination, le nom d’affichage, la version et la description.',
      },
      children: [
        ...(registries.length > 1
          ? [
              {
                type: 'select' as const,
                id: 'pack-target-registry',
                label: { en: 'Target Registry', fr: 'Registre de destination' },
                defaultValue:
                  selectedRegistry ||
                  (typeof registries[0] === 'string' ? registries[0] : registries[0]?.url) ||
                  DEFAULT_REGISTRY_URL,
                options: registryOptions,
                onChange: {
                  kind: 'rpc' as const,
                  method: 'hub.onDetailsChange',
                  params: { field: 'targetRegistry' },
                },
              },
            ]
          : []),
        {
          type: 'stack',
          direction: 'row',
          gap: 'sm',
          children: [
            {
              type: 'input',
              id: 'pack-author',
              disabled: true,
              label: { en: 'Author / Account (From Settings)', fr: 'Auteur / Compte (Depuis les réglages)' },
              defaultValue: authorDisplay,
            },
            {
              type: 'input',
              id: 'pack-version',
              disabled: true,
              label: { en: 'Version (Auto-incremented)', fr: 'Version (Incrémentée auto)' },
              defaultValue: version,
            },
          ],
        },
        {
          type: 'input',
          id: 'pack-display-name',
          defaultValue: displayName,
          label: { en: 'Display Name', fr: 'Nom d’affichage' },
          placeholder: { en: 'e.g. Fullstack Code Reviewer', fr: 'ex: Revue Complète Fullstack' },
          onChange: {
            kind: 'rpc',
            method: 'hub.onDetailsChange',
            params: { field: 'displayName' },
          },
        },
        {
          type: 'input',
          id: 'pack-description',
          defaultValue: description,
          label: { en: 'Description', fr: 'Description' },
          placeholder: {
            en: 'Briefly explain what this pack accomplishes...',
            fr: 'Expliquez brièvement ce que réalise ce pack...',
          },
          onChange: {
            kind: 'rpc',
            method: 'hub.onDetailsChange',
            params: { field: 'description' },
          },
        },
      ],
    },
    {
      type: 'card',
      title: {
        en: '2. Select Components to Include',
        fr: '2. Sélectionner les Composants à Inclure',
      },
      subtitle: {
        en: 'Check the local workflows, agents, skills, commands, and MCP servers to bundle into this pack.',
        fr: 'Cochez les workflows, agents, compétences, commandes et serveurs MCP locaux à inclure.',
      },
      children: [
        {
          type: 'details',
          title: {
            en: `Workflows (${inventory.workflows.length} available)`,
            fr: `Workflows (${inventory.workflows.length} disponibles)`,
          },
          defaultOpen: hasSelectedWf,
          children:
            inventory.workflows.length > 0
              ? inventory.workflows.map((wf) => ({
                  type: 'stack' as const,
                  direction: 'row' as const,
                  align: 'center' as const,
                  gap: 'xs' as const,
                  className: 'py-1 border-b border-border/40 flex-nowrap min-w-0',
                  children: [
                    {
                      type: 'input' as const,
                      id: `sel-wf-${wf.id}`,
                      inputType: 'checkbox' as const,
                      defaultChecked: Boolean(selectedMap[`wf:${wf.id}`]),
                      onChange: {
                        kind: 'rpc' as const,
                        method: 'hub.toggleComponent',
                        params: { type: 'workflow', id: wf.id },
                      },
                    },
                    {
                      type: 'badge' as const,
                      label: { en: wf.scope, fr: wf.scope },
                      tone: wf.scope === 'project' ? ('success' as const) : ('neutral' as const),
                      className: 'whitespace-nowrap shrink-0',
                    },
                    {
                      type: 'text' as const,
                      text: { en: `${wf.name} (${wf.id})`, fr: `${wf.name} (${wf.id})` },
                      className: 'font-medium text-xs whitespace-nowrap shrink-0',
                    },
                    ...(wf.description
                      ? [
                          {
                            type: 'text' as const,
                            text: { en: `- ${wf.description}`, fr: `- ${wf.description}` },
                            muted: true,
                            className: 'text-xs text-text-muted truncate min-w-0 flex-1',
                          },
                        ]
                      : []),
                  ],
                }))
              : [
                  {
                    type: 'text',
                    muted: true,
                    text: {
                      en: 'No custom workflows found in project or global configuration.',
                      fr: 'Aucun workflow trouvé dans le projet ou la config globale.',
                    },
                  },
                ],
        },
        {
          type: 'details',
          title: {
            en: `Agents & Sub-agents (${inventory.agents.length + inventory.subAgents.length} available)`,
            fr: `Agents & Sous-agents (${inventory.agents.length + inventory.subAgents.length} disponibles)`,
          },
          defaultOpen: hasSelectedAg,
          children: [
            ...inventory.agents.map((ag) => ({
              type: 'stack' as const,
              direction: 'row' as const,
              align: 'center' as const,
              gap: 'xs' as const,
              className: 'py-1 border-b border-border/40 flex-nowrap min-w-0',
              children: [
                {
                  type: 'input' as const,
                  id: `sel-ag-${ag.id}`,
                  inputType: 'checkbox' as const,
                  defaultChecked: Boolean(selectedMap[`ag:${ag.id}`]),
                  onChange: {
                    kind: 'rpc' as const,
                    method: 'hub.toggleComponent',
                    params: { type: 'agent', id: ag.id },
                  },
                },
                {
                  type: 'badge' as const,
                  label: { en: 'Agent', fr: 'Agent' },
                  color: ag.color,
                  tone: ag.color ? undefined : ('info' as const),
                  className: 'whitespace-nowrap shrink-0',
                },
                {
                  type: 'text' as const,
                  text: { en: `${ag.name} (${ag.id})`, fr: `${ag.name} (${ag.id})` },
                  className: 'font-medium text-xs whitespace-nowrap shrink-0',
                },
                ...(ag.description
                  ? [
                      {
                        type: 'text' as const,
                        text: { en: `- ${ag.description}`, fr: `- ${ag.description}` },
                        muted: true,
                        className: 'text-xs text-text-muted truncate min-w-0 flex-1',
                      },
                    ]
                  : []),
              ],
            })),
            ...inventory.subAgents.map((sa) => ({
              type: 'stack' as const,
              direction: 'row' as const,
              align: 'center' as const,
              gap: 'xs' as const,
              className: 'py-1 border-b border-border/40 flex-nowrap min-w-0',
              children: [
                {
                  type: 'input' as const,
                  id: `sel-sa-${sa.id}`,
                  inputType: 'checkbox' as const,
                  defaultChecked: Boolean(selectedMap[`sa:${sa.id}`]),
                  onChange: {
                    kind: 'rpc' as const,
                    method: 'hub.toggleComponent',
                    params: { type: 'subagent', id: sa.id },
                  },
                },
                {
                  type: 'badge' as const,
                  label: { en: 'Sub-agent', fr: 'Sous-agent' },
                  color: sa.color,
                  tone: sa.color ? undefined : ('danger' as const),
                  className: 'whitespace-nowrap shrink-0',
                },
                {
                  type: 'text' as const,
                  text: { en: `${sa.name} (${sa.id})`, fr: `${sa.name} (${sa.id})` },
                  className: 'font-medium text-xs whitespace-nowrap shrink-0',
                },
                ...(sa.description
                  ? [
                      {
                        type: 'text' as const,
                        text: { en: `- ${sa.description}`, fr: `- ${sa.description}` },
                        muted: true,
                        className: 'text-xs text-text-muted truncate min-w-0 flex-1',
                      },
                    ]
                  : []),
              ],
            })),
          ],
        },
        {
          type: 'details',
          title: {
            en: `Skills (${inventory.skills.length} available)`,
            fr: `Compétences (${inventory.skills.length} disponibles)`,
          },
          defaultOpen: hasSelectedSk,
          children:
            inventory.skills.length > 0
              ? skillChildren
              : [
                  {
                    type: 'text',
                    muted: true,
                    text: {
                      en: 'No skills found in project or global configuration.',
                      fr: 'Aucune compétence trouvée dans le projet ou la config globale.',
                    },
                  },
                ],
        },
        {
          type: 'details',
          title: {
            en: `Commands (${inventory.commands.length} available)`,
            fr: `Commandes (${inventory.commands.length} disponibles)`,
          },
          defaultOpen: hasSelectedCmd,
          children:
            inventory.commands.length > 0
              ? inventory.commands.map((cmd) => ({
                  type: 'stack' as const,
                  direction: 'row' as const,
                  align: 'center' as const,
                  gap: 'xs' as const,
                  className: 'py-1 border-b border-border/40 flex-nowrap min-w-0',
                  children: [
                    {
                      type: 'input' as const,
                      id: `sel-cmd-${cmd.id}`,
                      inputType: 'checkbox' as const,
                      defaultChecked: Boolean(selectedMap[`cmd:${cmd.id}`]),
                      onChange: {
                        kind: 'rpc' as const,
                        method: 'hub.toggleComponent',
                        params: { type: 'command', id: cmd.id },
                      },
                    },
                    {
                      type: 'badge' as const,
                      label: { en: 'Command', fr: 'Commande' },
                      tone: 'neutral' as const,
                      className: 'whitespace-nowrap shrink-0',
                    },
                    {
                      type: 'text' as const,
                      text: { en: `${cmd.name} (${cmd.id})`, fr: `${cmd.name} (${cmd.id})` },
                      className: 'font-medium text-xs whitespace-nowrap shrink-0',
                    },
                    ...(cmd.description
                      ? [
                          {
                            type: 'text' as const,
                            text: { en: `- ${cmd.description}`, fr: `- ${cmd.description}` },
                            muted: true,
                            className: 'text-xs text-text-muted truncate min-w-0 flex-1',
                          },
                        ]
                      : []),
                  ],
                }))
              : [
                  {
                    type: 'text',
                    muted: true,
                    text: {
                      en: 'No commands found in project or global configuration.',
                      fr: 'Aucune commande trouvée dans le projet ou la config globale.',
                    },
                  },
                ],
        },
        {
          type: 'details',
          title: {
            en: `MCP Servers (${inventory.mcpServers.length} available)`,
            fr: `Serveurs MCP (${inventory.mcpServers.length} disponibles)`,
          },
          defaultOpen: hasSelectedMcp,
          children: inventory.mcpServers.map((mcp) => {
            const isChecked = Boolean(selectedMap[`mcp:${mcp.id}`])
            const isHttp = mcp.mcpConfig?.transport === 'http'
            const customConf = mcpCustomConfigs[mcp.id]

            const defaultArgs = customConf?.args
              ? (customConf.args.length > 0 ? customConf.args.join('\n') : '')
              : (mcp.mcpConfig?.args && mcp.mcpConfig.args.length > 0 ? mcp.mcpConfig.args.join('\n') : '')

            const envMap = customConf?.env ?? mcp.mcpConfig?.env ?? {}
            const defaultEnv = Object.entries(envMap)
              .map(([k, v]) => (/token|key|secret|password|auth/i.test(k) && !v.includes('${') ? `${k}=\${${k}}` : `${k}=${v}`))
              .join('\n')

            const defaultUrl = customConf?.url ?? mcp.mcpConfig?.url ?? ''
            const headersMap = customConf?.headers ?? mcp.mcpConfig?.headers ?? {}
            const defaultHeaders = Object.entries(headersMap)
              .map(([k, v]) => (/token|key|secret|password|auth|bearer/i.test(k) || (typeof v === 'string' && /bearer|token/i.test(v)) ? `${k}=Bearer \${${mcp.id.toUpperCase()}_TOKEN}` : `${k}=${v}`))
              .join('\n')

            const formFields: DeclarativeNode[] = isHttp
              ? [
                  {
                    type: 'input' as const,
                    id: `mcp-url-${mcp.id}`,
                    label: { en: 'Server URL (HTTP endpoint)', fr: 'URL du Serveur (endpoint HTTP)' },
                    placeholder: { en: 'https://mcp.example.com/api', fr: 'https://mcp.example.com/api' },
                    defaultValue: defaultUrl,
                    onChange: {
                      kind: 'rpc' as const,
                      method: 'hub.onMcpConfigChange',
                      params: { mcpId: mcp.id, field: 'url' },
                    },
                  },
                  {
                    type: 'input' as const,
                    id: `mcp-headers-${mcp.id}`,
                    inputType: 'textarea' as const,
                    rows: 3,
                    label: {
                      en: 'Headers (HEADER=VALUE, one per line)',
                      fr: 'En-têtes HTTP (HEADER=VALEUR, un par ligne)',
                    },
                    placeholder: {
                      en: 'Authorization=Bearer ${TOKEN}\nContent-Type=application/json',
                      fr: 'Authorization=Bearer ${TOKEN}\nContent-Type=application/json',
                    },
                    defaultValue: defaultHeaders,
                    onChange: {
                      kind: 'rpc' as const,
                      method: 'hub.onMcpConfigChange',
                      params: { mcpId: mcp.id, field: 'headers' },
                    },
                  },
                ]
              : [
                  {
                    type: 'input' as const,
                    id: `mcp-args-${mcp.id}`,
                    inputType: 'textarea' as const,
                    rows: 2,
                    label: { en: 'Arguments (JSON array or one argument per line)', fr: 'Arguments (tableau JSON ou un argument par ligne)' },
                    placeholder: { en: '["-y", "@modelcontextprotocol/server-github"]', fr: '["-y", "@modelcontextprotocol/server-github"]' },
                    defaultValue: defaultArgs,
                    onChange: {
                      kind: 'rpc' as const,
                      method: 'hub.onMcpConfigChange',
                      params: { mcpId: mcp.id, field: 'args' },
                    },
                  },
                  {
                    type: 'input' as const,
                    id: `mcp-env-${mcp.id}`,
                    inputType: 'textarea' as const,
                    rows: 3,
                    label: {
                      en: 'Environment variables (KEY=VALUE, one per line)',
                      fr: 'Variables d’environnement (CLE=VALEUR, une par ligne)',
                    },
                    placeholder: { en: 'API_KEY=xxx\nGITHUB_TOKEN=${GITHUB_TOKEN}', fr: 'API_KEY=xxx\nGITHUB_TOKEN=${GITHUB_TOKEN}' },
                    defaultValue: defaultEnv,
                    onChange: {
                      kind: 'rpc' as const,
                      method: 'hub.onMcpConfigChange',
                      params: { mcpId: mcp.id, field: 'env' },
                    },
                  },
                ]

            return {
              type: 'stack' as const,
              direction: 'column' as const,
              gap: 'xs' as const,
              className: 'py-2 border-b border-border/40 w-full',
              children: [
                {
                  type: 'stack' as const,
                  direction: 'row' as const,
                  align: 'center' as const,
                  gap: 'xs' as const,
                  className: 'flex-nowrap min-w-0',
                  children: [
                    {
                      type: 'input' as const,
                      id: `sel-mcp-${mcp.id}`,
                      inputType: 'checkbox' as const,
                      defaultChecked: isChecked,
                      onChange: {
                        kind: 'rpc' as const,
                        method: 'hub.toggleComponent',
                        params: { type: 'mcp', id: mcp.id },
                      },
                    },
                    {
                      type: 'badge' as const,
                      label: { en: `MCP (${mcp.mcpConfig?.transport ?? 'stdio'})`, fr: `MCP (${mcp.mcpConfig?.transport ?? 'stdio'})` },
                      tone: 'warning' as const,
                      className: 'whitespace-nowrap shrink-0',
                    },
                    {
                      type: 'text' as const,
                      text: { en: mcp.name, fr: mcp.name },
                      className: 'font-medium text-xs whitespace-nowrap shrink-0',
                    },
                  ],
                },
                {
                  type: 'card' as const,
                  className: 'ml-6 mt-1 p-3 bg-bg-tertiary/40 border border-border/50 rounded-md space-y-2.5',
                  children: [
                    {
                      type: 'text' as const,
                      text: {
                        en: isHttp
                          ? `⚙️ Configure ${mcp.name} for export (URL & HTTP headers)`
                          : `⚙️ Configure ${mcp.name} for export (args & environment variables)`,
                        fr: isHttp
                          ? `⚙️ Configurer ${mcp.name} pour l’export (URL & en-têtes HTTP)`
                          : `⚙️ Configurer ${mcp.name} pour l’export (args & variables d’environnement)`,
                      },
                      className: 'text-xs font-semibold text-text-primary',
                    },
                    ...formFields,
                    {
                      type: 'text' as const,
                      text: {
                        en: '💡 Tip: Redact real secrets by using template placeholders like MY_SECRET=${MY_SECRET}',
                        fr: '💡 Astuce : Masquez vos secrets avec des placeholders comme MON_SECRET=${MON_SECRET}',
                      },
                      muted: true,
                      className: 'text-[11px] text-text-muted mt-0.5',
                    },
                  ],
                },
              ],
            }
          }),
        },
      ],
    },
    ...(previewPack ? [buildPackPreviewNode(previewPack)] : []),
    {
      type: 'stack',
      direction: 'row',
      justify: 'end',
      gap: 'sm',
      className: 'mt-3',
      children: [
        {
          type: 'button',
          label: {
            en: '👁️ Preview Pack',
            fr: '👁️ Aperçu du Pack',
          },
          variant: 'default',
          onActivate: {
            kind: 'rpc',
            method: 'hub.previewPack',
          },
        },
        {
          type: 'button',
          label: {
            en: publishStatus?.state === 'creating' ? '⏳ Publishing...' : '🚀 Publish Pack & Create Pull Request',
            fr: publishStatus?.state === 'creating' ? '⏳ Publication en cours...' : '🚀 Publier le Pack & Créer la Pull Request',
          },
          variant: 'primary',
          disabled: !canPublish || publishStatus?.state === 'creating',
          onActivate: {
            kind: 'rpc',
            method: 'hub.publishPackPr',
          },
        },
      ],
    },
    ...(!canPublish
      ? [
          {
            type: 'text' as const,
            text: {
              en: '⚠️ Fill in a Display Name and Description to publish.',
              fr: '⚠️ Renseignez un Nom d’affichage et une Description pour publier.',
            },
            muted: true,
            className: 'text-xs text-text-muted text-right mt-1',
          },
        ]
      : []),
  ]
}

export const hubSettingsSchema: PluginSettingsSchema = {
  fields: [
    {
      key: 'officialRegistryUrl',
      type: 'text',
      readOnly: true,
      label: {
        en: 'Official Community Registry',
        fr: 'Registre Communautaire Officiel',
      },
      description: {
        en: 'Always enabled, read-only. Every pack published to the official Community Hub lands here.',
        fr: 'Toujours actif, non modifiable. Tous les packs publiés sur le Hub Communautaire officiel arrivent ici.',
      },
      default: DEFAULT_REGISTRY_URL,
      scope: 'global',
    },
    {
      key: 'officialRegistryToken',
      type: 'password',
      secret: true,
      storageKey: 'github_token',
      label: {
        en: 'Official Registry Token',
        fr: 'Jeton du registre officiel',
      },
      description: {
        en: 'Optional. Authenticates reads of the official registry (higher rate limits) and publishing to it. Falls back to the token of the first GitHub line below.',
        fr: 'Optionnel. Authentifie la lecture du registre officiel (quotas plus élevés) et la publication vers celui-ci. À défaut, le jeton de la première ligne GitHub ci-dessous est utilisé.',
      },
      placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
      linkButton: {
        label: {
          en: 'Generate a token',
          fr: 'Générer un jeton',
        },
        href: 'https://github.com/settings/tokens/new',
      },
      scope: 'global',
    },
    {
      key: 'officialRegistryAccount',
      type: 'status',
      rpcMethod: 'hub.accountStatus',
      label: {
        en: 'GitHub account',
        fr: 'Compte GitHub',
      },
      description: {
        en: 'Checks the token above against GitHub and shows the account it belongs to.',
        fr: 'Vérifie le jeton ci-dessus auprès de GitHub et affiche le compte auquel il appartient.',
      },
      scope: 'global',
    },
    {
      key: 'registries',
      type: 'list',
      label: {
        en: 'Registries',
        fr: 'Registres',
      },
      description: {
        en: 'One line per registry: the source (GitHub or GitLab), the registry URL and the personal access token used for it. The official registry above stays active in addition. Tokens are required for private registries and to publish.',
        fr: 'Une ligne par registre : la source (GitHub ou GitLab), l’URL du registre et le jeton d’accès personnel associé. Le registre officiel ci-dessus reste actif en plus. Les jetons sont requis pour les registres privés et pour publier.',
      },
      addLabel: {
        en: 'Add registry',
        fr: 'Ajouter un registre',
      },
      removeLabel: {
        en: 'Remove registry',
        fr: 'Supprimer le registre',
      },
      default: '[]',
      scope: 'global',
      itemFields: [
        {
          key: 'source',
          type: 'select',
          label: {
            en: 'Source',
            fr: 'Source',
          },
          options: [
            { value: 'github', label: { en: 'GitHub', fr: 'GitHub' } },
            { value: 'gitlab', label: { en: 'GitLab', fr: 'GitLab' } },
          ],
          default: 'github',
        },
        {
          key: 'url',
          type: 'text',
          label: {
            en: 'Registry URL',
            fr: 'URL du registre',
          },
          placeholder: 'https://raw.githubusercontent.com/<owner>/<repo>/main/index.json',
        },
        {
          key: 'token',
          type: 'password',
          secret: true,
          label: {
            en: 'Personal Access Token',
            fr: 'Jeton d’accès personnel',
          },
          placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
          linkButton: {
            label: {
              en: 'Generate a token',
              fr: 'Générer un jeton',
            },
            href: 'https://github.com/settings/tokens/new',
            hrefByField: 'source',
            hrefByValue: {
              github: 'https://github.com/settings/tokens/new',
              gitlab: '{{url.origin}}/-/user_settings/personal_access_tokens',
            },
          },
        },
      ],
    },
  ],
}

export const hubSettingsTab: PluginSettingsTab = {
  id: 'community-hub-tab',
  label: {
    en: 'Community Hub',
    fr: 'Hub Communautaire',
  },
  icon: 'globe',
  order: 45,
  content: buildMarketplaceContent(),
}

export const hubUiPanel: PluginUiPanel = {
  id: 'community-hub-panel',
  title: {
    en: 'Community Hub',
    fr: 'Hub Communautaire',
  },
  kind: 'declarative',
  size: 'xl',
  content: buildMarketplaceContent(),
}

export const hubPublishPanel: PluginUiPanel = {
  id: 'community-hub-publish-panel',
  title: {
    en: 'Share & Publish Pack',
    fr: 'Partager & Publier un Pack',
  },
  kind: 'declarative',
  size: '2xl',
  content: buildPublishPanelContent(),
}

export const hubUiAction: PluginUiAction = {
  id: 'open-community-hub',
  slot: 'plugin.menu',
  label: {
    en: 'Community Hub',
    fr: 'Hub Communautaire',
  },
  onActivate: {
    kind: 'openSettings',
    tab: 'plugin:openfox-community-hub:community-hub-tab',
  },
}
