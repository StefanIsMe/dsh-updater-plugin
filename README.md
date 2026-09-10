# DSH Updater

Update a DeepSeek Harness **source checkout** while preserving local plugins and changes. The host service, model tools, browser settings page and generated Remote artifacts must be built together for the installed DSH revision.

This is a source integration kit. It is not a standalone npm install, and does not update the separately managed Electron desktop application. DSH's pre-stable APIs can change; compatibility repairs may be necessary. Verification failures keep the update incomplete and preserve recovery data.

## Install through your DSH agent

Copy the following into a chat in your DSH instance:

```text
Install the updater from https://github.com/StefanIsMe/dsh-updater-plugin in this DSH source checkout. Read its README.md and docs/INSTALL.md first. Inspect the actual DSH version, repository, active profile, package layout and launch command; do not assume my OS, username, directory, port, model or provider.

Back up my configuration, sessions, local plugins, tracked changes (including the index and deletions), untracked files and existing updater recovery records before modifying anything. Preserve existing backups and stashes. Integrate the host and client updater packages using the documented source mapping; adapt imports and manifests to this installed DSH revision without replacing unrelated configuration. Keep the updater optional and enable its tools in my active agent preset.

Configure the actual upstream remote and branch, the build command appropriate to this checkout, pre-restart verification, the exact DSH profile launch command, and an authenticated post-restart application check. Keep credentials in my existing local credential store; never copy them into plugin source, reports or Git commits.

Build the host updater, tools, generated Remote host/client artifacts and browser UI together. Run the updater regression tests and a real profile composition check. Verify that updater_start and updater_conflict_context are callable in the running host, not merely listed in a tool catalog. Restart after those checks pass, then verify authenticated access, updater status, session loading and preservation of my enabled plugins. If a required check fails, repair it and rerun it; do not label an unavailable or failed check as success. Tell me the verified result in plain language.
```

See [installation details](docs/INSTALL.md) for package mapping and verification requirements.

## Updating DSH after installation

Open Settings → Updater and start the AI update, or ask your agent:

```text
Update DSH using updater_start. I authorize backups, compatibility repairs, tests and restart for this update. Preserve my plugins, settings, conversations and local changes. Handle routine technical decisions yourself. Use updater_conflict_context and updater_write_merged for repairs, then updater_start to resume. Poll updater_status; report completion only after the operation is complete and post-restart checks pass. If the runtime and tools differ, repair and rebuild the installed updater before retrying.
```

The workflow pins the fetched commit, backs up local state, merges upstream, restores saved changes by their recorded stash IDs, runs the configured checks, and verifies the restarted application. Conflicts require a capable tool-using agent. No model or provider is selected by the updater.

### Updating cheaply

The update pipeline already runs `pnpm install` and the build itself, so an agent does not need to re-run the full test suite to trust an update. Saying **"update DSH cheaply"** tells the agent to poll `updater_status` to completion and verify only the surfaces the incoming commits actually touched, instead of re-running whole suites and burning API tokens.

```text
Update DSH cheaply. Call updater_start and let the pipeline do the backup, merge, install and build; poll updater_status until the phase settles. Skip the full test suite and spend effort in proportion — verify only the surfaces the incoming commits touched. Handle routine technical decisions yourself and restart when the update needs it. Tell me the result in plain language.
```

This is safe because the gateway, not the agent, owns completion: an update is not reported successful until the restarted application passes its configured post-restart verification, and recovery data is retained if any check fails. Asking for a cheap update changes how much the agent re-tests, never whether the update is verified.

A full-fidelity update is still available by omitting "cheaply" — useful after a large upstream jump or when you have changed many local files.

Recovery copies and stashes can contain private user data. They stay in the user's DSH installation and must not be uploaded to this repository. See [SECURITY.md](SECURITY.md).

## Development and scope

The updater code lives in `packages/host-updater` and `packages/client-ui-updater`. The older optional file attachment/provider sources in this repository are separate integrations; installing the updater does not require installing them.

Tests run in the target DSH workspace because this source kit references DSH workspace packages and its TypeScript/build configuration. Follow the version-specific commands in [docs/INSTALL.md](docs/INSTALL.md). The repository's GitHub URL necessarily identifies its public owner; private paths, email addresses, credentials and conversation records are not installation inputs.
