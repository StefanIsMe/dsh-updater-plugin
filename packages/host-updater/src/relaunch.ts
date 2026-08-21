/**
 * Supervised restart orchestration: a detached `node supervisor.mjs` keeps a
 * replacement DSH alive after the current process exits. Sequence is:
 *   1. write `arm.json` + `spawn.json` in the state dir,
 *   2. spawn the detached supervisor (it exits instantly unless armed),
 *   3. the Host process exits (client consent-gated) —
 * the supervisor then launches `cmd` (full argv: program first), keeps the child
 * alive while the arm exists, clears the arm once the child has been alive
 * {@link CLEAR_AFTER_MS}, and caps respawn attempts with a `dead` marker.
 *
 * @module @deepseek-ai/dsh-host-updater
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdaterConfig } from './config.ts'

/** The child must survive this long before the supervisor treats it as healthy. */
export const CLEAR_AFTER_MS = 20_000

/** Source of the bundled supervisor script. */
export function supervisorSourcePath(): string {
  return fileURLToPath(new URL('../supervisor/supervisor.mjs', import.meta.url))
}

/**
 * The full argv the supervisor re-launches (program first). Explicit
 * `config.launchCommand` wins; otherwise the current invocation is replayed
 * (`process.execPath` + argv tail).
 */
export function buildLaunchCommand(config: UpdaterConfig): string[] {
  if (config.launchCommand !== null && config.launchCommand.length > 0) return [...config.launchCommand]
  return [process.execPath, ...process.argv.slice(1)]
}

/**
 * Arm and spawn the supervised restart. Writes arm.json BEFORE spawning so a
 * supervisor that lands first never misfires; the arm is what the supervisor
 * clears once the new child is healthy.
 */
export function armSupervisor(config: UpdaterConfig): { ok: boolean; message: string } {
  const { repoPath } = config
  const stateDir = join(repoPath, '.dsh', 'updater')
  mkdirSync(stateDir, { recursive: true })
  const scriptPath = join(stateDir, 'supervisor.mjs')
  try {
    copyFileSync(supervisorSourcePath(), scriptPath)
  } catch (error) {
    return { ok: false, message: `Cannot copy supervisor script: ${error instanceof Error ? error.message : String(error)}` }
  }
  const payload = {
    cmd: buildLaunchCommand(config),
    cwd: repoPath,
    stateDir,
    clearAfterMs: CLEAR_AFTER_MS,
    maxAttempts: Math.max(1, config.maxRestartAttempts),
    // Post-restart UI gate: the supervisor only clears the arm when the web UI
    // actually serves the module table with the updater client row present.
    verifyUrl: 'http://127.0.0.1:3080/',
    verifyMarker: 'dsh-client-ui-updater',
  }
  try {
    writeFileSync(join(stateDir, 'arm.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`)
    writeFileSync(join(stateDir, 'spawn.json'), `${JSON.stringify(payload, null, 2)}\n`)
    const child = spawn(process.execPath, [scriptPath, stateDir], {
      cwd: stateDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true, message: `Supervisor armed (${payload.maxAttempts} attempts max)` }
  } catch (error) {
    return { ok: false, message: `Cannot arm supervisor: ${error instanceof Error ? error.message : String(error)}` }
  }
}