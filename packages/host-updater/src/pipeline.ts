/**
 * Apply-pipeline helpers: working-tree scanning, safety backups, draft stash
 * push/pop (the collision handlers), and long-running subprocess helpers.
 * Everything here performs its own bounded git runs; it never mutates state.
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runGit } from './git.ts'
import type { UpdaterConfig } from './config.ts'
import { stateDirOf } from './config.ts'

/** Minimal git status v1 path unquoting (double-quoted paths with escapes). */
export function decodeStatusPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try { return JSON.parse(path) as string } catch { return path }
  }
  return path
}

/** Scan the working tree for local drafts: tracked modifications + untracked files. */
export async function scanWorkingTree(repo: string): Promise<{ dirtyTracked: string[]; untracked: string[] }> {
  const res = await runGit(repo, ['status', '--porcelain', '--untracked-files=all'], { timeoutMs: 30_000 })
  const dirtyTracked: string[] = []
  const untracked: string[] = []
  for (const line of res.stdout.split('\n')) {
    if (line.length < 3) continue
    const xy = line.slice(0, 2)
    const path = decodeStatusPath(line.slice(3))
    if (xy === '??' || (xy[0] === '?' && xy[1] === '?')) untracked.push(path)
    else dirtyTracked.push(path)
  }
  return {
    dirtyTracked: [...new Set(dirtyTracked)],
    untracked: [...new Set(untracked)],
  }
}

/** Number of stashes currently on the stack. */
export async function countStashes(repo: string): Promise<number> {
  const res = await runGit(repo, ['stash', 'list'], { timeoutMs: 20_000 })
  if (res.code !== 0) return 0
  return res.stdout.split('\n').filter(l => l.trim().length > 0).length
}

interface BackupMeta {
  createdAt: string
  reason: string
  headSha: string | null
  stashCount: number
  conflictRisk: string[]
  untrackedRisk: string[]
}

