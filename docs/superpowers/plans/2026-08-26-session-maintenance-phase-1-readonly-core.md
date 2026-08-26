# Session Maintenance Phase 1 Read-only Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库交付独立、幂等、零平台写入的 DSH–Codex 会话维护内核，能够扫描已登记实例、建立不可变版本图、识别安全快进与冲突，并生成可审查但不可执行的同步计划。

**Architecture:** 新 monorepo 以 contracts、纯领域逻辑、SQLite/内容寻址存储、Codex/DSH 只读适配器和唯一 Engine 为边界。CLI 是可信本地配置入口；loopback API 只接受已登记 ID，通过 capability token 调用同一 Engine。

**Tech Stack:** Windows、Node.js `>=22.19.0`、pnpm `11.19.0`、TypeScript `5.9.2`、Vitest `3.2.4`、Zod `4.1.5`、Commander `14.0.0`、YAML `2.8.1`、`node:sqlite`、`node:zlib` Zstd、Node HTTP/SSE。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`

**Roadmap:** `2026-08-26-dsh-codex-session-maintenance-roadmap.md`

**Target repository:** `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`

---

## 1. 能力

- [ ] **独立工程与干净启动**：建立全新 pnpm monorepo、固定 Node/pnpm 版本、提供 Windows CI 和 `pnpm bootstrap`；不把当前 `dsh-codex-session-sync`、EAC 或 Maintenance 服务作为运行依赖。
- [ ] **统一数据模型**：以 Zod 校验的 DTO 表示平台实例、会话、事件、版本、binding、ref、checkpoint、计划、作业和 API 响应；平台适配器与 UI 不再创建同义模型。
- [ ] **规范化与稳定身份**：把 Codex/DSH 原始事件转换为 `NormalizedSession`，分别计算正文 hash 和元数据 hash；扫描时间、绝对路径、端口、PID 与日志位置不影响版本身份。
- [ ] **Git 式会话版本图**：支持零父、一父和经用户确认产生的两父版本；能够判定相等、来源领先、目标领先、分叉、重写、无共同祖先和元数据冲突。
- [ ] **不可变持久化**：使用 SQLite WAL 保存关系、ref、计划和作业；使用 Zstd 内容寻址对象保存规范化正文，支持去重、校验、重开恢复和受保护对象回收。
- [ ] **只读同步计划**：根据共同版本和平台指纹生成确定性的 `SyncPlan`；计划保存 adapter contract、前置指纹、风险与操作，状态变化后返回 `PLAN_STALE`。
- [ ] **Codex 只读适配器**：支持 Codex `0.146.0` 的任务索引、`state_5.sqlite` 和 rollout 读取；列表读取保持轻量，完整正文只在候选变化时读取。
- [ ] **DSH 只读适配器**：支持官方 DSH `0.1.1-rc.2` 的 session header、Zstd 多帧事件和 workspace/projection 元数据；未知事件保留来源并降格，不伪造成 Codex 工具调用。
- [ ] **干净发现与绑定**：在没有旧 ledger 的情况下扫描现有会话；相同平台 ID 幂等更新，只有明确 provenance 加兼容前缀可自动跨平台绑定，标题相同只形成候选。
- [ ] **CLI 工作流**：提供 `init`、`instance add/list`、`scan`、`diff`、`plan`、`status`；保留 `apply` 和 `restore` 命令名，但阶段一固定返回 `CAPABILITY_NOT_AVAILABLE`。
- [ ] **本机 API 与作业系统**：只监听 `127.0.0.1`，提供认证、分页查询、diff、计划、持久化扫描作业和可续订 SSE；HTTP 请求不能传入任意本机路径。
- [ ] **可迁移和可复现验证**：支持在干净 checkout 上 bootstrap、构建、测试；运行产物不含本机绝对路径、旧同步运行入口或非目标本地依赖。

## 2. 契约

### 2.1 包与依赖方向

| 目录 | 包名 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| `packages/contracts` | `@linmu/dsh-session-contracts` | DTO、Zod schema、错误码 | Zod |
| `packages/session-domain` | `@linmu/dsh-session-domain` | 规范化、hash、版本图、diff、plan、发现 | contracts |
| `packages/session-store` | `@linmu/dsh-session-store` | SQLite repository、Zstd object store | contracts、domain |
| `packages/test-support` | `@linmu/dsh-session-test-support` | 脱敏 fixture 与 live-home guard | contracts |
| `packages/adapter-codex-read` | `@linmu/dsh-adapter-codex-read` | Codex 只读适配 | contracts、domain |
| `packages/adapter-dsh` | `@linmu/dsh-adapter-dsh` | DSH 只读适配 | contracts、domain |
| `packages/local-api-client` | `@linmu/dsh-session-api-client` | 类型化 loopback API/SSE 客户端 | contracts |
| `apps/engine` | `@linmu/dsh-session-engine` | 唯一 composition root、CLI、HTTP、作业 | 上述生产包 |

所有内部依赖使用 `workspace:*`；包为 private ESM，测试通过 `development` export 读取 `src`，构建后的 Node 进程只读取 `dist`。任何包都不能向上依赖 Engine、UI、平台安装目录、EAC 或旧同步器。

### 2.2 核心数据契约

| 类型 | 必需内容 |
| --- | --- |
| `PlatformSessionKey` | `platform`、`instanceId`、`sessionId` |
| `NormalizedEvent` | 稳定 ID、父 ID、顺序、类型、角色、正文、附件、来源锚点、extensions |
| `NormalizedSession` | schema、平台 key、标题、归档、workspace ID、事件、正文/元数据 hash、provenance、兼容性 |
| `SessionVersionManifest` | 逻辑会话 ID、0–2 个父版本、正文对象、hash、来源和兼容性 |
| `PlatformBinding` | 逻辑会话、平台 key、adapter contract、共同版本和平台状态 |
| `SyncPlan` | 计划 ID/hash、共同基线、source/target 快照、adapter contracts、操作、风险、确认项和前置指纹 |
| `JobEvent` | `queued`、`running`、`progress`、`completed` 或 `failed`，并带单调递增序号 |

固定基础类型：

```ts
export type PlatformKind = "codex" | "dsh";
export type SyncMode = "continuation" | "native-mirror" | "paused";
export type CompatibilityStatus = "compatible" | "degraded" | "unsupported";

