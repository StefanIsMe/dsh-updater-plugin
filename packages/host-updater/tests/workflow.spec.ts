/** Recovery regressions use only owned disposable repositories. */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { commandSteps, readOperation, saveOperation } from '../src/workflow.ts'
import { createBackup, pushDraftStashes } from '../src/pipeline.ts'
import { resolveUpdaterConfig } from '../src/config.ts'
import { gitIn, makeTempRepo, commitAll } from './helpers.ts'

describe('recoverable update preparation', () => {
  it('backs up binary files and staged deletions before Git 2.55 stash preparation', async () => {
    const repo = makeTempRepo()
    try {
      writeFileSync(join(repo.path, 'binary.bin'), Buffer.from([0, 255, 1]))
      commitAll(repo.path, 'binary')
      unlinkSync(join(repo.path, 'base.txt'))
      gitIn(repo.path, ['add', '--', 'base.txt'])
      writeFileSync(join(repo.path, 'binary.bin'), Buffer.from([0, 128, 2]))
      writeFileSync(join(repo.path, 'untracked.bin'), Buffer.from([0, 129, 3]))
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      const id = await createBackup(repo.path, config, { headSha: gitIn(repo.path, ['rev-parse', 'HEAD']), stashCount: 0, conflictRisk: ['base.txt', 'binary.bin'], untrackedRisk: ['untracked.bin'] })
      expect(readFileSync(join(repo.path, '.dsh/updater/backups', id, 'checkpoint/binary.bin'))).toEqual(Buffer.from([0, 128, 2]))
      expect(readFileSync(join(repo.path, '.dsh/updater/backups', id, 'checkpoint/untracked.bin'))).toEqual(Buffer.from([0, 129, 3]))
      const saved = await pushDraftStashes(repo.path, ['base.txt', 'binary.bin'], [], 'test')
      expect(saved.refs).toHaveLength(1)
      gitIn(repo.path, ['stash', 'apply', saved.refs[0]!])
      expect(gitIn(repo.path, ['status', '--porcelain', '--', 'base.txt'])).toContain('D base.txt')
      expect(readFileSync(join(repo.path, 'binary.bin'))).toEqual(Buffer.from([0, 128, 2]))
    } finally { repo.cleanup() }
  }, 60_000)

  it('retains operation identity and draft restoration checkpoints across reload', () => {
    const repo = makeTempRepo()
    try {
      const op = { version: 1 as const, id: 'one', targetSha: 'target', backupId: 'backup', stage: 'drafts' as const,
        appliedDraftRefs: ['exact-stash'], applyingDraftRef: null, expectedPlugins: ['local-plugin'], checks: [], initiatorId: null, restartAuthorized: true }
      saveOperation(repo.path, op)
      expect(readOperation(repo.path)).toEqual(op)
    } finally { repo.cleanup() }
  })

  it('runs legacy command chains as separate commands and preserves quoted ampersands', () => {
    expect(commandSteps('node repair.mjs && node build.mjs')).toEqual(['node repair.mjs', 'node build.mjs'])
    expect(commandSteps('node "a&&b.mjs"')).toEqual(['node "a&&b.mjs"'])
    expect(() => commandSteps('node build.mjs | other')).toThrow()
    expect(() => commandSteps('node build.mjs &&')).toThrow()
  })
})
