# Session Maintenance Phase 1A Foundation and Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立 monorepo，固定跨包契约，并完成规范化、稳定 hash、版本图和差异分类。

**Architecture:** contracts 包是唯一 DTO 来源，session-domain 只包含确定性纯函数。批次结束时不得存在平台适配器、数据库或 HTTP 代码。

**Tech Stack:** Node.js `>=22.19.0`、pnpm `11.19.0`、TypeScript `5.9.2`、Vitest `3.2.4`、Zod `4.1.5`、Node crypto。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`（重点读取 §5、§8–§10、§13、§19.1）

**Parent plan:** `2026-08-26-session-maintenance-phase-1-readonly-core.md`

## Global Constraints

- 继承主计划全部约束；目标仓库为 `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`。
- P1–P4 串行执行且各自提交；不得开始 P5。
- 所有 ID/hash 来自 canonical JSON + SHA-256，不使用时间戳决定身份或先后。
- 未知平台只能被 Zod 拒绝；不得加入 `eac` 或旧同步器兼容字段。

---

### Task P1: Bootstrap the independent workspace

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `AGENTS.md`
- Create: `scripts/bootstrap.mjs`, `.github/workflows/ci.yml`
- Create: `packages/contracts/{package.json,tsconfig.json,src/index.ts}`
- Test: `tests/contract/workspace-contract.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-001.md`
- Copy: confirmed spec, roadmap and all four phase-one plan files to the same `docs/superpowers/` paths in the new repository

**Interfaces:**
- Consumes: Node `>=22.19.0`, pnpm `11.19.0`, this plan set.
- Produces: branch `codex/phase-1-readonly-core`; commands `pnpm bootstrap|build|typecheck|test|check|verify:clean`; export `CONTRACT_SCHEMA_VERSION = 1`.

- [ ] **Step 1: Write and run the workspace contract test**

```ts
it("is independent and pinned", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.packageManager).toBe("pnpm@11.19.0");
  expect(pkg.engines.node).toBe(">=22.19.0");
  expect(JSON.stringify(pkg)).not.toMatch(/dsh-codex-session-sync|EAC/);
});
```

Run `pnpm vitest run tests/contract/workspace-contract.test.ts`; expected result before root files exist: FAIL on missing manifest.

- [ ] **Step 2: Create the pinned workspace and package contract**

Initialize with:

```powershell
New-Item -ItemType Directory -Path 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance'
git -C 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance' init -b main
git -C 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance' switch -c codex/phase-1-readonly-core
```

Root scripts are exactly:

```json
{
  "bootstrap": "node scripts/bootstrap.mjs",
  "build": "pnpm -r --if-present build",
  "typecheck": "pnpm -r --if-present typecheck",
  "test": "vitest run",
  "check": "pnpm typecheck && pnpm build && pnpm test",
  "verify:clean": "pnpm bootstrap && pnpm check"
}
```

Use root dev dependencies `@types/node@24.3.0`, `typescript@5.9.2`, `vitest@3.2.4`. Workspace globs are only `apps/*` and `packages/*`. Library exports use `development: ./src/index.ts` and `default: ./dist/index.js`.

- [ ] **Step 3: Implement deterministic bootstrap and Windows CI**

`bootstrap.mjs` resolves its root from `import.meta.url`, validates Node/packageManager, then invokes `pnpm install --frozen-lockfile` with `spawnSync(..., { shell: false })`. CI uses `windows-latest`, Node `22.19.0` and `24.x`, pnpm `11.19.0`, then runs `pnpm bootstrap`, `pnpm check`, and rejects a dirty checkout.

- [ ] **Step 4: Verify, report and commit P1**

Run `pnpm bootstrap`, the workspace contract test, `pnpm check`, a second `pnpm bootstrap`, and `git diff --check`. Expected: all pass and the second bootstrap does not change `pnpm-lock.yaml`.
Write report `...001.md`, then commit all P1 files as `chore: bootstrap session maintenance workspace`.

---

### Task P2: Define shared contracts and runtime schemas

**Files:**
- Create: `packages/contracts/src/{model,adapters,store,plans,jobs,http,schemas,errors}.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-002.md`

**Interfaces:**
- Consumes: `CONTRACT_SCHEMA_VERSION = 1`, `zod@4.1.5`.
- Produces: `PlatformSessionKey`, `NormalizedEvent`, `NormalizedSession`, `SessionVersionManifest`, `SessionReadAdapter`, `SessionRepository`, `ContentObjectStore`, `SyncPlan`, job/HTTP DTOs, and `SessionMaintenanceError`.

- [ ] **Step 1: Write and run strict schema tests**

```ts
expect(platformSessionKeySchema.safeParse({ platform: "eac", instanceId: "x", sessionId: "s" }).success).toBe(false);
expect(sessionVersionManifestSchema.safeParse({
  schemaVersion: 1,
  id: "sv_a",
  logicalSessionId: "ls_a",
  parents: ["sv_1", "sv_2", "sv_3"],
  bodyObject: "sha256:a",
  bodyHash: "a",
  metadataHash: "b",
  source: { platform: "dsh", instanceId: "d", sessionId: "s", observedAt: "2026-08-26T00:00:00.000Z" },
  compatibility: { status: "compatible", issues: [] },
}).success).toBe(false);
expect(scanRequestSchema.safeParse({ instanceIds: ["dsh-fixture"], root: "C:\\forbidden" }).success).toBe(false);
```

Run `pnpm vitest run packages/contracts/test/contracts.test.ts`; expected: FAIL on missing exports.

- [ ] **Step 2: Implement model, adapter and store contracts**

Implement the exact shared types and `SessionReadAdapter`, `SessionRepository`, `ContentObjectStore` signatures from the parent plan. The only additional persistence-state union is:

```ts
type BindingStatus = "read-only" | "writable" | "busy" | "incompatible";
```

`NormalizedEvent` contains stable `id`, `parentId`, `sequence`, `kind`, `role`, `content`, attachments, source anchor and extensions. `SessionVersionManifest.parents` has at most two IDs. `RegisteredInstance.root` remains Engine-private.

- [ ] **Step 3: Implement plan, job, HTTP and error schemas**

Define strict Zod schemas for every parent-plan DTO plus `JobRef`, `JobStatus`, and the `queued | running | progress | completed | failed` `JobEvent` union. HTTP schemas reject unknown keys and path-bearing field names. Error codes are `UNSTABLE_READ`, `PLAN_STALE`, `ADAPTER_INCOMPATIBLE`, `CAPABILITY_NOT_AVAILABLE`, `LIVE_HOME_FORBIDDEN`, `RECOVERY_REQUIRED`, `IDENTITY_CONFLICT`, `OBJECT_CORRUPT`, `VERSION_ID_COLLISION`, and `LOOPBACK_ONLY`.

- [ ] **Step 4: Verify, report and commit P2**

Run the contracts test and package typecheck. Round-trip one complete normalized session, plan and every job event; expected: exact equality, strict unknown-key rejection and no emitted platform path in HTTP DTOs.
Write `...002.md` listing every public export and commit as `feat: define session maintenance contracts`.

---

### Task P3: Implement canonical normalization and hashes

**Files:**
- Create: `packages/session-domain/{package.json,tsconfig.json}`
- Create: `packages/session-domain/src/{canonical-json,normalize,index}.ts`
- Test: `packages/session-domain/test/normalize.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-003.md`

**Interfaces:**
- Consumes: P2 model DTOs.
- Produces: `canonicalJson(value): string`, `sha256Canonical(value): string`, `normalizeSession(input): NormalizedSession`, `NormalizationInput`, `RawSessionEvent`.

- [ ] **Step 1: Write and run normalization identity tests**

```ts
const base: NormalizationInput = {
  key: { platform: "codex", instanceId: "codex-fixture", sessionId: "thread-1" },
  title: "first",
  archived: false,
  workspaceId: "workspace-a",
  provenance: { platform: "codex", instanceId: "codex-fixture", sessionId: "thread-1", observedAt: "2026-08-26T00:00:00.000Z" },
  compatibility: { status: "compatible", issues: [] },
  events: [{ sourceEventId: "u1", parentSourceEventId: null, sequence: 0, kind: "message", role: "user", content: "hello", attachments: [], extensions: {} }],
};
const later = "2026-08-27T00:00:00.000Z";
expect(normalizeSession({ ...base, observedPath: "X:\\a" }).bodyHash)
  .toBe(normalizeSession({ ...base, observedPath: "Y:\\b", provenance: { ...base.provenance, observedAt: later } }).bodyHash);
expect(normalizeSession({ ...base, title: "new" }).bodyHash).toBe(normalizeSession(base).bodyHash);
expect(normalizeSession({ ...base, title: "new" }).metadataHash).not.toBe(normalizeSession(base).metadataHash);
```

Run the test; expected: FAIL on missing `normalizeSession`.

- [ ] **Step 2: Implement canonical JSON and stable event IDs**

Canonical JSON sorts object keys recursively, preserves array order, rejects non-finite numbers/undefined/functions/cycles, and encodes UTF-8 before SHA-256. Event ID is `ev_<first-24-hex>` of normalized source identity plus semantic event fields; it excludes local paths, scan time, PID, port and log location.

- [ ] **Step 3: Separate body and metadata identity**

Body hash covers ordered normalized events and stable workspace identity. Metadata hash covers title and archived state. Unknown source fields stay under `extensions` but never become writable fields without adapter support.

- [ ] **Step 4: Verify, report and commit P3**

Run normalization tests, domain typecheck and the root test suite. Include reordered keys, Unicode, attachment order, title-only change, archive-only change and forbidden non-JSON values.
Write `...003.md` and commit as `feat: normalize sessions with stable hashes`.

---

### Task P4: Implement version graph and reconciliation classification

**Files:**
- Create: `packages/session-domain/src/{graph,diff}.ts`
- Modify: `packages/session-domain/src/index.ts`
- Test: `packages/session-domain/test/{graph,diff}.test.ts`
- Create: `docs/validation/phase-1-progress.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-004.md`

**Interfaces:**
- Consumes: `NormalizedEvent`, `SessionVersionManifest`.
- Produces: `VersionGraph` with readonly `nodes: ReadonlyMap<string, VersionNode>`, `isAncestor()`, `findMergeBase()`, `classifyHeads()`, `classifyConversationDelta()`, `classifyMetadataDelta()`.

- [ ] **Step 1: Write and run graph/diff tests**

```ts
const graph = new VersionGraph([
  { id: "base", parents: [] },
  { id: "codex", parents: ["base"] },
  { id: "dsh", parents: ["base"] },
]);
const event = (id: string, content: string): NormalizedEvent => ({
  id, parentId: null, sequence: Number(id.slice(1)), kind: "message", role: "user", content,
  attachments: [], source: { platform: "dsh", instanceId: "d", sessionId: "s", eventId: id, sequence: Number(id.slice(1)) }, extensions: {},
});
const baseEvents = [event("e0", "a")];
const next = event("e1", "b");
const editedEvents = [event("e0", "changed")];
expect(classifyHeads(graph, "base", "codex").kind).toBe("target-ahead");
expect(classifyHeads(graph, "codex", "dsh")).toEqual({ kind: "diverged", mergeBase: "base" });
expect(classifyConversationDelta(baseEvents, [...baseEvents, next])).toBe("append-only");
expect(classifyConversationDelta(baseEvents, editedEvents)).toBe("rewritten");
```

Run both test files; expected: FAIL on missing graph/diff exports.

- [ ] **Step 2: Implement validated DAG traversal**

Reject duplicate IDs, missing parents, cycles and more than two parents. `findMergeBase()` chooses the common ancestor with minimum combined distance; lexical version ID resolves equal-distance ties. `classifyHeads()` uses ancestry only, never timestamps.

- [ ] **Step 3: Implement the non-merging decision matrix**

Conversation result is `unchanged | append-only | rewritten`; append-only requires deep equality of every base event at the same index. Metadata result is `unchanged | source-only | target-only | metadata-conflict`. No P4 function synthesizes a merged transcript.

- [ ] **Step 4: Verify, report, commit and close batch A**

Run P4 tests, domain typecheck and root tests. Cover unrelated roots, two-parent node, deletion, reordered events, identical two-sided rename, dual rename and one-sided archive.
Write `...004.md`, append actual commands/results to `docs/validation/phase-1-progress.md`, and commit as `feat: classify session version relationships`. Batch A ends only when `pnpm check` and `git diff --check` pass.
