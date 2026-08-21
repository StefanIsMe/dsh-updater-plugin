/**
 * Updater settings page dictionaries (en/zh) — reshaped 2026-08-19: the page
 * is a status + launch surface; updates happen in a chat session the "Update
 * with AI" button opens (prefilled with the updater command). No manual
 * apply/restart/restore buttons, no auto-apply toggle.
 * @module @deepseek-ai/dsh-client-ui-updater/client
 */

export interface UpdaterKeyMap {
  'nav': string
  'phase.idle': string
  'phase.checking': string
  'phase.update-available': string
  'phase.applying': string
  'phase.applied': string
  'phase.restart-pending': string
  'phase.conflicts': string
  'phase.error': string
  'upToDate.title': string
  'upToDate.body': string
  'status.title': string
  'status.current': string
  'status.currentVersion': string
  'status.upstream': string
  'status.upstreamVersion': string
  'status.dirty': string
  'status.untracked': string
  'status.lastCheck': string
  'status.lastApply': string
  'status.progress': string
  'status.git': string
  'launch.title': string
  'launch.body': string
  'launch.button': string
  'launch.command': string
  'restore.command': string
  'launch.busy': string
  'plan.title': string
  'plan.commits': string
  'plan.changed': string
  'plan.changedMore': string
  'plan.conflictRisk': string
  'plan.untrackedRisk': string
  'plan.install': string
  'plan.rebuild': string
  'plan.restart': string
  'plan.blocked': string
  'actions.check': string
  'conflicts.title': string
  'conflicts.hint': string
  'conflicts.chat': string
  'backups.title': string
  'backups.empty': string
  'backups.chat': string
  'error.title': string
  'error.hint': string
  'error.chat': string
  'result.ok': string
  'result.fail': string
  'config.title': string
  'config.autoCheck': string
  'config.poll': string
  'config.backups': string
  'config.backupsKeep': string
  'config.build': string
  'config.save': string
  'config.saved': string
  'config.rejected': string
  'repo': string
}

/** English dictionary. */
export const en: UpdaterKeyMap = {
  'nav': 'Updater',
  'phase.idle': 'Up to date',
  'phase.checking': 'Checking for updates',
  'phase.update-available': 'Update available',
  'phase.applying': 'Applying update',
  'phase.applied': 'Applied',
  'phase.restart-pending': 'Restart pending',
  'phase.conflicts': 'Conflicts need attention',
  'phase.error': 'Updater error',
  'upToDate.title': "You're on the latest version",
  'upToDate.body': 'Your local DSH matches the latest upstream. Nothing to update — the updater keeps checking automatically.',
  'status.title': 'Status',
  'status.current': 'Local',
  'status.currentVersion': 'Local version',
  'status.upstream': 'Upstream',
  'status.upstreamVersion': 'Upstream version',
  'status.dirty': 'modified local file(s)',
  'status.untracked': 'untracked local path(s)',
  'status.lastCheck': 'Last check',
  'status.lastApply': 'Last apply',
  'status.progress': 'Progress',
  'status.git': 'git',
  'launch.title': 'Update DSH with AI',
  'launch.body': 'Open a chat session that drives the updater: it checks for updates, reviews the plan, applies the update, and resolves any conflicts with your local changes — asking you when it needs a decision. You can pick the model in the session.',
  'launch.button': 'Update with AI',
  'launch.command': 'Load the DSH updater and update DSH: check for updates (updater_check), review the plan, apply the update (updater_apply), and resolve any conflicts by comparing my local changes with upstream (updater_local_draft, updater_file_diff, updater_resolve_conflict, updater_write_merged). Ask me anything you need, then restart when ready (updater_restart).',
  'restore.command': 'Load the DSH updater and restore the pre-update safety backup listed in updater_status (backups[].id): call updater_restore with that id. Confirm the backup id with the user first. Nothing should be lost — the restore resets to the pre-update commit, copies back untracked files, and re-applies local drafts.',
  'launch.busy': 'An update is already running — watch this chat or wait for it to settle.',
  'plan.title': 'Incoming update',
  'plan.commits': 'commit(s)',
  'plan.changed': 'changed file(s)',
  'plan.changedMore': 'more',
  'plan.conflictRisk': 'Local drafts upstream also touches',
  'plan.untrackedRisk': 'Untracked paths upstream also adds',
  'plan.install': 'Dependency install needed',
  'plan.rebuild': 'Rebuild needed',
  'plan.restart': 'Host restart needed',
  'plan.blocked': 'Blocked',
  'actions.check': 'Check now',
  'conflicts.title': 'Draft conflicts',
  'conflicts.hint': 'The update merged, but some local drafts conflict with it. Ask the AI session to compare your drafts with upstream and resolve them (keep local, take upstream, or merge) — nothing was dropped.',
  'conflicts.chat': 'Resolve in chat',
  'backups.title': 'Safety backups',
  'backups.empty': 'No backups yet.',
  'backups.chat': 'Restore in chat',
  'error.title': 'Updater error',
  'error.hint': 'Something went wrong. Ask the AI session to investigate and, if needed, restore the pre-update backup.',
  'error.chat': 'Investigate in chat',
  'result.ok': 'Done',
  'result.fail': 'Failed',
  'config.title': 'Configuration',
  'config.autoCheck': 'Check for updates automatically',
  'config.poll': 'Poll interval (s)',
  'config.backups': 'Keep backups',
  'config.backupsKeep': 'Backups to keep',
  'config.build': 'Build command',
  'config.save': 'Save',
  'config.saved': 'Saved',
  'config.rejected': 'Rejected',
  'repo': 'Repository',
}

