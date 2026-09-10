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
import { readOperation, saveOperation, commandSteps } from './workflow.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
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
  private authorizedRun = false
  private initiatorId: string | null = null

  /** @param ctx - Host context. @param rowConfig - validated row configuration. */
  constructor(ctx: Context, rowConfig: UpdaterConfig) {
    super(ctx, 'updater')
    const repoPath = typeof rowConfig?.repoPath === 'string' && rowConfig.repoPath.length > 0
      ? rowConfig.repoPath
      : process.cwd()
    this.config = existsSync(join(stateDirOf(repoPath), 'config.json'))
      ? loadUpdaterConfig(repoPath)
      : resolveUpdaterConfig({ ...rowConfig, repoPath })
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
    this.state.conflictedFiles = unmerged
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

      const upToDate = upstreamSha !== null && behindCount === 0
      this.state.conflictedFiles = await unmergedPaths(repoPath)
      const activeOperation = readOperation(repoPath)
      if (upToDate && activeOperation && !['complete', 'recovered'].includes(activeOperation.stage)) {
        if (this.state.conflictedFiles.length) this.setPhase('conflicts')
        else if (activeOperation.stage === 'restart') this.setPhase('restart-pending')
        return { ok: false, message: 'The pinned update is present; its recovery or verification still needs to finish.' }
      }
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
        // FORK UPDATE (2026-09-01): ahead > 0 is normal for the maintained
        // fork (paperclip File*, updater bundle, toolchain). ahead alone is
        // NOT "up to date" — that was the root cause of the phantom
        // "Update DSH with AI / 0.1.2-alpha.3 → 0.1.2-alpha.3" card: behind
        // was 0 but ahead was 8, so the old `upstreamSha === head` test
        // failed and the check fell through to `update-available` with an
        // empty 0-commit plan. behind === 0 means the working tree contains
        // every upstream commit; show the up-to-date state and let the UI
        // surface the ahead count in the status card.
        this.log(`check: up to date (behind 0, ahead ${aheadCount} fork commit(s) kept)`)
        this.setPhase('idle')
        return { ok: true, message: aheadCount > 0
          ? `Up to date — ${aheadCount} local fork commit(s) ahead, nothing new upstream.`
          : 'Up to date.' }
      }
      if (upstreamSha === null) {
        this.state.error = 'Upstream branch not found; is the remote configured?'
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }

      // Reasons the update cannot be applied (never auto-apply through these).
      //
      // FORK UPDATE (2026-09-01): ahead > 0 no longer blocks. This checkout is
      // a maintained fork — local commits are the point, not an obstacle. The
      // apply pipeline runs a real three-way merge (`git merge --no-edit`)
      // when ahead > 0 and keeps the ff-only fast path for a clean checkout.
      // Only a genuinely diverged/foreign remote stays blocked.
      const blocked: string | null = this.remoteGuard(remoteUrl)

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
    let upstreamRef = `${remoteName}/${branch}`
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
      // Fork merge needs the live ahead count (performCheck just refreshed it).
      const ahead = this.state.ahead
      if (plan.blocked !== null) {
        this.state.error = plan.blocked
        this.setPhase('update-available')
        return { ok: false, message: plan.blocked }
      }
      upstreamRef = this.state.upstreamSha ?? upstreamRef
      saveOperation(repoPath, { version: 1, id: startedAt, targetSha: upstreamRef, backupId: null, stage: 'merge', appliedDraftRefs: [], applyingDraftRef: null, expectedPlugins: this.pluginNames(), checks: [], initiatorId: this.initiatorId, restartAuthorized: this.authorizedRun })
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
      const operation = readOperation(repoPath)!
      operation.backupId = backupId
      saveOperation(repoPath, operation)
      this.state.stashRefs = []
      this.state.stashCount = 0
      this.pub()

      // 4 — stash only the drafts that would collide.
      if (plan.conflictRisk.length > 0 || plan.untrackedRisk.length > 0) {
        this.progress('stash', `Setting aside ${plan.conflictRisk.length + plan.untrackedRisk.length} local draft(s)…`)
        try {
          const created = await pushDraftStashes(repoPath, plan.conflictRisk, plan.untrackedRisk, backupId.slice(0, 17))
          this.state.stashCount = created.created
          this.state.stashRefs = created.refs
          this.pub()
          this.log(`apply: stashed ${created.created} draft(s)`)
        } catch (error) {
          this.state.stashCount = (await countStashes(repoPath)) - stashBefore
          this.state.error = error instanceof Error ? error.message : String(error)
          this.setPhase('error')
          return { ok: false, message: `Pre-merge stash failed: ${this.state.error}` }
        }
      }

      // 5 — fast-forward to upstream.
      //
      // FORK-MERGE (2026-09-01): this checkout is a maintained fork (8 local
      // commits: paperclip File*, updater bundle, toolchain). The old
      // `--ff-only` merge hard-refused whenever ahead > 0, making the updater
      // permanently useless for the fork it ships in. Strategy now:
      //   ahead == 0 → `merge --ff-only` (fast path, zero risk);
      //   ahead  > 0 → `git merge --no-edit <upstreamRef>` — a real three-way
      //   merge that keeps every fork commit. Content collisions inside the
      //   merge itself surface through MERGE_HEAD/unmerged paths (step 5b);
      //   history is never rewritten, so the fork's commits stay intact and
      //   any conflict is resolvable per-file.
      this.progress('merge', ahead > 0
        ? `Merging fork (ahead ${ahead}) with upstream ${upstreamRef}…`
        : `Fast-forwarding to ${upstreamRef}…`)
      const mergeArgv = ahead > 0
        ? ['merge', '--no-edit', upstreamRef]
        : ['merge', '--ff-only', upstreamRef]
      const mergeRes = await runGit(repoPath, mergeArgv, { timeoutMs: 120_000 })
      if (mergeRes.code !== 0) {
        // Fork-merge conflict: git left MERGE_HEAD + unmerged index entries.
        // These resolve through the SAME escape hatches as stash-pop conflicts
        // (resolveConflict / writeMerged / restore). Do NOT unwind the merge —
        // parking the fork into a fake error state loses the merge state git
        // is preserving for us. Handle stash drafts first (below), then
        // surface the merge conflicts as the `conflicts` phase.
        const mergeUnmerged = await unmergedPaths(repoPath)
        if (ahead > 0 && mergeUnmerged.length > 0) {
          this.state.conflictedFiles = mergeUnmerged
          this.state.error = null
          this.log(`apply: fork merge conflicted on ${mergeUnmerged.length} path(s) — resolve or restore`)
          // Drafts remain untouched until the fork merge is committed.
          // 5b — verification differs for a conflicted fork merge: HEAD has
          // NOT moved yet (the merge is unfinished), so comparing HEAD to
          // upstream would fail here. Skip to conflict resolution; the final
          // verification happens in resolveConflict/writeMerged finalization.
          this.progress('merge', `Fork merge needs conflict resolution (${this.state.conflictedFiles.length} file(s)).`)
          this.setPhase('conflicts')
          this.state.lastApplyAt = new Date().toISOString()
          this.state.lastResult = { ok: false, at: this.state.lastApplyAt, message: 'Update merged with conflicts; resolve them to finish.' }
          return { ok: false, message: 'Fork merge has conflicts; resolve them (chat) to finish the update.' }
        }
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
      // FORK-MERGE verification: after a three-way fork merge HEAD is a NEW
      // merge commit (never equal to upstreamSha). The correct invariant is
      // "upstream is now an ancestor of HEAD" — the ff-only path still gets
      // the strict equality check. Use `git merge-base --is-ancestor` for the
      // fork path; `--is-ancestor` also returns 0 for equal SHAs, so it is a
      // superset test, but the fast path keeps its exact check for parity.
      const verifyFork = ahead > 0
        ? (await runGit(repoPath, ['merge-base', '--is-ancestor', upstreamRef, 'HEAD'], { timeoutMs: 20_000 })).code === 0
        : false
      if (headAfter === null || (ahead > 0 ? !verifyFork : upstreamSha.stdout.trim() !== headAfter)) {
        this.state.error = ahead > 0
          ? 'Fork merge did not include the upstream commit; review the repository.'
          : 'Merge did not reach the upstream commit; review the repository.'
        this.setPhase('error')
        return { ok: false, message: this.state.error }
      }

      return await this.finishUpdate()
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

  /** Enabled Loader modules form the preservation baseline, independent of model. */
  private pluginNames(): string[] {
    const loader = this.ctx.get('loader')
    if (!loader) return []
    return [...new Set([...loader.entries()].filter(entry => !entry.options.group && !entry.disabled)
      .map(entry => entry.options.name).filter((name): name is string => typeof name === 'string'))].sort()
  }

  /** Continue the shared draft/build/check path after either kind of merge. */
  private async finishUpdate(): Promise<UpdaterAction> {
    const repo = this.config.repoPath
    const previousLock = this.applying.value
    this.applying.value = true
    this.state.inProgress = true
    try {
      let operation = readOperation(repo)
      if (!operation) {
        operation = { version: 1, id: new Date().toISOString(), targetSha: this.state.upstreamSha!,
          backupId: this.state.backupId, stage: 'drafts', appliedDraftRefs: [], applyingDraftRef: null,
          expectedPlugins: this.pluginNames(), checks: [], initiatorId: this.initiatorId, restartAuthorized: false }
        saveOperation(repo, operation)
      }
      if (readMergeHead(repo)) return { ok: false, message: 'The merge still needs repair.' }
      const included = await runGit(repo, ['merge-base', '--is-ancestor', operation.targetSha, 'HEAD'])
      if (included.code !== 0) throw new Error('The pinned update has not been merged. Resume the merge before verification.')
      if (operation.applyingDraftRef) throw new Error('Draft restoration was interrupted. Inspect the preserved draft before resuming; it will not be applied twice.')
      operation.stage = 'drafts'
      saveOperation(repo, operation)
      for (const ref of [...this.state.stashRefs].reverse()) {
        if (operation.appliedDraftRefs.includes(ref)) continue
        this.progress('restore-drafts', 'Restoring your saved changes…')
        operation.applyingDraftRef = ref
        saveOperation(repo, operation)
        const result = await runGit(repo, ['stash', 'apply', ref], { timeoutMs: 120_000 })
        const conflicts = await unmergedPaths(repo)
        if (result.code !== 0 && conflicts.length === 0) throw new Error(`Saved changes could not be restored: ${result.stderr}`)
        operation.appliedDraftRefs.push(ref)
        operation.applyingDraftRef = null
        saveOperation(repo, operation)
        if (conflicts.length) {
          if (this.config.strategy === 'upstream-overlay') {
            for (const path of conflicts) {
              const parked = await writeParkedDraft(repo, stateDirOf(repo), this.state.backupId ?? operation.id, path, ref)
              if (!parked) throw new Error(`Could not preserve the local draft of ${path}.`)
              this.state.parkedDrafts.push({ path, parkedAt: new Date().toISOString(), stashRef: ref, parkedFile: parked.parkedFile })
              const restored = await runGit(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
              if (restored.code !== 0) throw new Error(`Could not restore the upstream version of ${path}.`)
            }
            continue
          }
          this.state.conflictedFiles = conflicts
          this.state.error = null
          this.setPhase('conflicts')
          return { ok: false, message: 'Your saved changes need an automatic compatibility repair. Read the conflict context and write the merged files, then resume.' }
        }
      }
      this.state.conflictedFiles = await unmergedPaths(repo)
      if (this.state.conflictedFiles.length) { this.setPhase('conflicts'); return { ok: false, message: 'Compatibility repairs are still needed.' } }
      operation.stage = 'verify'
      operation.checks = []
      saveOperation(repo, operation)
      const check = async (name: string, argv: string[]): Promise<void> => {
        this.progress(name, name === 'build' ? 'Preparing the updated app…' : 'Checking the updated app…')
        const result = await runLongCommand(repo, argv, line => { this.log(`${name}: ${line}`); this.pub() })
        operation!.checks.push({ name, status: result.ok ? 'passed' : 'failed', detail: result.ok ? 'Completed' : `Exit ${result.code}; timeout ${result.timedOut}` })
        saveOperation(repo, operation!)
        if (!result.ok) throw new Error(`${name} did not pass. The recovery copy and saved changes have been retained.`)
      }
      if (this.state.plan?.needsInstall && this.config.installDeps) await check('install', ['pnpm', 'install', '--no-frozen-lockfile'])
      if (this.state.plan?.needsRebuild && this.config.buildEnabled) {
        for (const command of commandSteps(this.config.buildCommand)) await check('build', parseCommandLine(command))
      }
      if (this.config.verifyCommand.trim()) {
        for (const command of commandSteps(this.config.verifyCommand)) await check('application-checks', parseCommandLine(command))
      }
      this.state.currentSha = await resolveHead(repo)
      this.state.currentVersion = readLocalVersion(repo)
      this.state.behind = 0
      this.state.error = null
      this.state.progress = null
      this.state.lastApplyAt = new Date().toISOString()
      operation.stage = this.shouldRestart(this.state.plan) ? 'restart' : 'complete'
      saveOperation(repo, operation)
      this.state.lastResult = { ok: operation.stage === 'complete', at: this.state.lastApplyAt,
        message: operation.stage === 'complete' ? 'Update verified.' : 'Local checks passed; checking the restarted app is next.' }
      this.state.pendingRestart = operation.stage === 'restart'
      this.setPhase(operation.stage === 'restart' ? 'restart-pending' : 'applied')
      return { ok: true, message: this.state.lastResult.message }
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error)
      this.setPhase('error')
      return { ok: false, message: this.state.error }
    } finally {
      this.applying.value = previousLock
      this.state.inProgress = previousLock
      this.pub()
    }
  }

  /** Start or resume one user-authorized update, retaining the selected model. */
  @Remote('start')
  async start(): Promise<UpdaterAction> {
    if (this.applying.value || this.checking.value) return { ok: true, message: 'The update is already running.' }
    this.authorizedRun = true
    const agents = this.ctx.get('agents')
    try { this.initiatorId = agents?.requireInitiator().session.id ?? null } catch { this.initiatorId = null }
    const operation = readOperation(this.config.repoPath)
    if (!operation && this.state.stashRefs.length) {
      return { ok: false, message: 'An older updater left saved drafts without a restoration checkpoint. Inspect the retained stash and recovery copy against the working tree, then repair the checkpoint before starting another update. No saved drafts have been discarded.' }
    }
    if (operation && !['complete', 'recovered'].includes(operation.stage)) {
      this.state.conflictedFiles = await unmergedPaths(this.config.repoPath)
      operation.restartAuthorized = true
      operation.initiatorId = this.initiatorId ?? operation.initiatorId
      saveOperation(this.config.repoPath, operation)
      if (operation.stage === 'restart') return this.runRestart()
      if (this.state.conflictedFiles.length) return { ok: false, message: 'Read the conflict context, preserve local behavior, write the repairs, then resume.' }
      if (readMergeHead(this.config.repoPath)) {
        const commit = await runGit(this.config.repoPath, ['commit', '--no-edit'])
        if (commit.code !== 0) return { ok: false, message: 'The repaired merge could not be committed. Fix the reported repository checks and resume.' }
      }
      if (operation.stage === 'merge') {
        if (!operation.backupId) {
          void this.runApply()
          return { ok: true, message: 'Retrying update preparation with a new recovery checkpoint.' }
        }
        const merged = await runGit(this.config.repoPath, ['merge-base', '--is-ancestor', operation.targetSha, 'HEAD'])
        if (merged.code !== 0) {
          const result = await runGit(this.config.repoPath, ['merge', '--no-edit', operation.targetSha], { timeoutMs: 120_000 })
          this.state.conflictedFiles = await unmergedPaths(this.config.repoPath)
          if (result.code !== 0) {
            this.state.error = this.state.conflictedFiles.length ? null : result.stderr
            this.setPhase(this.state.conflictedFiles.length ? 'conflicts' : 'error')
            return { ok: false, message: 'The pinned merge needs repair before draft restoration can resume.' }
          }
        }
      }
      void this.finishUpdate().then(result => { if (result.ok && this.state.pendingRestart) void this.runRestart() })
      return { ok: true, message: 'Resuming the update and its checks.' }
    }
    void this.runApply().then(result => { if (result.ok && this.state.pendingRestart && this.authorizedRun) void this.runRestart() })
    return { ok: true, message: 'Updating DSH. Backups, repairs, checks and restart are included.' }
  }

  /** Return distinct base, fork, incoming and saved-draft sides for a repair. */
  @Remote('conflictContext')
  async conflictContext(path: string): Promise<{ path: string; mergePending: boolean; base: string; local: string; incoming: string; draft: string | null }> {
    if (!UpdaterGateway.validRelPath(path) || !this.state.conflictedFiles.includes(path)) throw new Error('Not a current conflict path.')
    const repo = this.config.repoPath
    const sides = await Promise.all([1, 2, 3].map(stage => runGit(repo, ['show', `:${stage}:${path}`])))
    const draft = await this.localDraft(path)
    const mergePending = readMergeHead(repo) !== null
    return { path, mergePending, base: sides[0]!.stdout,
      local: sides[mergePending ? 1 : 2]!.stdout, incoming: sides[mergePending ? 2 : 1]!.stdout, draft: draft.content }
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
    const operation = readOperation(this.config.repoPath)
    if (this.state.error || (operation && operation.stage !== 'restart')) return { ok: false, message: 'Verification must finish before restarting.' }
    const agents = this.ctx.get('agents')
    if (agents?.list().some(agent => agent.status === 'running' && agent.session.id !== operation?.initiatorId)) {
      return { ok: false, message: 'Waiting for your other conversations to finish. Resume the update afterward.' }
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
        // FORK-MERGE: during a mid-merge conflict, HEAD is still the
        // pre-merge fork commit, so `checkout HEAD -- path` would restore the
        // FORK version — the exact opposite of the requested resolution. Use
        // MERGE_HEAD (the incoming upstream commit) while a merge is in
        // flight; fall back to HEAD for the stash-pop conflict case.
        const midMergeSha = readMergeHead(repoPath)
        const upstreamSide = midMergeSha !== null ? midMergeSha : 'HEAD'
        const co = await runGit(repoPath, ['checkout', upstreamSide, '--', path], { timeoutMs: 30_000 })
        if (co.code !== 0) return { ok: false, message: `Cannot restore the upstream version of "${path}".` }
        await runGit(repoPath, ['add', '--', path], { timeoutMs: 30_000 })
      } else if (choice === 'keep-both') {
        // Same mid-merge subtlety: the "upstream" side of a fork-merge
        // conflict is MERGE_HEAD, not HEAD (HEAD is the fork side).
        const midMergeSha = readMergeHead(repoPath)
        const upstreamSide = midMergeSha !== null ? midMergeSha : 'HEAD'
        const co = await runGit(repoPath, ['checkout', upstreamSide, '--', path], { timeoutMs: 30_000 })
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
        // FORK-MERGE completion (2026-09-01): if this conflicts phase came
        // from a fork merge (MERGE_HEAD still present), commit the merge now
        // with the resolved index. Without this the merge stays unfinished —
        // HEAD never advances and the updater reports success while the repo
        // is mid-merge.
        const midMerge = readMergeHead(repoPath)
        if (midMerge !== null) {
          const commit = await runGit(
            repoPath,
            ['commit', '--no-edit', '--no-verify'],
            { timeoutMs: 60_000 },
          )
          if (commit.code !== 0) {
            this.state.error = `Cannot finish the fork merge: ${commit.stderr.trim() || commit.stdout.trim() || 'unknown'}`
            this.log(this.state.error)
            this.setPhase('error')
            return { ok: false, message: this.state.error }
          }
          this.log('resolve: fork merge committed')
          // Fork merge done: upstream must now be an ancestor of HEAD.
          const ancestor = await runGit(
            repoPath,
            ['merge-base', '--is-ancestor', readOperation(repoPath)?.targetSha ?? `${this.config.remoteName}/${this.config.branch}`, 'HEAD'],
            { timeoutMs: 20_000 },
          )
          if (ancestor.code !== 0) {
            this.state.error = 'Fork merge finished but upstream is not in history; review the repository.'
            this.log(this.state.error)
            this.setPhase('error')
            return { ok: false, message: this.state.error }
          }
          // The merge commit means the upstream version is in history; take-
          // upstream/keep-both resolved content, and keep-local deliberately
          // kept the fork draft. Either way the update is complete.
        }
        return await this.finishUpdate()
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
        // FORK-MERGE completion: same as resolveConflict — commit the pending
        // merge so HEAD advances past the merge (see resolveConflict notes).
        const midMerge = readMergeHead(repoPath)
        if (midMerge !== null) {
          const commit = await runGit(
            repoPath,
            ['commit', '--no-edit', '--no-verify'],
            { timeoutMs: 60_000 },
          )
          if (commit.code !== 0) {
            this.state.error = `Cannot finish the fork merge: ${commit.stderr.trim() || commit.stdout.trim() || 'unknown'}`
            this.log(this.state.error)
            this.setPhase('error')
            return { ok: false, message: this.state.error }
          }
          this.log('resolve: fork merge committed (write-merged path)')
          const ancestor = await runGit(
            repoPath,
            ['merge-base', '--is-ancestor', readOperation(repoPath)?.targetSha ?? `${this.config.remoteName}/${this.config.branch}`, 'HEAD'],
            { timeoutMs: 20_000 },
          )
          if (ancestor.code !== 0) {
            this.state.error = 'Fork merge finished but upstream is not in history; review the repository.'
            this.log(this.state.error)
            this.setPhase('error')
            return { ok: false, message: this.state.error }
          }
        }
        return await this.finishUpdate()
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
