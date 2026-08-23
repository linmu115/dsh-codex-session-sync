# DSH-CODEX-SESSION-SYNC-20260823-003

## 目标

完成 `dsh-codex-session-sync` 与历史桌面壳兼容层的彻底分离，并清理官方 DSH 部署中遗留的旧 profile 副本。

## 修改

- 同步器不再使用桌面壳命名、EAC 分支 ID、EAC 日志字段或 EAC 兼容判断；
- 分支统一命名为 `<session-id>--branch-...`，ledger 字段统一为 DSH 中性名称；
- 将旧 profile `web-desktop` 中的 `dsh-codex-session-sync@0.1.1` 注册和物化目录删除；
- 当前官方 `web` profile 使用本次 `0.2.1` 包；
- 不删除会话数据库或备份目录，避免改变用户会话内容。

## 验证

- 插件测试全部通过；
- 当前 `web` profile 的 bundle 配置只包含 `dshRoot`、`dshHome` 和 `healthUrl`；
- 当前官方 DSH WebUI 健康检查返回 HTTP 200；
- EAC 可执行文件进程为 0；
- `web-desktop` 中不存在该插件目录或注册项。

## 回退

回退本提交并重新安装 `dsh-codex-session-sync@0.2.0`。本次没有删除会话、工作区、Codex 源数据或维护引擎状态。
