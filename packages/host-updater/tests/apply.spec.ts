/**
 * End-to-end apply-pipeline tests through the real UpdaterGateway on throwaway
 * temp repos (the live checkout is never touched). These cover the regressions
 * that made Apply a silent no-op:
 *   - Bug A: runApply must not refuse its own internal check ("already running").
 *   - Bug B: plan classification must run on the FULL change set, with only the
 *     wire display list capped.
 * plus the strategy/restore/resolve behaviors.
 *
 * @vitest-environment node
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveUpdaterConfig, saveUpdaterConfig } from '../src/config.ts'
import UpdaterGateway from '../src/index.ts'
import { runGit } from '../src/git.ts'
import type { UpdaterSnapshot } from '../src/types.ts'
import { commitAll, editAndCommit, gitIn, makeTempRepo, type TempRepo } from './helpers.ts'

interface Harness {
  gateway: UpdaterGateway
  ctx: Context
  work: TempRepo
  upstream: TempRepo
  cleanup(): Promise<void>
}

const harnesses: Harness[] = []

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  const upstream = makeTempRepo('master')
  const work = makeTempRepo('master')
  gitIn(work.path, ['remote', 'add', 'origin', upstream.path])
  gitIn(work.path, ['fetch', 'origin'])
  gitIn(work.path, ['reset', '--hard', 'origin/master'])
  const config = resolveUpdaterConfig({
    repoPath: work.path,
    autoCheck: false,
    autoApply: false,
    requireConsentApply: false,
    installDeps: false,
    buildEnabled: false,
    backupsKeep: 2,
    ...overrides,
  })
  saveUpdaterConfig(work.path, config)
  const gateway = new UpdaterGateway(ctx, config)
  const h: Harness = { gateway, ctx, work, upstream, cleanup: async () => {
    try { ctx.dispose() } catch { /* best effort */ }
    work.cleanup()
    upstream.cleanup()
  } }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.cleanup()))
})

/**
 * Wait until the apply run settles. apply() is fire-and-forget (its Remote
 * returns { ok: true } before any work starts), so a naive phase poll returns
 * on the stale pre-apply phase. This waits for the operation to actually START
 * (inProgress flips synchronously in runApply) and then for a settled outcome
 * (inProgress back to false and a non-transient phase). A fully-awaited
 * operation (restore) is already settled on entry and returns immediately.
 */
async function settle(gateway: UpdaterGateway, timeoutMs = 60_000): Promise<UpdaterSnapshot> {
  const deadline = Date.now() + timeoutMs
  let started = false
  for (;;) {
    const snap = gateway.status()
    if (snap.inProgress || snap.phase === 'applying' || snap.phase === 'checking') started = true
    const settled = !snap.inProgress && snap.phase !== 'applying' && snap.phase !== 'checking'
    if (settled && (started || snap.lastResult !== null || snap.error !== null)) return snap
    if (Date.now() > deadline) throw new Error(`operation did not settle; phase=${snap.phase} inProgress=${snap.inProgress}`)
    await new Promise(r => setTimeout(r, 150))
  }
}

async function headOf(repo: string): Promise<string | null> {
  const res = await runGit(repo, ['rev-parse', 'HEAD'], { timeoutMs: 15_000 })
  return res.code === 0 ? res.stdout.trim() : null
}

async function fileContent(repo: string, rel: string): Promise<string | null> {
  const res = await runGit(repo, ['show', `HEAD:${rel}`], { timeoutMs: 15_000 })
  return res.code === 0 ? res.stdout : null
}

/** Working-tree file content (local drafts live here, never in HEAD). */
function workFile(repo: string, rel: string): string | null {
  try {
    return readFileSync(join(repo, ...rel.split('/')), 'utf8')
  } catch {
    return null
  }
}

