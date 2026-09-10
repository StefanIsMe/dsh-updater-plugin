/** Quiet update notice shared by all conversation headers. */
import { useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdaterPageInjected } from './UpdaterSection.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Session-header notice props provided by the updater plugin. */
export type UpdateNoticeProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'updater'> & UpdaterPageInjected

/** Display one dismissible notice per upstream version, without changing chats. */
export function UpdateNotice({ updater, t }: UpdateNoticeProps) {
  const snapshot = useSyncExternalStore(updater.subscribe, updater.getSnapshot)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('dsh.updater.dismissed') ?? '')
  const version = snapshot?.upstreamVersion ?? snapshot?.upstreamSha ?? ''
  if (snapshot?.phase !== 'update-available' || !version || dismissed === version) return null
  return <span role="status">
    <button type="button" onClick={() => { void updater.launchUpdate() }}>{t('notice.available')}</button>
    <button type="button" aria-label={t('notice.dismiss')} onClick={() => {
      localStorage.setItem('dsh.updater.dismissed', version)
      setDismissed(version)
    }}>×</button>
  </span>
}
