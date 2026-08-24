# Manager 同步按钮空 JSON 修复

## 现象

在 Manager 参数页点击“同步 Codex 会话”后显示：

```text
Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

## 根因

同步 helper 会停止当前 DSH Node 进程。旧实现从 action handler 内立即启动 helper，只用两秒固定延时争取回执时间；Manager 在 handler 返回后仍需读取面板状态并序列化 JSON，因此 DSH 可能在回执完成前被停止。

## 修复

- 在新版 Manager Host 中使用 `deferUntilResponse` 登记同步任务。
- action 先返回“同步任务已登记”，等 HTTP 响应完成后才创建 detached PowerShell helper。
- 保留旧版 Manager Host 的立即启动兼容路径；slash command 行为不变。
- 版本提升至 `0.3.1`。

## 验证

- 单元测试确认 action 返回确认结果时 launcher 尚未执行，只有 Host 释放延后任务后才执行。
- 覆盖延后任务异常、冷却拒绝和旧 Host 兼容路径。

## 回退

回退本提交并重新应用 `dsh-codex-session-sync@0.3.0`。回退后按钮仍能发起同步，但可能再次出现空 JSON 报错。
