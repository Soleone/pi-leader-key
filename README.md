# pi-leader-key

Vim-style leader key shortcuts for the [pi coding agent](https://github.com/earendil-works/pi), inspired by OpenCode.
Press the leader key (default `ctrl+space`), then tap a short key sequence to run a slash command, a built-in action, or a shell one-liner.

## Features

- **Leader key with multi-key sequences** — `gs` for git status, `m` for the model picker, whatever you like
- **Bind any slash command** — including commands contributed by other extensions, prompt templates, and skills
- **Three binding types** — slash commands (with arguments), built-in actions, shell one-liners
- **Interactive setup** — `/leader-bind` wizard and `/leader-commands` discovery picker, no JSON hand-editing required
- **Safe config** — survives package updates, never overwrites your file, refuses to clobber corrupt configs

## Why this exists

pi's native `keybindings.json` only remaps a fixed set of built-in action ids (`tui.*`, `app.*` — see pi's `docs/keybindings.md`). A handful mirror built-in commands like `/new` or `/tree`, but there is **no native way to assign a key to an arbitrary slash command**, and no way at all to bind commands contributed by extensions, prompts, or skills. `pi.registerShortcut()` exists but is an extension-author API (it registers a code handler), not user configuration.

This extension fills that gap: one leader key gives you an unlimited namespace of two- and three-key shortcuts to anything invokable in your session.

## Install

```bash
pi install npm:pi-leader-key
# or straight from git (same release, useful while npm lags):
pi install git:github.com/mmyers0114/pi-leader-key@v1.2.0
```

On first startup a blank config is written to `~/.pi/agent/leader-key.json` (outside the package directory, so it survives updates). Add bindings by hand or run `/leader-bind`.

## Quick start

```jsonc
// ~/.pi/agent/leader-key.json
{
  "leaderKey": "ctrl+space",
  "bindings": {
    "c":  { "action": "compact" },
    "m":  { "command": "/model" },
    "gs": { "exec": "git status" }
  }
}
```

Press `ctrl+space`, then `gs` — the shell command runs and its output appears as a notification. Press `ctrl+space`, then `m` — the model picker opens as if you had typed `/model`.

> [!NOTE]
> Restart pi after changing `leaderKey` — the shortcut registers once at startup. Every other setting applies on your next leader press.

## Bind any slash command

Anything you can type after `/` can go behind a key sequence — including commands from any installed package:

```jsonc
{
  "bindings": {
    "ov": { "command": "/om:view" },
    "r1": { "command": "/review:1" },
    "mo": { "command": "/model", "args": "opus" }
  }
}
```

Command bindings run through pi's full editor submit pipeline, exactly as if you had typed the text and pressed Enter — so arguments work too. Put them in the explicit `args` field; the two forms below dispatch byte-identically (`"/model opus"`), and the legacy embedded form keeps loading so existing configs don't break:

> [!TIP]
> Don't guess at command names — run `/leader-commands` to browse everything invokable in your current session, or `/leader-bind` to pick one and bind it in a single flow.

## Finding commands: `/leader-commands`

Opens a scrollable picker over every invokable command in the current session — extension commands, prompt templates, and skills — generated at invocation time, so newly installed packages appear automatically.

- **Type to filter** — fuzzy match over names and descriptions
- Entries show provenance (`extension`, `prompt`, or `skill`) plus the description
- Selecting an entry echoes the exact invokable string (e.g. `/om:view`) to paste into `bindings` — no typos
- **+ Add binding**, the first entry, jumps straight into the `/leader-bind` wizard

In non-TUI mode the list is shown as a plain notification instead. Escape cancels.

## Creating bindings: `/leader-bind`

Walks you through a binding in one overlay: pick a type (`command` / `action` / `exec`), enter the value (fuzzy command picker, action list, or free-text shell input), choose a key sequence, confirm, done.

- Sequences must be printable ASCII with no spaces; command values must start with `/`
- Collisions — exact or prefix overlaps — are shown with the conflicting bindings and require explicit overwrite confirmation
- The merged config is written to `~/.pi/agent/leader-key.json` and works immediately, no reload
- Escape walks back a step; cancelling anywhere writes nothing; a corrupt config file is never overwritten

## Configuration

| Key | Default | Description |
| --- | ------- | ----------- |
| `leaderKey` | `"ctrl+space"` | Combination that activates leader mode. Restart pi after changing it. |
| `leaderTimeoutMs` | `3600` | How long leader mode stays active before timing out. |
| `sequenceTimeoutMs` | `750` | Max wait between keystrokes in a multi-key sequence. Also the delay before a prefix binding fires (see below). |
| `editorEffect` | `"grayedOut"` | Visual indicator while leader mode is active: `"grayedOut"` grays out whichever editor is mounted — pi's own or a custom one — and falls back to a static `LEADER` status when no editor has focus. `"none"` always shows the `LEADER` status. |
| `bindings` | `{}` | Sequence → binding. Empty by default; the leader key warns until you add some. |

Invalid values fall back to defaults, and malformed binding entries are ignored — a typo in one binding can't break the rest.

### Binding types

| Type | Example | What it does |
| ---- | ------- | ------------ |
| `command` | `{ "command": "/model" }` | Runs a slash command through pi's full editor pipeline |
| `command` + args | `{ "command": "/model", "args": "opus" }` | Same, with arguments (legacy `{ "command": "/model opus" }` also accepted) |
| `action` | `{ "action": "compact" }` | `compact`, `shutdown`, or `clearEditor` |
| `exec` | `{ "exec": "git status" }` | Runs via `bash -c` (15s timeout); output shown as a notification, capped at 2KB |

> [!NOTE]
> `command` + `args` dispatches the composed string (`command + " " + args`) through the same handler a manual Enter press triggers. Args are opaque: edges trimmed, interior kept verbatim; a legacy `"/model  opus"` (double space) normalizes to `"/model opus"`. Unknown command names pass through untouched — the binding fires against whatever is registered that session, so a command from a removed package simply does nothing until the package is back. Composition, normalization, and draft-restore against the composed string are exercised by the automated dispatch matrix (`npx tsx __tests__/dispatch-matrix.test.ts`: built-in + args, extension + args, skill ref, prompt template + args, unknown-command passthrough, double-space normalization); if a command behaves differently bound than typed, please file an issue.

### Sequences

Keys are printable ASCII: single (`"c"`) or multi-key (`"gs"`). Escape cancels leader mode; non-printable keys are ignored.

A sequence that is also a prefix of a longer binding waits `sequenceTimeoutMs` for the next key: with both `"g"` and `"gs"` bound, leader + `g` pauses briefly for `s` before firing `"g"`.

## Development

```bash
npx tsx __tests__/logic.test.ts   # assert-based suite, no framework
pi install /path/to/this/repo     # load as a local package
```

Pure logic (config loading, key matching, menu building) lives in `logic.ts`, deliberately free of pi imports so the suite loads standalone under tsx. The `@earendil-works/pi-*` peers are declared in `package.json` and resolved by pi at runtime.

## License

MIT License

Copyright (c) 2026 mmyers0114

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
