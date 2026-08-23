import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { convertCodexJsonl } from './vendor/codex.mjs'

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const APPROVAL_TRANSCRIPT_PREFIXES = [
  'The following is the Codex agent history whose request action you are assessing.',
  'The following is the Codex agent history added since your last approval assessment.',
]
const EXPECTED_LEGACY_TAIL = ['session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy']
const ZSTD_MAGIC = 4247762216
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const DEFAULT_BUDGET = 494000

function pathKey(path) {
  if (typeof path !== 'string' || !path) return null
  const value = path.startsWith('\\\\?\\') ? path.slice(4) : path
  return resolve(value).toLowerCase()
}

function parseArgs(argv) {
  const out = { apply: false, verify: false, quiet: false, only: null, pruneRedundantBranches: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--verify') out.verify = true
    else if (arg === '--quiet') out.quiet = true
    else if (arg === '--prune-redundant-branches') out.pruneRedundantBranches = true
    else if (arg === '--only') out.only = argv[++i]
    else if (arg === '--dsh-home') out.dshHome = resolve(argv[++i])
    else if (arg === '--codex-root') out.codexRoot = resolve(argv[++i])
    else if (arg === '--budget') out.budget = Number(argv[++i])
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

export function isApprovalTranscript(text) {
  const value = String(text ?? '').trimStart()
  return APPROVAL_TRANSCRIPT_PREFIXES.some((prefix) => value.startsWith(prefix))
}

export function encodeSegment(raw) {
  if (!raw) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export function projectKey(cwd) {
  if (!cwd) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function sessionLogPath(sessionsRoot, cwd, id) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return join(sessionsRoot, project, encodeSegment(id), 'session.jsonl.zstd')
}

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`Zstandard 尾帧不完整：${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`Zstandard 帧头无效：${offset}`)
    offset += 4
    if (offset === buffer.length) throw new Error(`Zstandard 尾帧不完整：${start}`)
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 24) !== 0) throw new Error(`Zstandard 帧头保留位异常：${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`Zstandard 尾帧不完整：${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`Zstandard 尾帧不完整：${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`Zstandard 块类型无效：${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (offset > buffer.length) throw new Error(`Zstandard 尾帧不完整：${start}`)
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`Zstandard 尾帧不完整：${start}`)
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return frames
  }
  return frames
}

export function decodeArtifact(buffer) {
  const frames = scanZstdFrames(buffer)
  if (frames.length < 1) throw new Error('空的会话日志')
  const plain = Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end))))
  const lines = plain.toString('utf8').trimEnd().split('\n')
  const header = JSON.parse(lines.shift())
  if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('会话头无效')
  return { header, events: lines.filter(Boolean).map((line) => JSON.parse(line)), frameCount: frames.length }
}

function decodeHeader(buffer) {
  const [frame] = scanZstdFrames(buffer, 1)
  const line = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8').trimEnd()
  const header = JSON.parse(line)
  if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('会话头无效')
  return header
}

export function encodeArtifact(header, events) {
  const storedHeader = {
    type: 'session',
    version: header.version ?? 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
    ...(header.seedLength !== undefined ? { seedLength: header.seedLength } : {}),
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
  }
  const headerFrame = zstdCompressSync(`${JSON.stringify(storedHeader)}\n`, ZSTD_OPTIONS)
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  const eventFrame = zstdCompressSync(body, ZSTD_OPTIONS)
  return Buffer.concat([headerFrame, eventFrame])
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function nextSeq(events) {
  return events.length === 0 ? 0 : events.at(-1).seq + 1
}

function appendTitle(events, title, time = Date.now()) {
  if (!title) return events
  return [...events, {
    type: 'session/title',
    seq: nextSeq(events),
    time,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }]
}

function appendSeedTail(events, time = Date.now()) {
  const result = [...events]
  const push = (type, data) => result.push({ type, seq: nextSeq(result), time, data })
  push('session/end-seed', {})
  push('permission/preset', { preset: 'workspace-write' })
  push('sandbox/mode', { mode: 'workspace-write' })
  push('approval/policy', { policy: 'ask' })
  return result
}

function latestTitle(events) {
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title
}

function firstUserText(events) {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
    if (text) return text
  }
  return ''
}

function sessionListMetadata(events) {
  let blank = true
  let lastPromptAt = null
  for (const event of events) {
    if (event.type === 'turn/start') blank = false
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      lastPromptAt = event.time
    }
  }
  return { blank, lastPromptAt }
}

function legacyWasModified(events, importedEventCount) {
  if (!Number.isInteger(importedEventCount) || importedEventCount < 0) return true
  const tail = events.slice(importedEventCount)
  if (tail.length !== EXPECTED_LEGACY_TAIL.length) return true
  return tail.some((event, i) => event.type !== EXPECTED_LEGACY_TAIL[i])
}

export function hasOnlyBenignRuntimeTail(events, importedEventCount) {
  if (!Number.isInteger(importedEventCount) || importedEventCount < 0) return false
  if (!Array.isArray(events) || events.length <= importedEventCount) return false
  return events
    .slice(importedEventCount)
    .every((event) => event?.type === 'session/end-seed')
}

export function hasNativeDialogue(events, sourceId) {
  if (!Array.isArray(events) || typeof sourceId !== 'string' || !sourceId) return false
  const importedPrefix = `import:${sourceId}:`
  for (const event of events) {
    if (event?.type === 'user/message') {
      if (typeof event.data?.id !== 'string' || !event.data.id.startsWith(importedPrefix)) return true
    } else if (event?.type === 'assistant/message') {
      const messageId = event.data?.message?.id
      if (typeof messageId !== 'string' || !messageId.startsWith(importedPrefix)) return true
    }
  }
  return false
}

const MANAGED_BRANCH_TAIL_TYPES = new Set([
  'session/title',
  'session/end-seed',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
])

function withoutManagedBranchTail(events) {
  let end = events.length
  while (end > 0 && MANAGED_BRANCH_TAIL_TYPES.has(events[end - 1]?.type)) end--
  return events.slice(0, end)
}

function comparableEvent(event) {
  if (event?.type !== 'session/imported' || !event.data) return event
  const { importedAt: _importedAt, ...data } = event.data
  return { ...event, data }
}

function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function dialogueSignature(events) {
  const messages = []
  for (const event of events) {
    if (event?.type === 'user/message') {
      messages.push(['user', messageText(event.data?.content)])
    } else if (event?.type === 'assistant/message') {
      messages.push(['assistant', messageText(event.data?.message?.content)])
    }
  }
  return messages
}

function isPrefixOf(prefix, full) {
  return prefix.length <= full.length
    && prefix.every((value, index) => isDeepStrictEqual(value, full[index]))
}

export function isRedundantBranch(branchEvents, canonicalEvents) {
  if (!Array.isArray(branchEvents) || !Array.isArray(canonicalEvents)) return false
  const branchCore = withoutManagedBranchTail(branchEvents)
  const canonicalCore = withoutManagedBranchTail(canonicalEvents)
  if (branchCore.length > canonicalCore.length) return false
  const exactEventPrefix = branchCore.every((event, index) => (
    isDeepStrictEqual(comparableEvent(event), comparableEvent(canonicalCore[index]))
  ))
  if (exactEventPrefix) return true
  const branchDialogue = dialogueSignature(branchCore)
  const canonicalDialogue = dialogueSignature(canonicalCore)
  return branchDialogue.length > 0 && isPrefixOf(branchDialogue, canonicalDialogue)
}

function branchStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

function makeBranch(decoded, canonicalId, fallbackTitle) {
  const id = `${canonicalId}--branch-${branchStamp()}-${randomBytes(2).toString('hex')}`
  const baseTitle = latestTitle(decoded.events) || fallbackTitle || canonicalId
  const events = appendTitle(decoded.events, `${baseTitle} · 分支 ${branchStamp()}`)
  return {
    id,
    header: { ...decoded.header, id },
    events,
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    await rename(tmp, path)
  } catch (error) {
    if (!existsSync(path)) throw error
    const old = `${path}.old.${process.pid}.${randomBytes(3).toString('hex')}`
    await rename(path, old)
    try {
      await rename(tmp, path)
      await rm(old, { force: true })
    } catch (publishError) {
      if (!existsSync(path) && existsSync(old)) await rename(old, path)
      throw publishError
    }
  }
}

async function usableSessionCwd(cwd, fallbackCwd) {
  if (typeof cwd === 'string' && cwd) {
    try {
      if ((await stat(cwd)).isDirectory()) return cwd
    } catch {
      // rc.7 hides sessions whose stored cwd no longer resolves.
    }
  }
  return fallbackCwd
}

async function relocateUnusableLedgerSessions(
  ledger,
  sessionsRoot,
  fallbackCwd,
  backupRoot,
  preferredCwds = new Map(),
  excludedWorkspacePaths = new Set(),
) {
  let relocated = 0
  for (const [id, entry] of Object.entries(ledger.sessions ?? {})) {
    if (!entry?.dshPath || !existsSync(entry.dshPath)) continue
    const decoded = decodeArtifact(await readFile(entry.dshPath))
    const preferred = preferredCwds.get(id)
    let cwd = null
    if (!excludedWorkspacePaths.has(pathKey(preferred))) {
      cwd = await usableSessionCwd(preferred, null)
    }
    if (!cwd && !excludedWorkspacePaths.has(pathKey(decoded.header.cwd))) {
      cwd = await usableSessionCwd(decoded.header.cwd, null)
    }
    cwd ??= fallbackCwd
    if (pathKey(cwd) === pathKey(decoded.header.cwd)) continue

    const buffer = encodeArtifact({ ...decoded.header, cwd }, decoded.events)
    const targetPath = sessionLogPath(sessionsRoot, cwd, id)
    await publishArtifact(targetPath, buffer, backupRoot, id)
    if (dirname(entry.dshPath) !== dirname(targetPath)) {
      await moveDirToBackup(dirname(entry.dshPath), backupRoot, 'invalid-cwd-sessions')
    }
    entry.dshPath = targetPath
    entry.dshHash = sha256(buffer)
    entry.syncedAt = Date.now()
    relocated++
  }
  return relocated
}

async function archiveExcludedCodexSessions(
  dshSessions,
  metadata,
  excludedWorkspacePaths,
  syncRoot,
) {
  const archiveRoot = join(syncRoot, 'archived-sessions')
  let archived = 0
  for (const [id, session] of dshSessions) {
    const state = metadata.state.get(id)
    if (!state || Number(state.archived) === 0) continue
    if (!excludedWorkspacePaths.has(pathKey(state.cwd))) continue
    let target = join(archiveRoot, projectKey(state.cwd || session.header.cwd), id)
    if (existsSync(target)) target = `${target}-${branchStamp()}`
    await mkdir(dirname(target), { recursive: true })
    await rename(session.dir, target)
    archived++
  }
  return archived
}

async function prepareWorkspaceRebuild(
  dshHome,
  backupRoot,
  excludedSessionIds = new Set(),
  excludedWorkspacePaths = new Set(),
) {
  const path = join(dshHome, 'storages', 'workspace.json')
  if (!existsSync(path)) return { changed: false, migratedIds: 0 }

  const document = await readJson(path, null)
  const workspaces = document?.tables?.workspaces
  if (!document?.global || !workspaces || typeof workspaces !== 'object') {
    throw new Error(`workspace registry has an unsupported shape: ${path}`)
  }

  const actual = await scanDshSessions(join(dshHome, 'sessions'))
  const seen = new Set()
  let changed = false
  let migratedIds = 0
  let removedWorkspaces = 0
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (excludedWorkspacePaths.has(pathKey(record.path))) {
      delete workspaces[workspaceId]
      removedWorkspaces++
      changed = true
      continue
    }
    if (!Array.isArray(record.sessionIds)) continue
    const before = record.sessionIds
    const after = []
    let excludedCount = 0
    let missingCount = 0
    for (const storedId of before) {
      let id = storedId
      if (typeof storedId === 'string' && storedId.startsWith('import-')) {
        const canonicalId = storedId.slice('import-'.length)
        id = actual.has(canonicalId) ? canonicalId : null
        migratedIds++
      }
      if (id && excludedSessionIds.has(id)) {
        excludedCount++
        continue
      }
      if (id && !actual.has(id)) {
        missingCount++
        continue
      }
      if (!id || seen.has(id)) continue
      seen.add(id)
      after.push(id)
    }
    if (after.length === 0
      && before.length > 0
      && excludedCount + missingCount === before.length) {
      delete workspaces[workspaceId]
      removedWorkspaces++
      changed = true
      continue
    }
    if (after.length !== before.length || after.some((id, index) => id !== before[index])) {
      record.sessionIds = after
      record.updatedAt = new Date().toISOString()
      changed = true
    }
  }

  if (Array.isArray(document.global.workspaceIds)) {
    const workspaceIds = document.global.workspaceIds.filter((id) => workspaces[id])
    if (workspaceIds.length !== document.global.workspaceIds.length
      || workspaceIds.some((id, index) => id !== document.global.workspaceIds[index])) {
      document.global.workspaceIds = workspaceIds
      changed = true
    }
  }

  if (Array.isArray(document.global.archivedSessionIds)) {
    const archived = []
    for (const storedId of document.global.archivedSessionIds) {
      const id = typeof storedId === 'string' && storedId.startsWith('import-')
        ? storedId.slice('import-'.length)
        : storedId
      if (actual.has(id) && !archived.includes(id)) archived.push(id)
    }
    if (archived.length !== document.global.archivedSessionIds.length
      || archived.some((id, index) => id !== document.global.archivedSessionIds[index])) {
      document.global.archivedSessionIds = archived
      changed = true
    }
  }

  let unregisteredIds = 0
  for (const [id, session] of actual) {
    if (seen.has(id) || excludedSessionIds.has(id)) continue
    if (excludedWorkspacePaths.has(pathKey(session.header.cwd))) continue
    try {
      if (typeof session.header.cwd === 'string' && (await stat(session.header.cwd)).isDirectory()) {
        unregisteredIds++
      }
    } catch {
      // The workspace service also ignores sessions whose cwd no longer exists.
    }
  }
  if (unregisteredIds > 0 && document.global.initialized !== false) {
    document.global.initialized = false
    changed = true
  }
  if (changed) {
    const backupDir = join(backupRoot, 'workspace-registry')
    await mkdir(backupDir, { recursive: true })
    await copyFile(path, join(backupDir, 'workspace.json'))
    await writeJsonAtomic(path, document)
  }
  return { changed, migratedIds, removedWorkspaces, unregisteredIds }
}

async function stableRead(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat(path, { bigint: true })
    const raw = await readFile(path)
    const after = await stat(path, { bigint: true })
    if (before.size === after.size && before.mtimeNs === after.mtimeNs) {
      return {
        raw,
        size: Number(after.size),
        mtimeNs: String(after.mtimeNs),
        mtimeMs: Number(after.mtimeNs / 1000000n),
        sha256: sha256(raw),
      }
    }
  }
  throw new Error(`Codex 会话正在持续写入，请稍后重试：${path}`)
}

function openDatabase(path) {
  if (!existsSync(path)) return null
  return new DatabaseSync(path, { readOnly: true })
}

function loadCodexMetadata(codexRoot) {
  const statePath = join(codexRoot, 'state_5.sqlite')
  const catalogPath = join(codexRoot, 'sqlite', 'codex-dev.db')
  const state = new Map()
  const stateDb = openDatabase(statePath)
  if (stateDb) {
    try {
      for (const row of stateDb.prepare('select id, rollout_path, title, name, cwd, created_at, updated_at, archived from threads').all()) {
        state.set(row.id, row)
      }
    } finally {
      stateDb.close()
    }
  }

  const catalog = new Map()
  const catalogDb = openDatabase(catalogPath)
  if (catalogDb) {
    try {
      const rows = catalogDb.prepare(`
        select thread_id, display_title
        from local_thread_catalog
        where missing_candidate = 0
        order by observation_sequence asc, source_recency_at asc
      `).all()
      for (const row of rows) if (row.display_title) catalog.set(row.thread_id, row.display_title)
    } finally {
      catalogDb.close()
    }
  }
  return { state, catalog }
}

async function loadSessionIndex(codexRoot) {
  const titles = new Map()
  const path = join(codexRoot, 'session_index.jsonl')
  try {
    const raw = await readFile(path, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.id && typeof row.thread_name === 'string' && row.thread_name) titles.set(row.id, row.thread_name)
      } catch {
        // A malformed index row must not block syncing valid Codex rollouts.
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return titles
}

function sourceIdFromPath(path) {
  return basename(path).match(UUID_RE)?.[1]?.toLowerCase() ?? null
}

function sourceUnchangedFromLegacy(info, legacyRecord) {
  if (!info || !legacyRecord) return false
  const parts = String(legacyRecord.version ?? '').split(':')
  const recordedMtimeNs = parts.length >= 4 ? parts[3] : null
  return Number(legacyRecord.sizeBytes) === info.size
    && recordedMtimeNs !== null
    && recordedMtimeNs === info.mtimeNs
}

async function sourceInfo(path) {
  try {
    const value = await stat(path, { bigint: true })
    return {
      size: Number(value.size),
      mtimeNs: String(value.mtimeNs),
      mtimeMs: Number(value.mtimeNs / 1000000n),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function scanDshSessions(sessionsRoot) {
  const byId = new Map()
  if (!existsSync(sessionsRoot)) return byId
  const { readdir } = await import('node:fs/promises')
  for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const path = join(projectPath, session.name, 'session.jsonl.zstd')
      if (!existsSync(path)) continue
      const buffer = await readFile(path)
      const header = decodeHeader(buffer)
      if (byId.has(header.id)) throw new Error(`存在重复会话 ID：${header.id}`)
      byId.set(header.id, { path, dir: dirname(path), header, hash: null })
    }
  }
  return byId
}

async function refreshProjectionCache(dshHome, backupRoot, excludedSessionIds = new Set()) {
  const path = join(dshHome, 'storages', 'session_projcache.json')
  const document = await readJson(path, {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions: {} },
  })
  const records = document?.tables?.sessions
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    throw new Error(`projection cache has an unsupported shape: ${path}`)
  }

  const actual = await scanDshSessions(join(dshHome, 'sessions'))
  let removed = 0
  let updated = 0
  for (const id of Object.keys(records)) {
    if (actual.has(id) && !excludedSessionIds.has(id)) continue
    delete records[id]
    removed++
  }

  for (const [id, session] of actual) {
    if (excludedSessionIds.has(id)) continue
    const decoded = decodeArtifact(await readFile(session.path))
    const title = latestTitle(decoded.events) || firstUserText(decoded.events)
    const seq = decoded.events.at(-1)?.seq ?? -1
    const identity = {
      createdAt: decoded.header.createdAt,
      ...(decoded.header.cwd !== undefined ? { cwd: decoded.header.cwd } : {}),
    }
    const previous = records[id]
    const sameIdentity = previous?.identity?.createdAt === identity.createdAt
      && previous?.identity?.cwd === identity.cwd
    const record = {
      identity,
      rows: {
        ...(sameIdentity && previous?.rows && typeof previous.rows === 'object' ? previous.rows : {}),
        title: { ver: 1, seq, val: title },
        sessionListMetadata: { ver: 1, seq, val: sessionListMetadata(decoded.events) },
      },
    }
    if (JSON.stringify(previous) === JSON.stringify(record)) continue
    records[id] = record
    updated++
  }

  const changed = removed > 0 || updated > 0 || !existsSync(path)
  if (changed) {
    if (existsSync(path)) {
      const backupDir = join(backupRoot, 'session-projection-cache')
      await mkdir(backupDir, { recursive: true })
      await copyFile(path, join(backupDir, 'session_projcache.json'))
    }
    await writeJsonAtomic(path, document)
  }
  return { changed, updated, removed, total: Object.keys(records).length }
}

function loadLegacyImports(data) {
  const bySource = new Map()
  for (const [sourcePath, record] of Object.entries(data?.imports ?? {})) {
    if (record?.kind !== 'single' || typeof record.dshId !== 'string') continue
    bySource.set(resolve(sourcePath), { ...record, sourcePath: resolve(sourcePath) })
  }
  return bySource
}

function titleFor(id, metadata, indexTitles, fallback = '') {
  const state = metadata.state.get(id)
  return metadata.catalog.get(id)
    || indexTitles.get(id)
    || (typeof state?.name === 'string' && state.name)
    || (typeof state?.title === 'string' && state.title)
    || fallback
}

function createPlan(metadata, indexTitles, legacyBySource, ledger, only) {
  const sources = new Map()
  const legacyById = new Map()
  for (const legacy of legacyBySource.values()) {
    const id = sourceIdFromPath(legacy.sourcePath) || legacy.dshId.match(UUID_RE)?.[1]?.toLowerCase()
    if (id) legacyById.set(id, legacy)
  }
  for (const row of metadata.state.values()) {
    if (Number(row.archived) !== 0 || !row.rollout_path) continue
    sources.set(String(row.id).toLowerCase(), { id: String(row.id).toLowerCase(), sourcePath: resolve(row.rollout_path), state: row })
  }
  for (const legacy of legacyBySource.values()) {
    const id = sourceIdFromPath(legacy.sourcePath) || legacy.dshId.match(UUID_RE)?.[1]?.toLowerCase()
    if (!id) continue
    const state = metadata.state.get(id)
    if (state && Number(state.archived) !== 0) continue
    if (!sources.has(id)) sources.set(id, { id, sourcePath: legacy.sourcePath, state: metadata.state.get(id) })
  }
  for (const [id, entry] of Object.entries(ledger.sessions ?? {})) {
    const state = metadata.state.get(id)
    if (state && Number(state.archived) !== 0) continue
    if (!sources.has(id) && entry.sourcePath) sources.set(id, { id, sourcePath: resolve(entry.sourcePath), state })
  }
  const list = []
  for (const item of sources.values()) {
    if (only && item.id !== only.toLowerCase()) continue
    item.legacy = legacyBySource.get(resolve(item.sourcePath)) ?? legacyById.get(item.id) ?? null
    item.title = titleFor(item.id, metadata, indexTitles)
    item.bogus = isApprovalTranscript(item.state?.title)
    list.push(item)
  }
  return list.sort((a, b) => a.id.localeCompare(b.id))
}

async function moveDirToBackup(dir, backupRoot, category) {
  if (!dir || !existsSync(dir)) return null
  const target = join(backupRoot, category, `${basename(dir)}-${randomBytes(3).toString('hex')}`)
  await mkdir(dirname(target), { recursive: true })
  await rename(dir, target)
  return target
}

async function publishArtifact(path, buffer, backupRoot, label) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, buffer, { flag: 'wx' })
  let oldPath = null
  if (existsSync(path)) {
    oldPath = join(backupRoot, 'replaced-canonical', `${label}-${randomBytes(3).toString('hex')}.jsonl.zstd`)
    await mkdir(dirname(oldPath), { recursive: true })
    await rename(path, oldPath)
  }
  try {
    await rename(tmp, path)
  } catch (error) {
    if (oldPath && !existsSync(path) && existsSync(oldPath)) await rename(oldPath, path)
    await rm(tmp, { force: true })
    throw error
  }
}

function canonicalFromConverted(converted, id, title, sourcePath, time) {
  if (!converted.events?.length) return null
  const exactTitle = title || converted.title || firstUserText(converted.events)
  let events = appendTitle(converted.events, exactTitle, time)
  events = appendSeedTail(events, time)
  const header = {
    version: 0,
    id,
    createdAt: converted.meta.createdAt,
    ...(converted.meta.cwd !== undefined ? { cwd: converted.meta.cwd } : {}),
    delegationDepth: 0,
  }
  return { header, events, title: exactTitle, sourcePath }
}

function canonicalFromLegacy(decoded, id, title, legacyRecord, time) {
  const modified = legacyWasModified(decoded.events, Number(legacyRecord?.events))
  const baseEvents = modified
    ? decoded.events.slice(0, Number(legacyRecord.events))
    : decoded.events
  const exactTitle = title || latestTitle(baseEvents) || firstUserText(baseEvents)
  let events = appendTitle(baseEvents, exactTitle, time)
  if (modified) events = appendSeedTail(events, time)
  return {
    modified,
    canonical: {
      header: { ...decoded.header, id },
      events,
      title: exactTitle,
    },
  }
}

async function ensureHash(session) {
  if (!session) return null
  if (!session.hash) session.hash = sha256(await readFile(session.path))
  return session.hash
}

async function pruneRedundantBranches(ledger, sessionsRoot, backupRoot) {
  const sessions = await scanDshSessions(sessionsRoot)
  const survivors = []
  let pruned = 0
  for (const record of ledger.branches ?? []) {
    const branch = sessions.get(record.branchId)
    if (!branch) continue
    const canonical = sessions.get(record.sourceId)
    if (!canonical) {
      survivors.push(record)
      continue
    }
    const [branchDecoded, canonicalDecoded] = await Promise.all([
      readFile(branch.path).then(decodeArtifact),
      readFile(canonical.path).then(decodeArtifact),
    ])
    const importedOnly = !hasNativeDialogue(branchDecoded.events, record.sourceId)
    if (!importedOnly && !isRedundantBranch(branchDecoded.events, canonicalDecoded.events)) {
      survivors.push(record)
      continue
    }
    await moveDirToBackup(branch.dir, backupRoot, 'redundant-branches')
    pruned++
  }
  ledger.branches = survivors
  return pruned
}

async function execute(options) {
  const userHome = homedir()
  const codexRoot = options.codexRoot ?? join(userHome, '.codex')
  const dshHome = options.dshHome ?? join(userHome, '.dsh')
  const sessionsRoot = join(dshHome, 'sessions')
  const syncRoot = join(dshHome, 'codex-oneway-sync')
  const ledgerPath = join(syncRoot, 'ledger.json')
  const workspaceExclusionsPath = join(syncRoot, 'workspace-exclusions.json')
  const legacyRegistryPath = join(dshHome, 'dsh-chat-import', 'imports.json')
  const budget = Number.isFinite(options.budget) ? options.budget : DEFAULT_BUDGET
  const runId = `${branchStamp()}-${randomBytes(3).toString('hex')}`
  const backupRoot = join(syncRoot, 'backups', runId)

  const [metadata, indexTitles, legacyData, ledger, workspaceExclusions, dshSessions] = await Promise.all([
    Promise.resolve(loadCodexMetadata(codexRoot)),
    loadSessionIndex(codexRoot),
    readJson(legacyRegistryPath, { version: 1, imports: {} }),
    readJson(ledgerPath, { version: 2, sessions: {}, branches: [], lastRun: null }),
    readJson(workspaceExclusionsPath, { version: 1, paths: [] }),
    scanDshSessions(sessionsRoot),
  ])
  const excludedWorkspacePaths = new Set(
    (Array.isArray(workspaceExclusions?.paths) ? workspaceExclusions.paths : [])
      .map(pathKey)
      .filter(Boolean),
  )
  const legacyBySource = loadLegacyImports(legacyData)
  const plan = createPlan(metadata, indexTitles, legacyBySource, ledger, options.only)
  const counters = {
    considered: plan.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    migrated: 0,
    branched: 0,
    redundantBranchesPruned: 0,
    testSessionsRemoved: 0,
    missingSources: 0,
    failed: 0,
  }

  console.log(`${options.apply ? '开始同步' : '只读预检'}：${plan.length} 个 Codex 会话候选`)
  const log = (...args) => { if (!options.quiet) console.log(...args) }
  const nextLedger = structuredClone(ledger)
  nextLedger.version = 2
  nextLedger.sessions ??= {}
  nextLedger.branches ??= []
  const archivedSessionIds = new Set(
    [...metadata.state.values()]
      .filter((row) => Number(row.archived) !== 0)
      .map((row) => String(row.id)),
  )
  for (const id of archivedSessionIds) delete nextLedger.sessions[id]

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]
    const prefix = `[${i + 1}/${plan.length}] ${item.id}`
    const legacySession = item.legacy ? dshSessions.get(item.legacy.dshId) : null
    const canonicalSession = dshSessions.get(item.id)
    try {
      if (item.bogus) {
        log(`${prefix}：测试/审批会话，${options.apply ? '移出同步结果' : '将移出同步结果'}`)
        if (options.apply) {
          if (legacySession) await moveDirToBackup(legacySession.dir, backupRoot, 'deleted-test-sessions')
          if (canonicalSession) await moveDirToBackup(canonicalSession.dir, backupRoot, 'deleted-test-sessions')
          delete nextLedger.sessions[item.id]
        }
        counters.testSessionsRemoved++
        continue
      }

      const info = await sourceInfo(item.sourcePath)
      if (!info) counters.missingSources++
      const previous = nextLedger.sessions[item.id]
      const sourceLooksUnchanged = previous
        && info
        && previous.sourceSize === info.size
        && previous.sourceMtimeNs === info.mtimeNs
      const currentHash = canonicalSession ? await ensureHash(canonicalSession) : null
      let benignRuntimeTail = false
      if (previous && canonicalSession && currentHash && previous.dshHash !== currentHash) {
        const decoded = decodeArtifact(await readFile(canonicalSession.path))
        benignRuntimeTail = hasOnlyBenignRuntimeTail(decoded.events, Number(previous.eventCount))
      }
      const dshLooksUnchanged = previous
        && currentHash
        && (previous.dshHash === currentHash || benignRuntimeTail)
      const titleLooksUnchanged = previous && previous.title === item.title

      if (sourceLooksUnchanged && dshLooksUnchanged && titleLooksUnchanged && !legacySession) {
        counters.unchanged++
        if (options.verify) {
          const decoded = decodeArtifact(await readFile(canonicalSession.path))
          if (decoded.header.id !== item.id || latestTitle(decoded.events) !== item.title) {
            throw new Error('校验失败：会话 ID 或标题与 Codex 不一致')
          }
        }
        log(`${prefix}：无变化`)
        continue
      }

      let legacyDecoded = null
      let canonical = null
      let sourceRead = null
      if (legacySession) {
        legacyDecoded = decodeArtifact(await readFile(legacySession.path))
        if (!item.title) item.title = titleFor(item.id, metadata, indexTitles, firstUserText(legacyDecoded.events))
        if (isApprovalTranscript(firstUserText(legacyDecoded.events))) {
          log(`${prefix}：测试/审批会话，${options.apply ? '移出同步结果' : '将移出同步结果'}`)
          if (options.apply) await moveDirToBackup(legacySession.dir, backupRoot, 'deleted-test-sessions')
          counters.testSessionsRemoved++
          delete nextLedger.sessions[item.id]
          continue
        }
      }

      let legacyModified = legacyDecoded
        ? legacyWasModified(legacyDecoded.events, Number(item.legacy?.events))
        : false
      const canReuseLegacy = legacyDecoded
        && (!info || sourceUnchangedFromLegacy(info, item.legacy))
      if (canReuseLegacy) {
        const result = canonicalFromLegacy(legacyDecoded, item.id, item.title, item.legacy, Date.now())
        legacyModified = result.modified
        canonical = result.canonical
      } else if (info) {
        sourceRead = await stableRead(item.sourcePath)
        const converted = convertCodexJsonl(sourceRead.raw.toString('utf8'), {
          sessionId: item.id,
          sourcePath: item.sourcePath,
          budget,
        })
        if (!item.title) item.title = titleFor(item.id, metadata, indexTitles, converted.title)
        if (isApprovalTranscript(firstUserText(converted.events))) {
          log(`${prefix}：测试/审批会话，${options.apply ? '移出同步结果' : '将移出同步结果'}`)
          if (options.apply) {
            if (legacySession) await moveDirToBackup(legacySession.dir, backupRoot, 'deleted-test-sessions')
            if (canonicalSession) await moveDirToBackup(canonicalSession.dir, backupRoot, 'deleted-test-sessions')
          }
          counters.testSessionsRemoved++
          delete nextLedger.sessions[item.id]
          continue
        }
        canonical = canonicalFromConverted(converted, item.id, item.title, item.sourcePath, Date.now())
      } else if (legacyDecoded) {
        const result = canonicalFromLegacy(legacyDecoded, item.id, item.title, item.legacy, Date.now())
        legacyModified = result.modified
        canonical = result.canonical
      } else {
        log(`${prefix}：源文件不存在，保留现状`)
        continue
      }
      if (!canonical) {
        log(`${prefix}：没有可导入的人类对话，跳过`)
        continue
      }
      canonical.header.cwd = await usableSessionCwd(canonical.header.cwd, codexRoot)

      let conflictDecoded = null
      if (canonicalSession && (!previous || !dshLooksUnchanged)) {
        const existing = decodeArtifact(await readFile(canonicalSession.path))
        if (hasNativeDialogue(existing.events, item.id)) conflictDecoded = existing
      } else if (legacyModified) {
        conflictDecoded = legacyDecoded
      }

      if (!options.apply) {
        const action = canonicalSession ? '更新' : legacySession ? '迁移' : '新建'
        log(`${prefix}：将${action}${conflictDecoded ? '，并保留分支' : ''}；标题《${canonical.title}》`)
        if (conflictDecoded) counters.branched++
        if (legacySession) counters.migrated++
        else if (canonicalSession) counters.updated++
        else counters.created++
        continue
      }

      if (conflictDecoded) {
        const branch = makeBranch(conflictDecoded, item.id, canonical.title)
        const branchPath = sessionLogPath(sessionsRoot, branch.header.cwd, branch.id)
        const branchBuffer = encodeArtifact(branch.header, branch.events)
        await publishArtifact(branchPath, branchBuffer, backupRoot, branch.id)
        nextLedger.branches.push({ sourceId: item.id, branchId: branch.id, createdAt: Date.now() })
        counters.branched++
      }

      const canonicalBuffer = encodeArtifact(canonical.header, canonical.events)
      const targetPath = sessionLogPath(sessionsRoot, canonical.header.cwd, item.id)
      await publishArtifact(targetPath, canonicalBuffer, backupRoot, item.id)
      if (canonicalSession && canonicalSession.path !== targetPath) {
        await moveDirToBackup(canonicalSession.dir, backupRoot, 'moved-canonical-sessions')
      }
      if (legacySession && legacySession.dir !== dirname(targetPath)) {
        await moveDirToBackup(legacySession.dir, backupRoot, 'legacy-import-sessions')
      }

      const finalSource = sourceRead ?? info
      nextLedger.sessions[item.id] = {
        sourcePath: item.sourcePath,
        sourceSize: finalSource?.size ?? null,
        sourceMtimeNs: finalSource?.mtimeNs ?? null,
        sourceSha256: sourceRead?.sha256 ?? previous?.sourceSha256 ?? null,
        dshPath: targetPath,
        dshHash: sha256(canonicalBuffer),
        title: canonical.title,
        eventCount: canonical.events.length,
        syncedAt: Date.now(),
      }
      if (legacySession) counters.migrated++
      else if (canonicalSession) counters.updated++
      else counters.created++
      log(`${prefix}：完成；标题《${canonical.title}》${conflictDecoded ? '；已保留分支' : ''}`)
    } catch (error) {
      counters.failed++
      console.error(`${prefix}：失败：${error.message}`)
    }
  }

  if (options.apply) {
    if (options.pruneRedundantBranches) {
      counters.redundantBranchesPruned = await pruneRedundantBranches(
        nextLedger,
        sessionsRoot,
        backupRoot,
      )
    }
    const archivedSessions = await archiveExcludedCodexSessions(
      dshSessions,
      metadata,
      excludedWorkspacePaths,
      syncRoot,
    )
    const detachedCwd = join(dshHome, 'detached-workspace')
    await mkdir(detachedCwd, { recursive: true })
    const preferredCwds = new Map(
      [...metadata.state.values()].map((row) => [String(row.id), row.cwd]),
    )
    const relocatedInvalidCwds = await relocateUnusableLedgerSessions(
      nextLedger,
      sessionsRoot,
      detachedCwd,
      backupRoot,
      preferredCwds,
      excludedWorkspacePaths,
    )
    const workspace = await prepareWorkspaceRebuild(
      dshHome,
      backupRoot,
      archivedSessionIds,
      excludedWorkspacePaths,
    )
    const projectionCache = await refreshProjectionCache(dshHome, backupRoot, archivedSessionIds)
    nextLedger.lastRun = { runId, finishedAt: Date.now(), counters }
    nextLedger.lastRun.archivedSessions = archivedSessions
    nextLedger.lastRun.relocatedInvalidCwds = relocatedInvalidCwds
    nextLedger.lastRun.workspaceRegistry = workspace
    nextLedger.lastRun.projectionCache = projectionCache
    await writeJsonAtomic(ledgerPath, nextLedger)
    if (existsSync(legacyRegistryPath) && !options.only) {
      await mkdir(join(backupRoot, 'legacy-import-registry'), { recursive: true })
      await copyFile(legacyRegistryPath, join(backupRoot, 'legacy-import-registry', 'imports.json'))
      await writeJsonAtomic(legacyRegistryPath, { version: 1, imports: {} })
    }
  }

  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', counters, backupRoot: options.apply ? backupRoot : null }, null, 2))
  if (counters.failed > 0) process.exitCode = 1
  return { counters, backupRoot, ledgerPath }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  execute(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

export { execute }
