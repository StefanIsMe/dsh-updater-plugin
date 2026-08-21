/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-updater/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-updater'

/** Cordis companion plugin name. */
export const name = 'host-updater-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Invariant: the updater's critical files and config are sane.
 * This runs on every host boot (package invariants are checked at startup by
 * `scripts/verify-package-invariants.ts` and at runtime by the invariants service).
 * Every regression guard below pins a historical bug so it can never be reintroduced
 * by an upstream merge that overwrites the updater plugin.
 */
const install: InvariantInstaller = (_ctx, fail) => {
  // 1. Guard: buildCommand must never be the broken "pnpm run build" (see REGRESSIONS.md Bug D).
  //    The engine's normalizeConfig migrates it, but the invariant surfaces the problem even before the engine runs.
  try {
    const repoPath = process.cwd()
    const cfgPath = join(repoPath, '.dsh', 'updater', 'config.json')
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { buildCommand?: unknown }
      if (raw.buildCommand === 'pnpm run build') {
        fail('config buildCommand is "pnpm run build" — this is known-broken on this deployment (aggregate tsc fails). Fix: "node scripts/rebuild-dsh-client.mjs" or "pnpm run build:web". See REGRESSIONS.md Bug D.')
      }
    }
  } catch {
    // unreadable config never wedges the invariant check
  }

  // 2. Guard: autoApply must be false (user decision 2026-08-19 removed the UI toggle).
  //    A stale config that re-enables it would silently auto-apply on the next poll.
  try {
    const repoPath = process.cwd()
    const cfgPath = join(repoPath, '.dsh', 'updater', 'config.json')
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { autoApply?: unknown }
      if (raw.autoApply === true) {
        fail('config autoApply is true — this was removed from the UI and must stay false (deployment pin). Set it to false or remove it. See REGRESSIONS.md.')
      }
    }
  } catch {
  }

  // 3. Guard: expectedRemoteUrl should be the GitHub origin when set
  try {
    const repoPath = process.cwd()
    const cfgPath = join(repoPath, '.dsh', 'updater', 'config.json')
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { expectedRemoteUrl?: unknown }
      if (typeof raw.expectedRemoteUrl === 'string' && raw.expectedRemoteUrl.length > 0) {
        if (!raw.expectedRemoteUrl.includes('deepseek-ai/deepseek-harness') && !raw.expectedRemoteUrl.includes('github.com')) {
          fail('config expectedRemoteUrl is "' + String(raw.expectedRemoteUrl) + '" — expected the GitHub origin. Auto-apply will be blocked by the URL guard.')
        }
      }
    }
  } catch {
  }

  // 4. Guard: state.json stash leak — idle/applied phase must not retain stashRefs/backupId
  try {
    const repoPath = process.cwd()
    const statePath = join(repoPath, '.dsh', 'updater', 'state.json')
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as { phase?: string; stashRefs?: unknown; conflictedFiles?: unknown }
      const settled = raw.phase === 'idle' || raw.phase === 'applied'
      const hasStale = settled && Array.isArray(raw.stashRefs) && raw.stashRefs.length > 0 && (raw.conflictedFiles === undefined || (Array.isArray(raw.conflictedFiles) && (raw.conflictedFiles as string[]).length === 0))
      if (hasStale) {
        fail('state.json has stale stashRefs (' + String((raw.stashRefs as string[]).length) + ' ref(s)) in settled phase "' + String(raw.phase) + '" with no conflicts — this is the 2026-08-20 stash leak. The next boot will heal it, but the git stash list may still hold the entry')
      }
    }
  } catch {
  }
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
