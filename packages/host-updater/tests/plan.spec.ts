/**
 * Pure planner tests: classification of an update plan from raw inputs — collision
 * risk, install/rebuild/restart flags, path capping, and commit parsing.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import { capPaths, computePlan, parseCommits, type PlanInput } from '../src/plan.ts'

function baseInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    currentSha: 'a'.repeat(40),
    upstreamSha: 'b'.repeat(40),
    strategy: 'automerge',
    changedPaths: [],
    commits: [],
    commitsTruncated: false,
    dirtyTracked: [],
    addedPaths: [],
    untrackedPaths: [],
    ...overrides,
  }
}

describe('computePlan', () => {
  it('reports up-to-date as no changes', () => {
    const plan = computePlan(baseInput())
    expect(plan.incomingCount).toBe(0)
    expect(plan.changedFiles).toEqual([])
    expect(plan.needsInstall).toBe(false)
    expect(plan.needsRebuild).toBe(false)
    expect(plan.needsRestart).toBe(false)
    expect(plan.strategy).toBe('automerge')
  })

  it('classifies a host-plane change as needsRebuild + needsRestart', () => {
    const plan = computePlan(baseInput({
      changedPaths: ['packages/host/updater/src/index.ts'],
    }))
    expect(plan.needsRebuild).toBe(true)
    expect(plan.needsRestart).toBe(true)
    expect(plan.conflictRisk).toEqual([])
  })

  it('treats client-only changes as rebuild-without-restart', () => {
    const plan = computePlan(baseInput({
      changedPaths: ['packages/client/ui-something/src/client/index.ts'],
    }))
    expect(plan.needsRestart).toBe(false)
    expect(plan.needsRebuild).toBe(true)
  })

  it('flags dependency manifests as needsInstall', () => {
    const plan = computePlan(baseInput({
      changedPaths: ['package.json', 'pnpm-lock.yaml'],
    }))
    expect(plan.needsInstall).toBe(true)
  })

  it('flags upstream-changed files that also have local drafts as conflict risk', () => {
    const plan = computePlan(baseInput({
      changedPaths: ['packages/host/updater/src/index.ts', 'package.json'],
      dirtyTracked: ['packages/host/updater/src/index.ts'],
    }))
    expect(plan.conflictRisk).toEqual(['packages/host/updater/src/index.ts'])
  })

  it('flags upstream-added files that exist locally as untracked risk', () => {
    const plan = computePlan(baseInput({
      addedPaths: ['packages/new-thing/src/index.ts'],
      untrackedPaths: ['packages/new-thing/src/index.ts', 'scratch.txt'],
    }))
    expect(plan.untrackedRisk).toEqual(['packages/new-thing/src/index.ts'])
  })

  it('preserves strategy', () => {
    const plan = computePlan(baseInput({ strategy: 'upstream-overlay' }))
    expect(plan.strategy).toBe('upstream-overlay')
  })
})

describe('capPaths', () => {
  it('keeps under the cap untruncated', () => {
    const { paths, truncated } = capPaths(['a.ts', 'b.ts'])
    expect(paths).toEqual(['a.ts', 'b.ts'])
    expect(truncated).toBe(false)
  })

  it('caps over the limit keeping the head and marks truncated', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`)
    const { paths, truncated } = capPaths(many)
    expect(truncated).toBe(true)
    expect(paths).toHaveLength(400)
    expect(truncated).toBe(true)
  })
})

describe('parseCommits', () => {
  it('parses tab-separated rows into commit metadata', () => {
    const rows = parseCommits([
      'abcdef1234567890\tAlice\t2026-08-17T10:00:00+00:00\tFix the thing',
      'fedcba0987654321\tBob\t2026-08-17T09:00:00+00:00',
      '',
    ].join('\n'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sha: 'abcdef1234567890',
      short: 'abcdef123456',
      author: 'Alice',
      date: '2026-08-17T10:00:00+00:00',
      subject: 'Fix the thing',
    })
    expect(rows[1].subject).toBe('<empty>')
  })

  it('returns [] for empty input', () => {
    expect(parseCommits('')).toEqual([])
    expect(parseCommits('   \n\n  ')).toEqual([])
  })
})
