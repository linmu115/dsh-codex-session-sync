# dsh-codex-session-sync

DSH plugin wrapper for the local, UUID-aware Codex-to-DSH session synchronizer.

The plugin adds a `/codex-sync` command. An explicit invocation launches a detached PowerShell helper, stops only the current official DSH process, synchronizes Codex changes into the configured `DSH_HOME`, restarts the official launcher, and checks the loopback Web UI. Loading or installing the plugin never starts synchronization.

## Safety boundary

- The existing session synchronizer is bundled with the plugin and keeps its backup behavior.
- A short command cooldown and a system-wide helper mutex prevent overlapping runs.
- The helper log is written below `<DSH_HOME>/codex-oneway-sync/plugin-runs`.
- The process ID and command line are validated before DSH is stopped.
- EAC is neither detected nor controlled.

## Usage

Install into the official Web profile with the DSH CLI:

```powershell
dsh plugin --profile web add D:\AI\DSH-Plugin-Repositories\dsh-codex-session-sync
```

Then enter the following command in a DSH chat:

```text
/codex-sync
```

The command accepts no arguments. It waits briefly so the command result can reach the browser, then official DSH restarts around the session write. A second invocation during the launch window is rejected, and the detached helper holds a named mutex for the complete stop-sync-restart lifecycle.

## Configuration

The bundle patch provides `dshRoot`, `dshHome`, `healthUrl`, and a two-second launch delay. When omitted, runtime values come from `DSH_INSTALL_ROOT`, `DSH_HOME`, and `DSH_WEB_URL`; the official launcher exports these variables. `dshRoot` must contain `Start-Official-DSH.ps1`.

The synchronizer retains a few historical `EAC` labels in its ledger and branch IDs so existing imported-session metadata remains readable. Those labels are data-format compatibility only and do not call or inspect EAC.

## Development

```powershell
pnpm test
pnpm check
pnpm pack:check
```

The synchronization tests use temporary fixtures. They do not read, modify, or synchronize the live Codex/DSH session stores.

The runtime entry imports only Node.js built-ins. It intentionally declares no DSH host dependencies or peer dependencies, so pnpm cannot place version-shadowing copies of Cordis or command services into the profile.
