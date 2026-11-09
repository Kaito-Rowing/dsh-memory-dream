/**
 * Injection scanning for memory read back into the prompt.
 *
 * The threat is specific: memory is written by the agent and read by the
 * agent on later turns. Anything that reaches MEMORY.md from an untrusted
 * source (a web page, a tool result, another agent) becomes an instruction to
 * the future self.
 *
 * Design constraints, in tension with each other:
 *
 *  - A false positive that hides a real memory is worse than no scanner. The
 *    agent loses a fact it wrote down and does not know why.
 *  - A false negative is invisible. Nothing tells you the scanner should have
 *    caught something.
 *
 * The resolution here is to make the scanner's *output* recoverable rather
 * than to make its judgement perfect. A hit does not delete the entry or hide
 * it silently: the entry is replaced by a marker that names the pattern and
 * tells the agent how to see the original. The original text is never lost —
 * it is still in the file — and `memory_audit` can show it.
 *
 * The scanner is deliberately narrow. It looks for the shapes that only make
 * sense as an attack, not for words that are merely suspicious. "Ignore
 * previous instructions" is an attack; "the article discussed prompt
 * injection" is a note about one.
 */

/**
 * Patterns, each with an id used in the marker and in `memory_audit` output.
 *
 * `severity: 'block'` replaces the entry. `severity: 'flag'` leaves the text
 * alone and only reports it, because the shape is ambiguous enough that
 * hiding it would cost more than it saves.
 */
const PATTERNS = [
  // --- instruction override: unambiguous, block ---
  {
    id: 'override',
    severity: 'block',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)/i,
  },
  {
    id: 'override-ja',
    severity: 'block',
    // Imperative forms only. The earlier pattern matched the bare stem, so a
    // normal note like 「以前の設定を忘れて再設定した」 ("I forgot the previous
    // settings and reconfigured") was blocked and the entry disappeared from
    // the agent's view. A descriptive past tense is not an instruction.
    re: /(?:これまで|前述|上記|以前|先)の?(?:指示|命令|ルール|プロンプト|設定)を(?:無視(?:しろ|して(?:ください)?|せよ)|忘れ(?:ろ|てください|なさい)|捨て(?:ろ|てください|なさい)|破棄(?:しろ|して(?:ください)?|せよ))/,
  },

  // --- role reassignment: unambiguous, block ---
  {
    id: 'role',
    severity: 'block',
    re: /\b(?:from\s+now\s+on,?\s+you\s+are|you\s+are\s+now\s+(?:a|an|the|no\s+longer)|act\s+as\s+if\s+you\s+(?:are|were)\s+(?:a|an|the))\b/i,
  },
  {
    id: 'role-ja',
    severity: 'block',
    re: /(?:あなたは(?:今から|今後|これから)|これからは).{0,24}(?:として振る舞|になりき|演じ|として行動)/,
  },

  // --- system prompt exfiltration: unambiguous, block ---
  {
    id: 'exfil-prompt',
    severity: 'block',
    re: /\b(?:reveal|show|print|output|repeat|disclose)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|rules)\b/i,
  },

  // --- secret exfiltration: unambiguous, block ---
  {
    id: 'exfil-secret',
    severity: 'block',
    re: /\b(?:send|post|upload|exfiltrate|transmit|forward)\b[^.\n]{0,48}\b(?:api[_\s-]?key|password|passwd|token|credential|secret|private[_\s-]?key|\.env)\b/i,
  },
  {
    id: 'exfil-secret-ja',
    severity: 'block',
    re: /(?:apiキー|パスワード|トークン|認証情報|秘密鍵|クレデンシャル).{0,40}(?:送信|送って|アップロード|外部に送|教えて)/i,
  },

  // --- permission claims: block, this is how an injection escalates ---
  {
    id: 'grant',
    severity: 'block',
    re: /\b(?:you\s+(?:now\s+)?have\s+(?:full\s+|unrestricted\s+)?(?:permission|access|authorization)|you\s+are\s+(?:now\s+)?authorized\s+to|permission\s+(?:has\s+been|is)\s+granted)\b/i,
  },

  // --- invisible characters ---
  //
  // Split by what the character can actually do, because the earlier single
  // pattern blocked every zero-width character and destroyed legitimate
  // entries: a family emoji is a ZWJ sequence, and Persian and Hindi use ZWNJ
  // for ordinary spelling. Blocking those hid real memories.
  //
  // What stays a block is the set with no legitimate use in a memory entry:
  // the bidi embedding/override/isolate controls behind Trojan Source, the
  // word joiners and invisible operators, the BOM, and the zero-width space.
  {
    id: 'invisible',
    severity: 'block',
    re: /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/,
  },
  {
    id: 'invisible-joiner',
    severity: 'flag',
    // ZWNJ and ZWJ. Legitimate in emoji sequences and in Persian, Hindi and
    // Urdu orthography, so they must not hide the entry — but they can also
    // be used to smuggle text past a reader, so they are worth reporting.
    re: /[\u200C\u200D]/,
  },

  // --- ambiguous: flag only ---
  {
    id: 'tool-directive',
    severity: 'flag',
    re: /\b(?:call|invoke|run|execute)\s+the\s+\w+\s+tool\s+(?:with|using)\b/i,
  },
  {
    id: 'urgency',
    severity: 'flag',
    re: /\b(?:immediately|right\s+now|urgent(?:ly)?|before\s+anything\s+else)\b[^.\n]{0,40}\b(?:send|delete|transfer|post|execute)\b/i,
  },
]

/** All pattern ids, for docs and tests. */
export const PATTERN_IDS = PATTERNS.map((p) => p.id)

/**
 * Scan text and return the hits.
 *
 * @returns {{ id: string, severity: 'block'|'flag' }[]}
 */
export function scan(text) {
  if (typeof text !== 'string' || !text) return []
  const hits = []
  for (const { id, severity, re } of PATTERNS) {
    // Reset lastIndex: the regexes are not global, but a caller could pass a
    // shared one in future and this costs nothing.
    re.lastIndex = 0
    if (re.test(text)) hits.push({ id, severity })
  }
  return hits
}

/** True when the text contains at least one blocking pattern. */
export function isBlocked(text) {
  return scan(text).some((h) => h.severity === 'block')
}

/**
 * The marker that replaces a blocked entry.
 *
 * It names the pattern so the agent can tell a real hit from a false one, and
 * says where the original text still lives. The entry is not deleted, so
 * nothing is lost.
 */
export function blockedMarker(label, hits) {
  const ids = hits.map((h) => h.id).join(', ')
  return (
    `[BLOCKED: ${label} matched injection pattern(s) ${ids}. ` +
    `The original text is still on disk and was not loaded. ` +
    `Run memory_audit to see it, then rewrite or delete the entry.]`
  )
}

/**
 * Scan an entry and return either the text or a marker.
 *
 * `enabled: false` returns the text untouched, so a user who disagrees with
 * the scanner can turn it off without editing the plugin.
 */
export function guard(text, label, enabled = true) {
  if (!enabled) return { text, blocked: false, hits: [] }
  const hits = scan(text).filter((h) => h.severity === 'block')
  if (hits.length === 0) return { text, blocked: false, hits: [] }
  return { text: blockedMarker(label, hits), blocked: true, hits }
}
