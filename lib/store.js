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

import { readFile, writeFile, rename, unlink, mkdir, open, stat, link } from 'node:fs/promises'
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
 * When the lock file cannot be acquired, the mutation **fails** with
 * `LockBusyError`. Proceeding unprotected was the earlier behaviour and it
 * could lose an update: two writers read the same MEMORY.md, and the second
 * rename silently reverted the first. A caller that cannot write now gets an
 * error it can retry, which is recoverable; a lost entry is not.
 *
 * The two excuses for the old behaviour are gone: a lock whose owner is a
 * dead local process is broken at once, and `onDegraded` still reports the
 * refusal for `memory_status`.
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
  let token = null
  try {
    const acquired = await acquireFileLock(root)
    degraded = acquired.degraded
    token = acquired.token
    if (degraded) {
      if (typeof onDegraded === 'function') {
        try {
          onDegraded(degraded)
        } catch {
          // A reporting failure must not mask the refusal.
        }
      }
      throw new LockBusyError(degraded)
    }
    return await fn()
  } finally {
    if (!degraded) await releaseFileLock(root, token)
    release()
    if (inProcess.get(root) === current) inProcess.delete(root)
  }
}

/** Raised when the cross-process lock could not be taken. */
export class LockBusyError extends Error {
  constructor(info) {
    super(
      `another process holds the memory lock (${info?.reason ?? 'unknown'}); ` +
        'nothing was written — retry once it releases',
    )
    this.name = 'LockBusyError'
    this.code = 'LOCK_BUSY'
    this.reason = info?.reason ?? null
    this.ageMs = info?.ageMs ?? null
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
    // The token identifies *this* acquisition, so release can tell its own
    // lock from a successor's and never unlink someone else's.
    const token = randomBytes(12).toString('hex')
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token }),
        'utf8',
      )
      await handle.close()
      return { degraded: null, token }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // A directory we cannot write to is a real failure, not a lock race.
        return { degraded: { reason: `lock file unusable: ${err?.code ?? 'unknown'}` }, token: null }
      }
    }

    const owner = await readLockOwner(file)
    const localOwner =
      owner && owner.host === hostname() && Number.isInteger(owner.pid) ? owner.pid : null

    // A lock whose local owner is gone is broken at once: its pid is
    // checkable, so this is proof, not a guess.
    if (localOwner !== null && localOwner !== process.pid && !pidAlive(localOwner)) {
      await unlink(file).catch(() => {})
      continue
    }

    try {
      const info = await stat(file)
      lastAge = Date.now() - info.mtimeMs
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
    }

    // Age alone is not proof of death. A writer on another host may be alive
    // and simply slow, and stealing its lock puts two writers in the critical
    // section at once. Refuse instead, and name the file so it can be removed
    // by hand if that host really is gone.
    if (owner && owner.host && owner.host !== hostname()) {
      if (lastAge > __lockTiming.staleMs) {
        return {
          degraded: {
            reason:
              `lock held by another host (${owner.host}, pid ${owner.pid}); ` +
              'its liveness cannot be checked from here',
            ageMs: lastAge,
            lockFile: file,
          },
          token: null,
        }
      }
    } else if (!owner && lastAge > __lockTiming.staleMs) {
      // Unreadable and old: a crash artifact rather than a live writer, which
      // would have written the owner record within milliseconds of creating
      // the file.
      await unlink(file).catch(() => {})
      continue
    }

    if (Date.now() > deadline) {
      return {
        degraded: { reason: 'another process holds the lock', ageMs: lastAge, lockFile: file },
        token: null,
      }
    }
    await sleep(__lockTiming.retryMs)
  }
}

/** The owner recorded in a lock file, or null when it cannot be read. */
async function readLockOwner(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** True when a process with that pid exists (EPERM means it exists but is not ours). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Release the lock, but only if it is still ours.
 *
 * The pathname can be replaced while a slow writer holds it (a lock broken by
 * hand, a filesystem that lost a rename). Unlinking unconditionally would then
 * delete the *successor's* lock and let a third writer in.
 */
async function releaseFileLock(root, token) {
  const file = lockPath(root)
  if (!token) return
  const owner = await readLockOwner(file)
  if (owner && owner.token && owner.token !== token) return
  await unlink(file).catch(() => {})
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
