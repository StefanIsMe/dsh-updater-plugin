/**
 * Throwaway temp-repo helper for updater tests: create a real git repo in a
 * temp dir, commit a baseline, and clean up after the suite. Never touches the
 * real checkout.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A real, isolated git repo for one test run. */
export interface TempRepo {
  path: string
  cleanup(): void
}

const GIT = process.env.GIT_EXECUTABLE ?? 'git'

/** Windows-safe recursive remove: EBUSY on a just-released dir is transient. */
export function rmRetry(dir: string, attempts = 20): void {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      // Windows: a dying git child or an antivirus scan can hold the dir
      // briefly; wait and retry instead of failing the whole suite.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  throw lastError
}

/** Run git in `cwd`; throws on failure and returns trimmed stdout. */
export function gitIn(cwd: string, args: readonly string[]): string {
  const res = spawnSync(GIT, [...args], { cwd, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`)
  }
  return res.stdout.trim()
}

/**
 * Create a git repo with `identity: true` and one baseline commit on the given
 * branch (default `master`). Returns { path, cleanup }.
 */
export function makeTempRepo(branch = 'master'): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-updater-test-'))
  gitIn(dir, ['init', '-b', branch])
  gitIn(dir, ['config', 'user.email', 'updater-test@localhost'])
  gitIn(dir, ['config', 'user.name', 'Updater Test'])
  // Line endings must be byte-stable across platforms (no autocrlf CRLF
  // rewriting), or working-tree comparisons in the tests get `\r\n`.
  gitIn(dir, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'main.ts'), 'console.log(1)\n')
  writeFileSync(join(dir, 'package.json'), '{ "name": "tmp" }\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-m', 'baseline'])
  return { path: dir, cleanup: () => rmRetry(dir) }
}

/** Commit a new tree state (adds all and commits) and return the new sha. */
export function commitAll(repo: string, message: string): string {
  gitIn(repo, ['add', '-A'])
  gitIn(repo, ['commit', '-m', message])
  return gitIn(repo, ['rev-parse', 'HEAD'])
}

/** Modify one file then commit. */
export function editAndCommit(repo: string, relPath: string, content: string, message: string): string {
  writeFileSync(join(repo, relPath), content)
  return commitAll(repo, message)
}
