# OpenFox Community Hub Plugin

A decentralized, backend-less sharing and distribution system for OpenFox workflows, agents, sub-agents, MCP servers, skills, and commands.

---

## 🌟 Overview

The Community Hub enables the OpenFox community to share complex, multi-agent workflows and configurations without relying on any centralized server or database.

### Key Capabilities
- **Pack Manifest (v1)**: Self-contained declarative schema encompassing workflows, agents, skills, commands, and MCP servers with environment/secrets declarations.
- **Export / Bundler (`hub.exportPack` / `hub_export`)**: Automatically resolves a workflow and its recursive dependency tree (referenced agents, sub-agents, skills, MCP servers, and commands) into a portable JSON pack, redacting sensitive tokens.
- **Import / Installer (`hub.installPack` / `hub_install`)**: Deploys packs into either the **Project Scope** (`.openfox/`) or **Global Scope** (`~/.config/openfox/`), prompting and configuring required MCP environment variables.
- **Static Registry Synchronization (`hub.fetchRegistry` / `hub_search`)**: Fetches curated community packs from public GitHub repositories, jsDelivr CDN, or direct GitHub / Gist raw URLs with memory caching.
- **OpenFox Plugin Native**: Implemented entirely as an OpenFox plugin using declarative UI, custom RPCs, and agent tools.

---

## 📦 Pack Manifest Specification (`openfox-pack.json`)

```json
{
  "schemaVersion": 1,
  "name": "pr-deep-reviewer",
  "version": "1.0.0",
  "displayName": { "en": "PR Deep Reviewer", "fr": "Revue Approfondie de PR" },
  "description": "Full automated PR review workflow with security and linting agents",
  "author": "openfox-community",
  "tags": ["review", "security", "git"],
  "contents": {
    "workflows": [
      {
        "id": "pr-review",
        "name": "PR Review",
        "description": "Review workflow",
        "entryStep": "security-step",
        "steps": [
          {
            "id": "security-step",
            "name": "Security Scan",
            "agentMode": "security-agent",
            "transitions": [{ "target": "$done", "condition": "outcome.result == 'ok'" }]
          }
        ]
      }
    ],
    "agents": [
      {
        "id": "security-agent",
        "name": "Security Agent",
        "description": "Checks for vulnerabilities",
        "prompt": "You analyze code for security flaws.",
        "skills": ["owasp-top10"],
        "mcpServers": ["semgrep"]
      }
    ],
    "skills": [
      {
        "id": "owasp-top10",
        "name": "OWASP Top 10",
        "description": "Security best practices",
        "prompt": "# OWASP Top 10 Guide..."
      }
    ],
    "commands": [
      {
        "id": "review-pr",
        "name": "Review PR",
        "prompt": "/run-workflow pr-review"
      }
    ],
    "mcpServers": {
      "semgrep": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@semgrep/mcp"],
        "envRequirements": [
          {
            "key": "SEMGREP_APP_TOKEN",
            "description": "Token for Semgrep cloud rules",
            "required": true
          }
        ]
      }
    }
  }
}
```

---

## 🛠️ Usage

### 1. Searching Community Packs
Using the agent tool:
```
hub_search { "query": "review", "tag": "security" }
```

### 2. Installing a Pack
- By Registry Name:
  ```
  hub_install { "source": "pr-deep-reviewer", "scope": "project" }
  ```
- From a GitHub / Gist URL:
  ```
  hub_install { "source": "https://github.com/user/my-pack/blob/main/pack.json", "scope": "global" }
  ```
- With Environment Variables:
  ```
  hub_install {
    "source": "pr-deep-reviewer",
    "scope": "project",
    "envValues": { "SEMGREP_APP_TOKEN": "my-secret-token" }
  }
  ```

### 3. Exporting a Local Workflow as a Pack
```
hub_export { "workflowId": "pr-review", "name": "my-custom-pack", "version": "1.0.0" }
```

---

## 🔐 Private & Additional Registries

The Community Hub always queries the **official registry** (read-only, hard-coded) and every
extra registry you declare in **Settings → Plugins → Community Hub → Additional registries**
(one URL per line, the raw URL of an `index.json`). All registries are fetched in parallel and
merged into a single list:

- the official registry is always listed first and **wins on name conflicts** (same pack `name`,
  case-insensitive, in several registries → the first occurrence is kept);
- an unreachable registry never hides the others: its URL is reported in a warning line and the
  packs of the reachable registries stay browsable;
- each pack card shows a `Registry: <owner>/<repo>` badge as soon as more than one registry is
  configured, so you always know where a pack comes from.

### Creating your own (private) registry

A registry is just a Git repository exposing a static JSON file — no backend, no server:

1. Create a repository (public, or private if you set the GitHub token in the Community Hub
   settings — it is used as a `Bearer` token to read the registry).
2. Add an `index.json` at the root:

   ```json
   {
     "version": 1,
     "name": "My private registry",
     "updatedAt": "2026-01-01T00:00:00.000Z",
     "packs": [
       {
         "name": "my-pack",
         "version": "1.0.0",
         "displayName": "My pack",
         "description": "What this pack does",
         "author": "me",
         "tags": ["private"],
         "downloadUrl": "https://raw.githubusercontent.com/<owner>/<repo>/main/packs/my-pack.json"
       }
     ]
   }
   ```

   `version` must be `1`; each pack entry requires `name`, `version` and `downloadUrl`
   (the raw URL of the pack file, which is what `hub_export` produces).
3. Drop the pack files in `packs/`.
4. Paste the raw URL of `index.json` in the **Additional registries** field, e.g.
   `https://raw.githubusercontent.com/<owner>/<repo>/main/index.json`, and hit **Refresh** in the
   Community Hub tab.

> The `refs/heads/main` URL form produced by GitHub's “Raw” button is supported as well.

The same walkthrough is shown in the Community Hub tab under
“🔐 Private & additional registries”.

---

## 🚀 How to Publish a Pack (No Backend Needed)

1. Export your pack using `hub_export` or the Community Hub UI.
2. Commit your pack JSON file to your GitHub repository or GitHub Gist.
3. Submit a Pull Request adding your pack's metadata and raw download URL to the community `index.json`.
4. Anyone using OpenFox can now discover, search, and install your pack with a single click.
