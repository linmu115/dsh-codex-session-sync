# Session Maintenance Phase 1B Store and Read Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现不可变 SQLite/Zstd 存储、dry-run 计划、测试 sandbox，以及 Codex `0.146.0` 和官方 DSH `0.1.1-rc.2` 的只读适配器。

**Architecture:** 存储层只认识批次 A 的 DTO；平台适配器只负责探测、轻量列举、稳定读取、规范化和只读验证。所有适配器测试在带标记的临时 home 中运行。

**Tech Stack:** Node.js `node:sqlite`、`node:zlib` Zstd、Node filesystem/crypto、TypeScript、Vitest。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`（重点读取 §6、§8–§9、§12.3、§13、§18、§19.1–§19.2）

**Parent plan:** `2026-08-26-session-maintenance-phase-1-readonly-core.md`

## Global Constraints

- 仅在批次 A 门禁通过后执行；继承主计划全部只读约束。
- 对象 ID 是未压缩规范化字节的 SHA-256；压缩格式、路径和时间不得改变身份。
- 测试期间适配器构造器必须验证 fixture marker；任何真实 home 或越界 symlink 立即返回 `LIVE_HOME_FORBIDDEN`。
- 未知平台版本或 schema 只产生诊断；不得猜测解析或写入。
- P5–P9 串行提交；不得开始 P10。

---

### Task P5: Build SQLite metadata and Zstd content storage

**Files:**
- Create: `packages/session-store/{package.json,tsconfig.json}`
- Create: `packages/session-store/src/{schema,database,object-store,repository,index}.ts`
- Test: `packages/session-store/test/{object-store,repository}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-005.md`

**Interfaces:**
- Consumes: P2 store contracts and P3 canonical serialization.
- Produces: `openMaintenanceDatabase(path): DatabaseSync`; the P5 repository subset `createLogicalSession/putVersion/recordObservation/getGraph/listReachableObjectIds/close`; `ZstdContentObjectStore.put/get/collect`; schema version `1`. P6 adds plan persistence and P10 completes the remaining repository interface.

- [ ] **Step 1: Write and run persistence failure tests**

```ts
const root = await mkdtemp(join(tmpdir(), "dsh-sm-store-"));
const store = new ZstdContentObjectStore(root);
const first = await store.put(Buffer.from("same body"));
expect(await store.put(Buffer.from("same body"))).toBe(first);
expect(Buffer.from(await store.get(first)).toString()).toBe("same body");
const dbPath = join(root, "metadata.sqlite");
let repository = new SqliteSessionRepository(openMaintenanceDatabase(dbPath), store);
await repository.createLogicalSession({ id: "ls_a", displayTitle: "A", canonicalVersionId: null, syncMode: "paused", archived: false, labels: [], createdAt: "2026-08-26T00:00:00.000Z" });
const manifest = await repository.putVersion({
  logicalSessionId: "ls_a", parents: [], bodyObject: first, bodyHash: "body-a", metadataHash: "meta-a",
  source: { platform: "dsh", instanceId: "d", sessionId: "s", observedAt: "2026-08-26T00:00:00.000Z" },
  compatibility: { status: "compatible", issues: [] },
});
repository.close();
repository = new SqliteSessionRepository(openMaintenanceDatabase(dbPath), store);
expect((await repository.getGraph("ls_a")).nodes.some(node => node.id === manifest.id)).toBe(true);
```

Run `pnpm vitest run packages/session-store/test`; expected: FAIL because the package is absent.

- [ ] **Step 2: Implement schema migration 001 and database opening**

Create tables `schema_migrations`, `logical_sessions`, `session_versions`, `version_parents`, `platform_bindings`, `platform_refs`, `sync_plans`, `scan_cursors`, `match_candidates`, `checkpoints`, and `jobs`. Required uniqueness is `(platform, instance_id, session_id)` and `(version_id, ordinal)`; parent, binding, observed ref, logical session and last-common-version fields use foreign keys. Logical sessions store labels; bindings store adapter contract/status; checkpoints store refs, backup transaction IDs and creator.

`openMaintenanceDatabase()` enables foreign keys, WAL and `busy_timeout=5000`, runs migrations inside `BEGIN IMMEDIATE`, and refuses a newer schema version.

- [ ] **Step 3: Implement atomic content objects**

```ts
objectId = `sha256:${sha256(uncompressedBytes)}`;
objectPath = `objects/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.zst`;
```

`put()` compresses with Zstd checksum to a same-directory `wx` temp file, fsyncs and renames. Existing objects are decompressed and rehashed. `get()` always verifies the uncompressed hash and throws `OBJECT_CORRUPT` on mismatch.

- [ ] **Step 4: Implement immutable repository and protected collection**

`putVersion()` writes the object before its SQLite transaction, preserves parent order and treats an identical retry as success; same ID/different manifest throws `VERSION_ID_COLLISION`. `recordObservation()` moves only the platform ref. `listReachableObjectIds()` walks platform refs, canonical refs and checkpoints. `collect({ reachableObjectIds, olderThan, dryRun })` removes only aged unreferenced objects and reports counts/bytes.

- [ ] **Step 5: Verify, report and commit P5**

Test reopen, two concurrent puts, truncated Zstd, newer schema, idempotent version insertion and dry-run GC. Run package typecheck plus common validation, write `...005.md`, commit as `feat: persist immutable session versions`.

---

### Task P6: Generate immutable plans and reject stale state

**Files:**
- Create: `packages/session-domain/src/planner.ts`
- Modify: `packages/session-domain/src/index.ts`, `packages/session-store/src/repository.ts`
- Create: `packages/session-domain/test/plan-fixtures.ts`
- Test: `packages/session-domain/test/planner.test.ts`, `packages/session-store/test/plan-store.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-006.md`

**Interfaces:**
- Consumes: P4 classifications, `SyncPlan`, repository plan persistence.
- Produces: `createSyncPlan(request): SyncPlan`, `validatePlanPreconditions(plan, fingerprints): void`, `PlanningService.create/validate`.

- [ ] **Step 1: Write and run deterministic/stale tests**

```ts
const fixedTime = "2026-08-26T00:00:00.000Z";
const first = createSyncPlan(appendOnlyPlanFixture(fixedTime));
expect(createSyncPlan(appendOnlyPlanFixture(fixedTime))).toEqual(first);
expect(first.operations.map(x => x.type)).toEqual(["append-events"]);
const changedFingerprints = first.preconditions.map((item, index) => index === 0 ? { ...item, value: "changed" } : item);
expect(() => validatePlanPreconditions(first, changedFingerprints)).toThrow(/PLAN_STALE/);
```

Run planner and plan-store tests; expected: FAIL on missing planner/repository methods.

`plan-fixtures.ts` exports `appendOnlyPlanFixture(createdAt)`: one complete request whose target event list is the source list plus one event, with fixed adapter contracts and fingerprints. Conflict tests clone that request and replace only the field under test.

- [ ] **Step 2: Implement the exact operation matrix**

Equal heads create an empty safe plan; strict prefix creates `append-events`; one-sided allowed metadata creates `update-title` or `update-archive`; missing previously observed session creates `deletion-candidate`; divergence, rewrite, dual rename and identity conflict create only `require-review`.

- [ ] **Step 3: Implement identity, preconditions and persistence**

Canonicalize the candidate without `id/hash`, set `hash=sha256:<hex>` and `id=plan_<first-24-hex>`. Caller supplies `createdAt`. Preconditions require exact set equality over platform/instance/session/kind/value. Persist exact validated JSON; identical retry succeeds and ID/hash collision fails.

- [ ] **Step 4: Verify, report and commit P6**

Run P6 tests and common validation. Cover empty plan, both prefix directions, deletion candidate, every review reason, malformed stored JSON and repository reopen.
Write `...006.md` and commit as `feat: create immutable sync plans`.

---

### Task P7: Add sanitized fixtures and live-home guards

**Files:**
- Create: `packages/test-support/{package.json,tsconfig.json}`
- Create: `packages/test-support/src/{sandbox,codex-fixture,dsh-fixture,index}.ts`
- Test: `packages/test-support/test/sandbox.test.ts`
- Create: `fixtures/codex/0.146.0/{manifest.yaml,rollout.jsonl}`
- Create: `fixtures/dsh/0.1.1-rc.2/{manifest.yaml,header.json,events.jsonl}`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-007.md`

