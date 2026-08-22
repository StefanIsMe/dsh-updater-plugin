/**
 * Regression guard — every historical updater bug is pinned here by name so
 * a future upstream merge that reintroduces it will turn the suite red.
 * These are intentionally redundant with apply.spec.ts / helpers etc., but
 * each test is named after the regression it prevents and contains the exact
 * repro from the original incident report.
 *
 * If this file fails, read docs/self-updater/REGRESSIONS.md for the fix.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { computePlan, capPaths, parseNumstat } from '../src/plan.ts'
import { resolveUpdaterConfig } from '../src/config.ts'

// ── Bug A: dead Apply (runApply called runCheck which refused on applying lock) ──
describe('regression: Bug A — dead Apply', () => {
  it('performCheck must have no guard on applying/checking (runCheck owns the guard)', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    // performCheck must NOT contain the guard string; only runCheck does
    const performStart = src.indexOf('private async performCheck')
    const performBlock = src.slice(performStart, performStart + 2000)
    expect(performBlock).not.toMatch(/if\s*\(\s*this\.checking\.value/)
    expect(performBlock).not.toMatch(/if\s*\(\s*this\.applying\.value/)
    // runCheck must contain the guard
    const runCheckStart = src.indexOf('private async runCheck')
    const runCheckBlock = src.slice(runCheckStart, runCheckStart + 800)
    expect(runCheckBlock).toMatch(/this\.checking\.value.*this\.applying\.value/)
  })
  it('runApply must call performCheck, not runCheck', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    const applyStart = src.indexOf('private async runApply')
    const applyBlock = src.slice(applyStart, applyStart + 3000)
    expect(applyBlock).toContain('performCheck')
    // The old bug was runApply -> runCheck; that string must not appear
    // (allow runCheck definition elsewhere, just not inside runApply)
    const runCheckCallInApply = applyBlock.includes('runCheck(')
    expect(runCheckCallInApply).toBe(false)
  })
})

// ── Bug B: truncated plan + capture() truncation ──
describe('regression: Bug B — truncated plan / capture', () => {
  it('git.ts capture must accumulate size with +=, not =', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/git.ts', 'utf8'))
    expect(src).toContain('size += buf.length')
    expect(src).not.toMatch(/\n\s*size\s*=\s*buf\.length/)
    expect(src).toContain('REGRESSION GUARD — Bug B root cause')
  })
  it('computePlan doc must say FULL change set (DISPLAY_CAP only after)', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/plan.ts', 'utf8'))
    expect(src).toContain('FULL')
    expect(src).toContain('REGRESSION GUARD — Bug B')
  })
  it('computePlan classifies on the full list, not the display cap', () => {
    // 500 files, one late file collides with a local dirty file past the 400 cap
    const files = Array.from({ length: 500 }, (_, i) => `src/generated/file-${String(i).padStart(4, '0')}.ts`)
    const dirty = [files[450]!]
    const plan = computePlan({
      currentSha: 'a',
      upstreamSha: 'b',
      strategy: 'automerge',
      changedPaths: files,
      addedPaths: [files[450]!],
      dirtyTracked: dirty,
      untrackedPaths: [],
      commits: [],
      commitsTruncated: false,
    })
    // Before the fix this would be empty because capPaths was called first
    expect(plan.conflictRisk).toContain(files[450]!)
    // Display capping happens after, not here
    expect(plan.changedFiles.length).toBe(500)
    const capped = capPaths(plan.changedFiles, 400)
    expect(capped.paths.length).toBe(400)
    expect(capped.truncated).toBe(true)
  })
  it('needsInstall must be true even when package.json is beyond the display cap', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`)
    files.push('package.json') // 501st, beyond 400
    const plan = computePlan({
      currentSha: 'a',
      upstreamSha: 'b',
      strategy: 'automerge',
      changedPaths: files,
      addedPaths: [],
      dirtyTracked: [],
      untrackedPaths: [],
      commits: [],
      commitsTruncated: false,
    })
    expect(plan.needsInstall).toBe(true)
    expect(plan.changedFiles.length).toBe(501)
  })
})

// ── Bug C: UI swallows outcomes ──
describe('regression: Bug C — UI swallows outcomes', () => {
  it('UpdaterStore must unwrap RemoteResult envelope', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/client/ui-updater/src/client/updater-store.ts', 'utf8'))
    expect(src).toContain('unwrapAction')
    expect(src).toContain('result.ok ? result.value')
    expect(src).toContain('RemoteResult')
  })
})

// ── Bug D: pnpm run build is broken ──
describe('regression: Bug D — buildCommand pin', () => {
  it('config default must not be pnpm run build', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/config.ts', 'utf8'))
    expect(src).not.toMatch(/buildCommand:.*default\('pnpm run build'\)/)
    expect(src).toContain('node scripts/rebuild-dsh-client.mjs')
  })
  it('normalizeConfig must migrate pnpm run build to the safe command', () => {
    const cfg = resolveUpdaterConfig({ repoPath: 'C:\\tmp', buildCommand: 'pnpm run build' } as unknown)
    expect(cfg.buildCommand).not.toBe('pnpm run build')
    expect(cfg.buildCommand).toBe('node scripts/rebuild-dsh-client.mjs')
  })
  it('autoApply must be clamped to false', () => {
    const cfg = resolveUpdaterConfig({ repoPath: 'C:\\tmp', autoApply: true } as unknown)
    expect(cfg.autoApply).toBe(false)
  })
})

// ── Bug E: EBUSY / autocrlf / settle harness ──
describe('regression: Bug E — test harness', () => {
  it('helpers must use rmRetry with Atomics.wait backoff', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/tests/helpers.ts', 'utf8'))
    expect(src).toContain('rmRetry')
    expect(src).toContain('Atomics.wait')
  })
  it('helpers must set core.autocrlf false', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/tests/helpers.ts', 'utf8'))
    expect(src).toContain('core.autocrlf')
    expect(src).toContain('false')
  })
})

// ── Bug F: stash leak after resolve ──
describe('regression: Bug F — stash leak', () => {
  it('resolveConflict and writeMerged must drop stashes on finalization', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    // Both finalization paths should call dropApplyStashes
    const matches = src.match(/dropApplyStashes/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3) // restore + resolve + writeMerged
    expect(src).toContain('Hardening: drop the stash')
    expect(src).toContain('Hardening: same stash cleanup')
  })
  it('engine must heal stale stashRefs on boot', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/engine.ts', 'utf8'))
    expect(src).toContain('REGRESSION GUARD — stale stash leak')
    expect(src).toContain('hasStaleStash')
  })
})

// ── Guard: remote URL & ahead>0 block ──
describe('regression: guard — remote URL and ahead>0', () => {
  it('index.ts must contain remoteGuard and ahead block', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    expect(src).toContain('remoteGuard')
    expect(src).toContain('Local commits exist')
    expect(src).toContain('expectedRemoteUrl')
  })
  it('computePlan must carry blocked through to the snapshot', () => {
    const plan = computePlan({
      currentSha: 'a',
      upstreamSha: 'b',
      strategy: 'automerge',
      changedPaths: ['src/main.ts'],
      addedPaths: [],
      dirtyTracked: [],
      untrackedPaths: [],
      commits: [],
      commitsTruncated: false,
      blocked: 'Local commits exist (1 ahead)',
    })
    expect(plan.blocked).toBe('Local commits exist (1 ahead)')
  })
})

// ── Guard: overlay parking ──
describe('regression: guard — upstream-overlay parking', () => {
  it('pipeline must implement overlay parking under .dsh/updater/drafts', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/pipeline.ts', 'utf8'))
    expect(src).toContain('writeParkedDraft')
    expect(src).toContain('drafts')
    expect(src).toContain('overlay')
  })
  it('plan must distinguish conflictRisk vs untrackedRisk', () => {
    const plan = computePlan({
      currentSha: 'a',
      upstreamSha: 'b',
      strategy: 'automerge',
      changedPaths: ['src/main.ts', 'new.txt'],
      addedPaths: ['new.txt'],
      dirtyTracked: ['src/main.ts'],
      untrackedPaths: ['new.txt'],
      commits: [],
      commitsTruncated: false,
    })
    expect(plan.conflictRisk).toEqual(['src/main.ts'])
    expect(plan.untrackedRisk).toEqual(['new.txt'])
  })
})

/* parseNumstat bound is unrelated but pinned for completeness */
describe('regression: guard — numstat', () => {
  it('parseNumstat must handle binary "-" rows and join tabs in paths', () => {
    const stats = parseNumstat('10\t2\tpath/with\ttab.ts\n-\t-\tbinary.png\n')
    expect(stats[0]!.path).toBe('path/with\ttab.ts')
    expect(stats[1]!.added).toBe(0)
  })
})

