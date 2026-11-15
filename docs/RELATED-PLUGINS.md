# Related OpenFox plugins

> **This file is documentation only.** It is **not** part of the pack registry
> (`index.json`), and nothing here is installable through `hub_install`.
> Packs (workflows / agents / skills / commands / MCP servers) live in the pack
> catalog; the entries below are **standalone `openfox/plugin` v2 packages**
> installed from **Settings → Plugins** in OpenFox itself.

## Workflow Visualizer

- Repository: https://github.com/theshwal/openfox-workflow-visualizer
- Version: `0.3.5` — `openfox.apiVersion: 2`, ESM entry, zero runtime dependencies
- Install: **Settings → Plugins → Install from GitHub** →
  `https://github.com/theshwal/openfox-workflow-visualizer`
- What it does: contributes a `composer.top` bar (workflow name, current step,
  exact iteration counters) and a **Graph** button opening a panel that renders
  **the workflow manager's own diagram component** (vendored verbatim from
  co-l/openfox @ 0694574, MIT, with a documented in-tree runtime-highlight patch),
  including the active-step highlight and per-step engine counts.
- Capabilities: `ui`, `hooks`, `rpc`, `assets`. No network to third parties, no
  telemetry, no DOM patching.
- Known limits: the counter can be empty on the very first event; after a host
  restart the bar repopulates at the next workflow event (no public
  "read current execution" API for plugins); the native core variant proposed in
  https://github.com/co-l/openfox/pull/465 (draft, not merged) is richer but is
  **not** required by this plugin.
- Entry point: the **Workflow graph** button is always visible above the chat
  composer (even when no workflow runs) and opens the panel.
- Tests: 35 unit tests; verified install/enable/disable/uninstall on an isolated
  OpenFox instance; Chromium end-to-end check of bar → panel → SVG graph
  (the manager diagram rendered with the current step highlighted).

## Why this is not a pack

A pack is declarative configuration the Hub can index and install
(`hub_install`). A plugin is executable code with a manifest and an ESM entry
point that the host loads itself. Mixing both in one registry would make
`hub_install` silently attempt to install code it cannot validate.