**Interfaces:**
- Produces: `createFixtureSandbox(name): Promise<{root,codexHome,dshHome,cleanup}>`, `assertFixtureSandbox(root): void`, `writeCodexFixtureHome(root): Promise<void>`, `writeDshFixtureHome(root): Promise<void>`, marker `.dsh-session-maintenance-fixture`.

- [ ] **Step 1: Write and run the live-home guard test**

```ts
expect(() => assertFixtureSandbox(join(homedir(), ".codex"))).toThrow(/LIVE_HOME_FORBIDDEN/);
const sandbox = await createFixtureSandbox("guard");
expect(() => assertFixtureSandbox(sandbox.root)).not.toThrow();
```

Run the sandbox test; expected: FAIL on missing exports.

- [ ] **Step 2: Implement the process-level sandbox boundary**

Create a unique directory below `os.tmpdir()`, write a regular-file marker containing a random UUID, resolve symlinks and require containment below temp. Reject the temp root itself, a missing/symlink marker, `homedir()/.codex`, a non-fixture DSH directory and any escaping symlink. Under Vitest every adapter constructor calls this guard before opening a root.

- [ ] **Step 3: Materialize deterministic platform homes**

Codex fixture creation writes a minimal `state_5.sqlite`, `session_index.jsonl` and one rollout. DSH fixture creation writes a two-frame `session.jsonl.zstd`, `storages/workspace.json` and `storages/session_projcache.json`. Both refuse an existing non-empty destination without the same marker.

