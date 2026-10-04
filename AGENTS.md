# pi-leader-key

Press the leader key (default `ctrl+space`), then tap a short key sequence to trigger an action, slash command, or shell command.

## Config

`~/.pi/agent/leader-key.json` — created with blank defaults on first startup and never overwritten once it exists; it lives outside the package so it survives `pi update`.

```jsonc
{
  // Key combination to activate leader mode (default: "ctrl+space").
  // Restart pi after changing it — the shortcut registers once at startup.
  "leaderKey": "ctrl+space",

  // How long leader mode stays active before timing out (default: 3600)
  "leaderTimeoutMs": 3600,

  // Max wait between keystrokes in a multi-key sequence (default: 750)
  "sequenceTimeoutMs": 750,

  // Visual indicator during leader mode (default: "grayedOut").
  // "grayedOut" — dim the entire editor via ANSI faint
  // "none"      — static LEADER status indicator
  // Legacy "spinner" values coerce to "grayedOut"
  "editorEffect": "grayedOut",

  // Key bindings: sequence → binding
  "bindings": {
    "c":  { "action": "compact" },
    "m":  { "command": "/model" },
    "gs": { "exec": "git status" }
  }
}
```

An empty `bindings` object is the shipped state: pressing the leader key warns "No leader bindings configured" until you add some.

### Binding types

Each binding is exactly one of:

- **`command`** — a slash command, routed through pi's full editor pipeline. Anything starting with `/`. Arguments go in the explicit `args` field: `{ "command": "/model", "args": "opus" }` dispatches `"/model opus"`, exactly like typing it. Legacy embedded form (`{ "command": "/model opus" }`) normalizes identically at load (split on first space, trim edges, interior verbatim). Args are opaque — never an array, never re-tokenized.
- **`action`** — direct API call: `"compact"` (trigger conversation compaction), `"shutdown"` (graceful shutdown), `"clearEditor"` (clear the editor text).
- **`exec`** — shell command run via `bash -c`; output is shown as a notification.

Wizard specifics (`/leader-bind`): command values must start with `/`; sequences are validated (printable ASCII, no whitespace); conflicts with existing bindings — exact or prefix overlaps — require explicit overwrite confirmation; a corrupt config file is never overwritten (save refuses and reports); the save preserves all other bindings and non-binding fields.

### Sequences

Keys are printable ASCII: a single key (`"c"`) or multi-key (`"gs"`). Escape cancels leader mode; non-printable keys during leader mode are ignored.

A sequence that is also a prefix of another binding waits `sequenceTimeoutMs` for the next key: with both `"g"` and `"gs"` bound, leader+`g` waits briefly for `s` before firing `"g"`.

## Adding bindings

Run `/leader-bind` for an interactive wizard: type → value (+ optional args step for `command`) → key sequence →
conflict check → save. It writes the merged config and the binding works
immediately. Escape backs out a step; cancel writes nothing.

Alternatively, edit `~/.pi/agent/leader-key.json` by hand. Discover available
slash commands from the environment at runtime rather than trusting any cached
list:

1. `/leader-commands` — picker over `pi.getCommands()` (extension commands, prompt templates, skills), generated at invocation time; type-to-filter fuzzy-matches names and descriptions; selecting one echoes the exact invokable string to paste into `bindings`
2. `pi list` — installed packages
3. `grep registerCommand` in extension source files — registered commands
4. Skill `SKILL.md` files — their registered slash commands
5. Ask the user which commands they want mapped

## Maintaining

Test command and dev-install workflow: README, "Development". Facts the README doesn't carry:

- Config bootstrap (`ensureConfig()` in logic.ts, runs at extension load): missing file → writes defaults; existing file (even an invalid one) → never touched; write failure → in-memory defaults, extension keeps working.
- Keep `logic.ts` free of pi imports — the test suite loads it standalone under tsx, where `@earendil-works/pi-*` don't resolve. The peers are declared in `package.json` and resolved by pi at runtime.
- TUI components split across the peers: containers/widgets (`Container`, `Text`, `SelectList`, `Editor`, `fuzzyFilter`, …) come from `@earendil-works/pi-tui`; chrome (`DynamicBorder`, `CustomEditor`) comes from `@earendil-works/pi-coding-agent`. The LSP cannot resolve the peers, so a wrong-package import looks clean — verify exports with `node --input-type=module -e "console.log(typeof (await import('PKG')).NAME)"`.