describe('apply end-to-end (Bug A regression)', () => {
  it('applies a non-colliding upstream advance and re-applies the local draft', async () => {
    const h = await harness()
    try {
      // Local draft on a file upstream does NOT touch.
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      // Upstream advances on a different file.
      editAndCommit(h.upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream advance')

      const check = await h.gateway.check()
      expect(check.ok).toBe(true)
      expect(h.gateway.status().plan?.conflictRisk).toEqual([])
      expect(h.gateway.status().plan?.needsRestart).toBe(true)

      const apply = await h.gateway.apply()
      expect(apply.ok).toBe(true)
      const snap = await settle(h.gateway)

      // The merge actually happened (Bug A: this used to never run).
      expect(snap.phase).toBe('restart-pending')
      expect(await headOf(h.work.path)).toBe(await headOf(h.upstream.path))
      // The local draft survives in the working tree (it was never stashed —
      // upstream did not touch this file, so nothing collided).
      expect(workFile(h.work.path, 'src/main.ts')).toBe('console.log(local-draft)\n')
      expect(await fileContent(h.work.path, 'src/upstream-only.ts')).toBe('console.log(upstream)\n')
      expect(snap.error).toBeNull()
      expect(snap.lastResult?.ok).toBe(true)
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('stops at conflicts when a draft collides in content and resolves via keep-local', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      editAndCommit(h.upstream.path, 'src/main.ts', 'console.log(upstream-v2)\n', 'upstream touches the same file')

      const check = await h.gateway.check()
      expect(check.ok).toBe(true)
      expect(h.gateway.status().plan?.conflictRisk).toContain('src/main.ts')

      await h.gateway.apply()
      const snap = await settle(h.gateway)
      expect(snap.phase).toBe('conflicts')
      expect(snap.conflictedFiles).toContain('src/main.ts')
      // The merge DID land; only the draft re-apply conflicted.
      expect(await headOf(h.work.path)).toBe(await headOf(h.upstream.path))

      const resolve = await h.gateway.resolveConflict('src/main.ts', 'keep-local')
      expect(resolve.ok).toBe(true)
      const after = await settle(h.gateway)
      expect(after.phase).toBe('restart-pending')
      expect(workFile(h.work.path, 'src/main.ts')).toBe('console.log(local-draft)\n')
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('take-upstream keeps the merged version and drops the draft', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      editAndCommit(h.upstream.path, 'src/main.ts', 'console.log(upstream-v2)\n', 'upstream touches the same file')

      await h.gateway.apply()
      await settle(h.gateway)
      expect(h.gateway.status().phase).toBe('conflicts')

      const resolve = await h.gateway.resolveConflict('src/main.ts', 'take-upstream')
      expect(resolve.ok).toBe(true)
      const after = await settle(h.gateway)
      expect(after.phase).toBe('restart-pending')
      // HEAD moved to the upstream commit, and take-upstream keeps that version.
      expect(await fileContent(h.work.path, 'src/main.ts')).toBe('console.log(upstream-v2)\n')
      expect(workFile(h.work.path, 'src/main.ts')).toBe('console.log(upstream-v2)\n')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('agent merge remotes (A9)', () => {
  it('exposes the local draft and writes a merged file that finalizes the apply', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      editAndCommit(h.upstream.path, 'src/main.ts', 'console.log(upstream-v2)\n', 'upstream touches the same file')

      await h.gateway.apply()
      const snap = await settle(h.gateway)
      expect(snap.phase).toBe('conflicts')
      expect(snap.conflictedFiles).toContain('src/main.ts')

      // The agent reads the stashed local draft (local side of the merge).
      const draft = await h.gateway.localDraft('src/main.ts')
      expect(draft.ok).toBe(true)
      expect(draft.content).toBe('console.log(local-draft)\n')

      // The agent writes an authored merge that keeps both ideas.
      const merged = 'console.log(local-draft + upstream-v2)\n'
      const write = await h.gateway.writeMerged('src/main.ts', merged)
      expect(write.ok).toBe(true)
      const after = await settle(h.gateway)
      expect(after.phase).toBe('restart-pending')
      expect(workFile(h.work.path, 'src/main.ts')).toBe(merged)
      // The merged file is staged and no conflict markers remain.
      const unmerged = await runGit(h.work.path, ['diff', '--name-only', '--diff-filter=U'], { timeoutMs: 15_000 })
      expect(unmerged.stdout.trim()).toBe('')
      const staged = await runGit(h.work.path, ['diff', '--cached', '--name-only'], { timeoutMs: 15_000 })
      expect(staged.stdout.trim()).toContain('src/main.ts')
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('rejects writeMerged for a path that is not conflicted', async () => {
    const h = await harness()
    try {
      const write = await h.gateway.writeMerged('src/main.ts', 'whatever\n')
      expect(write.ok).toBe(false)
      expect(write.message).toMatch(/no conflicts|not a conflicted/)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  it('rejects an invalid path in localDraft', async () => {
    const h = await harness()
    try {
      const draft = await h.gateway.localDraft('../escape')
      expect(draft.ok).toBe(false)
      expect(draft.content).toBeNull()
    } finally {
      await h.cleanup()
    }
  }, 30_000)
})

describe('plan on the full change set (Bug B regression)', () => {
  it('classifies install/conflict risk from paths beyond the display cap', async () => {
    const h = await harness()
    try {
      // Upstream adds 500 files in one commit (all past the 400 display cap
      // when sorted) AND modifies package.json.
      const files = Array.from({ length: 500 }, (_, i) => `src/generated/file-${String(i).padStart(4, '0')}.ts`)
      mkdirSync(join(h.upstream.path, 'src', 'generated'), { recursive: true })
      for (const f of files) writeFileSync(join(h.upstream.path, f), `// ${f}\n`)
      editAndCommit(h.upstream.path, 'package.json', '{ "name": "tmp", "version": "9.9.9" }\n', 'manifest bump')
      // Local draft on one of the LATE files (beyond the display cap).
      mkdirSync(join(h.work.path, 'src', 'generated'), { recursive: true })
      writeFileSync(join(h.work.path, files[450]), 'console.log(local)\n')

      const check = await h.gateway.check()
      expect(check.ok).toBe(true)
      const plan = h.gateway.status().plan
      expect(plan).not.toBeNull()
      expect(plan!.changedFiles).toHaveLength(400)
      expect(plan!.changedFilesTruncated).toBe(true)
      // Classification used the FULL list, not the capped display list:
      expect(plan!.needsInstall).toBe(true)
      // The local draft sits on a path upstream ADDS → untracked collision,
      // and it is beyond the display cap, so only full-list classification
      // can see it.
      expect(plan!.untrackedRisk).toContain(files[450])
      expect(plan!.changedFilesTruncated).toBe(true)
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('upstream-overlay strategy', () => {
  it('parks the colliding draft and keeps the upstream version', async () => {
    const h = await harness({ strategy: 'upstream-overlay' })
    try {
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      editAndCommit(h.upstream.path, 'src/main.ts', 'console.log(upstream-v2)\n', 'upstream touches the same file')

      await h.gateway.apply()
      const snap = await settle(h.gateway)
      // No conflicts phase: the overlay resolves automatically.
      expect(snap.phase).toBe('restart-pending')
      expect(await fileContent(h.work.path, 'src/main.ts')).toBe('console.log(upstream-v2)\n')
      expect(snap.parkedDrafts).toHaveLength(1)
      expect(snap.parkedDrafts[0].path).toBe('src/main.ts')
      expect(snap.parkedDrafts[0].stashRef).not.toBeNull()
      // No unmerged entries remain after the overlay resolution.
      const res = await runGit(h.work.path, ['diff', '--name-only', '--diff-filter=U'], { timeoutMs: 15_000 })
      expect(res.code).toBe(0)
      expect(res.stdout.trim()).toBe('')
      // The parked draft file exists on disk under .dsh/updater/drafts/.
      const parkedAbs = join(h.work.path, '.dsh', 'updater', snap.parkedDrafts[0].parkedFile)
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(parkedAbs, 'utf8')).toBe('console.log(local-draft)\n')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('ahead > 0 block', () => {
  it('refuses to apply when the local repo has divergent commits', async () => {
    const h = await harness()
    try {
      // Create a local commit ahead of upstream.
      writeFileSync(join(h.work.path, 'local-commit.txt'), 'mine\n')
      commitAll(h.work.path, 'local commit')
      editAndCommit(h.upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream advance')

      const check = await h.gateway.check()
      expect(check.ok).toBe(true)
      const plan = h.gateway.status().plan
      expect(plan?.blocked).toMatch(/Local commits exist/)

      // apply() is fire-and-forget: it returns {ok:true} before the run starts.
      // The refusal surfaces through status().error once the run settles.
      const apply = await h.gateway.apply()
      expect(apply.ok).toBe(true)
      const snap = await settle(h.gateway)
      expect(snap.error).toMatch(/Local commits exist/)
      // Nothing moved.
      expect(snap.phase).toBe('update-available')
      expect(await headOf(h.work.path)).not.toBe(await headOf(h.upstream.path))
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('remote URL guard', () => {
  it('blocks apply when the remote URL does not match expectedRemoteUrl', async () => {
    const h = await harness({ expectedRemoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git' })
    try {
      editAndCommit(h.upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream advance')
      const check = await h.gateway.check()
      expect(check.ok).toBe(true)
      expect(h.gateway.status().remoteUrl).toContain(h.upstream.path)
      const plan = h.gateway.status().plan
      expect(plan?.blocked).toMatch(/remote URL changed/)
      const apply = await h.gateway.apply()
      expect(apply.ok).toBe(true)
      const snap = await settle(h.gateway)
      expect(snap.error).toMatch(/remote URL changed/)
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('allows apply when the remote URL matches (prefix match)', async () => {
    // expectedRemoteUrl must be set AFTER the harness exists (its value is
    // derived from the harness's own upstream repo path).
    const h = await harness()
    await h.gateway.setConfig({ expectedRemoteUrl: h.upstream.path.replace(/\\/g, '/') })
    try {
      editAndCommit(h.upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream advance')
      await h.gateway.apply()
      const snap = await settle(h.gateway)
      expect(snap.phase).toBe('restart-pending')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('restore completeness', () => {
  it('restores HEAD, stashed drafts, and untracked collision files from a backup', async () => {
    const h = await harness()
    try {
      const preHead = await headOf(h.work.path)
      // Draft on a tracked file upstream will touch (stashed by apply).
      writeFileSync(join(h.work.path, 'src/main.ts'), 'console.log(local-draft)\n')
      // Draft on an untracked path upstream will ADD (untracked risk).
      writeFileSync(join(h.work.path, 'scratch.txt'), 'local scratch\n')
      editAndCommit(h.upstream.path, 'src/main.ts', 'console.log(upstream-v2)\n', 'upstream touches main')
      editAndCommit(h.upstream.path, 'scratch.txt', 'upstream scratch\n', 'upstream adds scratch.txt')

      await h.gateway.apply()
      let snap = await settle(h.gateway)
      // scratch.txt is untracked-risk: stash -u + pop should re-apply it cleanly;
      // src/main.ts pops with a content conflict → conflicts phase.
      expect(snap.phase).toBe('conflicts')
      const backupId = snap.backupId
      expect(backupId).not.toBeNull()

      const restore = await h.gateway.restore(backupId!)
      expect(restore.ok).toBe(true)
      snap = await settle(h.gateway)
      expect(snap.phase).toBe('idle')
      // HEAD back at the pre-apply commit.
      expect(await headOf(h.work.path)).toBe(preHead)
      // Draft content restored via local.patch + the untracked snapshot.
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(join(h.work.path, 'src/main.ts'), 'utf8')).toBe('console.log(local-draft)\n')
      expect(readFileSync(join(h.work.path, 'scratch.txt'), 'utf8')).toBe('local scratch\n')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})
