# DSH Updater Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Harness-0f1419)](https://github.com/deepseek-ai/deepseek-harness)
[![Cordis](https://img.shields.io/badge/Cordis-Plugin-1a2332)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)]()

> **Never lose a draft. Stay up to date in one click.**

**The safest way to keep your [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) deployment current — without ever overwriting your local work.**

DSH Updater Plugin is a production-grade, draft-preserving self-update system built for every DSH deployment. Whether you customize prompts, tweak tools, or run a heavily modified fork, it lets you pull upstream improvements confidently, with full visibility and zero surprises.

Works out of the box on **Windows, macOS, and Linux**. No hardcoded paths, no personal data, no lock-in — just clone, plug in, and update.

---

## Why you'll love it

| | |
|---|---|
| 🛡️ **Draft-safe by design** | Your local changes are never silently overwritten. Every update creates a full backup, stashes only the files that actually collide, and restores everything else untouched. One-click restore to the exact pre-update state. |
| 🤖 **AI-powered merging** | Hit **"Update with AI"** and let your agent do the heavy lifting. It sees a precise diff, your stashed drafts, and can keep local, take upstream, or write a merged file — and ask you questions mid-update when it matters. |
| 🖥️ **Beautiful, live UI** | A native **Settings → Updater** page shows everything at a glance: local vs upstream SHA, ahead/behind, incoming commits, what needs a rebuild or restart, and exactly which files would collide — live, with progress tails. |
| ⚡ **Deterministic & fast** | Fast-forward only, fully observable pipeline. No magic, no history rewrites. Every phase is persisted to `.dsh/updater/state.json` and emitted as an `updater/state` event. |
| 🔒 **Consent-gated** | Nothing destructive happens without your click. Apply, Restart, and Restore all require explicit confirmation. |

> **Perfect for:** anyone running DSH who has local customizations — from a single prompt tweak to a full fork — and wants upstream fixes and features without the `git pull` anxiety.

---

## ✨ What you get

### 1. Host Updater (`packages/host-updater`)
Self-update orchestration for the repo your DSH process is running from. A Cordis host service (`updater`) that safely syncs with upstream **without ever clobbering local drafts**.

**Three-step pipeline** — fail-proof, resumable, and fully persisted:

**1. Check** — `git fetch` + plan
  - Lists incoming commits & changed files
  - Classifies what the update needs:
    - *install* — dependency manifests changed (`package.json`, `pnpm-lock.yaml`)
    - *rebuild* — source changed
    - *restart* — anything outside the browser client plane
  - Surfaces draft collisions upfront:
    - `conflictRisk` — files upstream touches that you have modified locally
    - `untrackedRisk` — files upstream adds that already exist as untracked locally

**2. Apply** — backup → stash *only colliding drafts* → fast-forward merge → restore drafts → auto `pnpm install` / build when needed
  - On conflict: stops cleanly at `conflicts` phase with backup + stash intact
  - `updater/restore` rolls back to the exact pre-update snapshot

**3. Restart** — consent-gated `updater/restart` arms a detached, attempt-capped supervisor that relaunches your original command, then stops the Host

Every transition emits the allowlisted `updater/state` event, so the UI stays live. Config lives durably in `.dsh/updater/config.json`.

### 2. Client UI (`packages/client-ui-updater`)
The browser half. Registers a native **Updater** settings page (`settings.section` id: `updater`) that talks to the host `updater` Remote namespace:

- **Status card** — local/upstream SHA, ahead/behind, modified/untracked counts, last check/apply timestamps, phase indicator
- **Plan card** — incoming commits, changed-file count, `needsInstall` / `needsRebuild` / `needsRestart` classification, collision file lists
- **Consent-gated actions** — Apply, Restart, Restore each open a confirmation dialog
- **Config editor** — auto-check toggles, poll interval, build command (all persisted by host)
- **Live updates** — subscribes to `updater/state` + polls `status()` every 30s; install/build progress and conflict states render in real time
- **"Update with AI" launcher** — pick a model → new chat session → prefilled `/updater` command. The agent handles the merge intelligently while the deterministic engine stays the safety net underneath

### 3. Model Tools — the "Update DSH" Plugin Surface (`packages/host-updater/src/tools.ts`)
Mount `@deepseek-ai/dsh-host-updater/tools` in any agent preset and the model can drive the pipeline via normal tool calls:

| Tool | What it does |
|------|--------------|
| `updater_status` | Compact JSON snapshot (phase, versions, plan, backups, parked drafts) |
| `updater_check` | Fetch upstream & recompute plan |
| `updater_apply` | Run the safe apply pipeline (fire-and-forget; poll status until settled) |
| `updater_file_diff` | Unified diff for one path (HEAD vs upstream) |
| `updater_local_draft` | Your stashed local draft for one conflicted path |
| `updater_resolve_conflict` | `keep-local` \| `take-upstream` \| `keep-both` |
| `updater_write_merged` | Write an agent-authored merged file & stage it |
| `updater_restore` | Restore a pre-update safety backup |
| `updater_restart` | Arm supervised host restart |
| `updater_refresh` | Clear transient error state |
| `/updater` command | Prints current status + available verbs into the session |

The gateway remains the sole executor and safety net — backup, stash-only-collisions, ff-only merge, draft restore, conflicts/restore — so the UI, the agent, and direct remote calls all go through the same trusted path.

---

## 🚀 Quick Start

### Prerequisites

- A running **DeepSeek Harness** checkout ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness))
- **Node.js ≥18**, **pnpm**, **git**
- DSH running at `http://127.0.0.1:3080` (default)

