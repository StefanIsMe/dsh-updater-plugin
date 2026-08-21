# Install Guide — Agnostic (Pure Updater)

This guide works on any machine without personal data. Replace placeholders like `C:\\Users\\you\\Projects\\my-app` with your own checkout path.

## Prerequisites

- DeepSeek Harness checkout (https://github.com/deepseek-ai/deepseek-harness)
- Node.js ≥18, pnpm, git

## Install

1. Clone this repository:

   ```bash
   git clone https://github.com/StefanIsMe/dsh-updater-plugin.git
   cd dsh-updater-plugin
   ```

2. Copy packages into your harness checkout:

   ```bash
   cp -r packages/host-updater <your-harness>/packages/host/updater
   cp -r packages/client-ui-updater <your-harness>/packages/client/ui-updater
   ```

   Or add as local pnpm dependencies and patch your bundle's `cordis.patch.yml`.

3. Patch the Host row:

   ```yaml
   add:
     updater:
       package: "@deepseek-ai/dsh-host-updater"
       config:
         buildCommand: "pnpm run build:web"
         expectedRemoteUrl: "https://github.com/<you>/<your-fork>.git"
         autoApply: false
   ```

4. Add the client package to your web-app bundle dependencies and import its entry.

5. Mount AI tools in `apps/cli/config/agent-presets/standard/agent.cordis.yml`:

   ```yaml
   install:
     - package: "@deepseek-ai/dsh-host-updater/tools"
   ```

6. Build and restart:

   ```bash
   pnpm -C packages/host/updater run build
   pnpm -C packages/client/ui-updater run build
   pnpm run build:web
   # restart DSH; open Settings → Updater → verify "Update with AI" appears
   ```

## No personal data

All example paths use `C:\\Users\\you\\...` — never commit your real home directory. Configuration lives in `.dsh/updater/config.json` per deployment and is gitignored by this plugin's `.gitignore`.
