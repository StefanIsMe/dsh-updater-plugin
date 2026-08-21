/**
 * The updater runtime: one durable state machine over the managed repo plus the
 * check/apply/restore pipelines. Safe by construction:
 *   - local drafts are only ever stashed (never dropped) and the stash count is
 *     recorded, so an apply that crashed between "stash" and "pop" is
 *     detected at next boot and reported as `error`, never retried blindly;
 *   - every apply that can write starts from a backup;
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdaterConfig } from './config.ts'
import type {
  UpdaterBackupInfo, UpdaterConfigView, UpdaterLogEntry, UpdaterParkedDraft, UpdaterPhase, UpdaterPlan,
  UpdaterResult, UpdaterSnapshot,
} from './types.ts'
import { stateDirOf } from './config.ts'

/** Wire config projection. */
export function configView(config: UpdaterConfig): UpdaterConfigView {
  const {
    repoPath, remoteName, branch, expectedRemoteUrl, pollIntervalMs, autoCheck, autoApply,
    requireConsentApply, requireConsentRestart, strategy, backups, backupsKeep, installDeps,
    buildEnabled, buildCommand, launchCommand, maxRestartAttempts,
  } = config
  return {
    repoPath, remoteName, branch, expectedRemoteUrl, pollIntervalMs, autoCheck, autoApply,
    requireConsentApply, requireConsentRestart, strategy, backups, backupsKeep, installDeps,
    buildEnabled, buildCommand, launchCommand, maxRestartAttempts,
  }
}

/** Fields the engine holds and persists. */
export interface EngineState {
  phase: UpdaterPhase
  upstreamSha: string | null
  currentSha: string | null
  currentVersion: string | null
  upstreamVersion: string | null
  ahead: number
  behind: number
  dirtyCount: number
  untrackedCount: number
  lastInstallLine: string | null
  plan: UpdaterPlan | null
  progress: { stage: string; message: string } | null
  lastCheckAt: string | null
  lastApplyAt: string | null
  lastResult: UpdaterResult | null
  error: string | null
  conflictedFiles: string[]
  parkedDrafts: UpdaterParkedDraft[]
  remoteUrl: string | null
  stashRefs: string[]
  stashCount: number
  backupId: string | null
  logs: UpdaterLogEntry[]
  inProgress: boolean
  gitAvailable: boolean
  gitVersion: string | null
  pendingRestart: boolean
  restartAuthorized: boolean
  restartLast: string | null
  restartDead: boolean
}

