# Changelog

## 0.1.1 — 2026-09-21

- Failure notifications now include sanitized provider error text, with secrets redacted
  and message length capped.
- Allowlist skips are recorded in the debug log when enabled; the UI stays silent.
- Documented renames and settings migration from the local `compaction-model` extension.

## 0.1.0 — 2026-09-21

- Initial release of the pi compaction router package.
- Added settings, environment, and project-trust aware routing.
- Added fail-open compaction handling and JSONL diagnostics.
- Added `/compact-router` status and configuration command.
