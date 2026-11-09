/**
 * Durable file primitives.
 *
 * Two properties matter here and neither is free:
 *
 *  1. A crash mid-write must not truncate an existing file. Writes go to a
 *     temp file in the same directory and are renamed into place, which is
 *     atomic on both POSIX and Windows for same-volume renames.
 *
 *  2. Two writers must not interleave. Each memory root gets one in-process
 *     mutex; a cross-process lock file covers the case where two DSH profiles
 *     share a home. The lock is advisory and best-effort: a stale lock older
 *     than `STALE_LOCK_MS` is broken rather than blocking forever.
 */

import { readFile, writeFile, rename, unlink, mkdir, open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const STALE_LOCK_MS = 30_000
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

/** Read a text file, returning `fallback` when it does not exist. */
export async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return fallback
    throw err
  }
}

/** Write a text file atomically: temp file in the same directory, then rename. */
export async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basenameSafe(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** Append text, creating the file if needed. */
export async function appendText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(file, 'a')
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
}

function basenameSafe(file) {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || 'file'
}

// ---------------------------------------------------------------- locking

const inProcess = new Map()

/**
 * Run `fn` while holding the lock for `root`.
 *
 * In-process serialization is exact. The lock file is best-effort: it stops
 * the common case of two processes writing at once, and a lock left behind by
 * a killed process is broken after `STALE_LOCK_MS` instead of wedging the
 * plugin.
 */
export async function withLock(root, fn) {
  const previous = inProcess.get(root) ?? Promise.resolve()
  let release
  const current = new Promise((r) => {
    release = r
  })
  inProcess.set(
    root,
    previous.then(() => current),
  )

  await previous
  try {
    await acquireFileLock(root)
    try {
      return await fn()
    } finally {
      await releaseFileLock(root)
    }
  } finally {
    release()
    if (inProcess.get(root) === current) inProcess.delete(root)
  }
}

function lockPath(root) {
  return join(root, '.state', 'write.lock')
}

async function acquireFileLock(root) {
  const file = lockPath(root)
  await mkdir(dirname(file), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
      await handle.close()
      return
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err
    }

    // Lock exists. Break it if it is stale.
    try {
      const info = await stat(file)
      if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await unlink(file).catch(() => {})
        continue
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
    }

    if (Date.now() > deadline) {
      // Do not fail the write because of a lock we cannot clear. The caller
      // still has the in-process mutex, which covers the common case.
      return
    }
    await sleep(LOCK_RETRY_MS)
  }
}

async function releaseFileLock(root) {
  await unlink(lockPath(root)).catch(() => {})
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
