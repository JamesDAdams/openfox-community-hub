# Related OpenFox plugins

> **This file is documentation only.** It is **not** part of the pack registry
> (`index.json`), and nothing here is installable through `hub_install`.
> Packs (workflows / agents / skills / commands / MCP servers) live in the pack
> catalog; the entries below are **standalone `openfox/plugin` v2 packages**
> installed from **Settings → Plugins** in OpenFox itself.

## Workflow Visualizer

- Repository: https://github.com/theshwal/openfox-workflow-visualizer
- Version: `0.1.0` — `openfox.apiVersion: 2`, ESM entry, zero runtime dependencies
- Install: **Settings → Plugins → Install from GitHub** →
  `https://github.com/theshwal/openfox-workflow-visualizer`
- What it does: contributes a `composer.top` component and a declarative panel
  showing the running workflow, its current step and the engine's exact
  iteration counters (including the cumulative total after a resume), plus the
  per-step run counts reported by the engine.
- Capabilities: `ui`, `hooks`, `rpc`. No network, no telemetry, no DOM access.
- Known limits: no SVG diagram yet (API v2 panel content is static); the bar
  repopulates on the next workflow event after a host restart. The graphical
  version is proposed natively in https://github.com/co-l/openfox/pull/465
  (draft, not merged).
- Tests: 22 unit/integration tests; verified install/enable/disable/uninstall on
  an isolated OpenFox instance; Chromium end-to-end check of the hook → RPC →
  zone chain.

## Why this is not a pack

A pack is declarative configuration the Hub can index and install
(`hub_install`). A plugin is executable code with a manifest and an ESM entry
point that the host loads and sandboxes itself. Mixing both in one registry would
make `hub_install` silently attempt to install code it cannot validate.
