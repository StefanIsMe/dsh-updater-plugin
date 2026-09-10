# @deepseek-ai/dsh-host-updater

English | [中文](README.zh.md)

Self-update orchestration for the DeepSeek Harness checkout this process is running
from. `UpdaterGateway` registers the `updater` service and publishes the generated
direct Remotes `updater/status`, `updater/check`, `updater/apply`, `updater/restore`,
`updater/setConfig`, `updater/restart`, and `updater/refresh`.

The service keeps the repository it is running FROM synchronized with an upstream
remote without ever clobbering local drafts:

1. **Check** (`git fetch` + plan): incoming commits, changed files, and three
   classifications — *install needed* (dependency manifests), *rebuild needed*
   (source changed), *restart needed* (anything outside the browser client plane).
   Draft collisions are surfaced up front: files upstream touches that have local
   drafts (`conflictRisk`) and files upstream adds that already exist locally
   (`untrackedRisk`).
2. **Apply** (the fail-proof pipeline): safety backup → stash *only the colliding
   drafts* → fast-forward merge to upstream → restore the drafts on top → optional
   `pnpm install` / build. A conflict stops the run and leaves the stash + backup
   intact; `updater/restore` returns the tree to the pre-update snapshot.
3. **Restart**: `updater/restart` (consent-gated by the caller) arms a detached
   supervisor that relaunches the exact original command, attempt-capped with a
   `dead` marker, and then stops the Host process.

Every transition is persisted to `.dsh/updater/state.json` (under the managed repo)
and emitted as the allowlisted `updater/state` event, so browser surfaces stay live.
Configuration is durable per deployment in `.dsh/updater/config.json`.

## Model Experience

### Updater session tools

#### What the model sees

When an agent preset mounts the `updater-tools` entry, ten tools enter the session toolset with their declared descriptions and parameter schemas: `updater_status`, `updater_check`, `updater_apply`, `updater_file_diff`, `updater_local_draft`, `updater_resolve_conflict`, `updater_write_merged`, `updater_restore`, `updater_restart`, and `updater_refresh`. Each is a thin adapter over the `updater` gateway — the sole executor and safety net behind the backup → stash-colliding-drafts → merge → restore pipeline — and every result is JSON: `updater_status` returns the compact status projection (phase, versions, ahead/behind, plan summary, conflicted files, backups), while each other tool returns its action outcome plus that same fresh status snapshot.

#### Token effect

The fixed tool descriptions and schemas add a constant token block to every request of a mounted session. Results are data-dependent — the status projection scales with the plan (changed files capped at 100), and `updater_file_diff`/`updater_local_draft` carry whole-file content — and are resent with each request until compaction.

#### KV Cache effect

Append-only: the toolset block is stable across requests, and each result's tokens follow the reusable prefix without editing earlier context.

### Updater guidance section

#### What the model sees

A fixed guidance section (name `tool:updater`, order 115) is injected into the same sessions, telling the model to read state, fetch and plan, apply, and resolve draft conflicts per file — never dropping a local draft silently — and closing with a mandatory post-update audit checklist. The exact injected text is quoted below.

##### Injected section text

```markdown
Use updater_status to read the self-update state, updater_check to fetch and plan, and updater_apply to run the update. When local drafts conflict with upstream changes, read the local side with updater_local_draft, compare it with the working tree / updater_file_diff, and resolve per file with updater_resolve_conflict (keep-local, take-upstream, keep-both) or write an authored merge with updater_write_merged. Never drop a local draft silently — park it or ask the user. Restore with updater_restore when something goes wrong; restart with updater_restart when the phase is restart-pending. Confirm destructive steps with the user when uncertain. MANDATORY POST-UPDATE AUDIT (2026-08-22, after rc.2 silently dropped wiring): before declaring success or calling updater_restart you MUST: (0) setConfig autoCheck:false before apply and re-enable after; (1) git grep -n -E "^(<{7}|={7}$|>{7})" over the ENTIRE repo including root tsconfigs and resolve markers; (2) verify packages/bundle/web-app/cordis.patch.yml still has updater+ui-updater rows; (3) verify api/remotes lists updater/state and mounts updaterRemote; (4) pnpm install if needed then node scripts/rebuild-dsh-client.mjs -> 0; (5) vitest every touched package -> green; (6) report all steps then restart. Skipping a step is failure even if updater reports success.
```

#### Token effect

One fixed section paragraph per request for every session that mounts the entry, independent of updater state.

#### KV Cache effect

The section is static at a fixed first-party order for the lifetime of the mount, so it stays inside the reusable prompt prefix and never invalidates earlier cache entries.

## Known Limitations and Deferred Work

- **One repo per process** — `repoPath` is fixed for the lifetime of the Host;
  changing it requires a restart.
- **Foreground apply steps** — install/build run in the Host process with a rolling
  log; very long builds block nothing (steps are async) but occupy one command slot.
- **No auto-resolve of stash-pop conflicts** — when a draft collides at the content
  level, the run stops at `conflicts` and the user resolves (or restores) explicitly;
  nothing is auto-discarded.
- **Restart is best-effort supervision** — the supervisor respawns the original
  invocation; exotic launch wrappers may need the `launchCommand` override.
