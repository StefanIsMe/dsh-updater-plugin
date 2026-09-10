# @deepseek-ai/dsh-client-ui-updater

English | [中文](README.zh.md)

Browser half of the self-update system. Registers the **Updater** settings page
(one `settings.section` entry, `id: updater`) that talks to the host
`updater` Remote namespace through the api-remotes assembly:

- a **status card** — local/upstream sha, ahead/behind, modified/untracked local
  draft counts, last check/apply timestamps, and a phase pill;
- a **plan card** — incoming commits, changed-file count, the `needsInstall` /
  `needsRebuild` / `needsRestart` classification, and the draft-collision lists
  (`conflictRisk`, `untrackedRisk`);
- **consent-gated actions** — Apply (fast-forward + stash-restore of drafts),
  Restart (supervised relaunch of DSH), Restore (roll back to a pre-update
  safety backup) each open a confirmation dialog; nothing destructive happens
  without the click;
- a **config editor** — auto-check / auto-apply / consent toggles, poll
  interval, build command; the patch is persisted by the host side;
- **live updates** — the page subscribes to the forwarded `updater/state`
  event and re-pulls `status()` every 30 s, so progress during an apply
  (install/build tail lines) and any conflict/error state render as they happen.

The page is a read/consent view: all state and mutation live in the Host
updater service.

## Model Experience

### Browser settings surface only

#### What the model sees

Nothing from this package enters a model request. The browser half registers one `settings.section` entry (`id: updater`) that drives the host `updater` Remote namespace (`status()`, `check()`, `apply()`, `setConfig()`, `restart()`, `refresh()`) and subscribes to the forwarded `updater/state` event; it registers no tools, no prompt sections, and no session-log content. Its one path to agent behavior is user-initiated and indirect: the "Update with AI" launcher opens a session and prefills its composer, after which that session's agent drives the update through the host updater's `updater_status`/`updater_check`/`updater_apply` tools — tools this package never registers.

#### Token effect

Zero tokens in either direction: registration adds nothing to any toolset, schema, or section, and the page's snapshots, Remote envelopes, and event payloads live entirely in browser state and the host service.

#### KV Cache effect

No effect on any model request prefix: nothing this package sends or receives is ever part of a conversation request, so there is nothing to cache or invalidate.

## Known Limitations and Deferred Work

- **Status polling only** — live progress arrives via events; the 30 s poll is
  a fallback for a missed event, not a guarantee of sub-second freshness.
- **No inline conflict editor** — when a stash-pop conflicts, the page lists
  the files and points to `git status`; full resolve/merge UI is deferred.
- **Restart is consent-gated by design** — the page never restarts the host
  without the user opening the restart dialog.
