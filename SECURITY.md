# Security policy

## Supported versions

This is a community project. The latest version in the default branch is the primary maintenance target; older releases do not have a guaranteed support window.

## Reporting a vulnerability

**Do not open a public issue with an exploit, secret, sensitive memory, or user transcript.** Prefer GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository if enabled. Otherwise contact the maintainer privately through an established channel linked from their GitHub profile. Do not assume a private reporting channel exists if none is listed.

When reporting, share the minimal redacted reproduction, affected version, impact, and proposed mitigation. Do not attach a full DSH home or debug snapshot.

## Threat model and limitations

- The plugin processes agent-authored memory and potentially sensitive user/assistant conversation transcripts. Files stored locally are not equivalent to end-to-end privacy: injected or dream material may be sent to the configured model provider.
- Prompt-injection scanning uses heuristics. It can miss malicious instructions and flag innocent text. Do not treat it as a security boundary.
- With `transcriptsSameWorkspace: true` (the default), transcript reading stays within the selected workspace; when no matching sessions exist it returns no transcript evidence rather than searching other projects. Setting `transcriptsSameWorkspace: false` intentionally allows all-workspace reading. Do not use that setting for sensitive project isolation.
- The cross-process file lock is best-effort and may allow writes without a lock on timeout. Concurrent writes across profiles require care.
- Debug snapshots, telemetry and DSH server logs may contain personal, operational, or authentication data. A token-only redaction regex does not safely anonymize them. Keep debugging artifacts private and perform a manual content review before sharing.
- Back up memory data before using destructive operations such as `memory_audit` with `fix: true`.

These are disclosures of known behavior, not security assurances.
