/**
 * Self-updater settings page plugin, browser half: registers the `updater`
 * settings section, keeps a live snapshot store fed by the forwarded
 * `updater/state` event and status() polling, and exposes the "Update with
 * AI" launcher — creating a new chat session prefilled with the updater
 * command and navigating to it (the session agent drives the whole update
 * through the updater_* tools).
 * @module @deepseek-ai/dsh-client-ui-updater/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { UpdaterSnapshot } from '@deepseek-ai/dsh-host-updater/types'
import { UpdaterSection, type UpdaterPageInjected } from './UpdaterSection.tsx'
import { UpdaterStore, type UpdaterRemoteFace, type UpdaterBinding } from './updater-store.ts'
import { UpdateNotice } from './UpdateNotice.tsx'
import { en, zh } from './locales.ts'

export type {
  UpdaterSectionProps, UpdaterPageInjected,
} from './UpdaterSection.tsx'
export type { UpdaterBinding, UpdaterRemoteFace } from './updater-store.ts'
export { UpdaterStore } from './updater-store.ts'
export type { UpdaterKey } from './locales.ts'
export { en, zh } from './locales.ts'

/** The forwarded-event bus surface this plugin needs from the remote store. */
type RemoteBus = {
  $on: (event: string, listener: (payload: unknown) => void) => () => void
}

/** Emitted for the settings shell's nav badge (StateDot on the Updater row). */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui-updater/status'(phase: string): void
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.updater', 'sessions', 'workspaces', 'uiWorkspace', 'conversation']

/** Dictionary namespace owned by this plugin. */
const NS = 'updater'

/**
 * Mount the Updater settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-updater: updater dictionaries')

  const remote = ctx.remote as unknown as { updater: UpdaterRemoteFace } & RemoteBus
  const store = new UpdaterStore(remote.updater)

  // Live and connected: the host pushes every transition, the page also
  // re-pulls when surfaced, and a polling fallback covers missed events.
  ctx.effect(() => remote.$on('updater/state', (payload) => {
    if (payload !== null && typeof payload === 'object' && 'phase' in (payload as object)) {
      const snapshot = payload as UpdaterSnapshot
      store.push(snapshot)
      // Nav badge feed for the settings shell (StateDot on the Updater row).
      ctx.emit('ui-updater/status', snapshot.phase)
    }
  }), 'ui-updater: forwarded updater/state listener')
  void store.load().then(() => {
    const snap = store.getSnapshot()
    if (snap !== null) ctx.emit('ui-updater/status', snap.phase)
  })
  const ticker = setInterval(() => { void store.load() }, 30_000)
  ctx.effect(() => () => clearInterval(ticker), 'ui-updater: status poll')

  const t = ctx.locale.bind(NS)

  /**
   * The "Update with AI" launcher: connect the workspace that owns the updater
   * repo (reuse its blank session or create one), prefill the composer with the
   * updater command, and navigate to it. Model selection happens in the session
   * (the existing per-session model picker).
   */
  const launchUpdate = async (repoPath: string, command?: string): Promise<void> => {
    const sessions = ctx.get('sessions') as ISessions
    const workspaces = ctx.get('workspaces') as IWorkspaces
    const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace
    // The session whose cwd matches the updater repo is the right workspace;
    // fall back to the current session's workspace, then any workspace.
    const wsList = workspaces.list.getSnapshot()
    const current = sessions.list.getSnapshot().current
    const currentWs = current === undefined
      ? undefined
      : wsList.items.find(ws => ws.sessionIds.includes(current))
    const repoWs = wsList.items.find(ws => ws.path === repoPath)
    const targetWs = repoWs ?? currentWs ?? wsList.items[0]
    // Prefill helper: draft the command into the given session's composer.
    // Returns true when the draft landed, false when the scope is unavailable.
    const prefill = (sessionId: SessionId, text: string): boolean => {
      const scope = sessions.scope(sessionId)
      if (scope === undefined) return false
      const conversation = ctx.get('conversation') as { input: { for(actx: unknown): { setDraft(text: string): void } } } | undefined
      const face = conversation?.input.for(scope)
      if (face === undefined) return false
      face.setDraft(text)
      return true
    }
    const text = command ?? t('launch.command')
    if (targetWs === undefined) {
      // No workspace at all: open the New Session view, then surface the
      // command instead of silently dropping the prefill.
      uiWorkspace.startSession()
      const nowCurrent = sessions.list.getSnapshot().current
      if (nowCurrent !== undefined && prefill(nowCurrent, text)) return
      throw new Error(`${text}`)
    }
    let sessionId: SessionId
    try {
      sessionId = await uiWorkspace.connectWorkspace(targetWs.workspaceId)
    } catch {
      // Connect failed: fall back to a fresh session view, then surface the
      // command instead of silently dropping the prefill.
      uiWorkspace.startSession()
      const nowCurrent = sessions.list.getSnapshot().current
      if (nowCurrent !== undefined && prefill(nowCurrent, text)) return
      throw new Error(`${text}`)
    }
    // Prefill the composer of the fresh (blank) session before opening it.
    prefill(sessionId, text)
    sessions.open(sessionId)
  }

  const binding: UpdaterBinding = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => store.subscribe(listener),
    load: () => store.load(),
    check: () => store.check(),
    setConfig: (patch: Record<string, unknown>) => store.setConfig(patch),
    refresh: () => store.refresh(),
    launchUpdate: async (command?: string) => {
      const snapshot = store.getSnapshot()
      if (snapshot === null) return
      await launchUpdate(snapshot.config.repoPath, command)
    },
  }
  const injected = (): UpdaterPageInjected => ({ updater: binding })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'updater-notice', order: 90, locale: NS, inject: injected,
  }, UpdateNotice))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'updater',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, UpdaterSection))
}
