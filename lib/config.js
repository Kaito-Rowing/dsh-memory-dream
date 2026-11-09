/**
 * Configuration.
 *
 * Every default must work with no configuration at all: a fresh install
 * should behave sensibly before the user reads the README.
 */

export const DEFAULTS = {
  /** Hard cap on MEMORY.md, in characters. Writes that would exceed it are rejected. */
  memoryCharLimit: 4000,

  /** How many days back the dream reads notes and transcripts. */
  lookbackDays: 14,

  /** Memory root. Defaults to `$DSH_HOME/memory`. */
  memoryDir: null,

  /** Scan memory text for injection patterns before it reaches the model. */
  scanInjection: true,

  /** Inject MEMORY.md into the model's context on every turn. */
  inject: true,

  /** Include the wiki topic list in the injected context. */
  injectTopics: true,

  /** Let the dream read session transcripts, not just notes. */
  transcripts: true,

  /** Upper bound on transcript text handed to the dream, in characters. */
  transcriptMaxChars: 40000,

  /** Restrict transcript reading to sessions from the current workspace. */
  transcriptsSameWorkspace: true,

  /** Tool descriptions and model-facing text: 'en' or 'ja'. */
  language: 'en',
}

/**
 * Validate and normalize a raw config object.
 * Unknown keys are ignored rather than rejected: a plugin update that drops a
 * key should not break an existing profile.
 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS }

  if (Number.isFinite(raw.memoryCharLimit) && raw.memoryCharLimit >= 100) {
    cfg.memoryCharLimit = Math.floor(raw.memoryCharLimit)
  }
  if (Number.isFinite(raw.lookbackDays) && raw.lookbackDays >= 1 && raw.lookbackDays <= 365) {
    cfg.lookbackDays = Math.floor(raw.lookbackDays)
  }
  if (typeof raw.memoryDir === 'string' && raw.memoryDir.trim()) {
    cfg.memoryDir = raw.memoryDir.trim()
  }
  if (Number.isFinite(raw.transcriptMaxChars) && raw.transcriptMaxChars >= 1000) {
    cfg.transcriptMaxChars = Math.floor(raw.transcriptMaxChars)
  }
  for (const key of ['scanInjection', 'inject', 'injectTopics', 'transcripts', 'transcriptsSameWorkspace']) {
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key]
  }
  if (raw.language === 'ja' || raw.language === 'en') cfg.language = raw.language

  return cfg
}
