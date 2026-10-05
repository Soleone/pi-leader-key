# Spec: Binding Wizard (`/leader-bind`)

> **Update (2026-09-14):** `/leader-commands` was renamed `/find-commands`.
> The old name is kept below because this document is the spec as written.
> The "Deferred" section at the bottom still holds: neither picker is
> redundant yet.

## Objective

An interactive wizard that creates leader-key bindings without hand-editing
JSON. Invoked via `/leader-bind` or an "Add binding" entry in the
`/leader-commands` picker. The user is a pi user who has installed
pi-leader-key and wants to add, say, `"gh": { "exec": "git log --oneline" }`
without opening `~/.pi/agent/leader-key.json` and guessing at the schema.

Success looks like: leader + a fresh sequence runs the newly created binding
in the same session, and the config file on disk survives `pi update` and
subsequent restarts.

## Patterns (source of truth: pi extension examples)

- **Wizard flow** — `examples/extensions/questionnaire.ts`: single
  `ctx.ui.custom<T>((tui, theme, _kb, done) => …)` overlay, `SelectList` for
  option steps, embedded `Editor` (custom `EditorTheme`) for free-text steps,
  tab/step navigation, `done(result)` to exit. One overlay for the whole
  wizard, not one overlay per step.
- **Command choice** — the existing `buildCommandMenu` + windowed
  `SelectList` picker already in `index.ts` (`/leader-commands`), reused
  rather than reimplemented.
- **Free text** — `Editor` with `matchesKey` for Enter/Escape, as in
  `questionnaire.ts`.
- **Config write** — read-modify-write in `logic.ts` (new function), same
  JSON shape as `ensureConfig()` output.

## Flow

1. **Type** — SelectList: `command` / `action` / `exec`.
2. **Value**
   - `command` — existing `/leader-commands`-style picker (fuzzy filter,
     windowed to 10). Selecting a command echoes `/name`; the user may
     append args (free-text editing of the line before confirming).
   - `action` — SelectList of the three actions with one-line descriptions.
   - `exec` — free-text `Editor` step.
3. **Sequence** — free-text `Editor` step; user types the sequence as text
   (e.g. `gs`). Validated: non-empty, printable ASCII, no whitespace,
   duplicates collapsed. Pure validation lives in `logic.ts`.
4. **Conflict check** — pure function in `logic.ts` compares against current
   bindings (exact match, or new sequence is a prefix of an existing one or
   vice versa). On collision: show the conflicting binding(s) and require
   explicit confirm; cancel returns to the sequence step unchanged.
5. **Confirm & save** — summary line (`"gh" → exec: git log --oneline`),
   confirm writes the merged config via read-modify-write, notifies
   `"gh" bound`, closes. Cancel at any step exits with nothing written.

## Commands

```
Test:    npx tsx __tests__/logic.test.ts
Lint:    (none configured — pi-lens pipeline runs on save)
Dev run: pi install /home/matthew/Projects/pi-leader-key  # load as local package, then /leader-bind
```

## Project Structure

```
index.ts               → wizard overlay UI (ctx.ui.custom, SelectList, Editor) + /leader-bind registration + picker entry
logic.ts               → pure additions: validateSequence(), findConflicts(), mergeBinding(config, seq, binding)
__tests__/logic.test.ts→ tests for the three new pure functions
~/.pi/agent/leader-key.json → the file written (outside the repo, never committed)
```

`logic.ts` stays free of pi imports (suite loads standalone under tsx).

## Code Style

Match the existing file: 4-space indent, double quotes, function-first,
`ctx.ui.notify(msg, level)` for feedback, no classes.

```ts
export function findConflicts(
    bindings: Record<string, LeaderBinding>,
    seq: string,
): string[] {
    // exact + prefix collisions, same rules as runtime matching
}
```

## Testing Strategy

Assert-based suite in `__tests__/logic.test.ts`, run with tsx, no framework
(existing convention — 103 tests today). New coverage:

- `validateSequence`: empty, whitespace, non-ASCII, valid multi-key.
- `findConflicts`: exact match, new-is-prefix, existing-is-prefix, no conflict.
- `mergeBinding`: adds new key, replaces existing, preserves unrelated keys
  and key order, does not mutate its input.

The overlay UI itself is manually verified (interactive TUI); pure logic is
fully covered.

## Boundaries

- **Always:** run the test suite before committing; keep UI strings and
  schema identical to the README/AGENTS.md config docs; validate before
  writing.
- **Ask first:** changing the config file schema or `editorEffect` semantics;
  adding a dependency; a fourth binding type.
- **Never:** overwrite an existing binding without explicit confirmation;
  touch the config outside the `bindings` object; let a failed write lose
  user config (read → merge → write, never blank-file overwrite; on write
  error notify and leave config untouched).

## Success Criteria

- [ ] `/leader-bind` runs the wizard end-to-end in an interactive pi session
- [ ] "Add binding" entry in `/leader-commands` opens the same wizard
- [ ] A `command` binding created with args (e.g. `/model opus`) fires correctly via leader key
- [ ] An `action` and an `exec` binding created via wizard fire correctly
- [ ] Collision with an existing or prefix-related sequence shows the conflict and requires explicit confirm
- [ ] Escape/cancel at every step leaves the config file byte-identical
- [ ] Config write preserves formatting-independence: file re-reads as valid JSON with all prior bindings intact
- [ ] All new `logic.ts` functions tested; full suite passes
- [ ] README + AGENTS.md mention `/leader-bind`

## Deferred: `/leader-commands` deprecation

The wizard's command step (same picker, better ending — it creates the
binding instead of echoing a string to paste) makes the standalone
`/leader-commands` search likely redundant. Do **not** remove it as part of
this build. Once the wizard is solid in real use, re-discuss deprecation:
remove the command, its README/AGENTS.md section, and any tests that only
exercise the standalone entry point (the picker components themselves stay —
the wizard reuses them).

## Resolved Questions

- Should the wizard offer to *edit or delete* existing bindings later, or is
  create-only correct for v1? — **Create only** (defer edit/delete to a
  future spec).
- After a successful create, should the binding be usable immediately
  without reload? — **Yes.** Verify at implementation that the dispatch path
  re-reads config; if it caches, invalidate the cache on save.
