# Manager 同步操作面板

## 目标

把已有的 `/codex-sync` 显式同步能力接入 `dsh-resource-management` 参数页，同时保持单一业务实现，不增加不需要的持久配置项。

## 修改前

- 同步只能在聊天输入 `/codex-sync` 触发。
- 插件安装包没有 `dsh-management/panel.yaml`，Manager 参数页无法展示操作入口。
- Manager action 服务与同步启动器没有公开接线。

## 修改后

- 版本提升至 `0.3.0`，安装包新增 `dsh-management/panel.yaml`。
- 参数页只提供一个“同步 Codex 会话”危险操作按钮；按钮说明概括 UUID、标题、分支、备份以及停止/重启/健康检查能力，不提供四个配置字段。
- `/codex-sync` 与 Manager 按钮复用同一个 `createSyncLauncher()` 和运行配置，不维护第二套同步逻辑。
- 插件延迟注入 `resourceManagementActions`：没有 Manager 时 slash command 仍可用；Manager 服务到达后登记 `sessions.sync`。
- 冷却、平台不支持和启动异常以 `ok: false` 返回，供 Manager 在按钮下显示小行错误反馈。

## 边界

- 按钮只报告 PowerShell helper 的启动阶段结果。DSH 停止后的同步或重启故障仍写入 `<DSH_HOME>/codex-oneway-sync/plugin-runs`，因为届时承载页面的 DSH 进程已经离线。
- 安装或加载插件不会自动执行同步；按钮需要确认，现有冷却与系统级互斥锁继续生效。
- 没有增加依赖或 DSH Host 服务副本。

## 验证

- `pnpm check`：15 项测试通过。
- `pnpm pack --dry-run`：确认 `dsh-management/panel.yaml` 进入 `dsh-codex-session-sync-0.3.0.tgz`。
- Contract v1 严格解析通过。

## 回退

重新激活 `dsh-codex-session-sync@0.2.1`。回退只移除 Manager 按钮，不改变同步 ledger、会话、备份或 `/codex-sync` 的既有能力。
