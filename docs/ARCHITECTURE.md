# Architecture

This document explains how the DSH Updater Plugin is structured so a fresh machine can understand it without personal context.

## Overview

```
Host Engine (deterministic, safety-first)
  .dsh/updater/config.json  → durable deployment config
  .dsh/updater/state.json   → persisted engine snapshot (phase, plan, backups, parkedDrafts)
  git (via shell)           → fetch, diff, stash, merge, restore
        │
        ├── Check:  git fetch + plan (classify install/rebuild/restart, collision detection)
        ├── Apply:  backup → stash-only-collisions → ff-only merge → restore drafts → install/build
        ├── Conflicts: per-file resolve (keep-local / take-upstream / keep-both / writeMerged)
        └── Restore: reset to pre-apply HEAD + untracked snapshot + local.patch --3way + drop stashes

Agent Tools (the "Update DSH" plugin surface mounted in every session)
  updater_status / check / apply / file_diff / local_draft / resolve_conflict / write_merged / restore / restart / refresh
  + /updater command (prefills status + verbs into the session)

Client
  Settings → Updater: live status card + plan card + "Update with AI" launcher (model picker → new session → prefilled /updater)
  Nav badge (StateDot) when an update is available or in a conflict/error state
  Events: updater/state forwarded via api-remotes; polling fallback every 30s
```

## Host packages

### `packages/host-updater/src`

- **`types.ts`** — wire types: `UpdaterFileStat`, `UpdaterParkedDraft`, `UpdaterFileDiff`, `UpdaterPlan` (fileStats + blocked), `UpdaterSnapshot` (parkedDrafts + remoteUrl + stashRefs), `UpdaterConfigView`.
- **`config.ts`** — `UpdaterConfigSchema` (zod/schemastery), normalization, `.dsh/updater/config.json` load/save, `.dsh/updater/state.json` state dir resolution, `expectedRemoteUrl` guard.
- **`engine.ts`** — `EngineState` persistence, snapshot projection, backup/parkedDraft bookkeeping, configView exposure.
- **`plan.ts`** — `computePlan(fullList)` on the **full** changed set; `fileStats` / `blocked` pass-through; `parseNumstat`; `capPaths(paths, cap)` parameterized; display cap 400, hard cap 20k.
- **`pipeline.ts`** — stash helpers (`pushDraftStashes` returns `{created, refs}`, untracked-first), overlay parking (`writeParkedDraft`), `unmergedPaths`, `restoreUntrackedSnapshot`, `applyLocalPatch` (`--3way`), `dropApplyStashes`, `runLongCommand`.
- **`git.ts`** — single `capture()` primitive with correct byte accumulation (`size += buf.length`) and `maxBytes` capping, so multi-chunk stdout is never truncated.
- **`index.ts` (Gateway)** — `UpdaterGateway extends TypertRemoteService`, Remotes: `updater/status`, `check`, `apply`, `restore`, `setConfig`, `restart`, `refresh`, plus `resolveConflict`, `fileDiff`, `writeMerged`, `localDraft`. Fixes Bug A (`runCheck`/`performCheck` split while holding the applying lock) and Bug B (classify on full list, cap only display). Strategy wiring incl. `parkedDrafts` + `remoteUrl`/`expectedRemoteUrl` guard + boot residual-conflict probe.
- **`tools.ts`** — model-facing adapters (`defineTool` via `@deepseek-ai/dsh-tools`): `updater_status`, `check`, `apply`, `file_diff`, `local_draft`, `resolve_conflict`, `write_merged`, `restore`, `restart`, `refresh`; `tool:updater` system-prompt section; `/updater` command; mounted in `standard` agent preset. Thin wrappers — gateway is the sole executor.
- **`relaunch.ts` + `supervisor/supervisor.mjs`** — detached supervisor that relaunches the original command, attempt-capped with a `dead` marker.

### `packages/client-ui-updater/src`

- **`client/UpdaterSection.tsx`** — settings page: status/plan cards, consent dialogs for Apply/Restart/Restore, config editor (autoCheck/poll/build; **no** autoApply — removed per design), live subscription to `updater/state` + 30s poll fallback.
- **`client/updater-store.ts`** — Zustand-like local store bridging remotes to the UI.
- **`client/locales.ts`** — en/zh strings.
- **`client/UpdaterSection.module.css`** — scoped styles.

## Strategies

- **`upstream-overlay`** — colliding local draft is parked under `.dsh/updater/drafts/<backupId>/<path>.local` (never dropped), upstream wins.
- **`automerge`** — stash+pop; on content conflict stop at `conflicts` phase; per-file `resolveConflict` or `writeMerged` or `restore`.

## Safety invariants

- Local drafts are never lost: backup + stash refs + parked drafts + untracked snapshot.
- Restore is complete: reset to pre-apply HEAD, copy back `untracked/` snapshot, `git apply --3way local.patch`, drop only the apply's own stashes (verified).
- `ahead > 0` → `plan.blocked`; apply refuses (never rewrites history).
- `expectedRemoteUrl` mismatch → apply refused.
- Boot recovery: residual unmerged files surfaced into `conflictedFiles`.

## Discovery topics

`dsh-plugin` · `dsh` · `cordis` — primary GitHub topics for search. Also `self-updater`, `deepseek-harness`.

