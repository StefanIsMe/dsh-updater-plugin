/**
 * Self-updater settings page plugin, browser half: registers the `updater`
 * settings section, keeps a live snapshot store fed by the forwarded
 * `updater/state` event and status() polling, and exposes the "Update with
 * AI" launcher — creating a new chat session prefilled with the updater
 * command and navigating to it (the session agent drives the whole update
 * through the updater_* tools).
 * @module @deepseek-ai/dsh-client-ui-updater/client
 */

import type { ClientContext, ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { UpdaterSnapshot } from '@deepseek-ai/dsh-host-updater/types'
import { UpdaterSection, type UpdaterPageInjected } from './UpdaterSection.tsx'
import { UpdaterStore, type UpdaterRemoteFace, type UpdaterBinding } from './updater-store.ts'
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


/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.updater', 'sessions', 'workspaces', 'conversation']

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
    // The session whose cwd matches the updater repo is the right workspace;
    // fall back to the current session's workspace, then any workspace.
    const wsList = workspaces.list.getSnapshot()
    const current = sessions.list.getSnapshot().current
    const currentWs = current === undefined
      ? undefined
      : wsList.items.find(ws => ws.sessionIds.includes(current))
    const repoWs = wsList.items.find(ws => ws.path === repoPath)
    const targetWs = repoWs ?? currentWs ?? wsList.items[0]
    if (targetWs === undefined) {
      // No workspace at all: the New Session view handles it; nothing to prefill.
      workspaces.startSession()
      return
    }
    let sessionId: SessionId
    try {
      sessionId = await workspaces.connectWorkspace(targetWs.workspaceId)
    } catch {
      workspaces.startSession()
      return
    }
    // Prefill the composer of the fresh (blank) session before opening it.
    const scope = sessions.scope(sessionId)
    if (scope !== undefined) {
      const conversation = ctx.get('conversation') as { input: { for(actx: unknown): { setDraft(text: string): void } } } | undefined
      conversation?.input.for(scope).setDraft(command ?? t('launch.command'))
    }
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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'updater',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, UpdaterSection))
}