- [ ] **Step 4: Verify fixture safety, report and commit P7**

Each manifest records exact platform version, `synthetic: true`, `containsUserData: false`. Test byte-for-byte deterministic output and scan fixture sources for the current account name, local installation terms and credential-shaped values; expected: no match.
Run common validation, write `...007.md`, commit as `test: add isolated session fixtures`.

---

### Task P8: Implement the Codex 0.146.0 read adapter

**Files:**
- Create: `packages/adapter-codex-read/{package.json,tsconfig.json}`
- Create: `packages/adapter-codex-read/src/{probe,catalog,stable-read,parser,normalizer,index}.ts`
- Test: `packages/adapter-codex-read/test/{codex-adapter,codex-schema}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-008.md`

**Interfaces:**
- Consumes: parent-plan `SessionReadAdapter`, P3 normalization, P7 Codex fixture.
- Produces: `CodexReadAdapter`; contract `codex-read/0.146.0/schema-1`.

- [ ] **Step 1: Write and run list/observe/normalize tests**

```ts
const sandbox = await createFixtureSandbox("codex-read");
await writeCodexFixtureHome(sandbox.codexHome);
const adapter = new CodexReadAdapter();
const instance: RegisteredInstance = { id: "codex-fixture", platform: "codex", displayName: "fixture", root: sandbox.codexHome, platformVersion: "0.146.0" };
const probe = await adapter.probe(instance);
expect(probe.status).toBe("compatible");
const summaries = await collect(adapter.list(instance));
const observed = await adapter.observe(instance, summaries[0].key, summaries[0].hint);
expect((await adapter.normalize(expectStable(observed))).events.map(e => e.role)).toEqual(["user", "assistant"]);
```

Run adapter tests; expected: FAIL because `CodexReadAdapter` is missing. Test helpers `collect()` and `expectStable()` live in the test file and accept only AsyncIterable/observation values.

- [ ] **Step 2: Implement version/schema probing**

Open `state_5.sqlite` read-only; require thread columns `id`, `rollout_path`, `title`, `name`, `cwd`, `created_at`, `updated_at`, `archived`; sample the `session_meta`/`response_item` envelope. Hash sorted table/column and supported envelope names into `schemaFingerprint`. Unknown version/fingerprint returns `unsupported` and `ADAPTER_INCOMPATIBLE` without reading bodies.

- [ ] **Step 3: Implement metadata-first catalog and stable read**