/** Chinese dictionary. */
export const zh: UpdaterKeyMap = {
  'nav': '自动更新',
  'phase.idle': '已是最新',
  'phase.checking': '正在检查更新',
  'phase.update-available': '有可用更新',
  'phase.applying': '正在应用更新',
  'phase.applied': '已应用',
  'phase.restart-pending': '等待重启',
  'phase.conflicts': '存在冲突待处理',
  'phase.error': '更新器错误',
  'upToDate.title': '你已是最新版本',
  'upToDate.body': '本地 DSH 已与最新上游一致，无需更新——更新器会持续自动检查。',
  'status.title': '状态',
  'status.current': '本地',
  'status.currentVersion': '本地版本',
  'status.upstream': '上游',
  'status.upstreamVersion': '上游版本',
  'status.dirty': '个已修改本地文件',
  'status.untracked': '个未跟踪本地路径',
  'status.lastCheck': '上次检查',
  'status.lastApply': '上次应用',
  'status.progress': '进度',
  'status.git': 'git',
  'launch.title': '用 AI 更新 DSH',
  'launch.body': '打开一个驱动更新器的对话会话：它会检查更新、查看计划、应用更新，并在你的本地改动发生冲突时解决冲突——需要决定时会询问你。你可以在会话中选择模型。',
  'launch.button': '用 AI 更新',
  'launch.command': '加载 DSH 更新器并更新 DSH：先检查更新（updater_check），查看计划，应用更新（updater_apply），并用 updater_local_draft、updater_file_diff、updater_resolve_conflict、updater_write_merged 对比我的本地改动与上游来解决任何冲突。有任何需要都可以问我，完成后用 updater_restart 重启。',
  'restore.command': '加载 DSH 更新器并恢复 updater_status 中 backups[] 列出的更新前安全备份（backups[].id）：调用 updater_restore 并传入该 id。先与用户确认备份 id。恢复会重置到更新前提交、复制回未跟踪文件、并重新应用本地草稿——任何内容都不会丢失。',
  'launch.busy': '已有更新正在运行——请在本会话中查看或等待其完成。',
  'plan.title': '传入更新',
  'plan.commits': '个提交',
  'plan.changed': '个变更文件',
  'plan.changedMore': '更多',
  'plan.conflictRisk': '上游也会修改的本地草稿',
  'plan.untrackedRisk': '上游新增且本地已存在的路径',
  'plan.install': '需要安装依赖',
  'plan.rebuild': '需要重新构建',
  'plan.restart': '需要重启 Host',
  'plan.blocked': '已阻止',
  'actions.check': '立即检查',
  'conflicts.title': '草稿冲突',
  'conflicts.hint': '更新已合并，但部分本地草稿与更新冲突。让 AI 会话对比你的草稿与上游并解决（保留本地、采用上游或合并）——任何内容都不会被丢弃。',
  'conflicts.chat': '在对话中解决',
  'backups.title': '安全备份',
  'backups.empty': '暂无备份。',
  'backups.chat': '在对话中恢复',
  'error.title': '更新器错误',
  'error.hint': '出错了。让 AI 会话调查问题，必要时恢复更新前的备份。',
  'error.chat': '在对话中排查',
  'result.ok': '完成',
  'result.fail': '失败',
  'config.title': '配置',
  'config.autoCheck': '自动检查更新',
  'config.poll': '轮询间隔（秒）',
  'config.backups': '保留备份',
  'config.backupsKeep': '保留备份数量',
  'config.build': '构建命令',
  'config.save': '保存',
  'config.saved': '已保存',
  'config.rejected': '被拒绝',
  'repo': '仓库',
}

/** Updater dictionary namespace key union. */
export type UpdaterKey = keyof UpdaterKeyMap
