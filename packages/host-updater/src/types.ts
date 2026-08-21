/**
 * Wire vocabulary of the updater domain: plan, snapshot, outcome, and config
 * view types plus the Host's `updater/state` event declaration. Types only —
 * no runtime code, and nothing here reaches a Host-only symbol, so this file is
 * safe for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-host-updater/types
 */

/**
 * Lifecycle state of the updater state machine.
 */
export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'applying'
  | 'conflicts'
  | 'applied'
  | 'error'
  | 'restart-pending'

/** Merge strategy an apply run follows. */
export type UpdaterStrategy = 'automerge' | 'upstream-overlay'

/** One incoming upstream commit (best-effort short metadata). */
export interface UpdaterCommit {
  readonly sha: string
  readonly short: string
  readonly subject: string
  readonly author: string
  readonly date: string
}

/** Add/delete line counts of one changed path (`git diff --numstat`). */
export interface UpdaterFileStat {
  readonly path: string
  readonly added: number
  readonly deleted: number
}

/** A local draft parked (never dropped) during an upstream-overlay apply. */
export interface UpdaterParkedDraft {
  readonly path: string
  readonly parkedAt: string
  readonly stashRef: string | null
  /** Relative path of the parked copy under `.dsh/updater/drafts/`. */
  readonly parkedFile: string
}

/** One point-in-time safety backup of the pre-apply working tree. */
export interface UpdaterBackupInfo {
  readonly id: string
  readonly createdAt: string
  readonly reason: string
  readonly headSha: string | null
  readonly note?: string
}

/** One line of the updater operation log. */
export interface UpdaterLogEntry {
  readonly at: string
  readonly level: 'info' | 'warn' | 'error' | 'ok'
  readonly message: string
}

/** Progress stage of a running apply run. */
export interface UpdaterProgress {
  readonly stage: string
  readonly message: string
}

/** Complete plan for one available update, computed after a fetch. */
export interface UpdaterPlan {
  readonly incomingCount: number
  readonly incomingCommits: readonly UpdaterCommit[]
  readonly commitsTruncated: boolean
  /** Display list of changed paths (bounded; see changedFilesTruncated). */
  readonly changedFiles: readonly string[]
  readonly changedFilesTruncated: boolean
  /** Per-path add/delete stats for the displayed files (best-effort, bounded). */
  readonly fileStats: readonly UpdaterFileStat[]
  /** Upstream-modified files that the working tree also has local drafts in. */
  readonly conflictRisk: readonly string[]
  /** Upstream-added files that the working tree already has as untracked paths. */
  readonly untrackedRisk: readonly string[]
  readonly needsInstall: boolean
  readonly needsRebuild: boolean
  readonly needsRestart: boolean
  readonly strategy: UpdaterStrategy
  /** Non-null when the update cannot be applied (e.g. local commits ahead). */
  readonly blocked: string | null
}

/** Result of the last completed apply run. */
export interface UpdaterResult {
  readonly ok: boolean
  readonly at: string
  readonly message: string
}

/** Restart orchestration state exposed to the UI. */
export interface UpdaterRestart {
  readonly pending: boolean
  readonly authorized: boolean
  readonly supervised: boolean
  readonly lastRestartAt: string | null
  readonly dead: boolean
}

/** Effective config, as the UI renders it. */
export interface UpdaterConfigView {
  readonly repoPath: string
  readonly remoteName: string
  readonly branch: string
  /** Expected upstream remote URL (exact or prefix match); null = no guard. */
  readonly expectedRemoteUrl: string | null
  readonly pollIntervalMs: number
  readonly autoCheck: boolean
  readonly autoApply: boolean
  readonly requireConsentApply: boolean
  readonly requireConsentRestart: boolean
  readonly strategy: UpdaterStrategy
  readonly backups: boolean
  readonly backupsKeep: number
  readonly installDeps: boolean
  readonly buildEnabled: boolean
  readonly buildCommand: string
  readonly launchCommand: readonly string[] | null
  readonly maxRestartAttempts: number
}

/** Point-in-time snapshot served by the updater Remote and pushed on every transition. */
export interface UpdaterSnapshot {
  readonly phase: UpdaterPhase
  readonly repoPath: string
  readonly branch: string
  readonly remoteName: string
  /** Human-readable DSH version of the local checkout (root package.json `version`). */
  readonly currentVersion: string | null
  /** Human-readable DSH version of upstream HEAD (root package.json `version` at the fetched ref). */
  readonly upstreamVersion: string | null
  readonly currentSha: string | null
  readonly upstreamSha: string | null
  readonly currentShort: string | null
  readonly upstreamShort: string | null
  readonly ahead: number
  readonly behind: number
  readonly dirtyCount: number
  readonly untrackedCount: number
  readonly plan: UpdaterPlan | null
  readonly inProgress: boolean
  readonly progress: UpdaterProgress | null
  readonly lastCheckAt: string | null
  readonly lastApplyAt: string | null
  /** Tail line of the last install/build step (for the UI). */
  readonly lastInstallLine: string | null
  readonly lastResult: UpdaterResult | null
  readonly error: string | null
  readonly conflictedFiles: readonly string[]
  /** Local drafts parked (never dropped) by an upstream-overlay apply. */
  readonly parkedDrafts: readonly UpdaterParkedDraft[]
  /** Actual remote URL of the tracked remote (for the URL guard + display). */
  readonly remoteUrl: string | null
  /** Stashes the last apply recorded; kept for conflict resolution. */
  readonly stashRefs: readonly string[]
  /** Number of stashes the last apply left on the stack (drafts held aside). */
  readonly stashCount: number
  /** Backup id tied to the current apply/conflict, if any. */
  readonly backupId: string | null
  readonly backups: readonly UpdaterBackupInfo[]
  readonly logs: readonly UpdaterLogEntry[]
  readonly config: UpdaterConfigView
  readonly restart: UpdaterRestart
  readonly gitAvailable: boolean
  readonly gitVersion: string | null
}

/** Outcome of one client-initiated updater action. */
export type UpdaterAction =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string }

/** Bounded unified diff of one path (plan detail), or null when unchanged. */
export type UpdaterFileDiff = {
  readonly ok: boolean
  readonly message: string
  readonly diff: string | null
}

/** The stashed local draft of one conflicted path (agent merge input). */
export type UpdaterLocalDraft = {
  readonly ok: boolean
  readonly message: string
  /** Full working-tree content of the local draft, or null when none is recorded. */
  readonly content: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Any updater transition: phase, plan, progress, logs. Forwarded to
     * browsers verbatim through the API_REMOTE_FORWARDED_EVENTS allowlist.
     * @param snapshot - the new full snapshot.
     * @mode emit
     */
    'updater/state'(snapshot: UpdaterSnapshot): void
  }
}
