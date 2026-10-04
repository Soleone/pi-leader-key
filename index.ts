/**
 * Leader Key Extension — vim-style leader key shortcuts for pi.
 *
 * Reads bindings from ~/.pi/agent/leader-key.json and activates them when
 * you press the configured leader key. An invisible overlay captures
 * keystrokes and matches them against configured bindings. Command bindings
 * are submitted through the editor's own submit path (its normal
 * submit pipeline) for full slash-command processing.
 *
 * Pure logic (config loading, key matching, command-menu building) lives in
 * logic.ts, which the test suite imports directly.
 *
 * On first startup (no leader-key.json), a blank default config is written
 * to ~/.pi/agent/leader-key.json — outside the package dir, so it survives
 * updates. The package itself ships no config file.
 *
 * /leader-commands opens a picker over pi.getCommands() for command-binding
 * discovery; selection echoes the exact invokable string. It also hosts an
 * "Add binding" entry that opens the /leader-bind wizard.
 *
 * /leader-bind creates a binding interactively: pick a type (command,
 * action, exec), enter the value, choose a key sequence (with conflict
 * detection), confirm, and it's saved to the config and usable immediately
 * (the leader-key handler re-reads the config on every press).
 *
 * ## Config: ~/.pi/agent/leader-key.json
 *
 * {
 *   "leaderKey": "ctrl+space",
 *   "leaderTimeoutMs": 3600,
 *   "sequenceTimeoutMs": 750,
 *   "editorEffect": "grayedOut",
 *   "bindings": {
 *     "c":  { "action": "compact" },
 *     "q":  { "action": "shutdown" },
 *     "gs": { "exec": "git status" },
 *     "su": { "command": "/spin-up" },
 *     "m":  { "command": "/model" },
 *     "mo": { "command": "/model", "args": "opus" }
 *   }
 * }
 *
 * Legacy embedded args ({ "command": "/model opus" }) normalize
 * identically at load; new writes use the split form.
 *
 * ## editorEffect values
 *
 *   "grayedOut" — Gray the mounted editor (pi's own or a custom one) while
 *     leader mode is open (default). Falls back to the LEADER status line
 *     when no editor has focus.
 *   "none"      — LEADER status line only; the editor is left alone.
 *
 * ## Binding types
 *
 *   command — Submitted through the editor's submit path for full
 *     slash-command processing. Works for extension commands and
 *     built-in commands alike. Arguments go in the explicit `args`
 *     field and are composed as `command + " " + args`.
 *
 *   action — Calls a pi API directly.
 *     "compact"      — trigger conversation compaction
 *     "shutdown"     — graceful shutdown
 *     "clearEditor"  — clear the editor text
 *
 *   exec — Runs a shell command via bash -c. Output shown as a
 *     notification.
 */