// ── Bug F (2026-08-22): poll tick demoted 'conflicts' to idle mid-resolution ──
// A fast-forward that stops at stash-pop conflicts leaves HEAD == upstream, so
// the next check's up-to-date branch flipped the phase to idle while unmerged
// paths remained — resolveConflict/writeMerged then refuse outside the
// conflicts phase, stranding resolution until a full restore + re-apply.
describe('regression: Bug F — poll clobbers conflicts phase', () => {
  it('the up-to-date branch must consult unmergedPaths before demoting to idle', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    const upToDateMark = src.indexOf('const upToDate =')
    expect(upToDateMark).toBeGreaterThan(0)
    // Take the branch from its marker to the idle demotion; the guard must sit
    // between them so no idle transition can happen while drafts are unmerged.
    const idleAfter = src.indexOf("this.setPhase('idle')", upToDateMark)
    expect(idleAfter).toBeGreaterThan(upToDateMark)
    const branch = src.slice(upToDateMark, idleAfter)
    expect(branch).toMatch(/unmergedPaths\(/)
    expect(branch).toMatch(/setPhase\('conflicts'\)/)
    // And the refusal message must tell the caller resolution is still pending.
    const afterIdle = src.slice(idleAfter, idleAfter + 400)
    expect(afterIdle.includes('still need resolution') || branch.includes('still need resolution')).toBe(true)
  })
  it('probeResidualConflicts must stay phase-aware (conflicts/error only)', async () => {
    const src = await import('node:fs').then(m => m.readFileSync('packages/host/updater/src/index.ts', 'utf8'))
    const probeStart = src.indexOf('private async probeResidualConflicts')
    const probeBlock = src.slice(probeStart, probeStart + 600)
    expect(probeBlock).toMatch(/phase !== 'error' && this\.state\.phase !== 'conflicts'/)
  })
})
