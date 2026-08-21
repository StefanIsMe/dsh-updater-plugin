/**
 * The Updater settings page — reshaped 2026-08-19 into a status + launch
 * surface: a live status card, the incoming plan, and one primary "Update
 * with AI" button that opens a chat session prefilled with the updater
 * command (the session agent drives the whole update through the updater_*
 * tools). When the local checkout already matches upstream the page shows a
 * plain "you're on the latest version" state with no update affordance.
 * No manual apply/restart/restore buttons — conflicts, errors, and
 * backups are all handled "in chat". Native DSH surface: product semantic
 * colors, --dsw tokens, familiar settings geometry.
 * @module @deepseek-ai/dsh-client-ui-updater/client
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  Button, StateDot,
  IconCheckOutline16, IconRefreshOutline16,
  IconNewChatOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdaterPhase, UpdaterSnapshot } from '@deepseek-ai/dsh-host-updater/types'
import type { UpdaterBinding } from './updater-store.ts'
import type { UpdaterKey } from './locales.ts'
import css from './UpdaterSection.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Updater settings page copy. */
    updater: UpdaterKey
  }
}

/** Injected page face for the 'updater' settings.section entry. */
export interface UpdaterPageInjected {
  updater: UpdaterBinding
}

/** Full props of the updater section entry. */
export type UpdaterSectionProps =
  PropsRuntime<'settings.section'> & UpdaterPageInjected & PropsLocale<'updater'>

/** Format an ISO timestamp for display. */
function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** StateDot semantic per updater phase. */
function phaseDotState(phase: UpdaterPhase): 'done' | 'warning' | 'ongoing' | 'error' {
  switch (phase) {
    case 'idle':
    case 'applied':
      return 'done'
    case 'checking':
    case 'applying':
      return 'ongoing'
    case 'update-available':
    case 'restart-pending':
      return 'warning'
    case 'conflicts':
    case 'error':
      return 'error'
  }
}

/** Phase chip: product state dot + localized label. */
function PhaseChip({ phase, t }: { phase: UpdaterPhase; t: (key: UpdaterKey) => string }) {
  return (
    <span className={css.phaseChip}>
      <StateDot state={phaseDotState(phase)} />
      {t('phase.' + phase as UpdaterKey)}
    </span>
  )
}

/** Version range chips (local → upstream). */
function VersionRange({ snapshot }: { snapshot: UpdaterSnapshot }) {
  const current = snapshot.currentVersion ?? snapshot.currentShort ?? '—'
  const upstream = snapshot.upstreamVersion ?? snapshot.upstreamShort ?? null
  return (
    <span className={css.versionRange}>
      <code className={css.versionChip}>{current}</code>
      {upstream !== null && (
        <>
          <span className={css.versionArrow}>→</span>
          <code className={css.versionChip}>{upstream}</code>
        </>
      )}
    </span>
  )
}

/**
 * The primary hero: current state + the single "Update with AI" action. The
 * button opens a chat session prefilled with the updater command — the AI
 * drives check → plan → apply → conflict resolution → restart.
 */
function LaunchHero({ snapshot, t, onLaunch, busy }: {
  snapshot: UpdaterSnapshot
  t: (key: UpdaterKey) => string
  onLaunch: () => void
  busy: boolean
}) {
  const plan = snapshot.plan
  const blocked = plan !== null && plan.blocked !== null
  return (
    <section className={clsx(css.hero, blocked ? css.heroError : css.heroApply)}>
      <div className={css.heroRow}>
        <span className={clsx(css.heroIcon, css.iconApply)}><IconNewChatOutline16 size={16} /></span>
        <div className={css.heroText}>
          <span className={css.heroTitle}>{t('launch.title')}</span>
          <VersionRange snapshot={snapshot} />
          <p className={css.heroBody}>{t('launch.body')}</p>
          {plan !== null && (
            <>
              <div className={css.badges}>
                {plan.needsInstall && <span className={css.badge}>{t('plan.install')}</span>}
                {plan.needsRebuild && <span className={css.badge}>{t('plan.rebuild')}</span>}
                {plan.needsRestart && <span className={clsx(css.badge, css.badgeWarn)}>{t('plan.restart')}</span>}
                {blocked && <span className={clsx(css.badge, css.badgeWarn)}>{t('plan.blocked')}</span>}
              </div>
              <span className={css.muted}>
                {plan.incomingCount} {t('plan.commits')} · {plan.changedFiles.length} {t('plan.changed')}
                {plan.changedFilesTruncated ? ' (+' + t('plan.changedMore') + ')' : ''}
              </span>
              {blocked && plan.blocked !== null && <p className={css.errorMsg}>{plan.blocked}</p>}
            </>
          )}
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="primary" icon={<IconNewChatOutline16 size={16} />} disabled={busy} onClick={onLaunch}>
          {t('launch.button')}
        </Button>
        {busy && <span className={css.muted}>{t('launch.busy')}</span>}
      </div>
    </section>
  )
}