export interface PlatformSessionKey {
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly sessionId: string;
}
```

### 2.3 平台适配器契约

```ts
export interface SessionReadAdapter {
  readonly platform: PlatformKind;
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary>;
  observe(instance: RegisteredInstance, key: PlatformSessionKey, hint?: ObservationHint): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(instance: RegisteredInstance, key: PlatformSessionKey, expected: ExpectedPlatformState): Promise<VerificationResult>;
}
```

锁定的阶段一 contract：

- Codex：`codex-read/0.146.0/schema-1`；
- DSH：`dsh-read/0.1.1-rc.2/session-v0`；
- schema 指纹或平台版本不匹配时返回 `unsupported`，不得猜测解析；
- `StableObservation.payload` 为 `unknown`，只能由产生它的 adapter 解释。

### 2.4 存储契约

```ts
export interface SessionRepository {
  putVersion(input: NewVersion): Promise<SessionVersionManifest>;
  recordObservation(input: ObservedHead): Promise<void>;
  getGraph(logicalSessionId: string): Promise<VersionGraph>;
  savePlan(plan: SyncPlan): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
}

export interface ContentObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  collect(policy: GcPolicy): Promise<GcReport>;
}
```

- 对象 ID 固定为未压缩正文的 `sha256:<hex>`；路径为 `objects/sha256/<前两位>/<剩余 hash>.zst`。
- SQLite schema version 为 `1`，启用 `foreign_keys`、WAL 和 `busy_timeout = 5000`。
- `putVersion()` 和 `savePlan()` 的相同 ID/相同内容重试必须幂等；相同 ID/不同内容必须报冲突。
- `collect()` 只可删除不在 platform ref、canonical ref 或 checkpoint 可达集合中的老对象，并支持 dry-run。

### 2.5 Engine、CLI 与 API 契约

```ts
export interface ReadOnlyEngine {
  listInstances(): Promise<readonly InstanceStatus[]>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraph(id: string, cursor?: string): Promise<VersionGraphPage>;
  scan(request: ScanRequest): Promise<DiscoveryResult>;
  diff(request: DiffRequest): Promise<SessionDiff>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
  status(): Promise<EngineStatus>;
}
```

CLI 固定入口：

```text
dsh-session-maint init
dsh-session-maint instance add --id <id> --platform codex|dsh --root <path> --platform-version <version>
dsh-session-maint instance list
dsh-session-maint scan (--instance <id> | --all)
dsh-session-maint diff --logical-session <id> [--source <binding-id>] [--target <binding-id>]
dsh-session-maint plan --logical-session <id> --source <binding-id> [--target <binding-id>]
dsh-session-maint status
dsh-session-maint apply --plan <id>
dsh-session-maint restore --transaction <id>
```

HTTP 固定入口：

```text
GET  /v1/health
GET  /v1/instances
GET  /v1/sessions?cursor=&limit=&platform=&status=
GET  /v1/sessions/:id/graph?cursor=&limit=
POST /v1/diffs
POST /v1/jobs/scan
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/plans
GET  /v1/plans/:id
POST /v1/plans/:id/apply
POST /v1/transactions/:id/restore
```

- 除 `/v1/health` 外均要求 bearer capability token；有 `Origin` 时必须等于服务器自身 origin。
- 请求体上限 `64 KiB`；分页默认 `50`、最大 `200`。
- API 只接受已登记的 instance/session/logical-session/plan/transaction ID，不接受 `root`、`path`、`cwd` 或 `home`。
- 阶段一的 apply/restore API 固定返回 `409 CAPABILITY_NOT_AVAILABLE`。

### 2.6 错误契约

必须稳定暴露并测试以下错误码：

```text
UNSTABLE_READ
PLAN_STALE
ADAPTER_INCOMPATIBLE
CAPABILITY_NOT_AVAILABLE
LIVE_HOME_FORBIDDEN
RECOVERY_REQUIRED
IDENTITY_CONFLICT
OBJECT_CORRUPT
VERSION_ID_COLLISION
LOOPBACK_ONLY
```

错误响应和日志不得包含 capability token、API key、会话正文或未登记绝对路径。

## 3. 不变量（Global Constraints）

- [ ] **只读边界**：阶段一不能创建、追加、重命名、归档、删除、重启或重写任何真实 Codex/DSH 会话。
- [ ] **唯一业务入口**：CLI、HTTP 和未来 UI 都调用同一 Engine；不得各自打开 SQLite、构造 adapter 或实现同步判断。
- [ ] **零旧运行依赖**：新代码不得 import、spawn 或复制 `dsh-codex-session-sync`、`sync.mjs`、`sync-and-restart.ps1`、`/codex-sync`、EAC 或 Maintenance runtime。
- [ ] **观察与规范分离**：扫描可以移动 observed platform ref，但不能移动 canonical ref；相同观察不得创建重复版本。
- [ ] **正文与元数据分离**：标题或归档变化只改变 metadata hash；时间戳、绝对路径及读取顺序不能改变正文或元数据身份。
- [ ] **不可变历史**：版本、计划和内容对象一旦写入不得就地改写；更新通过新版本、新 ref 或新计划表达。
- [ ] **禁止自动拼接分叉**：只有完全相等或可证明的严格前缀才能生成安全快进；双方各自追加、历史改写或双边重命名必须进入 review。
- [ ] **身份匹配保守**：标题、相似文本或时间接近不能自动合并会话；相同 UUID 但正文无共同祖先必须阻塞并报告 `IDENTITY_CONFLICT`。
- [ ] **适配器版本锁定**：未知 Codex/DSH 版本、schema、Zstd 结构或事件 envelope 只能进入只读诊断，不能继续猜测。
- [ ] **稳定读取**：读取期间源文件大小、mtime 或指纹变化时返回 `UNSTABLE_READ`，不创建版本或 ref。
- [ ] **计划前置校验**：执行面即使尚未开放，也必须保存完整 platform/adapter/state fingerprints；任何差异都使计划失效。
- [ ] **受保护回收**：platform ref、canonical ref、checkpoint 及其祖先可达对象永不被 GC 删除。
- [ ] **本机安全边界**：HTTP 只能监听 `127.0.0.1`；token 只存在于权限收紧的 connection file 和受信客户端内，浏览器不能获得 Engine token。
- [ ] **测试隔离**：自动测试只能使用带 marker 的系统临时目录和脱敏 fixture；在 Vitest 中访问真实 `CODEX_HOME`、`DSH_HOME` 或正式 profile 必须失败。
- [ ] **按需读取**：会话列表、首屏 API 与图分页不解压全部历史；正文只为发生变化的候选读取，adapter 并发上限为 `4`。
- [ ] **阶段隔离**：阶段一不包含 Dashboard、DSH writer、Codex 新任务创建、Codex 原生数据库写入或正式插件替换。

## 4. 关键测试

| ID | 关键测试 | 通过标准 |
| --- | --- | --- |
| K1 | 干净 bootstrap 与 Windows CI | Node `22.19.0`、`24.x` 均通过；连续两次 bootstrap 不改变 lockfile |
| K2 | 规范化/hash 属性测试 | 路径、时间、PID 变化不改变 hash；标题仅改变 metadata hash；事件编辑必改 body hash |
| K3 | 版本图与决策矩阵 | 正确区分 equal、两向 fast-forward、diverged、rewritten、unrelated 和 metadata conflict |
| K4 | 对象库与 SQLite | 并发 put 去重、重开一致、外键有效、损坏 Zstd 被拒绝、未知 schema 被拒绝、GC dry-run 与实际结果一致 |
| K5 | 计划确定性与过期 | 同输入生成相同 plan ID/hash；缺失、额外或变化的前置指纹均返回 `PLAN_STALE` |
| K6 | Codex adapter contract | 支持 `0.146.0` fixture；轻量列表不读 rollout 正文；未知表结构或 event envelope 返回 unsupported |
| K7 | DSH adapter contract | 支持 `0.1.1-rc.2` 多帧 fixture；截断帧、错误 magic、越界块、路径逃逸及重复 ID 被拒绝 |
| K8 | 发现幂等性 | 同一 fixture 连续扫描两次，第二次创建 `0` 个 LogicalSession、Binding 和 SessionVersion |
| K9 | 绑定安全 | 明确 provenance 可自动绑定；同标题只产生候选；复用 UUID 加无关正文产生 `IDENTITY_CONFLICT` |
| K10 | 零平台写入 | 每个 scan/diff/plan/CLI/API 流程前后，Codex 与 DSH fixture 的完整相对路径/hash 映射完全一致 |
| K11 | API 与作业恢复 | 非认证、恶意 Origin、非 loopback、超限正文和路径字段被拒绝；扫描作业按序产生事件并在重启后只恢复一次 |
| K12 | 大目录按需性能 | 1,000 会话第二次扫描调用完整 `observe()` 为 `0`；首个列表页读取正文对象为 `0`；并发不超过 `4` |
| K13 | 可迁移性与旧依赖扫描 | clean clone 可 bootstrap/check；构建输出无本机路径、`file:`/`link:`、旧同步入口或 EAC runtime 引用 |

必须执行的阶段验证命令：

```powershell
pnpm bootstrap
pnpm check
pnpm test:phase1
pnpm assert:portable
git diff --check
```

关键测试失败时不得用跳过、放宽断言、读取真实 home 或改写 fixture 来源来通过阶段门槛。

## 5. 阶段门槛

- [ ] 新仓库能从 clean checkout 在 Windows 上完成 `pnpm bootstrap` 和 `pnpm check`。
- [ ] P1–P13 对应能力全部存在，并各有绑定到源码提交的 Markdown 修改/排错记录。
- [ ] Codex `0.146.0` 与 DSH `0.1.1-rc.2` fixture 均通过 probe、list、observe、normalize 和 verify-read。
- [ ] 从空维护目录扫描两套 fixture 两次，第二次没有重复 LogicalSession、PlatformBinding、SessionVersion、ref 或 plan。
- [ ] equal、两向前缀增长、双边追加、历史重写、单边/双边重命名、归档、缺失会话和 UUID 冲突全部有确定结果。
- [ ] CLI 与 API 可以登记实例、扫描、查看版本图/diff 并生成 dry-run 计划。
- [ ] CLI/API 的 apply 和 restore 均明确返回 `CAPABILITY_NOT_AVAILABLE`，且不创建 transaction、backup 或平台改动。
- [ ] 所有平台 fixture 在每条测试路径前后的完整树 hash 相同。
- [ ] `UNSTABLE_READ`、`PLAN_STALE`、`ADAPTER_INCOMPATIBLE`、`IDENTITY_CONFLICT`、`OBJECT_CORRUPT` 和安全边界错误均被测试覆盖。
- [ ] 1,000 会话性能测试满足按需读取和并发上限，不在启动时读取全部正文或全部版本图。
- [ ] loopback API、capability token、Origin、请求体上限、ID-only 请求和日志脱敏全部通过安全测试。
- [ ] clean clone、固定工具链和 portability 检查通过，运行时不存在旧同步器、EAC 或 Maintenance 服务依赖。
- [ ] `docs/validation/phase-1-validation.md` 记录 Windows/Node/pnpm 版本、Git commit、验证命令结果、平台 hash、幂等计数和已延期能力。
- [ ] 用户审阅并确认阶段一验证报告前，不进入阶段二，不卸载旧插件，不部署正式 DSH 插件，也不写真实 Codex/DSH 会话。