export function initialEngineState(config: UpdaterConfig): EngineState {
  const file = join(stateDirOf(config.repoPath), 'state.json')
  const state: EngineState = {
    phase: 'idle',
    upstreamSha: null,
    currentSha: null,
    currentVersion: null,
    upstreamVersion: null,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    untrackedCount: 0,
    lastInstallLine: null,
    plan: null,
    progress: null,
    lastCheckAt: null,
    lastApplyAt: null,
    lastResult: null,
    error: null,
    conflictedFiles: [],
    parkedDrafts: [],
    remoteUrl: null,
    stashRefs: [],
    stashCount: 0,
    backupId: null,
    logs: [],
    inProgress: false,
    gitAvailable: false,
    gitVersion: null,
    pendingRestart: false,
    restartAuthorized: false,
    restartLast: null,
    restartDead: false,
  }
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<EngineState>
      if (raw.phase === 'applying' || raw.phase === undefined) {
        // A previous run died mid-apply: the stash/rebuild may be partial.
        state.phase = 'error'
        state.error = 'The previous update run did not finish. Check the repo and use "Restore" if anything looks off.'
      } else {
        state.phase = raw.phase ?? 'idle'
      }
      // REGRESSION GUARD — stale stash leak (2026-08-20): after a successful
      // writeMerged/resolveConflict the stash should be dropped. Old state.json
      // may still have stashRefs/stashCount === 1 while phase is idle/applied
      // and backupId is null. Heal by clearing when phase is settled and no
      // conflicts remain — the backup's local.patch is the restore path.
      const settled = state.phase === 'idle' || state.phase === 'applied'
      const hasStaleStash = settled && Array.isArray(raw.stashRefs) && raw.stashRefs.length > 0 && (raw.conflictedFiles === undefined || (Array.isArray(raw.conflictedFiles) && raw.conflictedFiles.length === 0)) && (raw.backupId === null || raw.backupId === undefined)
      if (hasStaleStash) {
        // Don't trust stale stashRefs after a settled phase — the draft was
        // already resolved via writeMerged/keep-local. Clear to prevent
        // stash accumulation warnings on the next apply.
        // The actual git stash list may still have the entry; the next apply's
        // countStashes will see it but dropApplyStashes will ignore unknown refs.
      }
      state.upstreamSha = raw.upstreamSha ?? null
      state.currentSha = typeof raw.currentSha === 'string' ? raw.currentSha : null
      state.currentVersion = typeof raw.currentVersion === 'string' ? raw.currentVersion : null
      state.upstreamVersion = typeof raw.upstreamVersion === 'string' ? raw.upstreamVersion : null
      state.ahead = typeof raw.ahead === 'number' ? raw.ahead : 0
      state.behind = typeof raw.behind === 'number' ? raw.behind : 0
      state.dirtyCount = typeof raw.dirtyCount === 'number' ? raw.dirtyCount : 0
      state.untrackedCount = typeof raw.untrackedCount === 'number' ? raw.untrackedCount : 0
      state.lastInstallLine = typeof raw.lastInstallLine === 'string' ? raw.lastInstallLine : null
      state.plan = (raw.plan as UpdaterPlan | null) ?? null
      state.progress = (raw.progress as { stage: string; message: string } | null) ?? null
      state.lastCheckAt = typeof raw.lastCheckAt === 'string' ? raw.lastCheckAt : null
      state.backupId = typeof raw.backupId === 'string' ? raw.backupId : null
      // logs are runtime-only by design: not restored on boot (see engine.spec.ts round-trips test)
      state.error = raw.error ?? state.error
      state.conflictedFiles = Array.isArray(raw.conflictedFiles) ? raw.conflictedFiles.filter((x): x is string => typeof x === 'string') : []
      state.parkedDrafts = Array.isArray(raw.parkedDrafts)
        ? raw.parkedDrafts.filter((d): d is UpdaterParkedDraft =>
          typeof d === 'object' && d !== null && typeof (d as UpdaterParkedDraft).path === 'string'
          && typeof (d as UpdaterParkedDraft).parkedFile === 'string')
        : []
      state.remoteUrl = typeof raw.remoteUrl === 'string' ? raw.remoteUrl : null
      // Apply stale-stash heal collected above
      if (settled && hasStaleStash) {
        state.stashRefs = []
        state.stashCount = 0
        state.backupId = null
      } else {
        state.stashRefs = Array.isArray(raw.stashRefs) ? raw.stashRefs.filter((x): x is string => typeof x === 'string') : []
        state.stashCount = typeof raw.stashCount === 'number' ? Math.max(0, raw.stashCount) : 0
      }
      state.lastApplyAt = raw.lastApplyAt ?? null
      state.lastResult = raw.lastResult ?? null
      state.pendingRestart = boolean(raw.pendingRestart)
      state.restartLast = raw.restartLast ?? null
      state.restartDead = boolean(raw.restartDead)
      // Auto-heal stale restart-pending/update-available when the persisted counters show we're actually up to date.
      // This handles upgrades from older state.json that never stored behind/currentSha.
      if ((state.phase === 'restart-pending' || state.phase === 'update-available') && state.behind === 0 && state.ahead === 0 && state.upstreamSha !== null && state.currentSha !== null && state.upstreamSha === state.currentSha) {
        state.phase = 'idle'
        state.pendingRestart = false
        state.plan = null
        state.progress = null
        state.error = null
      }
    }
  } catch {
    /* corrupt state file: keep defaults */
  }
  return state
}

function boolean(v: unknown): boolean { return v === true }

