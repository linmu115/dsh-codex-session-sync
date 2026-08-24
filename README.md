# dsh-codex-session-sync

DSH plugin wrapper for the local, UUID-aware Codex-to-DSH session synchronizer.

The plugin adds a `/codex-sync` command and a matching **同步 Codex 会话** button in `dsh-resource-management`. An explicit invocation uses a short-lived hidden PowerShell broker to create an independent hidden helper, stops only the current official DSH process, synchronizes Codex changes into the configured `DSH_HOME`, restarts the official launcher, and checks the loopback Web UI. Loading or installing the plugin never starts synchronization.

## Safety boundary

- The existing session synchronizer is bundled with the plugin and keeps its backup behavior.
- A short command cooldown and a system-wide helper mutex prevent overlapping runs.
- The helper log is written below `<DSH_HOME>/codex-oneway-sync/plugin-runs`.
- The process ID and command line are validated before DSH is stopped.
- The plugin is independent of any desktop shell and only controls the configured official DSH process.

## Usage

Install into the official Web profile with the DSH CLI:

```powershell
dsh plugin --profile web add D:\AI\DSH-Plugin-Repositories\dsh-codex-session-sync
```

Then enter the following command in a DSH chat:

```text
/codex-sync
```

Or open **插件管理 → dsh-codex-session-sync → 参数设置** and click **同步 Codex 会话**. The panel intentionally contains no persistent configuration fields: its only control is the same explicit one-shot synchronization action, with a short capability summary and inline failure feedback.

The command accepts no arguments. The Manager action first returns a complete acknowledgement to the browser and only starts the helper after the HTTP response has finished; official DSH then restarts around the session write. A second invocation during the launch window is rejected, and the helper holds a named mutex for the complete stop-sync-restart lifecycle. The slash command retains its short helper delay for compatibility with hosts that do not provide response-completion scheduling.

## Configuration

The bundle patch provides `dshRoot`, `dshHome`, `healthUrl`, and a two-second launch delay. When omitted, runtime values come from `DSH_INSTALL_ROOT`, `DSH_HOME`, and `DSH_WEB_URL`; the official launcher exports these variables. `dshRoot` must contain `Start-Official-DSH.ps1`.

The synchronizer uses only DSH-neutral ledger fields and branch IDs. It does not preserve desktop-shell compatibility labels.

## Development

```powershell
pnpm test
pnpm check
pnpm pack:check
```

The synchronization tests use temporary fixtures. They do not read, modify, or synchronize the live Codex/DSH session stores.

The runtime entry imports only Node.js built-ins. It intentionally declares no DSH host dependencies or peer dependencies, so pnpm cannot place version-shadowing copies of Cordis or command services into the profile.