/** Create a safety backup directory for one apply and prune old ones. */
export async function createBackup(repo: string, config: UpdaterConfig, info: { headSha: string | null; stashCount: number; conflictRisk: readonly string[]; untrackedRisk: readonly string[] }): Promise<string> {
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(stateDirOf(repo), 'backups', id)
  mkdirSync(dir, { recursive: true })
  const meta: BackupMeta = {
    createdAt: new Date().toISOString(),
    reason: 'apply',
    headSha: info.headSha,
    stashCount: info.stashCount,
    conflictRisk: [...info.conflictRisk],
    untrackedRisk: [...info.untrackedRisk],
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(meta, null, 2)}\n`)
  if (config.backups) {
    const patch = await runGit(repo, ['diff', '--full-index'], { timeoutMs: 60_000 })
    if (patch.code === 0) {
      try { writeFileSync(join(dir, 'local.patch'), patch.stdout) } catch { /* best effort */ }
    }
  }
  // Belt-and-braces snapshot of the untracked-risk files (tiny by design).
  for (const rel of info.untrackedRisk) {
    const src = join(repo, ...rel.split('/'))
    try {
      if (existsSync(src) && statSync(src).isFile()) {
        const dst = join(dir, 'untracked', rel)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
    } catch { /* best effort */ }
  }
  pruneBackups(repo, config)
  return id
}

/** Backups are pruned newest-first; keep at most backupsKeep. */
function pruneBackups(repo: string, config: UpdaterConfig): void {
  const dir = join(stateDirOf(repo), 'backups')
  if (!existsSync(dir)) return
  const keep = Math.max(1, config.backupsKeep)
  const dirs = readdirSync(dir).filter(n => /^\d{4}-\d{2}/.test(n)).sort().reverse()
  for (const stale of dirs.slice(keep)) {
    try { rmSync(join(dir, stale), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Read a backup's manifest, or null when absent/corrupt. */
export async function readBackupMeta(repo: string, id: string): Promise<BackupMeta | null> {
  try {
    const file = join(stateDirOf(repo), 'backups', id, 'manifest.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackupMeta>
    return {
      createdAt: raw.createdAt ?? '',
      reason: raw.reason ?? 'apply',
      headSha: raw.headSha ?? null,
      stashCount: typeof raw.stashCount === 'number' ? raw.stashCount : 0,
      conflictRisk: Array.isArray(raw.conflictRisk) ? raw.conflictRisk.filter((x): x is string => typeof x === 'string') : [],
      untrackedRisk: Array.isArray(raw.untrackedRisk) ? raw.untrackedRisk.filter((x): x is string => typeof x === 'string') : [],
    }
  } catch {
    return null
  }
}

/**
 * Stash the colliding drafts (untracked first, then tracked — so pops hit the
 * tracked stash on top and surface real conflict markers first) so a
 * fast-forward merge can run. Returns the number of stashes actually created
 * plus their commit SHAs (top of the stack last), so the caller can resolve
 * conflicts against the exact stash that holds a draft.
 */
export async function pushDraftStashes(
  repo: string,
  trackedPaths: readonly string[],
  untrackedPaths: readonly string[],
  tag: string,
): Promise<{ created: number; refs: string[] }> {
  const created: number[] = []
  const refs: string[] = []
  if (untrackedPaths.length > 0) {
    const r = await runGit(repo, ['stash', 'push', '-u', '-m', `updater-u:${tag}`, '--', ...untrackedPaths], { timeoutMs: 60_000 })
    if (r.code === 0) {
      created.push(1)
      const ref = await runGit(repo, ['rev-parse', 'stash@{0}'], { timeoutMs: 20_000 })
      if (ref.code === 0) refs.push(ref.stdout.trim())
    } else {
      throw new Error(`Failed to stash untracked drafts on ${untrackedPaths.length} path(s): ${r.stderr.trim() || 'unknown'}`)
    }
  }
  if (trackedPaths.length > 0) {
    const r = await runGit(repo, ['stash', 'push', '-m', `updater:${tag}`, '--', ...trackedPaths], { timeoutMs: 60_000 })
    if (r.code === 0) {
      created.push(1)
      const ref = await runGit(repo, ['rev-parse', 'stash@{0}'], { timeoutMs: 20_000 })
      if (ref.code === 0) refs.push(ref.stdout.trim())
    } else {
      throw new Error(`Failed to stash local drafts on ${trackedPaths.length} file(s): ${r.stderr.trim() || 'unknown'}`)
    }
  }
  return { created: created.length, refs }
}

/** Write a stashed draft blob next to the working tree as `<path>.local`. */
export async function writeParkedDraft(
  repo: string,
  stateDir: string,
  backupId: string,
  path: string,
  stashRef: string,
): Promise<{ parkedFile: string } | null> {
  const blob = await runGit(repo, ['show', `${stashRef}:${path}`], { timeoutMs: 30_000 })
  if (blob.code !== 0) return null
  const parkedFile = join('drafts', backupId, ...path.split('/')) + '.local'
  const dst = join(stateDir, parkedFile)
  try {
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, blob.stdout, 'utf8')
    return { parkedFile }
  } catch {
    return null
  }
}

/**
 * Pop `n` stashes from the top of the stack (newest first). A conflict aborts
 * the loop and reports it — the stash is left intact for manual resolution.
 *
 * In `overlay` mode (the upstream-overlay strategy) a pop conflict is resolved
 * automatically: the local draft is parked under `.dsh/updater/drafts/` (never
 * dropped), the upstream version stays in the tree, the conflict is staged
 * away, and the handled stash is dropped — the apply then continues.
 */
export async function unstashN(
  repo: string,
  n: number,
  options: {
    overlay?: boolean
    stateDir?: string
    backupId?: string
    onParked?: (path: string, parkedFile: string, stashRef: string | null) => void
  } = {},
): Promise<{ conflicts: string[]; parked: string[] }> {
  const conflicts: string[] = []
  const parked: string[] = []
  for (let i = 0; i < n; i += 1) {
    const r = await runGit(repo, ['stash', 'pop'], { timeoutMs: 60_000 })
    if (r.code === 0) continue
    // A conflict leaves the stash on the stack. Tracked-file conflicts surface
    // as unmerged markers; an untracked-stash pop that fails because upstream
    // now owns the path leaves NO markers — enumerate the stash's own paths
    // instead so the collision is still reported (never silently dropped).
    let files = await unmergedPaths(repo)
    if (files.length === 0) {
      const shown = await runGit(repo, ['stash', 'show', '--name-only', 'stash@{0}'], { timeoutMs: 20_000 })
      files = shown.stdout.split('\n').map(p => p.trim()).filter(p => p.length > 0)
    }
    if (options.overlay === true && files.length > 0) {
      const stashRes = await runGit(repo, ['rev-parse', 'stash@{0}'], { timeoutMs: 20_000 })
      const stashRef = stashRes.code === 0 ? stashRes.stdout.trim() : null
      for (const f of files) {
        if (!parked.includes(f)) parked.push(f)
        if (stashRef !== null && options.stateDir !== undefined && options.backupId !== undefined) {
          const parkedFile = await writeParkedDraft(repo, options.stateDir, options.backupId, f, stashRef)
          if (parkedFile !== null) {
            options.onParked?.(f, parkedFile.parkedFile, stashRef)
            continue
          }
        }
        if (!conflicts.includes(f)) conflicts.push(f)
      }
      // Resolve the conflict to the upstream version and drop the handled stash.
      if (stashRef !== null) {
        for (const f of files) {
          await runGit(repo, ['checkout', 'HEAD', '--', f], { timeoutMs: 30_000 })
          await runGit(repo, ['add', '--', f], { timeoutMs: 30_000 })
        }
        await runGit(repo, ['stash', 'drop'], { timeoutMs: 30_000 })
      }
      continue
    }
    for (const f of files) if (!conflicts.includes(f)) conflicts.push(f)
    break
  }
  return { conflicts, parked }
}

/** Paths with unmerged markers right now (`git diff --diff-filter=U`). */
export async function unmergedPaths(repo: string): Promise<string[]> {
  const res = await runGit(repo, ['diff', '--name-only', '--diff-filter=U'], { timeoutMs: 20_000 })
  return res.stdout.split('\n').map(p => p.trim()).filter(p => p.length > 0)
}

/**
 * Restore the `untracked/` snapshot of one backup into the working tree.
 * Overwrites only paths that are absent or still hold conflict markers, so a
 * newer file created after the backup is never clobbered.
 */
export function restoreUntrackedSnapshot(stateDir: string, backupId: string, repo: string): { restored: number; skipped: string[] } {
  const dir = join(stateDir, 'backups', backupId, 'untracked')
  if (!existsSync(dir)) return { restored: 0, skipped: [] }
  let restored = 0
  const skipped: string[] = []
  const walk = (rel: string): void => {
    const src = join(dir, rel)
    let entries: string[]
    try {
      entries = readdirSync(src)
    } catch {
      return
    }
    for (const entry of entries) {
      const relChild = rel.length === 0 ? entry : `${rel}/${entry}`
      const srcChild = join(src, entry)
      const dst = join(repo, ...relChild.split('/'))
      if (existsSync(srcChild) && statSync(srcChild).isDirectory()) {
        walk(relChild)
        continue
      }
      if (!existsSync(srcChild)) continue
      const keepNewer = existsSync(dst) && !hasConflictMarkers(dst)
      if (keepNewer) {
        skipped.push(relChild)
        continue
      }
      try {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(srcChild, dst)
        restored += 1
      } catch { /* best effort */ }
    }
  }
  walk('')
  return { restored, skipped }
}

/** Cheap heuristic: does a working-tree file still contain unmerged markers? */
function hasConflictMarkers(file: string): boolean {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 256)
    return head.includes('<<<<<<< ') || head.includes('>>>>>>> ')
  } catch {
    return false
  }
}

/**
 * Re-apply the pre-apply tracked drafts captured as `local.patch`
 * (`git diff --full-index` at backup time). 3-way so it merges against the
 * reset index instead of requiring a clean match.
 */
export async function applyLocalPatch(repo: string, stateDir: string, backupId: string): Promise<{ ok: boolean; message: string }> {
  const patchPath = join(stateDir, 'backups', backupId, 'local.patch')
  if (!existsSync(patchPath)) return { ok: true, message: 'no patch' }
  const res = await runGit(repo, ['apply', '--3way', patchPath], { timeoutMs: 60_000 })
  if (res.code === 0) return { ok: true, message: 'local drafts re-applied' }
  return { ok: false, message: `local.patch did not apply cleanly (saved at ${patchPath}): ${res.stderr.trim() || res.stdout.trim() || 'unknown'}` }
}

/**
 * Drop the apply's own stashes from the top of the stack, verifying each top
 * entry against the recorded stash SHAs so foreign stashes are never touched.
 * Returns the number dropped.
 */
export async function dropApplyStashes(repo: string, expectedRefs: readonly string[]): Promise<number> {
  let dropped = 0
  for (;;) {
    const top = await runGit(repo, ['rev-parse', 'stash@{0}'], { timeoutMs: 20_000 })
    if (top.code !== 0) break
    const sha = top.stdout.trim()
    if (!expectedRefs.includes(sha)) break
    const res = await runGit(repo, ['stash', 'drop'], { timeoutMs: 30_000 })
    if (res.code !== 0) break
    dropped += 1
  }
  return dropped
}

/** Long-running foreground command with a bounded tail log (for install/build). */
export async function runLongCommand(
  repo: string,
  argv: readonly string[],
  onLine: (text: string) => void,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ ok: boolean; code: number | null; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
  const program = argv[0]
  if (program === undefined) {
    onLine('[spawn] failed: command is empty')
    return { ok: false, code: null, timedOut: false }
  }
  return new Promise((resolve) => {
    const child = spawn(program, [...argv.slice(1)], {
      cwd: repo,
      detached: false,
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      windowsHide: true,
    })
    let size = 0
    const pipe = (chunk: Buffer): void => {
      if (size >= maxBytes || chunk.length === 0) return
      size += chunk.length
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) if (line.trim().length > 0) onLine(line.slice(0, 500))
    }
    child.stdout.on('data', pipe)
    child.stderr.on('data', pipe)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      onLine(`[spawn] failed: ${String(error.message)}`)
      resolve({ ok: false, code: null, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) onLine(`[timed out after ${timeoutMs} ms]`)
      resolve({ ok: code === 0, code, timedOut })
    })
  })
}

/**
 * Minimal whitespace+quote tokenizer for configured command strings (e.g.
 * `pnpm run build`). No shell semantics beyond that — argv stays explicit.
 */
export function parseCommandLine(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t') {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}
