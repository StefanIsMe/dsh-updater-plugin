/**
 * Updater gateway — the self-update service of a DeepSeek Harness deployment.
 *
 * It keeps the repository it is running FROM synchronized with an upstream
 * remote, in near-real time, without ever clobbering local drafts:
 *
 *   1. a poll loop does a cheap `git ls-remote` and, on SHA change, a fetch +
 *      plan (incoming commits, changed files, draft collisions, install /
 *      rebuild / restart classification);
 *   2. `apply()` runs the fail-proof pipeline: backup → stash-only-the-
 *      collisions → fast-forward upstream → restore the drafts on top →
 *      optional install/build → restart-pending classification. Under the
 *      `upstream-overlay` strategy a draft that cannot be re-applied cleanly
 *      is parked under `.dsh/updater/drafts/` (never dropped) and the upstream
 *      version wins; under `automerge` it stops at the `conflicts` phase and
 *      per-file resolution (`resolveConflict`) or Restore is the escape hatch;
 *   3. every transition is persisted to `.dsh/updater/state.json` and emitted
 *      as the allowlisted `updater/state` event, so the UI is always live;
 *   4. `restart()` arms a detached supervisor and then the Host process stops
 *      — the supervisor brings DSH back up (attempt-capped + liveness-cleared).
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runGit, resolveHead, readMergeHead } from './git.ts'
import { capPaths, computePlan, parseCommits, parseNumstat } from './plan.ts'
import type { UpdaterFileDiff, UpdaterLocalDraft, UpdaterPlan, UpdaterSnapshot } from './types.ts'
import {
  UpdaterConfigSchema, loadUpdaterConfig, resolveUpdaterConfig, saveUpdaterConfig, stateDirOf,
} from './config.ts'
import type { UpdaterConfig } from './config.ts'
import { initialEngineState, listBackups, persistState, readSnapshot, type EngineState } from './engine.ts'
import {
  applyLocalPatch, countStashes, createBackup, dropApplyStashes, parseCommandLine,
  pushDraftStashes, readBackupMeta, restoreUntrackedSnapshot, runLongCommand, scanWorkingTree,
  unmergedPaths, unstashN, writeParkedDraft,
} from './pipeline.ts'
import { armSupervisor } from './relaunch.ts'
import type { UpdaterAction, UpdaterConfigView, UpdaterParkedDraft } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The updater gateway service (`updater` host row). */
    updater: UpdaterGateway
  }
}

const GIT_TIMEOUT_MS = 60_000

/** Hard cap on paths fed to classification (pathological repos); beyond it, auto-apply is refused. */
const HARD_PATH_CAP = 20_000
/** Display cap for the changed-file list on the wire. */
const DISPLAY_CAP = 400