export function persistState(state: EngineState, config: UpdaterConfig): void {
  const dir = stateDirOf(config.repoPath)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  const body = JSON.stringify({
    phase: state.phase,
    upstreamSha: state.upstreamSha,
    currentSha: state.currentSha,
    currentVersion: state.currentVersion,
    upstreamVersion: state.upstreamVersion,
    ahead: state.ahead,
    behind: state.behind,
    dirtyCount: state.dirtyCount,
    untrackedCount: state.untrackedCount,
    lastInstallLine: state.lastInstallLine,
    plan: state.plan,
    progress: state.progress,
    lastCheckAt: state.lastCheckAt,
    lastApplyAt: state.lastApplyAt,
    lastResult: state.lastResult,
    error: state.error,
    conflictedFiles: state.conflictedFiles,
    parkedDrafts: state.parkedDrafts,
    remoteUrl: state.remoteUrl,
    stashRefs: state.stashRefs,
    stashCount: state.stashCount,
    backupId: state.backupId,
    logs: state.logs,
    pendingRestart: state.pendingRestart,
    restartLast: state.restartLast,
    restartDead: state.restartDead,
  }, null, 2)
  const temp = join(dir, `state.json.tmp-${process.pid}`)
  writeFileSync(temp, body + '\n')
  try {
    renameSync(temp, file)
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
  }
}

/** Build the full wire snapshot. */
export function readSnapshot(state: EngineState, config: UpdaterConfig, backups: UpdaterBackupInfo[]): UpdaterSnapshot {
  return {
    phase: state.phase,
    repoPath: config.repoPath,
    remoteName: config.remoteName,
    branch: config.branch,
    upstreamSha: state.upstreamSha,
    currentSha: state.currentSha,
    currentVersion: state.currentVersion,
    upstreamVersion: state.upstreamVersion,
    currentShort: state.currentSha === null ? null : state.currentSha.slice(0, 12),
    upstreamShort: state.upstreamSha === null ? null : state.upstreamSha.slice(0, 12),
    ahead: state.ahead,
    behind: state.behind,
    dirtyCount: state.dirtyCount,
    untrackedCount: state.untrackedCount,
    plan: state.plan,
    progress: state.progress,
    lastCheckAt: state.lastCheckAt,
    lastApplyAt: state.lastApplyAt,
    lastInstallLine: state.lastInstallLine,
    lastResult: state.lastResult,
    error: state.error,
    conflictedFiles: state.conflictedFiles,
    parkedDrafts: state.parkedDrafts,
    remoteUrl: state.remoteUrl,
    stashRefs: state.stashRefs,
    backupId: state.backupId,
    backups,
    stashCount: state.stashCount,
    logs: state.logs,
    inProgress: state.inProgress,
    gitAvailable: state.gitAvailable,
    gitVersion: state.gitVersion,
    restart: {
      pending: state.pendingRestart,
      authorized: false,
      supervised: false,
      lastRestartAt: state.restartLast,
      dead: state.restartDead,
    },
    config: configView(config),
  }
}

/** Read backup rows from disk (newest first). */
export function listBackups(config: UpdaterConfig): UpdaterBackupInfo[] {
  const dir = join(stateDirOf(config.repoPath), 'backups')
  if (!existsSync(dir)) return []
  try {
    const dirs = readdirSync(dir).filter(n => /^\d{4}-\d{2}/.test(n)).sort().reverse()
    return dirs.map((id) => {
      let createdAt = id
      try {
        const mPath = join(dir, id, 'manifest.json')
        if (existsSync(mPath)) {
          const m = JSON.parse(readFileSync(mPath, 'utf8')) as { createdAt?: string; headSha?: string | null }
          createdAt = m.createdAt ?? id
          return { id, createdAt, headSha: m.headSha ?? null, reason: 'apply' }
        }
      } catch { /* keep defaults */ }
      return { id, createdAt, headSha: null, reason: 'apply' }
    })
  } catch {
    return []
  }
}

export type { UpdaterConfigView }
