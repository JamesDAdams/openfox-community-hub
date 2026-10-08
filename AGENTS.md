# AGENTS.md — openfox-community-hub

Paths relative to `openfox-plugins/openfox-community-hub/`.

## Purpose

Decentralized OpenFox plugin to share, export, import, and install workflows, agents, sub-agents, MCP servers, skills, and commands via Git/static CDN registries without a backend.

## Stack

- TypeScript, ESM, tsup, vitest 3.x
- peerDep: `openfox >=2.0.0`

## Commands

```bash
npm run build      # tsup src/index.ts --format esm --clean
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts        # Plugin entry point (register)
├── types.ts        # TypeScript types (PackManifest, RegistryIndex)
├── schema.ts       # Manifest validation (zod)
├── bundler.ts      # Export/packaging logic
├── installer.ts    # Installation logic
├── registry.ts     # Registry fetch/sync
├── publisher.ts    # Pack publishing
├── tools.ts        # Agent tool definitions (hub_*)
├── ui.ts           # Declarative plugin UI
└── frontmatter.ts  # Frontmatter parsing (skills)
```

## Where to Look What

- **Add an agent tool** → `src/tools.ts`
- **Modify manifest format** → `src/schema.ts` + `src/types.ts`
- **Modify export/packaging** → `src/bundler.ts`
- **Modify installation** → `src/installer.ts`
- **Modify registry** → `src/registry.ts`

## Conventions

- `apiVersion: 2`, capabilities: `tools`, `ui`, `settings`, `rpc`, `notifications`
- ESM build only via tsup
- `openfox` is externalized (provided by host)
- Pack Manifest v1: self-contained JSON schema (`openfox-pack.json`)

## Cross-Project Dependencies

**Consumes**: `openfox/plugin` (PluginRegistry, PluginToolContext, DeclarativeNode).

**Consumed by**: OpenFox (loaded as plugin).

**Touchpoints**:

- `src/index.ts` (register)
- `src/tools.ts` (agent tools hub_*)
- `src/registry.ts` (registry fetch/sync)
- `src/types.ts` (PackManifest, RegistryIndex)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- Official registry is hardcoded (DEFAULT_REGISTRY_URL).
- Module-level state management (registrySnapshot, pollingTimer).
- Relative imports `../../../../src/plugin/index.js` (fragile paths).

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.
