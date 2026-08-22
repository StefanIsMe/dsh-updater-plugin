/**
 * Bug G (2026-08-22) — restore residue + staged-draft backup gap.
 *
 * Incident: apply stopped at stash-pop conflicts; a later check/restore left
 * six unmerged index entries, kept the apply stash, and reported success.
 *
 * Two defects pinned here:
 *   G1: createBackup captured `git diff --full-index` (UNSTAGED only), so
 *       drafts that were STAGED at backup time rode the stash but were never
 *       in local.patch — restore dropped the stash and lost them forever.
 *   G2: runRestore reported success and wiped state while unmerged index
 *       entries remained, never refreshed snapshot fields, and hid patch
 *       failures from the caller.
 *
 * @vitest-environment node
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitIn, makeTempRepo } from './helpers.ts'
import { runGit, resolveHead } from '../src/git.ts'
import { applyLocalPatch, dropApplyStashes, unmergedPaths, createBackup } from '../src/pipeline.ts'
import { stateDirOf } from '../src/config.ts'

const FILES = ["a.ts","b.ts","c.ts","d.ts","e.ts","f.ts","g.ts","h.ts"]
const STAGED = ['b.ts', 'c.ts', 'd.ts', 'e.ts']

function draft(repo: string, f: string): string {
  return readFileSync(join(repo, 'src', f), 'utf8')
}

async function incidentRepo() {
  const repo = makeTempRepo('master')
  const cfg = { backups: true, backupsKeep: 5 } as const
  // base commit
  mkdirSync(join(repo.path, 'src'), { recursive: true })
  for (const f of FILES) writeFileSync(join(repo.path, 'src', f), 'base-' + f + String.fromCharCode(10))
  gitIn(repo.path, ['add', '-A'])
  gitIn(repo.path, ['commit', '-m', 'base'])
  const base = await resolveHead(repo.path)
  // drafts on every file; FIRST FOUR get STAGED (the backup gap)
  for (const f of FILES) writeFileSync(join(repo.path, 'src', f), 'base-' + f + String.fromCharCode(10) + 'draft-' + f + String.fromCharCode(10))
  for (const f of STAGED) gitIn(repo.path, ['add', join('src', f)])
  // backup exactly as apply does (preHead, stashCount 1 incoming)
  const backupId = await createBackup(repo.path, cfg as never, { headSha: base, stashCount: 0, conflictRisk: [], untrackedRisk: [] })
  // apply choreography: stash everything -> upstream diverges on a.ts -> pop
  gitIn(repo.path, ['stash', 'push', '-m', 'updater'])
  writeFileSync(join(repo.path, 'src', 'a.ts'), 'base-a.ts' + String.fromCharCode(10) + 'upstream-touched' + String.fromCharCode(10))
  gitIn(repo.path, ['add', join('src', 'a.ts')])
  gitIn(repo.path, ['commit', '-m', 'upstream touches a.ts'])
  await runGit(repo.path, ['stash', 'pop'], { timeoutMs: 60_000 })
  const duringApply = await unmergedPaths(repo.path)
  return { repo, cfg: cfg as never, base, backupId, duringApply }
}

// ── G2: the restore choreography must end clean, complete, and truthful ──
describe('Bug G2 - restore ends clean and truthful', () => {
  it('no unmerged entries, every draft back (staged ones included)', async () => {
    const { repo, base, backupId, duringApply } = await incidentRepo()
    try {
      expect(duringApply).toContain('src/a.ts')
      // verbatim runRestore choreography
      await runGit(repo.path, ['merge', '--abort'], { timeoutMs: 30_000 }).catch(() => undefined)
      const reset = await runGit(repo.path, ['reset', '--hard', base], { timeoutMs: 60_000 })
      expect(reset.code).toBe(0)
      const patch = await applyLocalPatch(repo.path, stateDirOf(repo.path), backupId)
      console.log('[G] patch:', JSON.stringify(patch))
      if (patch.ok && patch.message !== 'no patch') {
        const top = await runGit(repo.path, ['rev-parse', 'stash@{0}'], { timeoutMs: 20_000 })
        if (top.code === 0) await dropApplyStashes(repo.path, [top.stdout.trim()])
      }
      const residue = await unmergedPaths(repo.path)
      console.log('[G] residue:', JSON.stringify(residue))
      expect(residue).toEqual([])
      for (const f of FILES) {
        const text = readFileSync(join(repo.path, 'src', f), 'utf8')
        expect(text).toContain('draft-' + f)
        expect(text).not.toMatch(/^<{7}/m)
      }
    } finally {
      repo.cleanup()
    }
  });
});