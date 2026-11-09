#!/usr/bin/env node
/**
 * Rewrite one session's header `cwd` so it can be resumed on another machine.
 *
 * The header is the first JSONL record and carries the absolute working
 * directory the session was created in. A session moved to a machine where
 * that path does not exist cannot be resumed: the loop refuses a session whose
 * recorded cwd is missing. Rewriting the header is the minimum change that
 * makes the log resumable, and it touches only that field.
 *
 * The physical format matters: DSH validates that the **first zstd frame
 * contains exactly one line** — the header — and refuses the log otherwise.
 * So the output is written as two frames: the header alone, then the body.
 *
 * Usage: node migrate-session.mjs <src.zstd> <dst.zstd> <newCwd>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zlib = require('node:zlib')

const [src, dst, newCwd] = process.argv.slice(2)
if (!src || !dst || !newCwd) {
  console.error('usage: migrate-session.mjs <src> <dst> <newCwd>')
  process.exit(1)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a multi-frame zstd buffer into frame boundaries. */
function frames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  return starts
}

const buf = readFileSync(src)
const starts = frames(buf)
if (starts.length === 0) {
  console.error('no zstd frames found')
  process.exit(1)
}

const texts = []
for (let k = 0; k < starts.length; k++) {
  const s = starts[k]
  const e = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    texts.push(zlib.zstdDecompressSync(buf.subarray(s, e)))
  } catch {
    // A torn tail is expected on a live session; drop it.
  }
}

const text = Buffer.concat(texts).toString('utf8')
const lines = text.split('\n').filter(Boolean)
if (lines.length === 0) {
  console.error('empty log')
  process.exit(1)
}

const header = JSON.parse(lines[0])
if (header.type !== 'session') {
  console.error(`first record is ${header.type}, expected session`)
  process.exit(1)
}

const before = header.cwd
header.cwd = newCwd

// Two frames: the header line alone, then every remaining line. The reader
// concatenates frames, and DSH's header validation requires the first frame to
// hold exactly one line.
const headerFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))
const bodyText = lines.slice(1).join('\n') + (lines.length > 1 ? '\n' : '')
const bodyFrame = bodyText
  ? zlib.zstdCompressSync(Buffer.from(bodyText, 'utf8'))
  : Buffer.alloc(0)

const out = Buffer.concat([headerFrame, bodyFrame])
mkdirSync(dirname(dst), { recursive: true })
writeFileSync(dst, out)

console.log(JSON.stringify({
  events: lines.length,
  cwdBefore: before,
  cwdAfter: newCwd,
  frames: bodyFrame.length ? 2 : 1,
  srcBytes: buf.length,
  dstBytes: out.length,
}))
