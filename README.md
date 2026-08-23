# dsh-codex-session-sync

DSH plugin wrapper for the local, UUID-aware Codex-to-DSH session synchronizer.

The plugin adds a `/codex-sync` command. An explicit command invocation launches a detached PowerShell helper, which safely stops EAC, synchronizes Codex session changes, restarts EAC, and checks the local web service. Loading or installing the plugin never starts a synchronization.

## Safety boundary

- The existing session synchronizer is bundled with the plugin and keeps its backup behavior.
- A short command cooldown and a system-wide helper mutex prevent overlapping runs.
- The helper log is written below `~/.dsh/codex-oneway-sync/plugin-runs`.
- The original double-click synchronization entry remains available.

Implementation and installation details are added with the first functional release.