/** Read the root `version` field from a local `package.json` (working tree). */
function readLocalVersion(repoPath: string): string | null {
  try {
    const pkgPath = join(repoPath, 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null
  } catch {
    return null
  }
}

/** Read the root `version` field from an upstream ref via `git show`. */
async function readRefVersion(repoPath: string, ref: string): Promise<string | null> {
  const res = await runGit(repoPath, ['show', `${ref}:package.json`], { timeoutMs: 30_000 })
  if (res.code !== 0) return null
  try {
    const pkg = JSON.parse(res.stdout) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * The updater host service.
 */
export class UpdaterGateway extends TypertRemoteService {
  static inject = []

  /** Loader validation: the full row config schema, fully defaulted per field. */
  static Config: z<UpdaterConfig> = UpdaterConfigSchema

  private config: UpdaterConfig
  private readonly state: EngineState
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private readonly checking = { value: false }
  private readonly applying = { value: false }
  private disposed = false

  /** @param ctx - Host context. @param rowConfig - validated row configuration. */
  constructor(ctx: Context, rowConfig: UpdaterConfig) {
    super(ctx, 'updater')
    const repoPath = typeof rowConfig?.repoPath === 'string' && rowConfig.repoPath.length > 0
      ? rowConfig.repoPath
      : process.cwd()
    this.config = loadUpdaterConfig(repoPath)
    this.state = initialEngineState(this.config)
    this.state.currentVersion = readLocalVersion(repoPath)
    this.state.gitAvailable = false
    this.state.gitVersion = null
    this.state.logs = []
    this.state.inProgress = false

    // Probe git availability + any residual unmerged entries asynchronously;
    // the first status() may precede it. Always run one reconciling check on boot
    // so a stale restart-pending/update-available flips to idle automatically even
    // when autoCheck is off — the next poll (if any) is still driven by schedulePoll.
    // Skipped under Vitest to keep the updater tests deterministic (they drive checks manually).
    void this.probeGit().then(async () => {
      await this.probeResidualConflicts()
      this.pub()
      if (!this.disposed && (process.env as unknown as Record<string, string>).VITEST !== 'true' && (process.env as unknown as Record<string, string>).NODE_ENV !== 'test') {
        // Only auto-reconcile stale update-available/restart-pending, not conflicts/error.
        if (this.state.phase === 'update-available' || this.state.phase === 'restart-pending') {
          void this.runCheck(false).catch(() => {})
        }
      }
    })

    if (this.config.autoCheck && !this.disposed) {
      this.schedulePoll()
    }
    ctx.effect(() => () => {
      this.disposed = true
      if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    }, 'updater.dispose')
  }

  // ── internal plumbing ──────────────────────────────────────────────

  private async probeGit(): Promise<void> {
    const res = await runGit(this.config.repoPath, ['--version'], { timeoutMs: 15_000 })
    if (res.code === 0) {
      this.state.gitAvailable = true
      this.state.gitVersion = res.stdout.trim().split('\n')[0] ?? null
    } else {
      this.state.gitAvailable = false
      this.state.gitVersion = null
      this.state.error = `git is not available: ${res.stderr.trim() || res.stdout.trim() || 'unknown'}`
    }
  }

  /** Surface residual unmerged files when booting into a conflict/error state. */
  private async probeResidualConflicts(): Promise<void> {
    if (this.state.phase !== 'error' && this.state.phase !== 'conflicts') return
    if (!this.state.gitAvailable) return
    const unmerged = await unmergedPaths(this.config.repoPath)
    if (unmerged.length > 0) this.state.conflictedFiles = unmerged
  }

  /** Persist + emit a fresh snapshot. */
  private pub(): void {
    persistState(this.state, this.config)
    this.ctx.emit('updater/state', readSnapshot(this.state, this.config, listBackups(this.config)))
  }

  /** Append a log line and bounce a snapshot. */
  private log(message: string): void {
    this.state.logs = [...this.state.logs.slice(-(400 - 1)), {
      at: new Date().toISOString(),
      level: 'info',
      message: message.slice(0, 2000),
    }]
  }

  private progress(stage: string, message: string): void {
    this.state.progress = { stage, message }
    this.pub()
  }

  private setPhase(phase: EngineState['phase']): void {
    this.state.phase = phase
    this.pub()
  }

  private schedulePoll(): void {
    if (this.disposed || !this.config.autoCheck) return
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    const ms = Math.max(15_000, Math.min(3_600_000, this.config.pollIntervalMs))
    this.pollTimer = setTimeout(() => { void this.tick() }, ms)
  }

  /** One automatic poll tick: check; apply only when autoApply + no consent barrier. */
  private async tick(): Promise<void> {
    try {
      await this.runCheck(false)
      const plan = this.state.plan
      if (this.state.phase === 'update-available'
        && plan !== null && plan.blocked === null
        && this.config.autoApply
        && !this.config.requireConsentApply) {
        await this.runApply()
      }
    } catch (error) {
      this.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
      this.pub()
    } finally {
      this.schedulePoll()
    }
  }

  // ── the check pipeline ─────────────────────────────────────────────

  /**
   * Guarded check entry: acquires the checking lock, runs {@link performCheck},
   * and bounces a snapshot. `manual` promotes transient failures to the `error`
   * phase (auto ticks keep the previous phase on a network blip).
   *
   * REGRESSION GUARD — Bug A (2026-08-19): runApply MUST call performCheck
   * directly while holding the applying lock. The old runApply called runCheck,
   * which refused itself on `this.applying.value` and made every Apply a
   * silent no-op ("already running", no log, no event). The split
   * runCheck(guard) / performCheck(no guard) is intentional — do NOT collapse it.
   */
  private async runCheck(manual: boolean): Promise<UpdaterAction> {
    if (this.checking.value || this.applying.value) {
      return { ok: false, message: 'A check or apply is already running.' }
    }
    this.checking.value = true
    this.state.inProgress = true
    try {
      return await this.performCheck(manual)
    } finally {
      this.checking.value = false
      this.state.inProgress = this.applying.value
      this.pub()
    }
  }

  /**
   * The actual fetch + replan work, WITHOUT the mutual-exclusion guard: the
   * caller owns the lock it runs under. `runCheck` guards it for the Remote/
   * poll faces; `runApply` calls it directly while holding the applying lock
   * (a check that refuses itself would make every apply a silent no-op).
   *
   * REGRESSION GUARD — Bug A companion: see runCheck above. This method has no
   * guard on purpose; any future guard added here will re-break Apply.
   * REGRESSION GUARD — Bug B: the plan is built on the FULL change set
   * (classificationPaths = changedAll unless >20k). DISPLAY_CAP (400) only
   * caps the wire display list AFTER computePlan. See plan.ts and git.ts guards.
   */
  private async performCheck(manual: boolean): Promise<UpdaterAction> {
    this.state.inProgress = true
    const { repoPath, remoteName, branch } = this.config
    try {
      if (!this.state.gitAvailable) await this.probeGit()
      if (!this.state.gitAvailable) {
        this.state.error = 'git is not available for this repository.'
        this.setPhase('error')
        return { ok: false, message: 'git is not available.' }
      }
      this.progress('fetch', `Fetching ${remoteName}/${branch}…`)
      this.log(`check: fetching ${remoteName}`)
      const fetchRes = await runGit(repoPath, ['fetch', '--prune', remoteName], { timeoutMs: GIT_TIMEOUT_MS })
      if (fetchRes.code !== 0) {
        this.state.error = `Fetch failed: ${fetchRes.stderr.trim() || fetchRes.stdout.trim() || 'unknown'}`
        this.log(this.state.error)
        if (manual) this.setPhase('error')
        else this.pub()
        return { ok: false, message: `Fetch failed: ${fetchRes.stderr.trim() || 'unknown'}` }
      }
      const upstreamRef = `${remoteName}/${branch}`
      const upstreamRes = await runGit(repoPath, ['rev-parse', upstreamRef], { timeoutMs: 20_000 })
      const upstreamSha = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null
      // Human-readable versions for the UI: local working tree + upstream ref.
      this.state.currentVersion = readLocalVersion(repoPath)
      this.state.upstreamVersion = upstreamSha === null ? null : await readRefVersion(repoPath, upstreamRef)
      const head = await resolveHead(repoPath)
      const aheadRes = await runGit(repoPath, ['rev-list', '--count', `${upstreamRef}..HEAD`], { timeoutMs: 20_000 })
      const behindRes = upstreamSha === null
        ? null
        : await runGit(repoPath, ['rev-list', '--count', `HEAD..${upstreamRef}`], { timeoutMs: 20_000 })
      const aheadCount = Number.parseInt(aheadRes.stdout.trim() || '0', 10)
      const behindCount = behindRes === null ? 0 : Number.parseInt(behindRes.stdout.trim() || '0', 10)

      const scan = await scanWorkingTree(repoPath)
      const remoteUrl = await this.readRemoteUrl(repoPath, remoteName)
      this.state.currentSha = head
      this.state.dirtyCount = scan.dirtyTracked.length
      this.state.untrackedCount = scan.untracked.length
      this.state.upstreamSha = upstreamSha
      this.state.remoteUrl = remoteUrl
      this.state.ahead = aheadCount
      this.state.behind = behindCount
      this.state.lastCheckAt = new Date().toISOString()
      this.state.error = null

      const upToDate = upstreamSha !== null && upstreamSha === head && behindCount === 0
      if (upToDate) {
        this.state.plan = null
        this.state.progress = null
        this.state.pendingRestart = false
        this.state.error = null
        // Bug F (2026-08-22): a fast-forward that stopped at stash-pop
        // conflicts leaves HEAD equal to upstream while the index still holds
        // unmerged drafts. Demoting the phase to idle here stranded
        // resolution — resolveConflict/writeMerged refuse outside the
        // conflicts phase — so the hourly poll silently disabled the escape
        // hatches mid-resolution. Unmerged paths mean the state is NOT idle:
        // keep/restore the conflicts phase, refresh the file list, and say so.
        const unmerged = await unmergedPaths(repoPath)
        if (unmerged.length > 0) {
          this.state.conflictedFiles = [...new Set([...this.state.conflictedFiles, ...unmerged])]
          if (this.state.phase !== 'conflicts') this.setPhase('conflicts')
          this.log(`check: up to date but ${unmerged.length} conflicted draft(s) await resolution`)
          return { ok: false, message: `Up to date, but ${unmerged.length} conflicted draft(s) still need resolution.` }
        }
        this.log('check: up to date')
        this.setPhase('idle')
        return { ok: true, message: 'Up to date.' }
      }
      if (upstreamSha === null) {
        this.state.error = 'Upstream branch not found; is the remote configured?'
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }

      // Reasons the update cannot be applied (never auto-apply through these).
      let blocked: string | null = aheadCount > 0
        ? `Local commits exist (${aheadCount} ahead of upstream). The updater never rewrites history — merge or reset locally before applying.`
        : null
      if (blocked === null) blocked = this.remoteGuard(remoteUrl)

      // Build the plan on the FULL change set; only the wire display list is capped.
      const raw = await runGit(
        repoPath,
        ['log', '--format=%H%x09%an%x09%aI%x09%s', '-n', '30', `HEAD..${upstreamRef}`],
        { timeoutMs: 30_000 },
      )
      const commits = parseCommits(raw.stdout)
      const commitsTruncated = behindCount > commits.length
      const changed = await runGit(
        repoPath,
        ['diff', '--name-only', 'HEAD', upstreamRef],
        { timeoutMs: 30_000 },
      )
      const added = await runGit(
        repoPath,
        ['diff', '--name-only', '--diff-filter=A', 'HEAD', upstreamRef],
        { timeoutMs: 30_000 },
      )
      const numstat = await runGit(repoPath, ['diff', '--numstat', 'HEAD', upstreamRef], { timeoutMs: 60_000 })
      const changedAll = changed.stdout.split('\n').map(p => p.trim()).filter(p => p.length > 0)
      const addedPaths = added.stdout.split('\n').map(p => p.trim()).filter(p => p.length > 0)
      const fileStats = parseNumstat(numstat.stdout)
      const classificationPaths = changedAll.length > HARD_PATH_CAP ? changedAll.slice(0, HARD_PATH_CAP) : changedAll
      const plan: UpdaterPlan = computePlan({
        currentSha: head ?? '',
        upstreamSha,
        strategy: this.config.strategy,
        changedPaths: classificationPaths,
        addedPaths,
        dirtyTracked: scan.dirtyTracked,
        untrackedPaths: scan.untracked,
        commits,
        commitsTruncated,
        fileStats,
        blocked,
      })
      const capped = capPaths(plan.changedFiles, DISPLAY_CAP)
      this.state.plan = {
        ...plan,
        changedFiles: capped.paths,
        changedFilesTruncated: capped.truncated || changedAll.length > HARD_PATH_CAP,
      }
      this.state.progress = null
      this.log(`check: ${behindCount} commit(s) behind upstream`)
      this.setPhase('update-available')
      return { ok: true, message: `Update available (${behindCount} commit(s) behind).` }
    } catch (error) {
      this.state.error = `Check failed: ${error instanceof Error ? error.message : String(error)}`
      this.log(this.state.error)
      if (manual) this.setPhase('error')
      this.pub()
      return { ok: false, message: this.state.error }
    }
  }

  /** Actual remote URL of the tracked remote, or null. */
  private async readRemoteUrl(repoPath: string, remoteName: string): Promise<string | null> {
    const res = await runGit(repoPath, ['remote', 'get-url', remoteName], { timeoutMs: 15_000 })
    return res.code === 0 && res.stdout.trim().length > 0 ? res.stdout.trim().split('\n')[0] ?? null : null
  }

  /** Expected-URL guard: null when satisfied or unconfigured, else a block reason. */
  private remoteGuard(remoteUrl: string | null): string | null {
    const expected = this.config.expectedRemoteUrl
    if (expected === null || expected.length === 0) return null
    if (remoteUrl === null) {
      return 'Cannot verify the upstream remote URL (git remote get-url failed). Auto-apply is disabled until this is reviewed.'
    }
    const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\.git$/, '').replace(/\/+$/, '')
    const actual = norm(remoteUrl)
    const want = norm(expected)
    if (actual === want || actual.startsWith(want)) return null
    return `Upstream remote URL changed (expected "${expected}", found "${remoteUrl}"). Auto-apply is disabled until this is reviewed.`
  }

  // ── the apply pipeline ─────────────────────────────────────────────

  /** Apply the pending update (fire-and-forget; progress follows via events). */
  private async runApply(): Promise<UpdaterAction> {
    if (this.applying.value) return { ok: false, message: 'An apply is already running.' }
    if (this.checking.value) return { ok: false, message: 'A check is running; wait a moment.' }
    this.applying.value = true
    this.state.inProgress = true
    const { repoPath, remoteName, branch } = this.config
    const upstreamRef = `${remoteName}/${branch}`
    const startedAt = new Date().toISOString()
    try {
      // 1 — ensure a fresh plan. The check runs under the applying lock we
      //     already hold (performCheck has no guard of its own).
      this.log('apply: starting')
      const checkRes = await this.performCheck(false)
      if (!checkRes.ok) return checkRes
      if (this.state.plan === null) {
        this.setPhase('idle')
        return { ok: false, message: 'Nothing to apply.' }
      }
      const plan = this.state.plan
      if (plan.blocked !== null) {
        this.state.error = plan.blocked
        this.setPhase('update-available')
        return { ok: false, message: plan.blocked }
      }
      this.bumpForApply()
      this.setPhase('applying')

      // 2 — bail out if git already has an operation in progress.
      const mergeHead = readMergeHead(repoPath)
      if (mergeHead !== null) {
        this.state.conflictedFiles = await unmergedPaths(repoPath)
        this.setPhase('conflicts')
        return { ok: false, message: 'A previous merge is still in progress; resolve or restore it first.' }
      }

      // 3 — backup.
      const headBefore = await resolveHead(repoPath)
      const stashBefore = await countStashes(repoPath)
      this.progress('backup', 'Creating a safety backup…')
      const backupId = await createBackup(repoPath, this.config, {
        headSha: headBefore,
        stashCount: stashBefore,
        conflictRisk: plan.conflictRisk,
        untrackedRisk: plan.untrackedRisk,
      })
      this.state.backupId = backupId
      this.pub()

      // 4 — stash only the drafts that would collide.
      if (plan.conflictRisk.length > 0 || plan.untrackedRisk.length > 0) {
        this.progress('stash', `Setting aside ${plan.conflictRisk.length + plan.untrackedRisk.length} local draft(s)…`)
        try {
          const created = await pushDraftStashes(repoPath, plan.conflictRisk, plan.untrackedRisk, backupId.slice(0, 17))
          this.state.stashCount = created.created
          this.state.stashRefs = created.refs
          this.log(`apply: stashed ${created.created} draft(s)`)
        } catch (error) {
          this.state.stashCount = (await countStashes(repoPath)) - stashBefore
          this.state.error = error instanceof Error ? error.message : String(error)
          this.setPhase('error')
          return { ok: false, message: `Pre-merge stash failed: ${this.state.error}` }
        }
      }

      // 5 — fast-forward to upstream.
      this.progress('merge', `Merging upstream ${upstreamRef}…`)
      const mergeRes = await runGit(repoPath, ['merge', '--ff-only', upstreamRef], { timeoutMs: 120_000 })
      if (mergeRes.code !== 0) {
        // Undo — pull the drafts back off the stack.
        if (this.state.stashCount > 0) await unstashN(repoPath, this.state.stashCount)
        this.state.stashCount = (await countStashes(repoPath)) - stashBefore
        this.state.error = `Merge failed: ${mergeRes.stderr.trim() || mergeRes.stdout.trim() || 'unknown'}`
        this.log(this.state.error)
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }
      const headAfter = await resolveHead(repoPath)
      const upstreamSha = await runGit(repoPath, ['rev-parse', upstreamRef], { timeoutMs: 20_000 })
      if (headAfter === null || upstreamSha.stdout.trim() !== headAfter) {
        this.state.error = 'Merge did not reach the upstream commit; review the repository.'
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }

      // 6 — restore the drafts on top of upstream.
      if (this.state.stashCount > 0) {
        this.progress('restore-drafts', 'Re-applying local drafts…')
        const overlay = this.config.strategy === 'upstream-overlay'
        const { conflicts, parked } = await unstashN(repoPath, this.state.stashCount, {
          overlay,
          stateDir: stateDirOf(repoPath),
          backupId,
          onParked: (path, parkedFile, stashRef) => {
            this.state.parkedDrafts = [...this.state.parkedDrafts, {
              path, parkedAt: new Date().toISOString(), stashRef, parkedFile,
            } satisfies UpdaterParkedDraft]
          },
        })
        this.state.stashCount = Math.max(0, (await countStashes(repoPath)) - stashBefore)
        const unmerged = await unmergedPaths(repoPath)
        if (!overlay && (conflicts.length > 0 || unmerged.length > 0)) {
          this.state.conflictedFiles = unmerged.length > 0 ? unmerged : conflicts
          this.state.error = 'Some local drafts conflict with the update. Resolve them or restore the backup.'
          this.log(`apply: stash pop conflicts: ${this.state.conflictedFiles.join(', ')}`)
          this.setPhase('conflicts')
          return { ok: false, message: 'Update merged; local drafts need conflict resolution.' }
        }
        if (parked.length > 0) {
          this.log(`apply: parked ${parked.length} draft(s) under .dsh/updater/drafts (upstream-overlay)`)
        }
      }

      // 7 — verify.
      const verified = await resolveHead(repoPath)
      if (verified === null || verified !== upstreamSha.stdout.trim()) {
        this.state.error = 'Verification failed after merge.'
        this.setPhase('error')
        return { ok: false, message: 'Verification failed after merge.' }
      }

      // 8 — dependency install.
      if (plan.needsInstall && this.config.installDeps) {
        this.progress('install', 'Installing dependencies (pnpm install)…')
        const install = await runLongCommand(repoPath, ['pnpm', 'install'], (line) => {
          this.log(`install: ${line}`)
          this.state.lastInstallLine = line.slice(0, 600)
          this.pub()
        })
        if (!install.ok) {
          this.state.error = `Dependency install failed (code ${String(install.code)}). The merge is applied; fix deps before restarting.`
          this.log(this.state.error)
          this.state.lastApplyAt = new Date().toISOString()
          this.state.lastResult = { ok: false, at: new Date().toISOString(), message: this.state.error }
          this.setPhase(this.config.requireConsentRestart && this.shouldRestart(plan) ? 'restart-pending' : 'error')
          return { ok: false, message: this.state.error }
        }
      }

      // 9 — rebuild.
      if (plan.needsRebuild && this.config.buildEnabled) {
        this.progress('build', `Building (${this.config.buildCommand})…`)
        const argv = parseCommandLine(this.config.buildCommand)
        const build = await runLongCommand(repoPath, argv.length > 0 ? argv : ['pnpm', 'run', 'build'], (line) => {
          this.log(`build: ${line}`)
          this.state.lastInstallLine = `build: ${line.slice(0, 600)}`
          this.pub()
        })
        if (!build.ok) {
          this.state.error = `Build failed (code ${String(build.code)}). The merge is applied; rebuild or install with the CLI and restart.`
          this.log(this.state.error)
          this.state.lastApplyAt = new Date().toISOString()
          this.state.lastResult = { ok: false, at: new Date().toISOString(), message: this.state.error }
          this.setPhase('restart-pending')
          return { ok: false, message: this.state.error }
        }
      }

      // 10 — finalize.
      this.state.lastApplyAt = new Date().toISOString()
      this.state.lastResult = { ok: true, at: this.state.lastApplyAt, message: 'Update applied.' }
      this.state.backupId = backupId
      this.state.progress = null
      this.log(`apply: success (${startedAt} → ${new Date().toISOString()})`)
      if (this.shouldRestart(plan)) {
        this.state.pendingRestart = true
        this.setPhase('restart-pending')
        return { ok: true, message: 'Update applied. DSH needs a restart to activate it.' }
      }
      this.setPhase('applied')
      return { ok: true, message: 'Update applied.' }
    } catch (error) {
      this.state.error = `Apply failed: ${error instanceof Error ? error.message : String(error)}`
      this.log(this.state.error)
      this.setPhase('error')
      return { ok: false, message: this.state.error }
    } finally {
      this.applying.value = false
      this.state.inProgress = false
      this.pub()
    }
  }

  private bumpForApply(): void {
    this.state.phase = 'applying'
    this.state.error = null
    this.state.conflictedFiles = []
    this.state.parkedDrafts = []
    this.state.lastResult = null
    // NOTE: stashRefs/stashCount/parkedDrafts are NOT cleared here — they belong
    // to the current apply's stash set and are needed for resolveConflict/writeMerged
    // and for restore's dropApplyStashes. They are overwritten at stash time (step 4)
    // and cleared on restore or on the next successful apply finalization.
  }

  private shouldRestart(plan: UpdaterPlan | null): boolean {
    return plan !== null && plan.needsRestart
  }

  /** The stash ref that holds the local draft of `path`, or null. */
  private async stashRefFor(path: string): Promise<string | null> {
    for (const ref of this.state.stashRefs) {
      const probe = await runGit(this.config.repoPath, ['show', `${ref}:${path}`], { timeoutMs: 15_000 })
      if (probe.code === 0) return ref
    }
    return null
  }

  // ── restore ────────────────────────────────────────────────────────

  /**
   * Restore the working tree to a pre-update backup. Complete by design:
   * reset to the pre-apply HEAD, copy back the `untracked/` snapshot, re-apply
   * `local.patch` (the full pre-apply tracked-draft diff) so even drafts that
   * were never stashed come back, and only then drop the apply's own stashes.
   * If the patch cannot apply, the stashes are preserved as the fallback and
   * reported.
   */
  private async runRestore(backupId: string): Promise<UpdaterAction> {
    if (this.applying.value) return { ok: false, message: 'An apply is running; wait for it to settle.' }
    const { repoPath } = this.config
    const stateDir = stateDirOf(repoPath)
    const meta = await readBackupMeta(repoPath, backupId)
    if (meta === null) return { ok: false, message: 'Backup not found.' }
    this.state.inProgress = true
    try {
      this.log(`restore: resetting to ${meta.headSha ?? '(unknown head)'}`)
      // 1 — abort a pending merge first, if any.
      await runGit(repoPath, ['merge', '--abort'], { timeoutMs: 30_000 })
      // 2 — hard reset to the pre-update head.
      if (meta.headSha !== null) {
        const reset = await runGit(repoPath, ['reset', '--hard', meta.headSha], { timeoutMs: 60_000 })
        if (reset.code !== 0) {
          this.state.error = `Reset failed: ${reset.stderr.trim() || 'unknown'}`
          this.setPhase('error')
          return { ok: false, message: this.state.error }
        }
      }
      // 3 — restore the untracked collision snapshot.
      const untracked = restoreUntrackedSnapshot(stateDir, backupId, repoPath)
      // 4 — re-apply the full pre-apply tracked-draft diff (covers stashed AND
      //     never-stashed drafts; the reset above discarded both).
      const patch = await applyLocalPatch(repoPath, stateDir, backupId)
      if (!patch.ok) this.log(`restore: ${patch.message}`)
      if (patch.ok && patch.message === 'no patch') {
        // Backups disabled: fall back to popping the apply's own stashes.
        if (this.state.stashCount > 0) await unstashN(repoPath, this.state.stashCount)
      } else if (patch.ok) {
        const dropped = await dropApplyStashes(repoPath, this.state.stashRefs)
        if (dropped > 0) this.log(`restore: dropped ${dropped} apply stash(es)`)
      } else {
        // Patch failed: keep the stashes as the recovery path and report.
        if (this.state.stashCount > 0) {
          const popped = await unstashN(repoPath, this.state.stashCount)
          if (popped.conflicts.length > 0) {
            this.state.conflictedFiles = popped.conflicts
          }
        }
      }
      // Bug G2 (2026-08-22): restore is complete only when the index holds no
      // unmerged entries. A --3way patch failure or a refused stash pop leaves
      // stage records behind while the caller gets a success message
      // (incident: six UU paths under "Restored the pre-update state").
      // Recover every unresolved path from the recorded apply stash — the
      // authoritative pre-apply snapshot of each colliding draft — falling
      // back to HEAD when no stash holds it.
      let residue = await unmergedPaths(repoPath)
      for (const p of residue) {
        let draft: string | null = null
        for (const ref of this.state.stashRefs) {
          const blob = await runGit(repoPath, ['show', `${ref}:${p}`], { timeoutMs: 15_000 })
          if (blob.code === 0) { draft = blob.stdout; break }
        }
        if (draft !== null) {
          const dst = join(repoPath, ...p.split('/'))
          mkdirSync(dirname(dst), { recursive: true })
          writeFileSync(dst, draft, 'utf8')
          this.log(`restore: recovered draft ${p} from the apply stash`)
        } else {
          this.log(`restore: no stash draft for ${p}; resetting to HEAD`)
        }
        const settle = draft !== null
          ? await runGit(repoPath, ['add', '--', p], { timeoutMs: 30_000 })
          : await runGit(repoPath, ['checkout', 'HEAD', '--', p], { timeoutMs: 30_000 })
        if (settle.code !== 0) this.log(`restore: could not settle ${p}`)
      }
      residue = await unmergedPaths(repoPath)
      if (residue.length > 0) {
        // Fail loud instead of reporting success over a broken index. The
        // physical stash is intentionally preserved for manual recovery.
        const shortList = residue.slice(0, 5).join(', ') + (residue.length > 5 ? ', …' : '')
        const msg = `Restore incomplete: ${residue.length} path(s) still unmerged (${shortList}). The apply stash is preserved for manual recovery.`
        this.state.error = msg
        this.setPhase('error')
        return { ok: false, message: msg }
      }
      this.state.stashCount = 0
      this.state.stashRefs = []
      this.state.conflictedFiles = []
      this.state.parkedDrafts = []
      this.state.error = null
      this.state.pendingRestart = false
      const extra: string[] = []
      if (untracked.restored > 0) extra.push(`${untracked.restored} untracked file(s) restored`)
      if (patch.ok && patch.message !== 'no patch') extra.push(patch.message)
      if (!patch.ok) extra.push(`warning: local patch did not apply cleanly (${patch.message})`)
      const message = `Restored the pre-update state from the safety backup.${extra.length > 0 ? ` ${extra.join(' · ')}.` : ''}`
      this.state.lastResult = { ok: true, at: new Date().toISOString(), message }
      this.log('restore: ok')
      // Bug G2 companion: refresh the snapshot fields so callers reading
      // status right after restore see the restored reality (currentSha,
      // dirty/untracked counts), not values captured before the reset.
      this.state.currentSha = await resolveHead(repoPath).catch(() => null)
      const scanAfter = await scanWorkingTree(repoPath)
      this.state.dirtyCount = scanAfter.dirtyTracked.length
      this.state.untrackedCount = scanAfter.untracked.length
      this.state.phase = 'idle'
      this.state.plan = null
      this.pub()
      return { ok: true, message: 'Restored the previous state.' }
    } catch (error) {
      this.state.error = `Restore failed: ${error instanceof Error ? error.message : String(error)}`
      this.setPhase('error')
      return { ok: false, message: this.state.error }
    } finally {
      this.state.inProgress = false
      this.pub()
    }
  }

  // ── restart ────────────────────────────────────────────────────────

  private async runRestart(): Promise<UpdaterAction> {
    if (this.applying.value || this.checking.value) {
      return { ok: false, message: 'An operation is running; restart is not possible right now.' }
    }
    if (this.state.phase !== 'restart-pending' && !this.state.pendingRestart) {
      return { ok: false, message: 'There is no restart pending.' }
    }
    const arm = armSupervisor(this.config)
    if (!arm.ok) return arm
    this.state.pendingRestart = true
    this.state.restartLast = new Date().toISOString()
    this.state.progress = { stage: 'restart', message: 'Restarting DSH — the page will reload in a moment.' }
    this.pub()
    this.log('restart: armed and stopping the host')
    // Give the HTTP response a beat, then request the launcher-driven exit.
    setTimeout(() => this.requestExit(), 800)
    return { ok: true, message: 'Restarting DSH now…' }
  }

  /**
   * Ask the launcher for an orderly process exit (`ctx.appExit` when present) with
   * a hard `process.exit` fallback. The supervisor was armed beforehand, so even the
   * hard path brings DSH back up.
   */
  private requestExit(code = 0): void {
    try {
      const exit = (this.ctx as Context)['get']?.('appExit') as ((c?: number) => void) | undefined
      if (typeof exit === 'function') {
        exit(code)
        return
      }
    } catch { /* fall through to the hard path */ }
    process.exit(code)
  }

  // ── Remote face ────────────────────────────────────────────────────

  /**
   * Current full snapshot (state + plan + backups + config).
   */
  @Remote('status')
  status(): UpdaterSnapshot {
    return readSnapshot(this.state, this.config, listBackups(this.config))
  }

  /** Manual fetch + replan, mirroring exactly what the auto-poller does. */
  @Remote('check')
  check(): Promise<UpdaterAction> {
    return this.runCheck(true)
  }

  /** Start an apply run (consented by the caller). Returns after it is queued. */
  @Remote('apply')
  apply(): Promise<UpdaterAction> {
    if (this.applying.value || this.checking.value) {
      return Promise.resolve({ ok: false, message: 'An operation is already running.' })
    }
    // Fire-and-forget; progress flows through events + status polling.
    void this.runApply()
    return Promise.resolve({ ok: true, message: 'Apply started.' })
  }

  /** Restore the working tree to a pre-update backup. */
  @Remote('restore')
  restore(backupId: string): Promise<UpdaterAction> {
    return this.runRestore(backupId)
  }

  /**
   * Resolve one conflicted file after an `automerge` apply stopped at
   * `conflicts`. `keep-local` puts the stashed draft back; `take-upstream`
   * keeps the merged upstream version; `keep-both` keeps upstream in the tree
   * and parks the draft as `<path>.local` under `.dsh/updater/drafts/`.
   */
  @Remote('resolveConflict')
  async resolveConflict(path: string, choice: 'keep-local' | 'take-upstream' | 'keep-both'): Promise<UpdaterAction> {
    if (this.applying.value || this.checking.value) {
      return { ok: false, message: 'An operation is running; wait for it to settle.' }
    }
    if (this.state.phase !== 'conflicts') {
      return { ok: false, message: 'There are no conflicts to resolve right now.' }
    }
    if (path.length === 0 || path.startsWith('-') || path.includes('..')) {
      return { ok: false, message: 'Invalid path.' }
    }
    if (!this.state.conflictedFiles.includes(path)) {
      return { ok: false, message: `"${path}" is not a conflicted file.` }
    }
    const { repoPath } = this.config
    try {
      const stashRef = await this.stashRefFor(path)
      if (choice === 'keep-local') {
        if (stashRef === null) return { ok: false, message: `No stash holds the local draft of "${path}".` }
        const blob = await runGit(repoPath, ['show', `${stashRef}:${path}`], { timeoutMs: 30_000 })
        if (blob.code !== 0) return { ok: false, message: `Cannot read the local draft of "${path}" from the stash.` }
        const dst = join(repoPath, ...path.split('/'))
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, blob.stdout, 'utf8')
        await runGit(repoPath, ['add', '--', path], { timeoutMs: 30_000 })
      } else if (choice === 'take-upstream') {
        const co = await runGit(repoPath, ['checkout', 'HEAD', '--', path], { timeoutMs: 30_000 })
        if (co.code !== 0) return { ok: false, message: `Cannot restore the upstream version of "${path}".` }
        await runGit(repoPath, ['add', '--', path], { timeoutMs: 30_000 })
      } else if (choice === 'keep-both') {
        const co = await runGit(repoPath, ['checkout', 'HEAD', '--', path], { timeoutMs: 30_000 })
        if (co.code !== 0) return { ok: false, message: `Cannot restore the upstream version of "${path}".` }
        await runGit(repoPath, ['add', '--', path], { timeoutMs: 30_000 })
        if (stashRef !== null) {
          const parkedFile = await writeParkedDraft(repoPath, stateDirOf(repoPath), this.state.backupId ?? 'manual', path, stashRef)
          if (parkedFile !== null) {
            this.state.parkedDrafts = [...this.state.parkedDrafts, {
              path, parkedAt: new Date().toISOString(), stashRef, parkedFile: parkedFile.parkedFile,
            } satisfies UpdaterParkedDraft]
          }
        }
      } else {
        return { ok: false, message: `Unknown resolution choice: ${String(choice)}` }
      }
      const remaining = await unmergedPaths(repoPath)
      this.state.conflictedFiles = [...new Set(
        this.state.conflictedFiles.filter(f => f !== path).concat(remaining),
      )]
      this.log(`resolve: ${path} → ${choice}`)
      if (this.state.conflictedFiles.length === 0) {
        // Hardening: drop the stash(es) that held the now-resolved draft(s) so they don't accumulate across updates.
        // The backup's local.patch remains the canonical restore path; stashes are ephemeral conflict storage.
        try { await dropApplyStashes(repoPath, this.state.stashRefs) } catch { /* best effort */ }
        this.state.stashRefs = []
        this.state.stashCount = 0
        this.state.backupId = null
        this.state.error = null
        this.state.progress = null
        this.state.lastApplyAt = new Date().toISOString()
        this.state.lastResult = { ok: true, at: this.state.lastApplyAt, message: 'Conflicts resolved; update applied.' }
        if (this.shouldRestart(this.state.plan)) {
          this.state.pendingRestart = true
          this.setPhase('restart-pending')
        } else {
          this.setPhase('applied')
        }
        return { ok: true, message: 'Conflict resolved. The update is now complete.' }
      }
      this.pub()
      return { ok: true, message: `Resolved "${path}". ${this.state.conflictedFiles.length} file(s) still need attention.` }
    } catch (error) {
      this.state.error = `Resolve failed: ${error instanceof Error ? error.message : String(error)}`
      this.setPhase('error')
      return { ok: false, message: this.state.error }
    }
  }

  /** Validate a caller-supplied repo-relative path for the write/draft faces. */
  private static validRelPath(path: string): boolean {
    return path.length > 0 && !path.startsWith('-') && !path.includes('..') && !path.includes('\\')
  }

  /**
   * The stashed local draft of one conflicted path, for agent-authored merges:
   * the model reads the upstream version (fileDiff / working tree) and the
   * local draft side by side, then calls {@link writeMerged}.
   */
  @Remote('localDraft')
  async localDraft(path: string): Promise<UpdaterLocalDraft> {
    if (!UpdaterGateway.validRelPath(path)) {
      return { ok: false, message: 'Invalid path.', content: null }
    }
    const { repoPath } = this.config
    try {
      const stashRef = await this.stashRefFor(path)
      if (stashRef === null) {
        return { ok: false, message: `No stashed local draft is recorded for "${path}".`, content: null }
      }
      const blob = await runGit(repoPath, ['show', `${stashRef}:${path}`], { timeoutMs: 30_000 })
      if (blob.code !== 0) {
        return { ok: false, message: `Cannot read the local draft of "${path}" from the stash.`, content: null }
      }
      return { ok: true, message: '', content: blob.stdout.slice(0, 512 * 1024) }
    } catch (error) {
      return { ok: false, message: `localDraft failed: ${error instanceof Error ? error.message : String(error)}`, content: null }
    }
  }

  /**
   * Write an agent-authored merged file for one conflicted path (the AI merge
   * face). The content replaces the conflict markers, is staged, and the path
   * leaves the conflicted set; when none remain the apply finalizes exactly
   * like a keep-local/take-upstream resolution.
   */
  @Remote('writeMerged')
  async writeMerged(path: string, content: string): Promise<UpdaterAction> {
    if (this.applying.value || this.checking.value) {
      return { ok: false, message: 'An operation is running; wait for it to settle.' }
    }
    if (this.state.phase !== 'conflicts') {
      return { ok: false, message: 'There are no conflicts to resolve right now.' }
    }
    if (!UpdaterGateway.validRelPath(path)) {
      return { ok: false, message: 'Invalid path.' }
    }
    if (!this.state.conflictedFiles.includes(path)) {
      return { ok: false, message: `"${path}" is not a conflicted file.` }
    }
    if (content.length > 2 * 1024 * 1024) {
      return { ok: false, message: 'Merged content exceeds the 2 MiB bound.' }
    }
    const { repoPath } = this.config
    try {
      const dst = join(repoPath, ...path.split('/'))
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, content, 'utf8')
      const added = await runGit(repoPath, ['add', '--', path], { timeoutMs: 30_000 })
      if (added.code !== 0) {
        this.state.error = `Cannot stage the merged "${path}".`
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }
      const remaining = await unmergedPaths(repoPath)
      this.state.conflictedFiles = [...new Set(
        this.state.conflictedFiles.filter(f => f !== path).concat(remaining),
      )]
      this.log(`resolve: ${path} → write-merged (agent-authored)`)
      if (this.state.conflictedFiles.length === 0) {
        // Hardening: same stash cleanup as resolveConflict — the agent-authored merge resolved the last conflict, so the stashed draft is no longer needed.
        try { await dropApplyStashes(repoPath, this.state.stashRefs) } catch { /* best effort */ }
        this.state.stashRefs = []
        this.state.stashCount = 0
        this.state.backupId = null
        this.state.error = null
        this.state.progress = null
        this.state.lastApplyAt = new Date().toISOString()
        this.state.lastResult = { ok: true, at: this.state.lastApplyAt, message: 'Merged content written; update applied.' }
        if (this.shouldRestart(this.state.plan)) {
          this.state.pendingRestart = true
          this.setPhase('restart-pending')
        } else {
          this.setPhase('applied')
        }
        return { ok: true, message: 'Merged content written. The update is now complete.' }
      }
      this.pub()
      return { ok: true, message: `Merged "${path}". ${this.state.conflictedFiles.length} file(s) still need attention.` }
    } catch (error) {
      this.state.error = `Write-merged failed: ${error instanceof Error ? error.message : String(error)}`
      this.setPhase('error')
      return { ok: false, message: this.state.error }
    }
  }

  /**
   * Bounded unified diff of one path between HEAD and upstream (plan detail).
   *
   * Bug H (2026-08-22): after a fast-forward that stopped at stash-pop
   * conflicts, HEAD equals upstream and this diff was always empty — exactly
   * while an agent is resolving conflicts and needs to see what upstream did.
   * During the conflicts phase with a known pre-apply backup, diff from the
   * backup head instead, so the incoming change becomes visible again.
   */
  @Remote('fileDiff')
  async fileDiff(path: string): Promise<UpdaterFileDiff> {
    if (path.length === 0 || path.startsWith('-') || path.includes('..')) {
      return { ok: false, message: 'Invalid path.', diff: null }
    }
    const { repoPath, remoteName, branch } = this.config
    const upstreamRef = `${remoteName}/${branch}`
    let baseRef = 'HEAD'
    if (this.state.phase === 'conflicts' && this.state.backupId !== null) {
      const meta = await readBackupMeta(repoPath, this.state.backupId)
      if (meta?.headSha) baseRef = meta.headSha
    }
    const res = await runGit(
      repoPath,
      ['diff', '--no-color', '--unified=8', baseRef, upstreamRef, '--', path],
      { timeoutMs: 30_000, maxBytes: 512 * 1024 },
    )
    if (res.code !== 0) return { ok: false, message: res.stderr.trim() || 'diff failed', diff: null }
    const diff = res.stdout.slice(0, 256 * 1024)
    return { ok: true, message: '', diff: diff.length > 0 ? diff : null }
  }

  /** Persist a config patch (repoPath is fixed for the lifetime of the process). */
  @Remote('setConfig')
  setConfig(patch: Partial<UpdaterConfigView>): UpdaterAction {
    const current: Record<string, unknown> = { ...this.config } as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (key === 'repoPath') continue // locked for the process lifetime
      current[key] = value
    }
    try {
      const next = resolveUpdaterConfig(current)
      const changedRepo = next.repoPath !== this.config.repoPath
      this.config = next
      saveUpdaterConfig(this.config.repoPath, next)
      this.schedulePoll()
      this.log('config: updated')
      this.pub()
      return changedRepo
        ? { ok: true, message: 'Config updated (repo path is fixed until the next restart).' }
        : { ok: true, message: 'Config updated.' }
    } catch (error) {
      return { ok: false, message: `Config rejected: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Arm the supervised restart (consent-gated by the client; nothing happens without the call). */
  @Remote('restart')
  restart(): Promise<UpdaterAction> {
    return this.runRestart()
  }

  /** Ignore the current conflicts/error and re-check (non-destructive). */
  @Remote('refresh')
  refresh(): UpdaterAction {
    this.state.error = null
    this.pub()
    return { ok: true, message: 'Status cleared; re-check next.' }
  }
}

export default UpdaterGateway
