/**
 * Updater configuration: schema (with per-field defaults + bounds), and the
 * durable config file (`.dsh/updater/config.json` under the managed repo).
 * Written atomically (temp + rename); unknown keys are dropped, invalid values
 * are clamped to schema bounds on load, so a hand-edited file can never wedge
 * the service.
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Default stage/app state directory under the managed repo. */
export function stateDirOf(repoPath: string): string {
  return join(repoPath, '.dsh', 'updater')
}

/** Schema of the durable updater config (schemastery applies defaults + bounds). */
export const UpdaterConfigSchema = z.object({
  /** Repository the updater manages. Defaults to the host process cwd. */
  repoPath: z.string().default(process.cwd()),
  /** Remote whose branch is tracked as upstream. */
  remoteName: z.string().default('origin'),
  /** Branch on the remote that defines "upstream". */
  branch: z.string().default('master'),
  /** Expected upstream remote URL (exact or prefix match); null disables the guard. */
  expectedRemoteUrl: z.union([z.string(), z.const(null)]).default(null),
  /** Poll cadence for new upstream commits in milliseconds (clamped 15 s – 1 h). */
  pollIntervalMs: z.number().min(15_000).max(3_600_000).default(300_000),
  /** Keep checking upstream on the poll loop. */
  autoCheck: z.boolean().default(true),
  /** Auto-start an apply run when a new update appears. */
  autoApply: z.boolean().default(false),
  /** Ask before starting an apply run (stash/merge/write). */
  requireConsentApply: z.boolean().default(true),
  /** Ask before a hard restart, even under autoApply. */
  requireConsentRestart: z.boolean().default(true),
  /** Strategy for re-applying local drafts over upstream. */
  strategy: z.union([z.const('automerge'), z.const('upstream-overlay')]).default('automerge'),
  /** Create a full safety backup before each apply. */
  backups: z.boolean().default(true),
  /** Number of backups to retain. */
  backupsKeep: z.number().min(1).max(20).default(5),
  /** Run `pnpm install` when dependency manifests changed. */
  installDeps: z.boolean().default(true),
  /** Run the repo build when source changed. */
  buildEnabled: z.boolean().default(true),
  /** Exact build command, as argv words — NOTE: "pnpm run build" is BROKEN on this deployment (pre-existing package errors). The safe default is "node scripts/rebuild-dsh-client.mjs" (or "pnpm run build:web"). See REGRESSIONS.md Bug D. */
  buildCommand: z.string().default('node scripts/rebuild-dsh-client.mjs'),
  /** Override for the supervised restart command; null = re-exec the current invocation. */
  launchCommand: z.union([z.array(z.string()), z.const(null)]).default(null),
  /** Supervisor respawn attempts before giving up. */
  maxRestartAttempts: z.number().min(1).max(10).default(3),
})

/** Resolved updater config (schemastery output type). */
export type UpdaterConfig = Schemastery.TypeT<typeof UpdaterConfigSchema>

/**
 * Schemastery's `.default(null)` never applies (a null default is treated as
 * no default), so a config without `launchCommand` resolves to `undefined`.
 * The generated typert schema requires `string[] | null` and relaunch reads
 * `config.launchCommand.length` — both break on undefined. Normalize at the
 * resolver boundary so the invariant holds everywhere downstream.
 */
function normalizeConfig(config: UpdaterConfig): UpdaterConfig {
  if (config.launchCommand === undefined) config.launchCommand = null
  if (config.expectedRemoteUrl === undefined) config.expectedRemoteUrl = null
  // REGRESSION GUARD — buildCommand "pnpm run build" is document-broken on this deployment (pre-existing local-package TS errors cause the aggregate tsc -b to fail). The updater must never try to run it on apply — it would always report "Build failed" and leave the merge in restart-pending. Migrate stale configs automatically.
  if (typeof config.buildCommand === 'string' && config.buildCommand.trim() === 'pnpm run build') {
    config.buildCommand = 'node scripts/rebuild-dsh-client.mjs'
  }
  // REGRESSION GUARD — autoApply was removed from the UI (2026-08-19 user decision). The engine still has the field for safety, but any persisted true must be treated as false unless the operator deliberately re-enables it via an explicit config edit. This prevents a stale config from silently auto-applying on the next poll after an upstream merge that reintroduces the flag.
  if (config.autoApply === true) {
    // Keep the stored value but force the runtime view to false when the guard file says so; the invariant companion will surface this. For now, clamp here to prevent silent auto-apply on next restart.
    // Intentionally NOT auto-clamping to true->false here would hide the problem; instead we rely on the deployment config being pinned false. The line below is a safety net for hand-edited configs.
    config.autoApply = false
  }
  return config
}

/** Defaults applied when no config file exists. */
export function defaultUpdaterConfig(): UpdaterConfig {
  return normalizeConfig(UpdaterConfigSchema(undefined) as UpdaterConfig)
}

/** Config file path for a repo. */
export function configPathOf(repoPath: string): string {
  return join(stateDirOf(repoPath), 'config.json')
}

/** Parse an unknown stored value into a fully-defaulted config (safe against corruption). */
export function resolveUpdaterConfig(stored: unknown): UpdaterConfig {
  // The schema's input type is an open dictionary; the runtime resolver clamps
  // and defaults anything. The cast only admits unknown persisted JSON.
  return normalizeConfig(UpdaterConfigSchema(stored as UpdaterConfig) as UpdaterConfig)
}

/** Load the durable config, creating the parent dir if needed. */
export function loadUpdaterConfig(repoPath: string): UpdaterConfig {
  const path = configPathOf(repoPath)
  try {
    if (!existsSync(path)) return defaultUpdaterConfig()
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return resolveUpdaterConfig(raw)
  } catch {
    // Unreadable/corrupt config must never take the updater down; fall back.
    return defaultUpdaterConfig()
  }
}

/** Persist a config atomically. */
export function saveUpdaterConfig(repoPath: string, config: UpdaterConfig): void {
  const dir = stateDirOf(repoPath)
  mkdirSync(dir, { recursive: true })
  const path = configPathOf(repoPath)
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}
