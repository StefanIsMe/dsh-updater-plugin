/**
 * Git engine of the updater: bounded `git` invocations over the managed repo.
 * argv-based spawn (no shell), no terminal prompts, dead simple capture with a
 * hard cap, and a bounded timeout. Every caller must only pass argv — paths and
 * refs travel as separate arguments, so no quoting layer exists.
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Marker file/directory names that mean git is mid-operation. */
const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const

/** Whether the repo has a merge/rebase/cherry-pick in progress (synchronous probe). */
export function hasGitOperationInProgress(repoPath: string): string | null {
  for (const marker of IN_PROGRESS_MARKERS) {
    if (existsSync(join(repoPath, '.git', marker))) return marker
  }
  // Worktree checkouts use a `.git` file; the real git dir differs. Best-effort:
  return null
}

/** Raw MERGE_HEAD content (the in-flight merge target), or null. */
export function readMergeHead(repoPath: string): string | null {
  const marker = join(repoPath, '.git', 'MERGE_HEAD')
  if (!existsSync(marker)) return null
  try {
    return readFileSync(marker, 'utf8').split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

/** Bounds for one git invocation. */
export interface GitRunOptions {
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number
  /** Hard cap on collected stdout+stderr bytes; the overflow is truncated. */
  maxBytes?: number
  /** Environment override; defaults to the current environment. */
  env?: NodeJS.ProcessEnv
}

/** Result of one git invocation. */
export interface GitRunResult {
  /** exit code, or null when the process was killed. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 2_000_000

/** Canonical extra env for every git run. */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never hang on a prompt; keep pagers/colors off.
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
  }
}

/**
 * Buffer collected up to maxBytes, silently truncating the tail.
 *
 * REGRESSION GUARD — Bug B root cause (2026-08-19):
 * `size` MUST accumulate with ``size += buf.length`` (`not` `size = buf.length``).
 * The old overwrite collapsed multi-chunk git output to the LAST chunk only,
 * so a 501-path `git diff --name-only` came back as 46 truncated mid-paths
 * and the planner misclassified install/conflict risks. The companion invariant
 * is `plan.ts:computePlan` classifying on the FULL list, not the DISPLAY_CAP
 * (400) slice. Never reintroduce `size = buf.length`.
 */
function capture(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    let truncated = false
    const listener = (chunk: Buffer): void => {
      if (truncated) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      const room = maxBytes - size
      if (buf.length > room) {
        chunks.push(buf.subarray(0, Math.max(0, room)))
        truncated = true
        // size is the accumulated byte count BEFORE this chunk; the capped
        // chunk tops it up to exactly maxBytes.
        resolve(Buffer.concat(chunks, maxBytes).toString('utf8'))
      } else {
        chunks.push(buf)
        size += buf.length // REGRESSION CRITICAL: must accumulate, not overwrite (see doc above)
      }
    }
    stream.on('data', listener)
    stream.on('end', () => {
      if (!truncated) resolve(Buffer.concat(chunks, size).toString('utf8'))
    })
    stream.on('error', () => {
      if (!truncated) resolve(Buffer.concat(chunks, size).toString('utf8'))
    })
  })
}

/**
 * Run one git command in the repo and wait for its settlement.
 * @param repoPath - working directory for the command.
 * @param args - git argv after the `git` executable.
 * @param options - bounds override.
 * @returns the settled result. Never rejects — errors are folded into the result.
 */
export function runGit(repoPath: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return new Promise<GitRunResult>((resolve) => {
    const env = gitEnv(options.env ?? process.env)
    const child = spawn('git', [...args], { cwd: repoPath, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = capture(child.stdout, maxBytes)
    const stderr = capture(child.stderr, maxBytes)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({
        code: null,
        stdout: '',
        stderr: `git failed to start: ${String(error?.message ?? error)}`,
        timedOut,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      void Promise.all([stdout, stderr]).then(([out, err]) => {
        resolve({ code, stdout: out, stderr: timedOut ? `${err}\ngit command timed out after ${timeoutMs} ms`.trim() : err, timedOut })
      })
    })
  })
}

/** Convenience: resolve the repository's current HEAD sha, or null when absent. */
export async function resolveHead(repoPath: string): Promise<string | null> {
  const res = await runGit(repoPath, ['rev-parse', 'HEAD'], { timeoutMs: 15_000 })
  return res.code === 0 ? res.stdout.split('\n')[0]?.trim() || null : null
}

/** Whether the repo is currently mid-merge (a MERGE_HEAD exists). */
export async function isMidMerge(repoPath: string): Promise<boolean> {
  const res = await runGit(repoPath, ['rev-parse', '--verify', 'MERGE_HEAD'], { timeoutMs: 10_000 })
  return res.code === 0
}
