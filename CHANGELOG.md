# Changelog

All notable changes to this project are documented in this file.

## [1.3.0] - 2026-10-04

### Added

- `npm test` typechecks (`tsc --noEmit`) before running the suite under `tsx --test`.
- The wizard's command step is two keys again: **tab** fills the highlighted match into the query line, **enter** commits it to the args step. `/find-commands` shares the contract.

### Changed

- `editorEffect: "grayedOut"` grays whatever editor is mounted, custom ones included, instead of swapping in a copy of pi's default; falls back to the LEADER status line when no editor has focus.
- `/leader-commands` renamed `/find-commands`. No alias.
- Config hardening: prototype-polluting binding keys, bindings with more than one type, and non-object `bindings` are reported as dropped with a reason rather than silently ignored; `leaderKey` and both timeouts are validated; saving merges into the raw file so unknown fields and unrecognized bindings survive, and writes atomically.
- `exec` output is stripped of ANSI escapes and capped.

### Fixed

- Command step no longer answers "command must start with /" when enter is pressed on a name-only filter (`mod` → `/model`).
- Leader mode no longer loses pasted editor content when a `command` binding runs, and restores the editor effect in a `finally`.

## [1.2.0] - 2026-09-13

### Added

- Command bindings take an explicit optional `args` field:
  `{ "command": "/model", "args": "opus" }` dispatches `"/model opus"`
  through the full editor submit pipeline. Args are opaque (edges trimmed,
  interior kept verbatim); `command` itself must be a bare slash name (no
  interior whitespace). Legacy embedded form (`{ "command": "/model opus" }`)
  normalizes identically at load, so existing configs keep working; new
  `/leader-bind` writes always use the split form.
- `/leader-bind` gains an optional args step after the command pick (Enter
  on empty = no args); summary and conflict lines show the composed
  `command + args` string.
- Invalid bindings are reported: `loadConfig` returns `dropped: string[]`
  and the leader-key handler notifies once per press
  (`Ignored invalid bindings: "x" — check leader-key.json.`).

### Fixed

- Malformed bindings in `leader-key.json` (null, empty, or wrong-shaped
  entries from hand-editing) no longer crash dispatch — `loadConfig` drops
  invalid entries and keeps the valid ones; unknown `action` values notify
  instead of silently doing nothing.
- `/leader-bind` command step requires a leading `/`, so free-typed text
  can't save as a broken `{ command }` binding.
- Command dispatch restores the user's pre-dispatch editor draft (built-ins
  clear the editor; extension commands leave the command text).
- Documented that changing `leaderKey` requires a pi restart (the shortcut
  registers once at startup; all other settings apply on next press).

## [1.1.0] - 2026-09-05

### Added

- `/leader-bind`: interactive binding-creation wizard in a single overlay —
  type → value (command picker with fill-then-confirm, action list, or shell
  command editor) → key sequence → conflict check (exact and prefix overlaps,
  explicit overwrite confirmation) → summary + save. Escape walks back a
  step; cancel writes nothing; a corrupt config file is never overwritten.
  New bindings work immediately without a reload. Reachable via
  `/leader-bind` or the "Add binding" entry atop `/leader-commands`.
- Command picker extracted into one shared component used by both
  `/leader-commands` and the wizard.

## [1.0.0] - 2026-09-05

### Added

- Leader key (default `ctrl+space`) with multi-key sequences; bindings for
  slash commands, built-in actions (`compact`, `shutdown`, `clearEditor`),
  and shell one-liners, with prefix-disambiguation timers.
- `/leader-commands`: runtime command discovery over `pi.getCommands()` —
  scrollable picker windowed to 10 rows (pi's built-in selector does not
  scroll), fuzzy type-to-filter, provenance labels, exact invokable string
  echoed on selection.
- First-run blank config written to `~/.pi/agent/leader-key.json`, guarded to
  never overwrite an existing file; config lives outside the package so it
  survives updates.
