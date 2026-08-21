# DSH Updater Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Harness-0f1419)](https://github.com/deepseek-ai/deepseek-harness)
[![Cordis](https://img.shields.io/badge/Cordis-Plugin-1a2332)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)]()

> **Agnostic, draft-preserving self-update system for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — plus a standalone Windows-native Git Cordis plugin.**

This repository publishes the complete source for the DSH self-updater that was previously embedded in a private fork. It is **fully agnostic**: no hardcoded user paths, no personal data, no machine-specific configuration. Anyone can clone, build, and install it on their own DSH deployment.

---

## ✨ What this gives you

### 1. Host Updater (`packages/host-updater`)
Self-update orchestration for the repository checkout your DSH process is running from. Implemented as a Cordis host service (`updater`) that safely syncs with an upstream remote **without ever clobbering local drafts**.

**Pipeline** (fail-proof, persisted to `.dsh/updater/state.json`):

1. **Check** — `git fetch` + plan: incoming commits, changed files, and three classifications:
   - *install needed* (dependency manifests changed)
   - *rebuild needed* (source changed)
   - *restart needed* (anything outside the browser client plane)
   
   Draft collisions are surfaced upfront:
   - `conflictRisk` — files upstream touches that have local modifications
   - `untrackedRisk` — files upstream adds that already exist locally as untracked

2. **Apply** — safety backup → stash *only colliding drafts* → fast-forward merge to upstream → restore drafts on top → optional `pnpm install` / build. On conflict the run stops at `conflicts` phase with stash + backup intact; `updater/restore` rolls back to the pre-update snapshot.

3. **Restart** — `updater/restart` (consent-gated) arms a detached supervisor that relaunches the exact original command, attempt-capped with a `dead` marker, then stops the Host.

Every transition is emitted as the allowlisted `updater/state` event, so browser surfaces stay live. Configuration is durable per deployment in `.dsh/updater/config.json`.

### 2. Client UI (`packages/client-ui-updater`)
Browser half of the self-update system. Registers the **Updater** settings page (`settings.section` id: `updater`) that talks to the host `updater` Remote namespace:

- **Status card** — local/upstream SHA, ahead/behind, modified/untracked counts, last check/apply timestamps, phase pill
- **Plan card** — incoming commits, changed-file count, `needsInstall` / `needsRebuild` / `needsRestart` classification, collision lists
- **Consent-gated actions** — Apply, Restart, Restore each open a confirmation dialog; nothing destructive without a click
- **Config editor** — auto-check toggles, poll interval, build command (persisted by host)
- **Live updates** — subscribes to `updater/state` events and polls `status()` every 30s; progress (install/build tails) and conflict states render in real time
- **AI Update flow (new)** — single **"Update with AI"** launcher: picks a model, creates a new chat session, prefills the `/updater` command, and navigates to it. All merging then happens through the agent — the agent may keep local, take upstream, or write a merged file and ask you questions mid-update. This replaces manual keep/take buttons as the primary surface while keeping the deterministic engine as the safe executor underneath.

### 3. Model Tools — the "Update DSH" Plugin Surface (`packages/host-updater/src/tools.ts`)
Any chat session whose agent preset mounts `@deepseek-ai/dsh-host-updater/tools` can drive the pipeline via ordinary tool calls:

| Tool | Purpose |
|------|---------|
| `updater_status` | Compact JSON snapshot (phase, versions, plan, backups, parked drafts) |
| `updater_check` | Fetch upstream + recompute plan |
| `updater_apply` | Run the safe apply pipeline (fire-and-forget; poll status until settled) |
| `updater_file_diff` | Unified diff of one path (HEAD vs upstream, bounded) |
| `updater_local_draft` | Stashed local draft content for one conflicted path |
| `updater_resolve_conflict` | `keep-local` \| `take-upstream` \| `keep-both` |
| `updater_write_merged` | Write an agent-authored merged file and stage it |
| `updater_restore` | Restore a pre-update safety backup |
| `updater_restart` | Arm supervised host restart |
| `updater_refresh` | Clear transient error state |
| `/updater` command | Prints current status + available verbs into the session |

The gateway stays the **sole executor and safety net** (backup → stash-only-collisions → ff-only merge → draft restore → conflicts/restore).

### 4. Windows Git Plugin (`plugin/`)
A standalone **Cordis dynamic plugin** that exposes Windows-native `git` through `pwsh` — useful on its own and as a reference for building agnostic DSH plugins:

- Every tool call is a fresh `pwsh -Command` — never `cd`, always pass `workdir` as a native Windows path (`C:\Users\you\Projects\app`)
- Handles PowerShell single-quote escaping (`''` for `'`), sandbox awareness (`workspace-write` vs `danger-full-access`), truncation spill files, timeouts (30s default, 60s for push/pull)
- **11 tools**: `git_status`, `git_log`, `git_diff`, `git_branch`, `git_add`, `git_commit`, `git_checkout`, `git_push`, `git_pull`, `git_stash`, `git_init`
- **Client panel**: React dashboard in the Cordis *Run* card (`tool.view.cordis` key `self`) — input repo path, tabs for status/log/diff/branch, Refresh/Harness/Toplevel shortcuts, plus a sidebar footer hint

---

## 🚀 Quick Start

### Prerequisites

- **DSH** — a running DeepSeek Harness checkout (`http://127.0.0.1:3080`)
- **Node.js ≥18**, **pnpm**, **git**, **PowerShell 7+**

### Install the Git Plugin (agnostic dynamic plugin)

This works on **any** DSH installation — Windows, macOS, Linux. The plugin auto-detects git + pwsh on the host machine; no hardcoded paths are needed.

**Option A — Ask the model (recommended):**

Paste into any DSH chat at `http://127.0.0.1:3080`:

> Create a git plugin for Windows using files at `<path-to-cloned-repo>/plugin/host.js` and `<path-to-cloned-repo>/plugin/client.js`. Interact with git via pwsh on native paths, expose 11 git tools, and show the dashboard in the Run card. Call `cordis_inspect_list` first per skill.

The model will read both files, call `cordis_define` (plugin kind `new`, idPrefix `git`, name `Git Windows`), then `cordis_run`. If the Run card shows *awaiting-approval*, tick **single** (this version) or **double** (future versions) and Approve.

**Option B — Manual:**

1. `cordis_inspect_list` → confirm `shell` service exists
2. `cordis_define { plugin:{kind:"new", idPrefix:"git"}, name:"Git Windows", purpose:"Interact with git on Windows via pwsh...", code:{ host:"<host.js contents>", client:"<client.js contents>" } }`
3. `cordis_run { pluginId:"<from define>", packageId:"<from define>", mode:"run" }`
4. Approve the Client half box → status *running* → tools available

**Quick tests after install:**

```text
git_status workdir="C:\Users\you\Projects\my-app"          -> branch + file list
git_log    workdir="C:\Users\you\Projects\my-app" limit=5  -> recent commits
# In the Run card panel: type C:\Users\you\Projects\my-app -> Refresh
# -> green "Working tree clean" or file list
```

> **Sandbox note:** If you see `[sandbox: file access denied under workspace-write]`, the repo is outside the workspace. Retry the *exact same* tool call with `sandbox_permissions` + justification — the approval prompt is how you consent. Each call is fresh `pwsh`; never rely on `cd`.

### Install the Full Self-Updater

The host + client updater are **first-class DSH packages**, not a two-file dynamic plugin. To use them:

1. Clone this repo and copy the packages into your DSH checkout, or add them as pnpm workspaces:

   ```bash
   # in your deepseek-harness checkout
   pnpm add file:../dsh-updater-plugin/packages/host-updater
   pnpm add file:../dsh-updater-plugin/packages/client-ui-updater
   ```

2. Wire the host row (example `cordis.patch.yml` patch or add to your bundle):

   ```yaml
   add:
     updater:
       package: "@deepseek-ai/dsh-host-updater"
       config:
         buildCommand: "pnpm run build:web"
         expectedRemoteUrl: "https://github.com/<you>/<your-harness-fork>.git"
         autoApply: false
   ```

3. Mount the client page (it registers `settings.section` `updater` via `@deepseek-ai/dsh-client-ui-updater`).

4. Mount the AI tools in your agent preset (`apps/cli/config/agent-presets/standard/agent.cordis.yml`):

   ```yaml
   install:
     - package: "@deepseek-ai/dsh-host-updater/tools"
   ```

5. Build:

   ```bash
   pnpm -C packages/host/updater run build
   pnpm -C packages/client/ui-updater run build
   pnpm run build:web
   ```

6. Deploy: commit `.dsh/updater/config.json` with `autoApply: false`, restart DSH, and open **Settings → Updater**. You should see the status card + **Update with AI** button.

---

## 📖 Documentation

- [**Architecture**](docs/ARCHITECTURE.md) — engine, pipeline, planner, remotes, supervisor
- [**Install Guide**](docs/INSTALL.md) — detailed agnostic install for fresh machines

---

## ⚙️ Configuration

`.dsh/updater/config.json` (durable per deployment):

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

- `autoApply: false` is pinned for the AI flow — updates only happen through a chat session, always user-invoked.
- `expectedRemoteUrl` — if set, apply is refused when the live remote URL mismatches (safety guard).

---

## 🛡️ Safety Model

- One repo per process (`repoPath` fixed for the lifetime of the Host)
- Backup before every apply (`.dsh/updater/backups/<id>`)
- Stashes only colliding drafts; non-colliding dirty files are untouched
- Fast-forward only (`git merge --ff-only`); `ahead > 0` → `plan.blocked` → apply refused
- `upstream-overlay`: colliding draft parked at `.dsh/updater/drafts/<backupId>/<path>.local`, upstream wins
- `automerge`: stop at `conflicts` phase; per-file `resolveConflict` or `writeMerged` or `Restore`
- Byte-correct git capture (multi-chunk stdout safe), full-list classification (display capped at 400), hard cap 20k paths

---

## 🧪 Tests

```bash
pnpm -C packages/host-updater test          # 46 tests (engine + tools + regression)
pnpm -C packages/client-ui-updater test     # client build + types
```

The suite includes: Bug-A e2e (dead-apply guard), Bug-B (500+ path classification + multi-chunk capture), conflict resolution keep-local/take-upstream/writeMerged/localDraft, ahead>0 block, remote-URL guard, and restore completeness (reset + untracked snapshot + `git apply --3way`).

---

## 🤝 Feedback & Bugs

This repository is **issues-only** — pull requests are not accepted. This keeps the plugin surface stable and auditable.

- **Bug reports & feature requests:** [Open an Issue](../../issues) — use the *Bug report* or *Feature request* template.
- **Security issues:** please use the *Bug report* template and mark it as security-sensitive.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 🗂️ Repository Topics

`dsh-plugin` · `dsh` · `cordis` · `deepseek-harness` · `self-updater` · `git` · `windows` · `pwsh`

---

## 📄 License

[MIT](LICENSE) — Copyright (c) 2026 DSH Updater Plugin Contributors. No personal data is embedded in this repository; all example paths use placeholders like `C:\Users\you\Projects\my-app`.

---

## 🙏 Acknowledgments

- Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis host/client, Typert remotes, DSH tools)
- Supervisor pattern inspired by the DSH host lifecycle