/**
 * Up-to-date state: local matches upstream — a confirmation hero with no
 * update CTA (nothing to update); only a re-check affordance is offered.
 */
function UpToDateHero({ snapshot, t, onCheck }: {
  snapshot: UpdaterSnapshot
  t: (key: UpdaterKey) => string
  onCheck: () => void
}) {
  const current = snapshot.currentVersion ?? snapshot.currentShort ?? '—'
  return (
    <section className={clsx(css.hero, css.heroSuccess)}>
      <div className={css.heroRow}>
        <span className={clsx(css.heroIcon, css.iconSuccess)}><IconCheckOutline16 size={16} /></span>
        <div className={css.heroText}>
          <span className={css.heroTitle}>{t('upToDate.title')}</span>
          <span className={css.versionRange}>
            <code className={css.versionChip}>{current}</code>
          </span>
          <p className={css.heroBody}>{t('upToDate.body')}</p>
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="ghost" icon={<IconRefreshOutline16 size={14} />} onClick={onCheck}>
          {t('actions.check')}
        </Button>
      </div>
    </section>
  )
}

/** Conflicts: the merge landed but local drafts collide — resolve in chat. */
function ConflictsHero({ snapshot, t, onChat }: {
  snapshot: UpdaterSnapshot
  t: (key: UpdaterKey) => string
  onChat: () => void
}) {
  return (
    <section className={clsx(css.hero, css.heroConflict)}>
      <div className={css.heroRow}>
        <span className={clsx(css.heroIcon, css.iconConflict)}><IconWarningOutline16 size={16} /></span>
        <div className={css.heroText}>
          <span className={css.heroTitle}>{t('conflicts.title')}</span>
          {snapshot.conflictedFiles.length > 0 && (
            <ul className={css.conflictList}>
              {snapshot.conflictedFiles.slice(0, 12).map((file, i) => <li key={file + '-' + i}>{file}</li>)}
            </ul>
          )}
          <p className={css.heroBody}>{t('conflicts.hint')}</p>
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="primary" icon={<IconNewChatOutline16 size={16} />} onClick={onChat}>
          {t('conflicts.chat')}
        </Button>
      </div>
    </section>
  )
}

/** Error state — investigate in chat. */
function ErrorHero({ snapshot, t, onChat }: {
  snapshot: UpdaterSnapshot
  t: (key: UpdaterKey) => string
  onChat: () => void
}) {
  return (
    <section className={clsx(css.hero, css.heroError)}>
      <div className={css.heroRow}>
        <span className={clsx(css.heroIcon, css.iconError)}><IconWarningOutline16 size={16} /></span>
        <div className={css.heroText}>
          <span className={css.heroTitle}>{t('error.title')}</span>
          {snapshot.error !== null && <p className={css.errorMsg}>{snapshot.error}</p>}
          <p className={css.heroBody}>{t('error.hint')}</p>
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="primary" icon={<IconNewChatOutline16 size={16} />} onClick={onChat}>
          {t('error.chat')}
        </Button>
      </div>
    </section>
  )
}

/** Brief state shown while a check is running. */
function CheckingHero({ t }: { t: (key: UpdaterKey) => string }) {
  return (
    <section className={clsx(css.hero, css.heroRun)} role="status" aria-live="polite">
      <div className={css.heroRow}>
        <span className={clsx(css.heroIcon, css.iconRun)}><StateDot state="ongoing" size={14} /></span>
        <div className={css.heroText}>
          <span className={css.heroTitle}>{t('phase.checking')}</span>
          <p className={css.heroBody}>{t('launch.body')}</p>
        </div>
      </div>
    </section>
  )
}

/**
 * Render the updater section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the updater page element tree.
 */
