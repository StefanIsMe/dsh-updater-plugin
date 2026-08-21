# Install Guide — Agnostic

This guide works on any machine without personal data. Replace placeholders like `C:\\Users\\you\\Projects\\my-app` with your own checkout path.

## Prerequisites

- DeepSeek Harness checkout (https://github.com/deepseek-ai/deepseek-harness)
- Node.js ≥18, pnpm, git, PowerShell 7+ (Windows) or pwsh on macOS/Linux

## A. Standalone Git Cordis Plugin (`plugin/`)

1. Clone this repository:

   ```bash
   git clone https://github.com/StefanIsMe/dsh-updater-plugin.git
   cd dsh-updater-plugin
   ```

2. In DSH chat at http://127.0.0.1:3080, paste:

   > Create a git plugin using files at <absolute-path-to-clone>/plugin/host.js and <absolute-path-to-clone>/plugin/client.js. Use pwsh on native paths, expose 11 git tools, show dashboard in Run card. Call cordis_inspect_list first.

3. Approve the Client half when the Run card appears.

Test:

```
git_status workdir="C:\\Users\\you\\Projects\\my-app"
git_log workdir="C:\\Users\\you\\Projects\\my-app" limit=5
```

## B. Full Self-Updater (host + client)

1. Copy packages into your harness checkout:

   ```bash
   cp -r packages/host-updater <your-harness>/packages/host/updater
   cp -r packages/client-ui-updater <your-harness>/packages/client/ui-updater
   ```

   Or add as local pnpm dependencies and patch your bundle's `cordis.patch.yml`.

2. Patch the Host row:

   ```yaml
   add:
     updater:
       package: "@deepseek-ai/dsh-host-updater"
       config:
         buildCommand: "pnpm run build:web"
         expectedRemoteUrl: "https://github.com/<you>/<your-fork>.git"
         autoApply: false
   ```

3. Add the client package to your web-app bundle dependencies and import its entry.

4. Mount AI tools in `apps/cli/config/agent-presets/standard/agent.cordis.yml`:

   ```yaml
   install:
     - package: "@deepseek-ai/dsh-host-updater/tools"
   ```

5. Build and restart:

   ```bash
   pnpm -C packages/host/updater run build
   pnpm -C packages/client/ui-updater run build
   pnpm run build:web
   # restart DSH; open Settings → Updater → verify "Update with AI" appears
   ```

## No personal data

All example paths use `C:\\Users\\you\\...` — never commit your real home directory. Configuration lives in `.dsh/updater/config.json` per deployment and is gitignored by this plugin's `.gitignore`.
