/**
 * Pure plan computation for an available update. Feeds everything the UI needs to
 * present consequences (draft collisions, install/rebuild/restart needs) and the
 * apply pipeline decides its stashing against.
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import type { UpdaterCommit, UpdaterFileStat, UpdaterPlan, UpdaterStrategy } from './types.ts'

/** Raw material the planner needs, gathered by the engine before compute. */
export interface PlanInput {
  readonly currentSha: string
  readonly upstreamSha: string
  readonly strategy: UpdaterStrategy
  /** All paths changed between HEAD and upstream (relative, LF, no quoting). */
  readonly changedPaths: readonly string[]
  /** Subset of changedPaths that upstream ADDS (path must not exist locally at HEAD.). */
  readonly addedPaths: readonly string[]
  /** Tracked paths with local (uncommitted) drafts. */
  readonly dirtyTracked: readonly string[]
  /** Untracked paths present in the working tree. */
  readonly untrackedPaths: readonly string[]
  /** Incoming commits (optionally bounded) and whether the list was truncated. */
  readonly commits: readonly UpdaterCommit[]
  readonly commitsTruncated: boolean
  /** Per-path add/delete stats (best-effort, bounded). */
  readonly fileStats?: readonly UpdaterFileStat[]
  /** Why the update cannot be applied, or null. */
  readonly blocked?: string | null
}

/** Root-level markers whose change makes a dependency install necessary. */
const INSTALL_MARKERS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'])

/** Line-prefix of client plane files: rebuilt into the browser, no host restart. */
function isClientPlane(path: string): boolean {
  return path.startsWith('packages/client/') || path.startsWith('apps/web/')
}

/**
 * Compute the plan for one update. Pure with respect to its input.
 *
 * REGRESSION GUARD — Bug B (2026-08-19): the input path lists MUST be the FULL
 * change set. Classification (install/rebuild/restart + conflictRisk/untrackedRisk)
 * is only correct on the complete diff. Display bounding of `changedFiles` happens
 * at the snapshot boundary (index.ts caps to DISPLAY_CAP=400 AFTER computePlan),
 * never before. The real bug was git.ts capture() truncating to the last chunk
 * (46 paths instead of 501) AND capPaths-before-computePlan — both now fixed.
 * See REGRESSIONS.md and git.ts capture() guard. Every test that checks
 * plan.changedFiles.length === 400 also asserts the classification used the full list.
 */
export function computePlan(input: PlanInput): UpdaterPlan {
  const needsInstall = input.changedPaths.some(path => INSTALL_MARKERS.has(path))
  const changedFiles = [...input.changedPaths]
  const needsRebuild = changedFiles.length > 0
  const needsRestart = changedFiles.some(path => !isClientPlane(path))
  const conflictRisk = changedFiles.filter(path => input.dirtyTracked.includes(path))
  const untrackedRisk = input.addedPaths.filter(path => input.untrackedPaths.includes(path))
  return {
    incomingCount: input.commits.length,
    incomingCommits: input.commits,
    commitsTruncated: input.commitsTruncated,
    changedFiles,
    changedFilesTruncated: false,
    fileStats: input.fileStats ?? [],
    conflictRisk,
    untrackedRisk,
    needsInstall,
    needsRebuild,
    needsRestart,
    strategy: input.strategy,
    blocked: input.blocked ?? null,
  }
}

/** Bound a candidate path list, keeping the head. */
export function capPaths(paths: readonly string[], cap = 400): { paths: readonly string[]; truncated: boolean } {
  return paths.length > cap ? { paths: paths.slice(0, cap), truncated: true } : { paths, truncated: false }
}

/**
 * Parse `git log` output (one commit per line:
 * `<sha>\t<author>\t<iso date>\t<subject>`) into commit rows.
 */
export function parseCommits(text: string): UpdaterCommit[] {
  if (text.trim().length === 0) return []
  const out: UpdaterCommit[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const [sha, author = '', date = '', ...subjectParts] = line.split('\t')
    if (sha === undefined || sha.length === 0) continue
    const short = sha.slice(0, 12)
    out.push({ sha, short, author, date, subject: subjectParts.join(' ') || '<empty>' })
  }
  return out
}

/**
 * Parse `git diff --numstat` output (`<added>\t<deleted>\t<path>`) into
 * per-path stats, bounded to `limit` rows. Binary rows report `-` and are
 * counted as 0 lines.
 */
export function parseNumstat(text: string, limit = 2000): UpdaterFileStat[] {
  if (text.trim().length === 0) return []
  const out: UpdaterFileStat[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0 || out.length >= limit) continue
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t')
    if (pathParts.length === 0) continue
    const path = pathParts.join('\t')
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10)
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw ?? '0', 10)
    out.push({ path, added: Number.isFinite(added) ? added : 0, deleted: Number.isFinite(deleted) ? deleted : 0 })
  }
  return out
}