### Install in 5 minutes

**1. Clone this plugin:**

```bash
git clone https://github.com/StefanIsMe/dsh-updater-plugin.git
cd dsh-updater-plugin
```

**2. Add it to your harness checkout:**

```bash
# from your deepseek-harness directory
pnpm add file:../dsh-updater-plugin/packages/host-updater
pnpm add file:../dsh-updater-plugin/packages/client-ui-updater
```

Or copy the packages into your harness and patch your bundle's `cordis.patch.yml`:

```yaml
add:
  updater:
    package: "@deepseek-ai/dsh-host-updater"
    config:
      buildCommand: "pnpm run build:web"
      expectedRemoteUrl: "https://github.com/<you>/<your-harness-fork>.git"
      autoApply: false
```

**3. Register the Settings page:**

Import `@deepseek-ai/dsh-client-ui-updater` in your web bundle — it auto-registers `settings.section` `updater`.

**4. Enable the AI assistant:**

In `apps/cli/config/agent-presets/standard/agent.cordis.yml`:

```yaml
install:
  - package: "@deepseek-ai/dsh-host-updater/tools"
```

**5. Build:**

```bash
pnpm -C packages/host-updater run build
pnpm -C packages/client-ui-updater run build
pnpm run build:web
```

**6. Launch:**

Restart DSH and open **Settings → Updater**. You'll see the live status card and the **Update with AI** button — you're ready.

> Need a detailed walkthrough? See the [**Installation Guide**](docs/INSTALL.md).

---

## 📖 Documentation

- [**Installation Guide**](docs/INSTALL.md) — step-by-step setup for any machine
- [**Architecture**](docs/ARCHITECTURE.md) — engine, pipeline, planner, remotes & supervisor explained

---

## ⚙️ Configuration

All settings live durably in `.dsh/updater/config.json` (per deployment, gitignored):

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

- `autoCheck` / `pollMs` — automatic upstream checks while DSH runs
- `buildCommand` — what to run after applying (e.g. rebuild the web shell)
- `expectedRemoteUrl` — safety guard: apply is refused if the live git remote doesn't match
- `autoApply` — keep `false` for the AI flow; updates only happen when you explicitly invoke them
- `strategy` — `upstream-overlay` (park colliding draft, upstream wins) or `automerge` (stop at conflicts for per-file resolution)

---

## 🛡️ Your work is always safe

- **One repo per process** — `repoPath` is fixed for the Host lifetime
- **Full backup before every apply** — `.dsh/updater/backups/<id>` with complete rollback
- **Minimal stashing** — only files that actually collide are stashed; your other dirty files are left alone
- **Fast-forward only** — `git merge --ff-only`; if you're `ahead > 0`, the plan is marked `blocked` and apply is refused (no history rewrite, ever)
- **Parked drafts** — with `upstream-overlay`, a colliding local draft is parked at `.dsh/updater/drafts/<backupId>/<path>.local` and never dropped
- **Per-file resolution** — with `automerge`, resolve each conflict with `keep-local` / `take-upstream` / `keep-both` or `writeMerged`
- **Complete restore** — resets to pre-apply HEAD, restores untracked snapshot, reapplies `local.patch --3way`, and drops only the apply's own stashes (verified)
- **Hardened execution** — byte-correct `git capture` (multi-chunk safe), full-list classification (display capped at 400, hard cap 20k), and a detached, attempt-capped supervisor with a `dead` marker for restarts

---

## 🧪 Tested, reliable

```bash
pnpm -C packages/host-updater test          # 46 tests (engine + tools + regression)
pnpm -C packages/client-ui-updater test     # client build + types
```

Coverage includes: dead-apply guard (Bug A), 500+ path classification + multi-chunk capture (Bug B), per-file conflict resolution (`keep-local` / `take-upstream` / `writeMerged` / `localDraft`), `ahead > 0` blocking, remote-URL guard, and restore completeness (reset + untracked snapshot + `git apply --3way`).

---

## 🤝 Feedback & Ideas

We'd love to hear from you! This repository is **issues-only** to keep the plugin surface stable and auditable — pull requests are automatically closed with guidance.

- **Found a bug or have an idea?** → [Open an Issue](../../issues) using the *Bug report* or *Feature request* template
- **Security concern?** → open a Bug report and add the `security` label (please don't post exploits publicly)

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 🗂️ Topics

`dsh-plugin` · `dsh` · `cordis` · `deepseek-harness` · `self-updater`

---

## 📄 License

[MIT](LICENSE) — Copyright (c) 2026 DSH Updater Plugin Contributors.

---

## 🙏 Acknowledgments

- Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — Cordis host/client, Typert remotes, and DSH tools
- Supervisor lifecycle inspired by the DSH host
