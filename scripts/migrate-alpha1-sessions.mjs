import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { decodeArtifact, encodeArtifact, migrateImportedSessionEvents } from '../sync/sync.mjs'

function parseArgs(argv) {
  const result = { apply: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--apply') result.apply = true
    else if (arg === '--dsh-home') result.dshHome = resolve(argv[++index])
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!result.dshHome) throw new Error('--dsh-home is required')
  return result
}

async function sessionLogs(root) {
  const result = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') result.push(path)
    }
  }
  return result.sort()
}

async function replaceAtomic(path, buffer) {
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}`
  const temporary = `${path}.${suffix}.tmp`
  const previous = `${path}.${suffix}.previous`
  await writeFile(temporary, buffer, { flag: 'wx' })
  await rename(path, previous)
  try {
    await rename(temporary, path)
    await rm(previous, { force: true })
  } catch (error) {
    if (!existsSync(path) && existsSync(previous)) await rename(previous, path)
    await rm(temporary, { force: true })
    throw error
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sessionsRoot = join(options.dshHome, 'sessions')
  const syncRoot = join(options.dshHome, 'codex-oneway-sync')
  const ledgerPath = join(syncRoot, 'ledger.json')
  const runId = `alpha1-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  const backupRoot = join(syncRoot, 'backups', runId, 'session-logs')
  const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, 'utf8')) : null
  const ledgerByPath = new Map(Object.values(ledger?.sessions ?? {}).map((entry) => [resolve(entry.dshPath), entry]))
  const files = await sessionLogs(sessionsRoot)
  const pending = []
  for (const path of files) {
    const original = await readFile(path)
    const decoded = decodeArtifact(original)
    const migration = migrateImportedSessionEvents(decoded.events)
    if (!migration.changed) continue
    const replacement = encodeArtifact(decoded.header, migration.events)
    const verified = decodeArtifact(replacement)
    if (!isDeepStrictEqual(verified.header, decoded.header) || !isDeepStrictEqual(verified.events, migration.events)) {
      throw new Error(`round-trip verification failed: ${path}`)
    }
    pending.push({ path, original, replacement, eventCount: migration.events.length, provenance: migration.provenance })
  }

  if (options.apply && pending.length > 0) {
    for (const item of pending) {
      const backupPath = join(backupRoot, relative(sessionsRoot, item.path))
      await mkdir(dirname(backupPath), { recursive: true })
      await copyFile(item.path, backupPath)
      await replaceAtomic(item.path, item.replacement)
      const entry = ledgerByPath.get(resolve(item.path))
      if (entry) {
        entry.dshHash = sha256(item.replacement)
        entry.eventCount = item.eventCount
        entry.syncedAt = Date.now()
        entry.sessionEventFormat = 'dsh-0.1.2-alpha.1'
      }
    }
    if (ledger) {
      const ledgerBackup = join(backupRoot, '..', 'ledger.json')
      await mkdir(dirname(ledgerBackup), { recursive: true })
      await copyFile(ledgerPath, ledgerBackup)
      await replaceAtomic(ledgerPath, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`))
    }
    await writeFile(join(backupRoot, '..', 'migration-report.json'), `${JSON.stringify({
      schemaVersion: 1,
      migratedAt: new Date().toISOString(),
      count: pending.length,
      sessions: pending.map((item) => ({ path: item.path, provenance: item.provenance })),
    }, null, 2)}\n`)
  }

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: files.length,
    affected: pending.length,
    backupRoot: options.apply && pending.length > 0 ? resolve(backupRoot, '..') : null,
  }, null, 2))
}

main().catch((error) => {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
})
