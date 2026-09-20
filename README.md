# pi-compaction-router

A vendor-neutral pi package that routes compaction summaries through a configured
model while preserving pi-native compaction and fail-open behavior.

## Install

Install from a local checkout or a pinned git reference:

```text
pi install ./pi-compaction-router
pi install git:github.com/ErshovDmitry/pi-compaction-router@v0.1.0
pi -e git:github.com/ErshovDmitry/pi-compaction-router@v0.1.0
```

The package loads `src/index.ts` directly. Pi supplies the peer packages at runtime;
this package does not bundle pi core.

## Configuration

Add `compactionRouter` to global or trusted project `settings.json`:

```json
{
  "compactionRouter": {
    "enabled": true,
    "model": "some-provider/some-model",
    "thinkingLevel": "medium",
    "reserveTokens": 16384,
    "onlyForActiveModels": [],
    "reasons": ["manual", "threshold", "overflow"],
    "debug": false,
    "debugPath": "./router.log"
  }
}
```

Project fields override global fields independently. An absent project field inherits
its global value. `PI_COMPACTION_ROUTER` is applied last: `off` disables routing, and
`some-provider/some-model` enables that target. Invalid environment values are ignored.
`reserveTokens` integers are clamped to `1024..1000000`; fractional values are ignored
with a warning, preserving other fields. Empty `onlyForActiveModels` and absent
`reasons` match all values.

| Option | Default |
| --- | --- |
| `enabled` | `false` |
| `model` | none; required when enabled |
| `thinkingLevel` | `"off"` |
| `reserveTokens` | absent → pi default |
| `onlyForActiveModels` | absent → all |
| `reasons` | absent → all |
| `debug` | `false` |
| `debugPath` | `<agent-dir>/logs/compaction-router.log` |

## Command

- `/compact-router` or `/compact-router status` shows effective configuration.
- `/compact-router off` disables routing in the selected settings file.
- `/compact-router some-provider/some-model` enables a target.
- `/compact-router reasons manual,threshold` limits compaction reasons.

Trusted projects write `<project>/.pi/settings.json`. Untrusted projects write the
user settings file and report that choice. Malformed settings files are never replaced.
An active environment override remains stronger than command persistence.

## Diagnostics and failure behavior

With `debug: true`, one sanitized JSON object per line is appended to `debugPath`.
Writes are serialized and best-effort; they never block or fail compaction. Credentials,
headers, provider environments, and private model data are not written.

Routing returns control to pi when disabled, filtered, aborted, when the model is
unavailable, or when summarization fails. Pi then performs its default compaction.
On authentication resolution failure, the router warns once and still attempts
compaction because credentials may resolve at request time. If that attempt fails,
pi falls back to default compaction. The `session_compact_failed` event is recorded
separately.

## Troubleshooting

- Check `/compact-router status` for source and effective fields.
- Confirm the target is present in pi's model registry as `provider/modelId`.
- Remove or correct `PI_COMPACTION_ROUTER` when it intentionally overrides settings.
- Ensure the diagnostics directory is writable if debug logging is required.

## Compatibility

The extension host (pi 0.86.x) itself requires Node ≥22.19 at runtime; the package's own typecheck/tests run on Node 20 and 22.
