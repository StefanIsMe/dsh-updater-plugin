# Installation

Use a supported DSH source checkout with the Node and pnpm versions declared by that checkout's `package.json`. For the verified DSH 0.1.5-alpha.2 integration, Node is `^22.19.0 || >=24.0.0` and pnpm is `11.7.0`. Read the checkout's own instructions before editing it. Electron Desktop manages its executable packages separately and is outside this plugin's scope.

## Source mapping

Clone this repository into a separate working directory. Integrate only these packages, preserving existing local modifications:

| Plugin source | DSH checkout destination |
| --- | --- |
| `packages/host-updater` | `packages/host/updater` |
| `packages/client-ui-updater` | `packages/client/ui-updater` |

These packages use `workspace:^` dependencies and DSH-relative TypeScript configuration. Do not run `pnpm add file:...` against the detached source kit and expect it to resolve the harness workspace. Do not copy `node_modules`, generated `lib`, credentials or user data between installations.

## Wire the active profile

Inspect the current DSH architecture and existing integrations. Register the host updater, client updater and updater tools once each. On the tested source layout, the browser bundle is `packages/bundle/web-app`; its manifest must declare the host/client packages, and its patch must mount them. The model preset mounts `@deepseek-ai/dsh-host-updater/tools`. Preserve existing rows and use the patch syntax supported by the installed DSH version.

The host manifest name is `@deepseek-ai/dsh-host-updater`; the client name is `@deepseek-ai/dsh-client-ui-updater`. The API Remote assembly imports the host's `/typert` and `/remote` exports and forwards `updater/state`. Add missing dependency declarations, TypeScript references and path mappings where required. Inspect existing Remote contributions as the version-specific pattern. Avoid creating a second updater service or duplicating a Remote namespace.

## Configure for this installation

Configure `repoPath`, `remoteName`, `branch` and `expectedRemoteUrl` from the actual checkout. Configure `buildCommand` for its supported build process; its default is `pnpm run build`. A custom repair script is a deployment choice, not a portable prerequisite. Ordered `&&` build steps and quoted arguments are supported without a shell.

Set `verifyCommand` to meaningful pre-restart checks, including the pinned upstream commit, remaining conflicts, installed plugin inventory and build artifacts. Set `postRestartCommand` to a single executable command with arguments that returns zero only after authenticated application checks pass. Use an absolute executable path when necessary. It must check the correct configured endpoint/profile and fail on unauthorized responses or unavailable checks. Read credentials locally without embedding them in command arguments. Restart is refused until this command is configured.

Set `launchCommand` to the exact supported DSH profile invocation as an array of executable plus arguments if the current invocation is wrapped by another supervisor. Ensure that only one supervisor owns the host. Preserve loader flags such as `--import tsx/esm` for source launches. The updater retains the current process flags when using its default relaunch command.

## Build and verify

From the integrated DSH checkout, install dependencies using its pnpm version. Compile the updater project, bundle its host/tools, generate its Remote artifacts, and build the client and web application. In the tested layout the key commands are:

```text
pnpm install --no-frozen-lockfile
pnpm exec tsc -b packages/host/updater/tsconfig.json
pnpm --dir packages/host/updater exec tsdown
pnpm exec vitest run packages/host/updater/tests
```

Remote generation and client compilation must follow the current DSH workspace build. If the checkout has a custom rebuild helper, confirm that it regenerates stale artifacts, rather than only missing files, and rebuilds the host updater as well as the client. A successful browser build alone is insufficient.

Boot through the actual `dsh` profile and verify its composed configuration. Exercise the updater tools against a disposable repository first; verify a real update, conflict repair, draft restoration and a second update. Then confirm that the live gateway exposes `start()` and `conflictContext()`, and that authenticated session and plugin operations work after restart. Preserve recovery copies until all required checks pass. Report precisely which platform and DSH revision were tested; do not promise compatibility with unknown future upstream changes.
