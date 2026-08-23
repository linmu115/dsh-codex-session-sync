# dsh-codex-session-sync

DSH plugin wrapper for the local, UUID-aware Codex-to-DSH session synchronizer.

The plugin adds a `/codex-sync` command. An explicit command invocation launches a detached PowerShell helper, which safely stops EAC, synchronizes Codex session changes, restarts EAC, and checks the local web service. Loading or installing the plugin never starts a synchronization.

## Safety boundary

- The existing session synchronizer is bundled with the plugin and keeps its backup behavior.
- A short command cooldown and a system-wide helper mutex prevent overlapping runs.
- The helper log is written below `~/.dsh/codex-oneway-sync/plugin-runs`.
- The original double-click synchronization entry remains available.

## Usage

Install into the EAC desktop profile with the DSH CLI:

```powershell
dsh plugin --profile web-desktop add D:\AI\DSH-Plugin-Repositories\dsh-codex-session-sync
```

Then enter the following command in a DSH chat:

```text
/codex-sync
```

The command accepts no arguments. It waits briefly so the command result can reach the browser, then EAC closes and restarts. A second invocation during the launch window is rejected, and the detached helper also holds a named mutex for the complete stop-sync-restart lifecycle.

## Configuration

The bundle patch provides the current EAC installation root and a two-second launch delay. `eacRoot` can be changed in a profile override if EAC moves. The plugin also accepts `DSH_EAC_ROOT` when no configured root is supplied.

## Development

```powershell
pnpm test
pnpm check
pnpm pack:check
```

The synchronization tests use temporary fixtures. They do not read, modify, or synchronize the live Codex/DSH session stores.

The runtime entry imports only Node.js built-ins. It intentionally declares no DSH host dependencies or peer dependencies, so pnpm cannot place version-shadowing copies of Cordis or command services into the profile.
