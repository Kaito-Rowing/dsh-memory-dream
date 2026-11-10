# Changelog

Notable changes to dsh-memory-dream. Versions refer to the source package; publication on GitHub Releases or npm is a separate step.

## [Unreleased]

### Documentation and release readiness

- Prepared npm package metadata, a maintainer publishing guide, a manual OIDC workflow for future npm releases, and DSH community announcement drafts.
- Made workspace-scoped transcript reads fail closed by default; no implicit cross-project fallback when matching sessions are absent.

- Added a short installation and verification path in both languages.
- Documented Node.js zstd requirements, privacy expectations and cross-workspace transcript fallback.
- Added contributor, security and maintainer release guidance.
- Expanded CI coverage to run the package's full test command.

## [0.3.0] — source version

- Layered memory index, dated notes, topic wiki and transcript-backed dream material.
- Optional local telemetry, status and memory audit tools.
- Safety checks for memory paths and heuristic prompt-injection scanning.

See the Git history for detailed development changes. This changelog does **not** imply a tagged release has been published.
