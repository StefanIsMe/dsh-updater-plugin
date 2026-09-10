/**
 * Model-facing updater tools — the "update DSH" plugin surface. Any session
 * whose agent preset mounts this entry can drive the self-update pipeline
 * through ordinary tool calls, instead of a settings-page button:
 *
 *   - `updater_status` — current snapshot (compact JSON).
 *   - `updater_check` — fetch upstream + recompute the plan.
 *   - `updater_apply` — run the safe apply pipeline (fork-merge aware:
 *     fast-forward when clean, three-way merge when the fork is ahead;
 *     fire-and-forget — poll `updater_status` until the phase settles).
 *   - `updater_file_diff` — unified diff of one path (HEAD vs upstream).
 *   - `updater_local_draft` — the stashed local draft of one conflicted path
 *     (the local side of an AI-authored merge).
 *   - `updater_resolve_conflict` — keep-local | take-upstream | keep-both.
 *   - `updater_write_merged` — write an agent-authored merged file for one
 *     conflicted path and stage it.
 *   - `updater_restore` — restore a pre-update safety backup.
 *   - `updater_restart` — arm the supervised host restart.
 *   - `updater_refresh` — clear transient error state.
 *
 * Plus the `/updater` command: prints the current status + available verbs
 * into the session's command surface.
 *
 * Every tool is a thin adapter over the `updater` gateway's public methods;
 * the gateway stays the sole executor and safety net (backup → stash-only
 * collisions → ff-only/fork-merge → draft restore → conflicts/restore).
 *
 * @module @deepseek-ai/dsh-host-updater/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import type { UpdaterSnapshot } from './types.ts'
import type UpdaterGateway from './index.ts'

export const name = 'updater-tools'

/** The updater gateway (host row `updater`) plus the registries this entry needs. */
export const inject = ['tools', 'systemPrompt', 'updater', 'commands']

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Compact status projection: enough for the model to decide, not the whole snapshot. */
function compactStatus(snapshot: UpdaterSnapshot): string {
  const plan = snapshot.plan
  const backups = snapshot.backups.slice(0, 5).map(b => ({ id: b.id, createdAt: b.createdAt }))
  return JSON.stringify({
    operation: snapshot.operation,
    phase: snapshot.phase,
    repoPath: snapshot.repoPath,
    currentVersion: snapshot.currentVersion,
    upstreamVersion: snapshot.upstreamVersion,
    currentShort: snapshot.currentShort,
    upstreamShort: snapshot.upstreamShort,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    dirtyCount: snapshot.dirtyCount,
    untrackedCount: snapshot.untrackedCount,
    inProgress: snapshot.inProgress,
    progress: snapshot.progress,
    error: snapshot.error,
    lastCheckAt: snapshot.lastCheckAt,
    lastApplyAt: snapshot.lastApplyAt,
    lastResult: snapshot.lastResult,
    conflictedFiles: snapshot.conflictedFiles,
    parkedDrafts: snapshot.parkedDrafts.map(d => ({ path: d.path, parkedFile: d.parkedFile })),
    remoteUrl: snapshot.remoteUrl,
    stashCount: snapshot.stashCount,
    backupId: snapshot.backupId,
    backups,
    plan: plan === null ? null : {
      incomingCount: plan.incomingCount,
      commitsTruncated: plan.commitsTruncated,
      changedFileCount: plan.changedFiles.length,
      changedFiles: plan.changedFiles.slice(0, 100),
      changedFilesTruncated: plan.changedFilesTruncated,
      fileStatCount: plan.fileStats.length,
      conflictRisk: plan.conflictRisk,
      untrackedRisk: plan.untrackedRisk,
      needsInstall: plan.needsInstall,
      needsRebuild: plan.needsRebuild,
      needsRestart: plan.needsRestart,
      blocked: plan.blocked,
      strategy: plan.strategy,
    },
  }, null, 0)
}

