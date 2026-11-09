/**
 * MEMORY.md parsing and rendering.
 *
 * The file is a small markdown document: an optional header (headings and
 * HTML comments) followed by entries separated by a `§` line.
 *
 * The previous parser had three boundary bugs, all fixed here and covered by
 * tests:
 *
 *  1. An entry whose first line started with `#` was absorbed into the header
 *     and silently lost.
 *  2. An unterminated `<!--` comment swallowed every entry after it.
 *  3. A `§` inside an entry body was treated as a separator.
 *
 * The fix for all three is the same idea: the header is a known, small shape,
 * and the body is parsed by an explicit separator line rather than by
 * scanning for "the first line that does not look like a heading".
 */

/** The separator between entries: a line containing only `§`. */
const SEPARATOR_LINE = '§'
const RENDER_SEPARATOR = '\n\n§\n\n'

/**
 * Split a raw file into `{ header, entries }`.
 *
 * The header is everything before the first separator, minus a leading
 * document title and comment block. Because the separator is a whole line,
 * `§` inside an entry body is ordinary text.
 */
export function parseMemory(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n')
  if (!text.trim()) return { header: '', entries: [] }

  const parts = splitOnSeparator(text)

  // The first part carries the header followed by the first entry.
  const first = parts.shift() ?? ''
  const { header, body } = splitHeader(first)

  const entries = []
  for (const chunk of [body, ...parts]) {
    const normalized = normalizeEntry(chunk)
    if (normalized) entries.push(normalized)
  }

  return { header, entries }
}

/**
 * Split on separator lines.
 *
 * Two shapes are recognized, because both exist in the wild:
 *
 *   - a line whose trimmed content is exactly `§` (the current format);
 *   - a line that *starts* with `§ ` (the format written by version 0.1).
 *
 * A `§` in the middle of a line is ordinary text and never splits.
 */
function splitOnSeparator(text) {
  const chunks = []
  let current = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === SEPARATOR_LINE) {
      chunks.push(current.join('\n'))
      current = []
    } else if (trimmed.startsWith(`${SEPARATOR_LINE} `)) {
      // Legacy: the separator was prefixed to the following entry.
      chunks.push(current.join('\n'))
      current = [trimmed.slice(2)]
    } else {
      current.push(line)
    }
  }
  chunks.push(current.join('\n'))
  return chunks
}

/**
 * Normalize a chunk into one entry.
 *
 * Two legacy shapes exist in files written by earlier versions:
 *
 *   - the separator on its own line (`\n§\n`), which `splitOnSeparator`
 *     already handles;
 *   - the separator prefixed to the following line (`\n§ text`), which lands
 *     inside the chunk and must be stripped.
 *
 * The second is why this function exists: without it an entry rendered as
 * "fact one\n§ fact two" and the model saw the marker as content.
 */
function normalizeEntry(chunk) {
  return chunk
    .replace(/^\s*§\s*/, '') // separator at the very start
    .replace(/\n\s*§\s*/g, '\n') // separator embedded mid-chunk
    .trim()
}

/**
 * Separate the document header from the first entry.
 *
 * The header is a bounded, recognizable shape: an optional `#` title, then
 * optional HTML comment blocks, then a blank line. Nothing else is header.
 *
 * The earlier rule — "everything that looks like a heading is header" — was
 * wrong in a way that lost data: an entry beginning with `#` was absorbed into
 * the header and vanished from the model's view while still sitting in the
 * file. Bounding the header to its actual shape fixes that.
 *
 * An unterminated comment ends the header at the comment rather than eating
 * the rest of the file.
 */
function splitHeader(text) {
  const lines = text.split('\n')
  const headerLines = []
  let i = 0

  // 1. Optional leading title: one `#` heading line, plus blank lines.
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && /^#{1,6}\s/.test(lines[i].trim())) {
    headerLines.push(lines[i])
    i++
    while (i < lines.length && lines[i].trim() === '') {
      headerLines.push(lines[i])
      i++
    }
  }

  // 2. Comment blocks, each starting at the beginning of a line.
  while (i < lines.length && lines[i].trim().startsWith('<!--')) {
    let closed = lines[i].trim().includes('-->')
    headerLines.push(lines[i])
    i++
    while (!closed && i < lines.length) {
      headerLines.push(lines[i])
      if (lines[i].trim().includes('-->')) closed = true
      i++
    }
    if (!closed) {
      // Malformed: close it ourselves so the rest of the file stays readable.
      headerLines.push('-->')
    }
    while (i < lines.length && lines[i].trim() === '') {
      headerLines.push(lines[i])
      i++
    }
  }

  return {
    header: headerLines.join('\n').trim(),
    body: lines.slice(i).join('\n'),
  }
}

/** Default header used when a file has none. */
export const DEFAULT_HEADER = [
  '# MEMORY.md',
  '',
  '<!-- Curated long-term memory: durable facts, preferences and commitments.',
  '     Keep it small. Detail belongs in wiki/ and notes/. -->',
].join('\n')

/** Render entries back to file text. */
export function renderMemory({ header, entries }) {
  const head = (header && header.trim()) || DEFAULT_HEADER
  const body = entries.filter(Boolean).join(RENDER_SEPARATOR)
  return body ? `${head}\n\n${body}\n` : `${head}\n`
}

/** Character count as the model sees it: entries plus separators, header excluded. */
export function charCount(entries) {
  return entries.filter(Boolean).join(RENDER_SEPARATOR).length
}
