/** Durable update checkpoints shared by the gateway and restart supervisor. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdaterOperation } from './types.ts'
import { stateDirOf } from './config.ts'

/** Read the current operation without treating corrupt recovery records as success. */
export function readOperation(repo: string): UpdaterOperation | null {
  const path = join(stateDirOf(repo), 'operation.json')
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as UpdaterOperation
  if (value.version !== 1 || !value.id || !value.targetSha || !Array.isArray(value.appliedDraftRefs) || !Array.isArray(value.checks)) {
    throw new Error('The update recovery record is invalid; its backup has been retained.')
  }
  return value
}

/** Publish a checkpoint atomically before the next update step. */
export function saveOperation(repo: string, operation: UpdaterOperation): void {
  const dir = stateDirOf(repo)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'operation.json')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(operation, null, 2)}\n`)
  renameSync(temp, path)
}

/** Split legacy build chains into ordered argv steps without invoking a shell. */
export function commandSteps(command: string): string[] {
  const steps: string[] = []
  let quote = '', start = 0
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) { if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (command.slice(i, i + 2) === '&&') {
      steps.push(command.slice(start, i).trim()); start = i + 2; i++
    } else if (ch === '|' || ch === ';' || ch === '>' || ch === '<' || ch === '&') {
      throw new Error('Build steps must be executable commands separated by &&.')
    }
  }
  steps.push(command.slice(start).trim())
  if (quote || steps.some(step => !step)) throw new Error('Invalid build command.')
  return steps
}
