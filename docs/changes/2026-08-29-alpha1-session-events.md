# Codex Session Sync 0.4.0：迁移到 DSH alpha.1 原生事件集

## 问题

0.3.3 在每个导入日志的序号 0 写入私有 `session/imported` 事件，并依赖 RC2 的
`ignorable: true` 规则。DSH 0.1.2-alpha.1 删除了未知事件放行，因此全部导入会话
被 Session Persistence 拒绝读取。

## 修改

- 新导入日志不再写任何私有 Session 事件；导入来源由现有外部 ledger 唯一记录。
- 增加严格、可回滚的 alpha.1 批量迁移器：删除规范的旧标记，连续重排 `seq`，
  同步重排 `sourceEventSeqs`，并更新 ledger 哈希。
- 迁移器默认只读预览；只有显式 `--apply` 才会逐文件备份并原子替换。

## 验证

- 覆盖事件重排、工具调用引用重排、幂等执行和压缩日志往返验证。
- 对正式 DSH home 先 dry-run，再停服备份并应用，最后由 alpha.1 实际观察全部日志。
