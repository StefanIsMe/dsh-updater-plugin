/**
 * Tool-surface tests for the updater "dsh plugin": registration, presentation,
 * and execution of the updater_* tools + the /updater command against the real
 * gateway on a throwaway temp repo (the live checkout is never touched).
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Commands from '@deepseek-ai/dsh-commands'
import UpdaterGateway from '../src/index.ts'
import * as updaterTools from '../src/tools.ts'
import { resolveUpdaterConfig, saveUpdaterConfig } from '../src/config.ts'
import { editAndCommit, gitIn, makeTempRepo, type TempRepo } from './helpers.ts'

const testToolSignal = new AbortController().signal

interface Harness {
  ctx: Context
  work: TempRepo
  upstream: TempRepo
  cleanup(): Promise<void>
}

const harnesses: Harness[] = []

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Commands)
  const upstream = makeTempRepo('master')
  const work = makeTempRepo('master')
  gitIn(work.path, ['remote', 'add', 'origin', upstream.path])
  gitIn(work.path, ['fetch', 'origin'])
  gitIn(work.path, ['reset', '--hard', 'origin/master'])
  const config = resolveUpdaterConfig({
    repoPath: work.path,
    autoCheck: false,
    autoApply: false,
    requireConsentApply: false,
    installDeps: false,
    buildEnabled: false,
    backupsKeep: 2,
  })
  saveUpdaterConfig(work.path, config)
  await ctx.plugin(UpdaterGateway, config)
  await ctx.plugin(updaterTools)
  const h: Harness = { ctx, work, upstream, cleanup: async () => {
    try { await ctx.stop() } catch { /* best effort */ }
    work.cleanup()
    upstream.cleanup()
  } }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.cleanup()))
})

/** Execute one registered tool and return its normalized result. */
async function execute(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
  })
}

/** Parse the text output of a successful tool result. */
async function resultText(result: ToolExecutionResult): Promise<string> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return block.text
}

describe('updater tools (the "dsh plugin")', () => {
  it('registers all ten updater tools plus guidance and disposes them', async () => {
    const { ctx } = await harness()
    const names = [
      'updater_status', 'updater_check', 'updater_apply', 'updater_file_diff',
      'updater_local_draft', 'updater_resolve_conflict', 'updater_write_merged',
      'updater_restore', 'updater_restart', 'updater_refresh',
    ]
    expect(names.map(name => ctx.tools.get(name)?.name)).toEqual(names)
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:updater')
    expect(section?.text).toContain('updater_status')
    expect(section?.text).toContain('updater_write_merged')
  })

  it('updater_status reports the idle snapshot as compact JSON', async () => {
    const { ctx } = await harness()
    const result = await execute(ctx, 'updater_status', {})
    const text = await resultText(result)
    const parsed = JSON.parse(text) as { phase: string }
    expect(parsed.phase).toBe('idle')
  })

  it('updater_check fetches and reports an available update', async () => {
    const { ctx, upstream } = await harness()
    editAndCommit(upstream.path, 'src/upstream-only.ts', 'console.log(upstream)\n', 'upstream advance')
    const result = await execute(ctx, 'updater_check', {})
    const text = await resultText(result)
    const parsed = JSON.parse(text) as { action: { ok: boolean }; status: { phase: string; behind: number } }
    expect(parsed.action.ok).toBe(true)
    expect(parsed.status.phase).toBe('update-available')
    expect(parsed.status.behind).toBe(1)
  })

  it('updater_file_diff reports the incoming change', async () => {
    const { ctx, upstream } = await harness()
    editAndCommit(upstream.path, 'src/main.ts', 'console.log(2)\n', 'upstream edits main')
    await execute(ctx, 'updater_check', {})
    const result = await execute(ctx, 'updater_file_diff', { path: 'src/main.ts' })
    const text = await resultText(result)
    const parsed = JSON.parse(text) as { ok: boolean; diff: string | null }
    expect(parsed.ok).toBe(true)
    expect(parsed.diff).toContain('console.log(2)')
  })

  it('rejects an invalid path in updater_file_diff', async () => {
    const { ctx } = await harness()
    const result = await execute(ctx, 'updater_file_diff', { path: '../escape' })
    const text = await resultText(result)
    const parsed = JSON.parse(text) as { ok: boolean }
    expect(parsed.ok).toBe(false)
  })

  it('registers the /updater command surface', async () => {
    const { ctx } = await harness()
    // The command registered on the root (global) layer; any agent resolves it.
    const listed = (ctx.commands as unknown as { list(agent: object): readonly { name: string }[] }).list({})
    expect(listed.map(c => c.name)).toContain('updater')
  })
})
