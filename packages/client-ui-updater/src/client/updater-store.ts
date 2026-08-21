/**
 * Browser store for the updater settings page: a plain observable snapshot
 * holder fed by status() polling and the forwarded `updater/state` event.
 * @module @deepseek-ai/dsh-client-ui-updater/client
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  UpdaterAction, UpdaterConfigView, UpdaterSnapshot,
} from '@deepseek-ai/dsh-host-updater/types'

/**
 * The generated updater Remote namespace this page drives. Every method
 * resolves to the standard `RemoteResult` envelope (`{ ok: true, value }` on
 * success, `{ ok: false, error }` on carrier failure) — the store unwraps it
 * below; callers of the binding never see the envelope.
 */
export type UpdaterRemoteFace = Pick<
  ClientRemote['updater'],
  'status' | 'check' | 'apply' | 'restore' | 'setConfig' | 'restart' | 'refresh'
>

/** Error envelope of one failed Remote call (carrier-reported). */
export interface UpdaterRemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Result envelope of one generated Remote call (value or carrier error). */
export type UpdaterRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UpdaterRemoteFailure }

/** Snapshot of the page's remote bindings. */
export interface UpdaterBinding {
  /** Latest full snapshot from the host; null until the first load settles. */
  getSnapshot(): UpdaterSnapshot | null
  /** uSES subscribe contract over the latest snapshot. */
  subscribe(listener: () => void): () => void
  /** Refresh the snapshot from the host (status()). */
  load(): Promise<void>
  /** Manual check (fetch + replan). */
  check(): Promise<UpdaterAction>
  /** Persist a config patch. */
  setConfig(patch: Record<string, unknown>): Promise<UpdaterAction>
  /** Clear transient error state. */
  refresh(): void
  /**
   * Open a new chat session prefilled with an updater command (the "Update
   * with AI" launcher). The session agent drives the whole update through the
   * updater_* tools. Implemented by the client apply over sessions/workspaces/
   * conversation; may throw when session creation fails.
   * @param command - override prefill text; defaults to the main updater command.
   */
  launchUpdate(command?: string): Promise<void>
}

/** Owned controller bound to the generated updater Remote face. */
export class UpdaterStore {
  private snapshot: UpdaterSnapshot | null = null
  private readonly listeners = new Set<() => void>()

  /** @param remote - the mounted updater Remote namespace. */
  constructor(private readonly remote: UpdaterRemoteFace) {}

  /** Latest snapshot (uSES getSnapshot). */
  getSnapshot(): UpdaterSnapshot | null {
    return this.snapshot
  }

  /** uSES subscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Push a snapshot delivered by the forwarded `updater/state` event. */
  push(snapshot: UpdaterSnapshot): void {
    this.snapshot = snapshot
    this.emit()
  }

  /** Collapse a failed envelope into a failed business action.
   * REGRESSION GUARD — Bug C (2026-08-18): the generated Remote namespace resolves
   * to a `RemoteResult` envelope (`{ok, value|error}`), not the snapshot/action
   * directly. The old store treated `remote.status()` as the snapshot and pushed
   * the envelope into the store, crashing UpdaterSection on `config.repoPath`
   * and leaving the content column blank. This unwrap is mandatory; do not remove.
   */
  private unwrapAction(result: UpdaterRemoteResult<UpdaterAction>): UpdaterAction {
    return result.ok ? result.value : { ok: false, message: result.error.message }
  }

  /** Pull the full snapshot from the host. */
  async load(): Promise<void> {
    try {
      const result = await this.remote.status()
      if (result.ok) this.push(result.value)
    } catch {
      /* connection transient: keep the previous snapshot */
    }
  }

  /** Manual check. */
  async check(): Promise<UpdaterAction> {
    const result = await this.remote.check()
    void this.load()
    return this.unwrapAction(result)
  }

  /** Apply the pending update. */
  async apply(): Promise<UpdaterAction> {
    const result = await this.remote.apply()
    void this.load()
    return this.unwrapAction(result)
  }

  /** Restore one backup. */
  async restore(backupId: string): Promise<UpdaterAction> {
    const result = await this.remote.restore(backupId)
    void this.load()
    return this.unwrapAction(result)
  }

  /** Persist a config patch. */
  async setConfig(patch: Record<string, unknown>): Promise<UpdaterAction> {
    const result = await this.remote.setConfig(patch as unknown as Partial<UpdaterConfigView>)
    void this.load()
    return this.unwrapAction(result)
  }

  /** Arm the supervised restart. */
  async restart(): Promise<UpdaterAction> {
    const result = await this.remote.restart()
    void this.load()
    return this.unwrapAction(result)
  }

  /** Clear transient error state. */
  refresh(): void {
    void this.remote.refresh()
    void this.load()
  }
}