import {
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    matchesKey,
    Text,
    type KeyId,
} from "@earendil-works/pi-tui";
import {
    buildCommandMenu,
    capOutput,
    CONFIG_PATH,
    dispatchPlan,
    ensureConfig,
    focusedEditor,
    isMountedEditor,
    isPrintableKey,
    leaderIndicator,
    loadConfig,
    processKey,
    renderEditor,
    shouldRestoreDraft,
    type LeaderConfig,
    type MountedEditor,
} from "./logic.ts";
import { makeCommandPicker, runBindingWizard } from "./wizard.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear an existing timer (if any) and start a new one. */
function resetTimer(
    timer: ReturnType<typeof setTimeout> | null,
    ms: number,
    fn: () => void,
): ReturnType<typeof setTimeout> {
    if (timer) clearTimeout(timer);
    return setTimeout(fn, ms);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    const { config } = loadConfig();
    // First run in this install: write a blank config to edit. Guarded —
    // never overwrites an existing file; failure falls back to defaults.
    ensureConfig();

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /**
     * The editor pi has mounted, captured when the capture overlay opens
     * (that is when the TUI can still name it). Left null when focus is
     * not on an editor, in which case leader mode falls back to the
     * LEADER status line.
     */
    let activeEditor: MountedEditor | null = null;
    /** True while a leader press is in flight — pi fires shortcuts without awaiting. */
    let capturing = false;
    /** One warning per extension load: leader mode found no editor to gray. */
    let warnedNoEditor = false;

    /**
     * Surface config problems once per session rather than on every press:
     * an unusable `leaderKey` or an unparseable binding is a standing
     * problem, not a per-keystroke event.
     */
    function reportConfigProblems(ctx: ExtensionContext): void {
        const { error, dropped, reasons, notes } = loadConfig();
        if (error === "parse") {
            ctx.ui.notify(
                `Failed to parse ${CONFIG_PATH} — using defaults.`,
                "error",
            );
            return;
        }
        for (const note of notes) ctx.ui.notify(note, "warning");
        if (dropped.length > 0)
            ctx.ui.notify(
                `Ignored ${dropped.length} invalid binding(s): ${dropped
                    .map((k) => `"${k}" (${reasons[k] ?? "invalid"})`)
                    .join(", ")} — check leader-key.json.`,
                "warning",
            );
    }

    /**
     * Submit a command binding through the editor's own submit path.
     *
     * pi-tui keeps submitValue() private, but the Enter handler calls it
     * and it is what a typed command needs: it cancels autocomplete, exits
     * history browsing, and — unlike setText — leaves no undo entry
     * holding the synthetic command text. Going through handleInput("\r")
     * instead would depend on the user not having remapped
     * `tui.input.submit`. onSubmit is wrapped for the duration of the call
     * so the real handler's return value stays awaitable; if a future pi
     * drops submitValue, fall back to calling onSubmit directly.
     */
    function submitViaEditor(
        editor: MountedEditor | null,
    ): Promise<void> {
        if (!editor) return Promise.resolve();
        let pending: void | Promise<void> = undefined;
        const original = editor.onSubmit;
        editor.onSubmit = (value) => {
            pending = original?.(value);
        };
        try {
            // SAFETY: pi-tui marks submitValue private in its .d.ts but the
            // method exists at runtime (the Enter handler calls it), and
            // the typeof guard below falls back if a future pi drops it.
            const submit = (editor as unknown as { submitValue?: () => void })
                .submitValue;
            if (typeof submit === "function") submit.call(editor);
            else original?.(editor.getText());
        } finally {
            editor.onSubmit = original;
        }
        return Promise.resolve(pending).then(() => undefined);
    }

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    pi.on("session_shutdown", () => {
        activeEditor = null;
    });

    pi.on("session_start", (_event, ctx) => {
        // A session switch can drop an in-flight capture overlay without
        // resolving it; reset so the leader key is live again afterwards.
        activeEditor = null;
        capturing = false;
        reportConfigProblems(ctx);
    });

    // ------------------------------------------------------------------
    // Capture overlay + effect renderer
    // ------------------------------------------------------------------

    async function runEffectCapture(
        ctx: ExtensionContext,
        current: LeaderConfig,
    ): Promise<string | null> {
        return ctx.ui.custom<string | null>(
            (tui, theme, _keybindings, done) => {
                // Whatever editor pi has mounted — its own or a custom one
                // from another extension — is still the focused component at
                // this point, and it stays mounted behind this overlay. Gray
                // it in place instead of swapping in a look-alike. Focus does
                // move to the overlay while it is up, so a text cursor
                // disappears for the duration; the editor's text, keys, and
                // undo history are untouched.
                const editor = focusedEditor(tui);
                activeEditor = editor;
                const indicator = leaderIndicator(
                    current.editorEffect,
                    editor !== null,
                );
                if (indicator.warnNoEditor && !warnedNoEditor) {
                    warnedNoEditor = true;
                    ctx.ui.notify(
                        "Leader mode found no editor to gray — falling back to the LEADER indicator.",
                        "warning",
                    );
                }
                if (indicator.status) {
                    ctx.ui.setStatus("leader", indicator.status);
                }
                // Hoisted: this is a per-frame call, and pi's editor renders
                // lazily, so the closure is reused rather than rebuilt.
                const mutedBorder = (s: string) => theme.fg("muted", s);

                let buffer = "";
                let leaderTimer: ReturnType<typeof setTimeout> | null = null;
                let sequenceTimer: ReturnType<typeof setTimeout> | null = null;

                const cleanup = () => {
                    if (leaderTimer) clearTimeout(leaderTimer);
                    if (sequenceTimer) clearTimeout(sequenceTimer);
                };

                const dismiss = () => {
                    cleanup();
                    done(null);
                };
                const fire = (key: string) => {
                    cleanup();
                    done(key);
                };

                leaderTimer = resetTimer(
                    leaderTimer,
                    current.leaderTimeoutMs,
                    dismiss,
                );

                return {
                    render(width: number): string[] {
                        // Frozen at open: the editor reference never changes
                        // under this overlay, so a session switch cannot leave
                        // a live read and a stale flag disagreeing.
                        if (!editor) return [""];
                        return renderEditor(editor, width, {
                            dim: indicator.dim,
                            borderColor: mutedBorder,
                        });
                    },
                    invalidate(): void {
                        editor?.invalidate?.();
                    },
                    // The host drops overlays on a session switch without
                    // resolving them, so the timers have to die here too.
                    dispose(): void {
                        buffer = "";
                        cleanup();
                    },

                    handleInput(data: string): void {
                        if (matchesKey(data, "escape")) {
                            dismiss();
                            return;
                        }
                        if (!isPrintableKey(data)) return;

                        leaderTimer = resetTimer(
                            leaderTimer,
                            current.leaderTimeoutMs,
                            dismiss,
                        );

                        buffer += data;

                        const result = processKey(buffer, current.bindings);
                        if (result.action === "fire") {
                            fire(result.key);
                        } else if (result.action === "wait") {
                            sequenceTimer = resetTimer(
                                sequenceTimer,
                                current.sequenceTimeoutMs,
                                result.exact ? () => fire(buffer) : dismiss,
                            );
                        } else {
                            dismiss();
                        }
                    },
                };
            },
        );
    }

    // ------------------------------------------------------------------
    // Dispatch helper
    // ------------------------------------------------------------------

    async function dispatchBinding(
        ctx: ExtensionContext,
        current: LeaderConfig,
        key: string,
    ): Promise<void> {
        const binding = current.bindings[key];
        if (!binding) return;

        const plan = dispatchPlan(binding);
        if (plan.kind === "command") {
            // Submitting means driving the mounted editor's own handler,
            // which needs the instance the overlay captured. With no editor
            // focused there is nothing to submit into, and silently typing
            // the command somewhere else would be worse than saying so.
            if (!activeEditor) {
                ctx.ui.notify(
                    "That leader command needs the editor focused.",
                    "warning",
                );
                return;
            }
            const submitted = plan.text;
            // Snapshot through the UI accessor, not activeEditor.getText():
            // a large paste is stored collapsed as a marker, getText()
            // returns that marker, and getEditorText() expands it.
            // Restoring the marker after submitValue() wiped the paste map
            // would lose the pasted text for good.
            const draft = ctx.ui.getEditorText();
            // ctx.ui writes through pi's own editor instance
            // (setEditorText is `this.editor.setText`). That is the editor
            // the capture overlay focused on in practice — the leader
            // shortcut is routed from the editor's own handler — so the
            // draft and the submission below land on the same instance.
            ctx.ui.setEditorText(submitted);
            await submitViaEditor(activeEditor);
            // Give the draft back unless the command left new text behind.
            if (shouldRestoreDraft(ctx.ui.getEditorText(), submitted)) {
                ctx.ui.setEditorText(draft);
            }
            return;
        }

        if (plan.kind === "action") {
            switch (plan.action) {
                case "compact":
                    ctx.compact({
                        onComplete: () =>
                            ctx.ui.notify("Compaction complete", "info"),
                        onError: (err: Error) =>
                            ctx.ui.notify(
                                `Compaction failed: ${err.message}`,
                                "error",
                            ),
                    });
                    break;
                case "shutdown":
                    ctx.shutdown();
                    break;
                case "clearEditor":
                    ctx.ui.setEditorText("");
                    break;
                default:
                    ctx.ui.notify(
                        `Unknown action for "${key}" — check leader-key.json.`,
                        "warning",
                    );
                    break;
            }
        } else if (plan.kind === "exec") {
            const r = await pi.exec("bash", ["-c", plan.cmd], {
                timeout: 15000,
            });
            // Cap what reaches the TUI — `cat huge.log` shouldn't flood it
            // — and strip control sequences so a command can't move the
            // cursor or rewrite the terminal title through its output.
            const failed = r.code !== 0;
            const body = capOutput(failed && r.stderr ? r.stderr : r.stdout);
            ctx.ui.notify(
                failed
                    ? `[exit ${r.code}] ${body || "no output"}`
                    : body || `[exit ${r.code}]`,
                "info",
            );
        } else {
            ctx.ui.notify(
                `Binding "${key}" isn't a command, action, or shell command — check leader-key.json.`,
                "warning",
            );
        }
    }

    // ------------------------------------------------------------------
    // /leader-bind — entry point
    // ------------------------------------------------------------------

    pi.registerCommand("leader-bind", {
        description: "Create a leader-key binding interactively",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/leader-bind needs a TUI session.", "warning");
                return;
            }
            await runBindingWizard(ctx, pi.getCommands());
        },
    });

    // ------------------------------------------------------------------
    // /leader-commands — runtime command discovery
    // ------------------------------------------------------------------

    pi.registerCommand("leader-commands", {
        description: "Browse every invokable command for leader-key bindings",
        handler: async (_args, ctx) => {
            const commands = pi.getCommands();
            if (commands.length === 0) {
                ctx.ui.notify("No commands available to bind.", "warning");
                return;
            }

            if (ctx.mode !== "tui") {
                ctx.ui.notify(
                    buildCommandMenu(commands)
                        .map(
                            (e) =>
                                `${e.label}${e.description ? ` — ${e.description}` : ""}`,
                        )
                        .join("\n"),
                    "info",
                );
                return;
            }

            const menu: Array<{
                value: string;
                label: string;
                description: string;
            }> = [
                {
                    value: "__add__",
                    label: "+ Add binding",
                    description: "open the binding wizard (/leader-bind)",
                },
                ...buildCommandMenu(commands),
            ];

            // pi's built-in extension selector renders every option with no
            // scrolling, so long lists push the cursor off screen — use the
            // documented ui.custom + SelectList pattern instead (windowed to 10).
            const picked = await ctx.ui.custom<string | null>(
                (tui, theme, _kb, done) => {
                    let query = "";
                    const picker = makeCommandPicker(theme, menu, {
                        getQuery: () => query,
                        setQuery: (q) => {
                            query = q;
                        },
                        onPick: (value) => done(value),
                        onCancel: () => done(null),
                    });

                    const container = new Container();
                    container.addChild(
                        new DynamicBorder((s) => theme.fg("accent", s)),
                    );
                    container.addChild(
                        new Text(
                            theme.fg("accent", theme.bold("Command to bind")),
                            1,
                            0,
                        ),
                    );
                    container.addChild(picker);
                    container.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "type to filter • ↑↓ navigate • tab fill • enter insert • esc cancel",
                            ),
                            1,
                            0,
                        ),
                    );
                    container.addChild(
                        new DynamicBorder((s) => theme.fg("accent", s)),
                    );

                    return {
                        render: (w) => container.render(w),
                        invalidate: () => container.invalidate(),
                        handleInput: (data) => {
                            picker.handleInput(data);
                            tui.requestRender();
                        },
                    };
                },
            );

            if (picked == null) return;
            if (picked === "__add__") {
                await runBindingWizard(ctx, commands);
                return;
            }
            const entry = menu.find((e) => e.value === picked);
            // Put the command in the editor instead of echoing it: the
            // caller is standing at the prompt about to type it, and pi's
            // own autocomplete completes into the editor the same way.
            // Only when the editor is empty or already holds a command —
            // appending to unrelated text would produce a line pi cannot
            // run.
            const editor = ctx.ui.getEditorComponent?.();
            if (editor && isMountedEditor(editor)) {
                const draft = editor.getText().trim();
                if (draft === "" || draft.startsWith("/")) {
                    editor.setText(`${draft}${draft ? " " : ""}/${picked} `);
                    return;
                }
            }
            ctx.ui.notify(
                `/${picked}${entry?.description ? ` — ${entry.description}` : ""}`,
                "info",
            );
        },
    });

    // ------------------------------------------------------------------
    // Shortcut
    // ------------------------------------------------------------------

    pi.registerShortcut(config.leaderKey as KeyId, {
        description: "Leader key",
        handler: async (ctx) => {
            if (ctx.mode !== "tui") return;
            // pi fires shortcuts without awaiting the handler and swaps the
            // editor in a microtask, so two leader presses in one stdin
            // chunk would otherwise start two overlapping overlays.
            if (capturing) return;

            capturing = true;
            try {
                const { config: current } = loadConfig();
                if (Object.keys(current.bindings).length === 0) {
                    ctx.ui.notify("No leader bindings configured.", "warning");
                    return;
                }

                // The overlay captures the mounted editor and renders it
                // grayed; when there is no editor to gray it puts up the
                // LEADER status line itself.

                try {
                    const result = await runEffectCapture(ctx, current);
                    if (typeof result === "string")
                        await dispatchBinding(ctx, current, result);
                } finally {
                    // Drop the editor reference and the indicator: the next
                    // press recaptures both, and a throw in the overlay or
                    // the dispatch must not leave LEADER on screen.
                    activeEditor = null;
                    ctx.ui.setStatus("leader", undefined);
                }
            } finally {
                capturing = false;
            }
        },
    });
}
