# Installation Guide

Get DeepSeek Updater running in your DeepSeek Harness deployment in under 5 minutes. This guide works on any machine — Windows, macOS, or Linux — with no personal data required. Just replace example paths like `C:\Users\you\Projects\my-app` with your own checkout.

## Prerequisites

- **DeepSeek Harness** checkout — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **Node.js ≥18**, **pnpm**, **git**
- A running DSH instance (default `http://127.0.0.1:3080`)

## Install

### 1. Clone this plugin

```bash
git clone https://github.com/StefanIsMe/dsh-updater-plugin.git
cd dsh-updater-plugin
```

### 2. Add it to your harness checkout

**Option A — pnpm workspaces (recommended):**

```bash
# from your deepseek-harness directory
pnpm add file:../dsh-updater-plugin/packages/host-updater
pnpm add file:../dsh-updater-plugin/packages/client-ui-updater
```

**Option B — copy packages:**

```bash
cp -r packages/host-updater <your-harness>/packages/host/updater
cp -r packages/client-ui-updater <your-harness>/packages/client/ui-updater
```

Or patch your bundle's `cordis.patch.yml` to reference the local packages.

### 3. Register the host service

Patch the Host row (example `cordis.patch.yml`):

```yaml
add:
  updater:
    package: "@deepseek-ai/dsh-host-updater"
    config:
      buildCommand: "pnpm run build:web"
      expectedRemoteUrl: "https://github.com/<you>/<your-fork>.git"
      autoApply: false
```

> `expectedRemoteUrl` is a safety guard — if set, the updater refuses to apply when the live git remote doesn't match.

### 4. Register the Settings page

Add `@deepseek-ai/dsh-client-ui-updater` to your web bundle dependencies and import its entry. It automatically registers the **Updater** section under **Settings**.

### 5. Enable the AI assistant

In `apps/cli/config/agent-presets/standard/agent.cordis.yml`:

```yaml
install:
  - package: "@deepseek-ai/dsh-host-updater/tools"
```

This mounts the `updater_*` tools and the `/updater` command into every chat session using the `standard` preset.

### 6. Build and launch

```bash
pnpm -C packages/host/updater run build
pnpm -C packages/client/ui-updater run build
pnpm run build:web
# restart DSH
```

Open **Settings → Updater** — you should see the live status card and the **Update with AI** button.

## Configuration

All settings are stored per-deployment in `.dsh/updater/config.json` (gitignored) and survive restarts:

```json
{
  "autoCheck": true,
  "pollMs": 30000,
  "buildCommand": "pnpm run build:web",
  "expectedRemoteUrl": "https://github.com/<you>/<your-harness>.git",
  "autoApply": false,
  "strategy": "upstream-overlay"
}
```

See the main [README](../README.md#️-configuration) for details on each field.

## Tips

- All example paths use `C:\Users\you\...` placeholders — never commit your real home directory.
- Configuration lives in `.dsh/updater/` and is excluded by this plugin's `.gitignore`.
- Need help? [Open an issue](https://github.com/StefanIsMe/dsh-updater-plugin/issues/new/choose) with the Bug report template.