/** Generic args-only pending presentation shared by every updater tool. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, ...rawInput === undefined ? {} : { rawInput } }
}

/** Register the updater tools and the `/updater` command. */
export function apply(ctx: Context): void {
  const updater = ctx.updater as UpdaterGateway

  ctx.systemPrompt.section({
    name: 'tool:updater',
    order: 115,
    text: 'For a user-requested DSH update, use updater_start. This authorizes the complete backup, repair, verification and restart workflow. '
      + 'Use updater_status for progress. For conflicts use updater_conflict_context, preserve local functionality, '
      + 'write a compatible result with updater_write_merged, then resume with updater_start. '
      + 'Handle routine technical decisions without asking the user. Never delete or disable local plugins to pass checks. '
      + 'The gateway owns verification; do not claim success until the operation is complete. Explain outcomes in plain language. '
      + 'Spend effort in proportion: the pipeline already runs install and build, so poll updater_status instead of re-running whole suites, and test only the surfaces the incoming commits touched.',
  })

  ctx.tools.register(defineTool({
    name: 'updater_start',
    description: 'Start or resume the user-requested DSH update, including backup, repairs, checks and restart. Poll updater_status for progress.',
    parameters: {}, output: TEXT_OUTPUT,
    async execute() {
      if (typeof updater.start !== 'function') return JSON.stringify({ ok: false, message: 'Updater tools and host versions differ. Rebuild the host updater, generated Remote artifacts and client together, verify them, then restart the DSH profile. Preserve the existing recovery records; retrying this tool cannot reload the host.' })
      return JSON.stringify(await updater.start())
    },
    presentCall: () => present('Update DSH'),
  }))
  ctx.tools.register(defineTool({
    name: 'updater_conflict_context',
    description: 'Read separate base, local, incoming and saved-draft versions of a conflicted file before preserving both sets of behavior.',
    parameters: { path: { type: 'string', required: true, description: 'Conflicted repository-relative file.' } },
    output: TEXT_OUTPUT,
    async execute(args: { path: string }) {
      if (typeof updater.conflictContext !== 'function') return JSON.stringify({ ok: false, message: 'Updater host is older than its tools. Rebuild matching updater artifacts and restart the profile before resuming repairs.' })
      return JSON.stringify(await updater.conflictContext(args.path))
    },
    presentCall: args => present('Prepare compatibility repair', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_status',
    description: 'Read the current DSH self-update snapshot: phase, versions, plan, conflicts, '
      + 'parked drafts, backups, and the last result. Compact JSON.',
    parameters: {},
    output: TEXT_OUTPUT,
    execute() {
      return Promise.resolve(compactStatus(updater.status()))
    },
    presentCall: () => present('Read updater status', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_check',
    description: 'Fetch the upstream remote and recompute the update plan (incoming commits, '
      + 'changed files, install/rebuild/restart needs, conflict and untracked risks). '
      + 'Run this before applying so the plan is fresh.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const action = await updater.check()
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: () => present('Check for updates'),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_apply',
    description: 'Start the safe apply pipeline: safety backup, stash only the colliding local '
      + 'drafts, then merge upstream. On a clean checkout this is a fast-forward; on the '
      + 'maintained fork (local commits ahead) it is a real three-way merge that KEEPS all '
      + 'fork commits — conflicts surface in the conflicts phase and resolve via '
      + 'updater_resolve_conflict / updater_write_merged. Fire-and-forget: poll updater_status '
      + 'until inProgress is false and the phase settles (update-available, conflicts, '
      + 'applied, restart-pending, or error).',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const action = await updater.apply()
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: () => present('Apply the update'),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_file_diff',
    description: 'Bounded unified diff of one repo-relative path between the current HEAD and the '
      + 'upstream ref (the incoming change). Use it to judge what upstream did to a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Repo-relative path, e.g. src/main.ts.' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { path: string }) {
      const diff = await updater.fileDiff(args.path)
      return JSON.stringify(diff)
    },
    presentCall: args => present('Diff a file', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_local_draft',
    description: 'Read the stashed local draft of one conflicted path (the local side of an '
      + 'AI-authored merge). Returns the full working-tree content of the draft, or an error '
      + 'when no stash holds it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Conflicted repo-relative path.' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { path: string }) {
      const draft = await updater.localDraft(args.path)
      return JSON.stringify(draft)
    },
    presentCall: args => present('Read local draft', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_resolve_conflict',
    description: 'Resolve one conflicted file after an automerge apply stopped at the conflicts '
      + 'phase. keep-local restores the stashed draft; take-upstream keeps the merged upstream '
      + 'version; keep-both keeps upstream in the tree and parks the draft under '
      + '.dsh/updater/drafts/.',
    parameters: {
      path: { type: 'string', required: true, description: 'Conflicted repo-relative path.' },
      choice: {
        type: 'string', required: true, enum: ['keep-local', 'take-upstream', 'keep-both'],
        description: 'Resolution choice.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args: { path: string; choice: 'keep-local' | 'take-upstream' | 'keep-both' }) {
      const action = await updater.resolveConflict(args.path, args.choice)
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: args => present('Resolve conflict', `${args.path} → ${args.choice}`),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_write_merged',
    description: 'Write an agent-authored merged file for one conflicted path: the content '
      + 'replaces the conflict markers, is staged, and the path leaves the conflicted set. '
      + 'When none remain the update finalizes (restart-pending or applied). Use after reading '
      + 'updater_local_draft and the working tree to combine the best of both sides.',
    parameters: {
      path: { type: 'string', required: true, description: 'Conflicted repo-relative path.' },
      content: { type: 'string', required: true, description: 'Full merged file content.' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { path: string; content: string }) {
      const action = await updater.writeMerged(args.path, args.content)
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: args => present('Write merged file', args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_restore',
    description: 'Restore the working tree to a pre-update safety backup: reset to the pre-apply '
      + 'HEAD, copy back the untracked snapshot, re-apply the local-draft patch, and drop the '
      + "apply's own stashes. Complete by design — local drafts never lost.",
    parameters: {
      backup_id: { type: 'string', required: true, description: 'Backup id from updater_status (backups[]).' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { backup_id: string }) {
      const action = await updater.restore(args.backup_id)
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: args => present('Restore backup', args.backup_id),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_restart',
    description: 'Arm the supervised host restart (only meaningful when the phase is '
      + 'restart-pending). The host stops and the supervisor brings DSH back up.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const action = await updater.restart()
      return JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) })
    },
    presentCall: () => present('Restart DSH'),
  }))

  ctx.tools.register(defineTool({
    name: 'updater_refresh',
    description: 'Clear transient updater error state and re-check next. Non-destructive.',
    parameters: {},
    output: TEXT_OUTPUT,
    execute() {
      const action = updater.refresh()
      return Promise.resolve(JSON.stringify({ action, status: JSON.parse(compactStatus(updater.status())) }))
    },
    presentCall: () => present('Refresh updater state'),
  }))

  ctx.commands.register({
    name: 'updater',
    description: 'show the DSH self-update status and available verbs',
    handler: () => {
      const snapshot = updater.status()
      const lines = [
        `Phase: ${snapshot.phase}`,
        `Versions: ${snapshot.currentVersion ?? snapshot.currentShort ?? '—'}`
          + (snapshot.upstreamVersion !== null || snapshot.upstreamShort !== null
            ? ` → ${snapshot.upstreamVersion ?? snapshot.upstreamShort}`
            : ''),
        `Behind: ${snapshot.behind} · Dirty: ${snapshot.dirtyCount} · Untracked: ${snapshot.untrackedCount}`,
      ]
      if (snapshot.error !== null) lines.push(`Error: ${snapshot.error}`)
      if (snapshot.plan !== null) {
        lines.push(`Plan: ${snapshot.plan.incomingCount} commit(s), `
          + `${snapshot.plan.changedFiles.length} file(s)`
          + (snapshot.plan.blocked !== null ? ` · blocked: ${snapshot.plan.blocked}` : ''))
      }
      if (snapshot.conflictedFiles.length > 0) {
        lines.push(`Conflicts: ${snapshot.conflictedFiles.join(', ')}`)
      }
      lines.push('')
      lines.push('Verbs (any session): updater_check, updater_apply, updater_resolve_conflict, '
        + 'updater_write_merged, updater_restore, updater_restart. Ask the agent to "update DSH".')
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
