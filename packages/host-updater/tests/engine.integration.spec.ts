/**
 * Git-engine integration tests on a throwaway temp repo. The real DSH checkout is
 * never touched: everything runs against a temp dir created by helpers.ts.
 *
 * @vitest-environment node
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  editAndCommit, gitIn, makeTempRepo,
} from './helpers.ts'
import {
  hasGitOperationInProgress, readMergeHead, resolveHead, runGit,
} from '../src/git.ts'
import { parseCommandLine, runLongCommand } from '../src/pipeline.ts'

describe('runGit basics', () => {
  it('resolves HEAD of a fresh repo', async () => {
    const repo = makeTempRepo('master')
    try {
      const sha = await resolveHead(repo.path)
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      const res = await runGit(repo.path, ['rev-parse', 'HEAD'])
      expect(res.code).toBe(0)
      expect(res.stdout.trim()).toBe(sha)
    } finally {
      repo.cleanup()
    }
  })

  it('returns a non-zero code for a failing command without rejecting', async () => {
    const repo = makeTempRepo('master')
    try {
      const res = await runGit(repo.path, ['rev-parse', 'NOT_A_REF'], { timeoutMs: 10_000 })
      expect(res.code).not.toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('reports no in-progress operation on a clean repo', () => {
    const repo = makeTempRepo('master')
    try {
      expect(hasGitOperationInProgress(repo.path)).toBeNull()
      expect(readMergeHead(repo.path)).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

describe('working-tree scans', () => {
  it('detects a dirty tracked file and an untracked file', async () => {
    const repo = makeTempRepo('master')
    try {
      editAndCommit(repo.path, 'src/main.ts', 'console.log(2)\n', 'second')
      // A local (uncommitted) draft:
      writeFileSync(join(repo.path, 'src/main.ts'), 'console.log(local)\n')
      writeFileSync(join(repo.path, 'scratch.txt'), 'local\n')
      const res = await runGit(repo.path, ['status', '--porcelain', '--untracked-files=all'], { timeoutMs: 30_000 })
      expect(res.stdout).toContain('src/main.ts')
      expect(res.stdout).toContain('scratch.txt')
    } finally {
      repo.cleanup()
    }
  })

  it('fast-forwards cleanly when only non-colliding files change', async () => {
    const upstream = makeTempRepo('master')
    const work = makeTempRepo('master')
    try {
      // Work tracks upstream via a remote; upstream then advances on a file
      // work never touched. The two repos share the baseline history through
      // the fetch below only if they start from the same commit — so reset work
      // to upstream's baseline first.
      gitIn(work.path, ['remote', 'add', 'origin', upstream.path])
      gitIn(work.path, ['fetch', 'origin'])
      gitIn(work.path, ['reset', '--hard', 'origin/master'])
      const baseline = await resolveHead(work.path)
      expect(baseline).toBe(await resolveHead(upstream.path))

      editAndCommit(upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream-only change')
      gitIn(work.path, ['fetch', 'origin'])
      const before = await resolveHead(work.path)
      const merged = await runGit(work.path, ['merge', '--ff-only', 'origin/master'], { timeoutMs: 60_000 })
      expect(merged.code).toBe(0)
      const after = await resolveHead(work.path)
      expect(after).not.toBe(before)
      expect(await isClean(work.path)).toBe(true)
    } finally {
      upstream.cleanup()
      work.cleanup()
    }
  })
})

async function isClean(repo: string): Promise<boolean> {
  const res = await runGit(repo, ['status', '--porcelain'], { timeoutMs: 30_000 })
  return res.stdout.trim().length === 0
}

describe('parseCommandLine + runLongCommand', () => {
  it('tokenizes a simple command', () => {
    expect(parseCommandLine('pnpm run build')).toEqual(['pnpm', 'run', 'build'])
  })

  it('handles quotes and whitespace', () => {
    expect(parseCommandLine('cmd "a b" c')).toEqual(['cmd', 'a b', 'c'])
    expect(parseCommandLine('')).toEqual([])
    expect(parseCommandLine('  single  spaced  ')).toEqual(['single', 'spaced'])
  })

  it('runs a real short command and streams lines', async () => {
    const lines: string[] = []
    const result = await runLongCommand(process.cwd(), ['node', '-e', 'console.log("hello");console.log("world")'], (line) => lines.push(line), { timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
    expect(lines.join(' ')).toContain('hello')
    expect(lines.join(' ')).toContain('world')
  }, 60_000)

  it('returns ok=false when the command is empty', async () => {
    const result = await runLongCommand(process.cwd(), [], () => {})
    expect(result.ok).toBe(false)
  })
})