export function UpdaterSection({ t, updater }: UpdaterSectionProps) {
  const snapshot = useSyncExternalStore(updater.subscribe, updater.getSnapshot)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const launchErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (launchErrorTimer.current !== undefined) clearTimeout(launchErrorTimer.current)
  }, [])

  if (snapshot === null) {
    return <div className={css.section}><div className={css.hero}>{t('status.title')}…</div></div>
  }

  const { config, plan, error } = snapshot
  // Defensive auto-heal: if the host still reports restart-pending/update-available but git is actually 0 behind/ahead and SHAs match, show idle. This covers old persisted state.json that predates the host boot-reconcile.
  const effectivePhase: UpdaterPhase = (snapshot.phase === 'restart-pending' || snapshot.phase === 'update-available') && snapshot.behind === 0 && snapshot.ahead === 0 && snapshot.upstreamSha !== null && snapshot.currentSha !== null && snapshot.upstreamSha === snapshot.currentSha ? 'idle' : snapshot.phase
  const phase = effectivePhase
  const busy = snapshot.inProgress

  /** Open the AI session prefilled with the updater command.
   * The session agent drives the whole update via updater_* tools (the only
   * supported path after 2026-08-19; no manual Apply button exists).
   */
  const launch = async (command?: string): Promise<void> => {
    try {
      setLaunchError(null)
      await updater.launchUpdate(command)
    } catch (launchFailure: unknown) {
      setLaunchError(launchFailure instanceof Error ? launchFailure.message : String(launchFailure))
      if (launchErrorTimer.current !== undefined) clearTimeout(launchErrorTimer.current)
      launchErrorTimer.current = setTimeout(() => setLaunchError(null), 8000)
    }
  }

  return (
    <div className={css.section}>
      <header className={css.header}>
        <PhaseChip phase={phase} t={t} />
        <code className={css.repo}>{config.repoPath}</code>
      </header>

      {busy && <CheckingHero t={t} />}
      {!busy && phase === 'conflicts' && (
        <ConflictsHero snapshot={snapshot} t={t} onChat={() => void launch()} />
      )}
      {!busy && phase === 'error' && (
        <ErrorHero snapshot={snapshot} t={t} onChat={() => void launch()} />
      )}
      {!busy && (phase === 'idle' || phase === 'applied') && (
        <UpToDateHero snapshot={snapshot} t={t} onCheck={() => void updater.check()} />
      )}
      {!busy && phase !== 'conflicts' && phase !== 'error' && phase !== 'idle' && phase !== 'applied' && (
        <LaunchHero snapshot={snapshot} t={t} busy={false}
          onLaunch={() => void launch()} />
      )}
      {launchError !== null && <p className={css.errorMsg} role="alert">{launchError}</p>}

      <div className={css.stack}>
        <section className={css.card}>
          <h3>{t('status.title')}</h3>
          <dl className={css.dl}>
            <dt>{t('status.currentVersion')}</dt>
            <dd><code>{snapshot.currentVersion ?? '—'}</code></dd>
            <dt>{t('status.upstreamVersion')}</dt>
            <dd><code>{snapshot.upstreamVersion ?? '—'}</code></dd>
            <dt>{t('status.current')}</dt>
            <dd><code>{snapshot.currentShort ?? '—'}</code></dd>
            <dt>{t('status.upstream')}</dt>
            <dd><code>{snapshot.upstreamShort ?? '—'}</code></dd>
            <dt>{t('status.dirty')}</dt>
            <dd>{snapshot.dirtyCount}</dd>
            <dt>{t('status.untracked')}</dt>
            <dd>{snapshot.untrackedCount}</dd>
            <dt>{t('status.lastCheck')}</dt>
            <dd>{formatTime(snapshot.lastCheckAt)}</dd>
            <dt>{t('status.lastApply')}</dt>
            <dd>{formatTime(snapshot.lastApplyAt)}</dd>
            {snapshot.progress !== null && (
              <>
                <dt>{t('status.progress')}</dt>
                <dd>{snapshot.progress.message}</dd>
              </>
            )}
          </dl>
          <div className={css.actions}>
            <Button variant="ghost" disabled={busy} onClick={() => void updater.check()}>
              {t('actions.check')}
            </Button>
          </div>
        </section>

        {error !== null && !busy && (
          <section className={css.card}>
            <h3>{t('error.title')}</h3>
            <p className={css.errorMsg}>{error}</p>
          </section>
        )}

        {plan !== null && phase === 'update-available' && (
          <section className={css.card}>
            <h3>{t('plan.title')}</h3>
            <div className={css.badges}>
              {plan.needsInstall && <span className={css.badge}>{t('plan.install')}</span>}
              {plan.needsRebuild && <span className={css.badge}>{t('plan.rebuild')}</span>}
              {plan.needsRestart && <span className={clsx(css.badge, css.badgeWarn)}>{t('plan.restart')}</span>}
              {plan.blocked !== null && <span className={clsx(css.badge, css.badgeWarn)}>{t('plan.blocked')}</span>}
            </div>
            <p className={css.muted}>
              {plan.incomingCount} {t('plan.commits')} · {plan.changedFiles.length} {t('plan.changed')}
              {plan.changedFilesTruncated ? ' (+' + t('plan.changedMore') + ')' : ''}
            </p>
            {plan.blocked !== null && <p className={css.errorMsg}>{plan.blocked}</p>}
            {(plan.conflictRisk.length > 0 || plan.untrackedRisk.length > 0) && (
              <div className={css.risk}>
                {plan.conflictRisk.length > 0 && (
                  <>
                    <p className={css.muted}><strong>{t('plan.conflictRisk')}</strong></p>
                    <ul className={css.fileList}>
                      {(plan.conflictRisk as readonly string[]).slice(0, 8).map((file, i) => <li key={'c-' + i}><code>{file}</code></li>)}
                    </ul>
                  </>
                )}
                {plan.untrackedRisk.length > 0 && (
                  <>
                    <p className={css.muted}><strong>{t('plan.untrackedRisk')}</strong></p>
                    <ul className={css.fileList}>
                      {(plan.untrackedRisk as readonly string[]).slice(0, 8).map((file, i) => <li key={'u-' + i}><code>{file}</code></li>)}
                    </ul>
                  </>
                )}
              </div>
            )}
            <ul className={css.commitList}>
              {plan.incomingCommits.slice(0, 6).map((commit) => (
                <li key={commit.sha}>
                  <code>{commit.sha.slice(0, 8)}</code> <span>{commit.subject}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <BackupsCard t={t} backups={snapshot.backups} onChat={(backupId) => {
          // Prefill a restore command with the exact backup id.
          void launch(`${t('restore.command')}\n\nBackup id: ${backupId}`)
        }} />

        <ConfigCard t={t} updater={updater} config={config} />
      </div>
    </div>
  )
}

/** Backups strip — each row offers "restore in chat". */
function BackupsCard({ t, backups, onChat }: {
  t: (key: UpdaterKey) => string
  backups: readonly { id: string; createdAt: string }[]
  onChat: (backupId: string) => void
}) {
  return (
    <section className={css.card}>
      <h3>{t('backups.title')}</h3>
      {backups.length === 0 && <p className={css.muted}>{t('backups.empty')}</p>}
      <ul className={css.backupList}>
        {backups.slice(0, 5).map((backup) => (
          <li key={backup.id} className={css.backupRow}>
            <span>{formatTime(backup.createdAt)}</span>
            <Button size="sm" variant="outline" icon={<IconNewChatOutline16 size={14} />} onClick={() => onChat(backup.id)}>
              {t('backups.chat')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Config editor (client draft; saved through the Remote face). No auto-apply toggle. */
function ConfigCard({ t, updater, config }: {
  t: (key: UpdaterKey) => string
  updater: UpdaterBinding
  config: UpdaterSnapshot['config']
}) {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [saved, setSaved] = useState<'none' | 'ok' | 'fail'>('none')
  const value = draft ?? { ...(config as unknown as Record<string, unknown>) }

  const bump = (key: string, next: unknown): void => {
    setDraft({ ...value, [key]: next })
    setSaved('none')
  }

  return (
    <section className={css.card}>
      <h3>{t('config.title')}</h3>
      <div className={css.form}>
        <label className={css.row}>
          <input type="checkbox" checked={Boolean(value.autoCheck)} onChange={(e) => bump('autoCheck', e.target.checked)} />
          <span>{t('config.autoCheck')}</span>
        </label>
        <label className={css.field}>
          <span>{t('config.poll')}</span>
          <input
            type="number"
            min={15}
            max={3600}
            value={Number(value.pollIntervalMs) / 1000}
            onChange={(e) => bump('pollIntervalMs', Math.max(15, Number(e.target.value) * 1000))}
          />
        </label>
        <label className={css.field}>
          <span>{t('config.build')}</span>
          <input type="text" value={String(value.buildCommand ?? '')} onChange={(e) => bump('buildCommand', e.target.value)} />
        </label>
        <div className={css.formActions}>
          <Button variant="ghost" disabled={draft === null} onClick={() => {
            void updater.setConfig(draft ?? {}).then((result) => {
              setSaved(result.ok ? 'ok' : 'fail')
            })
          }}>
            {t('config.save')}
            {saved === 'ok' && <span className={css.savedHint}> · {t('config.saved')}</span>}
            {saved === 'fail' && <span className={clsx(css.savedHint, css.fail)}> · {t('config.rejected')}</span>}
          </Button>
        </div>
      </div>
    </section>
  )
}