List uses database/index metadata plus file size/mtime and does not read full rollout bodies. Observe opens without write access, captures stat before/after, reads bounded JSONL, and returns `UNSTABLE_READ` on size/mtime change. Resolve rollout paths by realpath containment under the registered root; reject escape, duplicate IDs and malformed JSONL.

- [ ] **Step 4: Normalize supported Codex events**

Map user/assistant/system messages and attachments in source order. Unknown tool/event envelopes become source extensions with degraded compatibility; they are never represented as native DSH tool calls. `verify()` repeats fingerprints read-only.

- [ ] **Step 5: Verify, report and commit P8**

Assert listing 100 summaries performs zero full rollout reads; observing one reads only that rollout. Cover truncated JSONL, path escape, duplicate ID, changed-during-read and unknown schema. Run package typecheck and common validation.
Write `...008.md` with the supported fingerprint and commit as `feat: scan Codex sessions read-only`.

---

### Task P9: Implement the official DSH 0.1.1-rc.2 read adapter

**Files:**
- Create: `packages/adapter-dsh/{package.json,tsconfig.json}`
- Create: `packages/adapter-dsh/src/{probe,zstd-codec,reader,normalizer,index}.ts`
- Test: `packages/adapter-dsh/test/{dsh-adapter,zstd-codec}.test.ts`
- Modify: `docs/validation/phase-1-progress.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-009.md`

**Interfaces:**
- Consumes: parent-plan `SessionReadAdapter`, P3 normalization, P7 DSH fixture.
- Produces: `DshReadAdapter`; contract `dsh-read/0.1.1-rc.2/session-v0`; bounded multi-frame decoder.

- [ ] **Step 1: Write and run frame/adapter tests**

```ts
const twoFrameFixture = encodeFixtureArtifact(
  { type: "session", version: 0, id: "dsh-session-1", createdAt: 1, cwd: "C:\\fixture\\workspace", delegationDepth: 0 },
  [{ type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "hello" }] } }],
);
const decoded = decodeDshArtifact(twoFrameFixture);
expect(decoded.frameCount).toBe(2);
expect(decoded.header.version).toBe(0);
expect(decoded.events).toHaveLength(1);
```

The adapter test lists one fixture, observes it and expects visible roles plus imported tool records. Run package tests; expected: FAIL on missing exports.

- [ ] **Step 2: Implement bounded Zstd frame decoding**

Validate magic `0xFD2FB528`, frame headers, reserved bits, block boundaries and checksum before decompression. Limits: 64 MiB compressed artifact, 256 MiB decompressed data, 1,000,000 JSONL lines, 8 MiB per line. `decodeHeaderFrame()` reads only the first frame; `decodeDshArtifact()` reads all frames. Fixture encoding is exposed only through a test export.

- [ ] **Step 3: Implement probe and metadata-first listing**

Require declared platform version `0.1.1-rc.2`, contained `sessions/` and `storages/`, and sampled header `{ type: "session", version: 0 }`. Enumerate only `sessions/<project>/<session>/session.jsonl.zstd`, decode one header frame and join archive metadata. Unknown version returns unsupported; escaped symlink or duplicate header ID returns diagnostics without binding.

- [ ] **Step 4: Normalize DSH without forging Codex semantics**

Map visible user/assistant messages to `message`; combine tool call/result as ordered `tool-import` with DSH sequence/source type; preserve unknown events under extensions with degraded compatibility. Runtime seed/preset/sandbox/approval tails remain source metadata. Workspace identity is a hash of normalized registered mapping, not raw `cwd`.

- [ ] **Step 5: Verify corruption, lazy reads and zero writes**

Cover invalid magic, truncated second frame, oversized block, path escape, duplicate ID and unknown session version. Listing 100 sessions decompresses only 100 header frames; observing one fully reads only one artifact. Hash the fixture tree before/after every operation and run common validation.

- [ ] **Step 6: Record, commit and close batch B**

Write `...009.md`, append actual results to `docs/validation/phase-1-progress.md`, and commit as `feat: scan official DSH sessions read-only`. Do not begin P10 until batch A+B tests and `git diff --check` pass.
