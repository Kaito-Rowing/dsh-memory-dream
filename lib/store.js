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
import { hostname } from 'node:os'

const STALE_LOCK_MS = 30_000
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

/**
 * Override the lock timings for tests.
 *
 * The defaults are tuned for a real machine: five seconds is long enough to
 * ride out a slow writer and short enough that a wedged lock does not stall a
 * turn. A test that has to wait five seconds to observe the timeout would make
 * the suite slow enough that people stop running it.
 */
export const __lockTiming = {
  staleMs: STALE_LOCK_MS,
  retryMs: LOCK_RETRY_MS,
  timeoutMs: LOCK_TIMEOUT_MS,
}

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
 * Two layers, with different guarantees:
 *
 *  - The in-process mutex is exact. Two calls in one process never overlap.
 *  - The lock file is best-effort coordination between processes. It cannot be
 *    made reliable without a real advisory-lock API, and pretending otherwise
 *    would be worse than saying so.
 *
 * When the lock file cannot be acquired, the write still proceeds: the
 * in-process mutex already covers the common case, and refusing to save a
 * memory because a stale lock file exists would lose data to protect against a
 * race that may not exist. The degradation is reported through `onDegraded`
 * so the caller can surface it rather than swallowing it.
 */
export async function withLock(root, fn, { onDegraded } = {}) {
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
  let degraded = null
  try {
    degraded = await acquireFileLock(root)
    if (degraded && typeof onDegraded === 'function') {
      try {
        onDegraded(degraded)
      } catch {
        // A reporting failure must not fail the write.
      }
    }
    return await fn()
  } finally {
    if (!degraded) await releaseFileLock(root)
    release()
    if (inProcess.get(root) === current) inProcess.delete(root)
  }
}

function lockPath(root) {
  return join(root, '.state', 'write.lock')
}

/**
 * Acquire the cross-process lock.
 *
 * @returns {Promise<null | {reason: string, ageMs?: number}>} null on success,
 *   or a description of why the lock was not taken. A non-null return means the
 *   caller is proceeding without cross-process exclusion.
 */
async function acquireFileLock(root) {
  const file = lockPath(root)
  await mkdir(dirname(file), { recursive: true })
  const deadline = Date.now() + __lockTiming.timeoutMs
  let lastAge = 0

  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }),
        'utf8',
      )
      await handle.close()
      return null
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // A directory we cannot write to is a real failure, not a lock race.
        return { reason: `lock file unusable: ${err?.code ?? 'unknown'}` }
      }
    }

    // Lock exists. Break it if it is stale.
    try {
      const info = await stat(file)
      lastAge = Date.now() - info.mtimeMs
      if (lastAge > __lockTiming.staleMs) {
        await unlink(file).catch(() => {})
        continue
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
    }

    if (Date.now() > deadline) {
      return {
        reason: 'another process holds the lock',
        ageMs: lastAge,
      }
    }
    await sleep(__lockTiming.retryMs)
  }
}

async function releaseFileLock(root) {
  await unlink(lockPath(root)).catch(() => {})
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
