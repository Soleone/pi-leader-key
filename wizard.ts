// wizard.ts — /leader-bind interactive binding wizard and the shared
// fuzzy-filter command picker. UI only; pure logic lives in logic.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
    Container,
    Editor,
    fuzzyFilter,
    Key,
    matchesKey,
    SelectList,
    Text,
    type Component,
    type EditorTheme,
} from "@earendil-works/pi-tui";
import {
    buildCommandMenu,
    composeCommand,
    findConflicts,
    isPrintableKey,
    isProperPrefix,
    loadConfig,
    saveBinding,
    validateSequence,
    type BindingAction,
    type CommandMenuEntry,
    type PiCommand,
} from "./logic.ts";

/** pi hands `ui.custom` a resolved theme; `getTheme` types it as optional. */
type Theme = NonNullable<ReturnType<ExtensionContext["ui"]["getTheme"]>>;

/**
 * A custom component pi-tui can focus. `isFocusable()` is a structural
 * check for a `focused` property, so an overlay that omits it never gets
 * `focused = true` — and the Editor it hosts then renders no caret,
 * because the editor only draws its cursor marker while focused.
 */
type FocusableOverlay = Component & {
    dispose?(): void;
    focused?: boolean;
    setFocused?(focused: boolean): void;
};

// ---------------------------------------------------------------------------
// Shared picker helpers
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// /leader-bind — interactive binding wizard
// ------------------------------------------------------------------

/** SelectList theme shared by every picker in the extension. */
function selectListTheme(
    theme: Theme,
) {
    return {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
    };
}

interface SelectItem {
    value: string;
    label: string;
    description?: string;
}

function makeSelectList(
    theme: Theme,
    items: SelectItem[],
    onSelect: (value: string) => void,
    onCancel: () => void,
): SelectList {
    const list = new SelectList(
        items,
        Math.min(items.length, 10),
        selectListTheme(theme),
    );
    list.onSelect = (item) => onSelect(item.value);
    list.onCancel = onCancel;
    return list;
}

function makeEditor(
    tui: TUI,
    theme: Theme,
): Editor {
    const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: selectListTheme(theme),
    };
    return new Editor(tui, editorTheme);
}

/**
 * Fuzzy-filtered command picker: query line + SelectList over `menu`.
 * Shared by /leader-commands (enter on a selection = pick) and the
 * wizard's command step (enter = fill query; the caller confirms when
 * the query starts with "/"). Query state lives in the caller.
 */
export function makeCommandPicker(
    theme: Theme,
    menu: CommandMenuEntry[],
    opts: {
        getQuery: () => string;
        setQuery: (q: string) => void;
        onPick: (value: string) => void;
        onCancel: () => void;
    },
) {
    const queryText = new Text("", 1, 0);
    const listContainer = new Container();
    const container = new Container();
    container.addChild(queryText);
    container.addChild(listContainer);

    let list: SelectList;
    const rebuild = () => {
        const q = opts.getQuery();
        queryText.setText(theme.fg("accent", `> ${q}▏`));
        const filtered = q.trim()
            ? fuzzyFilter(menu, q, (e) => `${e.label} ${e.description}`)
            : menu;
        list = makeSelectList(theme, filtered, opts.onPick, opts.onCancel);
        listContainer.clear();
        listContainer.addChild(list);
    };
    rebuild();

    return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
            if (matchesKey(data, "escape")) {
                opts.onCancel();
                return;
            }
            if (data === "\x7f") {
                opts.setQuery(opts.getQuery().slice(0, -1));
                rebuild();
            } else if (isPrintableKey(data)) {
                opts.setQuery(opts.getQuery() + data);
                rebuild();
            } else {
                // Arrows etc. go to the live list; no rebuild, so the
                // selection survives the keystroke.
                list.handleInput(data);
            }
        },
    };
}

/**
 * Run the create-binding wizard in a single overlay. Steps: type →
 * value → sequence → (conflict confirm) → summary + save. Escape walks
 * back a step; nothing is written until the final save. Returns true
 * when a binding was saved.
 */
export async function runBindingWizard(
    ctx: ExtensionContext,
    commands: PiCommand[],
): Promise<boolean> {
    const menu: CommandMenuEntry[] = buildCommandMenu(commands);

    return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
        type Step =
            | "type"
            | "command"
            | "args"
            | "action"
            | "exec"
            | "sequence"
            | "conflict"
            | "confirm";

        let step: Step = "type";
        let bindingType: "command" | "action" | "exec" | null = null;
        let commandValue = "/";
        let argsValue = "";
        let execValue = "";
        let sequence = "";
        let status = "";

        const editor = makeEditor(tui, theme);
        editor.onSubmit = (value) => {
            if (step === "args") {
                argsValue = value.trim();
                goSequence();
            } else if (step === "exec") {
                execValue = value.trim();
                if (!execValue) {
                    status = "enter a shell command";
                    // submitValue() cleared the editor before calling us;
                    // put the user's own text back so they can fix it.
                    editor.setText(value);
                    refresh();
                    return;
                }
                goSequence();
            } else if (step === "sequence") {
                const err = validateSequence(value);
                if (err) {
                    if (err === "empty") status = "sequence cannot be empty";
                    else if (err === "whitespace")
                        status = "no spaces in a sequence";
                    else status = "printable ASCII keys only";
                    editor.setText(value);
                    refresh();
                    return;
                }
                sequence = value.trim();
                const conflicts = findConflicts(currentBindings(), sequence);
                step = conflicts.length > 0 ? "conflict" : "confirm";
                status = "";
                refresh();
            }
        };

        const currentBindings = () => loadConfig().config.bindings;

        /** True on the steps whose input goes to the text editor. */
        const isEditorStep = (): boolean =>
            step === "exec" || step === "sequence" || step === "args";

        const back = () => {
            status = "";
            if (step === "command" || step === "action" || step === "exec")
                step = "type";
            else if (step === "args") step = "command";
            else if (step === "sequence") step = valueStep();
            else if (step === "conflict" || step === "confirm")
                step = "sequence";
            if (step === "args") editor.setText(argsValue);
            refresh();
        };

        const valueStep = (): Step => {
            if (bindingType === "command") return "args";
            return bindingType === "action" ? "action" : "exec";
        };

        const goArgs = (prefill: string) => {
            step = "args";
            status = "";
            argsValue = prefill;
            editor.setText(prefill);
            refresh();
        };

        const goSequence = () => {
            step = "sequence";
            status = "";
            editor.setText("");
            refresh();
        };

        let chosenAction: "compact" | "shutdown" | "clearEditor" = "compact";

        const makeBinding = (): BindingAction => {
            if (bindingType === "command") {
                const command = commandValue.trim();
                return argsValue ? { command, args: argsValue } : { command };
            }
            if (bindingType === "action") return { action: chosenAction };
            return { exec: execValue };
        };

        const save = () => {
            if (!bindingType || !sequence) return;
            const binding = makeBinding();
            const result = saveBinding(sequence, binding);
            if (result.ok) {
                ctx.ui.notify(
                    `Bound: ${sequence} → ${describeBinding(binding)}`,
                    "info",
                );
                done(true);
            } else {
                status = result.error;
                refresh();
            }
        };

        const describeBinding = (b: BindingAction): string => {
            if ("command" in b) return composeCommand(b);
            if ("exec" in b) return `!${b.exec}`;
            return `action: ${b.action}`;
        };

        const summaryLines = (): string[] => {
            if (!bindingType) return [];
            const binding = makeBinding();
            return [
                theme.fg("text", `  ${sequence} → ${describeBinding(binding)}`),
                "",
            ];
        };

        const conflictLines = (): string[] => {
            const bindings = currentBindings();
            const lines = [
                theme.fg("warning", "  Conflicts with existing binding(s):"),
                "",
            ];
            for (const key of findConflicts(bindings, sequence)) {
                const existing = bindings[key];
                if (!existing) continue;
                lines.push(
                    `    ${key} → ${describeBinding(existing)}`,
                    theme.fg("dim", `      ${conflictRelation(key)}`),
                );
            }
            lines.push("");
            return lines;
        };

        /**
         * How an existing key relates to the new one. Only an exact match
         * is actually replaced by saving; prefix relations only cost a
         * sequence timeout, so the wording has to say which is which.
         */
        const conflictRelation = (key: string): string => {
            if (key === sequence) return "same sequence — saving replaces it";
            if (isProperPrefix(sequence, key))
                return `longer sequence — pressing ${sequence} now waits ${currentConfig().sequenceTimeoutMs}ms before firing`;
            return `shorter sequence — it fires first if you stop after ${key}`;
        };

        const currentConfig = () => loadConfig().config;

        // ---- Command picker state (command step) ----
        let query = "";
        let list: SelectList | null = null;
        let picker: ReturnType<typeof makeCommandPicker> | null = null;

        const container = new Container();

        function refresh() {
            container.clear();
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

            const titles: Record<Step, string> = {
                type: "New leader binding — what kind?",
                command: "New leader binding — which command?",
                args: "New leader binding — args (optional)",
                action: "New leader binding — which action?",
                exec: "New leader binding — shell command",
                sequence: "New leader binding — key sequence",
                conflict: "New leader binding — conflict",
                confirm: "New leader binding — confirm",
            };
            container.addChild(
                new Text(theme.fg("accent", theme.bold(titles[step])), 1, 0),
            );

            if (status) {
                container.addChild(
                    new Text(theme.fg("warning", `  ${status}`), 0, 0),
                );
            }

            let hint = "";
            list = null;

            if (step === "type") {
                list = makeSelectList(
                    theme,
                    [
                        {
                            value: "command",
                            label: "command",
                            description: "slash command",
                        },
                        {
                            value: "action",
                            label: "action",
                            description: "compact, shutdown, clearEditor",
                        },
                        {
                            value: "exec",
                            label: "exec",
                            description: "shell one-liner",
                        },
                    ],
                    (value) => {
                        bindingType = value as "command" | "action" | "exec";
                        status = "";
                        if (bindingType === "command") {
                            step = "command";
                            query = "";
                        } else if (bindingType === "action") {
                            step = "action";
                        } else {
                            step = "exec";
                            editor.setText("");
                        }
                        refresh();
                    },
                    () => done(false),
                );
                hint = "↑↓ navigate • enter select • esc cancel";
            } else if (step === "action") {
                list = makeSelectList(
                    theme,
                    [
                        {
                            value: "compact",
                            label: "compact",
                            description: "trigger conversation compaction",
                        },
                        {
                            value: "shutdown",
                            label: "shutdown",
                            description: "graceful shutdown",
                        },
                        {
                            value: "clearEditor",
                            label: "clearEditor",
                            description: "clear the editor text",
                        },
                    ],
                    (value) => {
                        chosenAction = value as
                            | "compact"
                            | "shutdown"
                            | "clearEditor";
                        goSequence();
                    },
                    back,
                );
                hint = "↑↓ navigate • enter select • esc back";
            } else if (step === "conflict") {
                for (const line of conflictLines())
                    container.addChild(new Text(line, 0, 0));
                list = makeSelectList(
                    theme,
                    [
                        {
                            value: "overwrite",
                            label: "overwrite this sequence",
                            description: `replace the binding for ${sequence}; related sequences are kept`,
                        },
                        {
                            value: "back",
                            label: "back",
                            description: "pick another sequence",
                        },
                    ],
                    (value) => {
                        if (value === "overwrite") {
                            step = "confirm";
                            refresh();
                        } else {
                            back();
                        }
                    },
                    back,
                );
                hint = "↑↓ navigate • enter select • esc back";
            } else if (step === "confirm") {
                for (const line of summaryLines())
                    container.addChild(new Text(line, 0, 0));
                list = makeSelectList(
                    theme,
                    [
                        {
                            value: "save",
                            label: "save",
                            description: "write to ~/.pi/agent/leader-key.json",
                        },
                        {
                            value: "back",
                            label: "back",
                            description: "edit the sequence",
                        },
                    ],
                    (value) => {
                        if (value === "save") save();
                        else back();
                    },
                    back,
                );
                hint = "↑↓ navigate • enter select • esc back";
            } else if (step === "sequence") {
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            "  e.g. gs, c, ox — printable keys, no spaces",
                        ),
                        0,
                        0,
                    ),
                );
                container.addChild(editor);
                hint = "enter confirm • esc back";
            } else if (step === "exec") {
                container.addChild(
                    new Text(
                        theme.fg("dim", "  run via bash -c, e.g. git status"),
                        0,
                        0,
                    ),
                );
                container.addChild(editor);
                hint = "enter confirm • esc back";
            } else if (step === "args") {
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            `  ${commandValue.trim()} — type args, or enter empty to skip`,
                        ),
                        0,
                        0,
                    ),
                );
                container.addChild(editor);
                hint = "enter confirm • esc back";
            } else if (step === "command") {
                picker = makeCommandPicker(theme, menu, {
                    getQuery: () => query,
                    setQuery: (q) => {
                        query = q;
                    },
                    onPick: (value) => {
                        query = `/${value}`;
                        refresh();
                    },
                    onCancel: back,
                });
                container.addChild(picker);
                hint = "enter fill command • enter again for args • esc back";
            }

            if (list) container.addChild(list);
            container.addChild(new Text(theme.fg("dim", `  ${hint}`), 1, 0));
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
            // The TUI only sets focus once, when the overlay mounts, so
            // keep the editor's focus in step with the current step.
            editor.focused = isEditorStep();
            tui.requestRender();
        }

        refresh();

        const overlay: FocusableOverlay = {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            // pi-tui only marks a component focused if it structurally has
            // a `focused` property; the Editor draws its caret (and emits
            // the terminal cursor marker) only while focused, so forward
            // the overlay's focus to whichever child is currently live.
            get focused() {
                return isEditorStep() ? editor.focused : false;
            },
            set focused(value: boolean) {
                if (isEditorStep()) editor.focused = value;
            },
            setFocused(focused: boolean) {
                if (isEditorStep()) editor.focused = focused;
            },
            handleInput: (data) => {
                if (matchesKey(data, "escape")) {
                    if (step === "type") done(false);
                    else back();
                    return;
                }
                if (step === "command") {
                    if (
                        matchesKey(data, Key.enter) &&
                        query.trim().length > 1
                    ) {
                        const text = query.trim();
                        if (!text.startsWith("/")) {
                            status = "command must start with /";
                            refresh();
                            return;
                        }
                        // Inline args typed in the picker split off into
                        // the args step (prefilled, still editable).
                        const ws = text.search(/\s/);
                        commandValue = ws === -1 ? text : text.slice(0, ws);
                        goArgs(ws === -1 ? "" : text.slice(ws).trim());
                        return;
                    }
                    picker?.handleInput(data);
                    tui.requestRender();
                    return;
                }
                if (step === "exec" || step === "sequence" || step === "args") {
                    editor.handleInput(data);
                    tui.requestRender();
                    return;
                }
                list?.handleInput(data);
                tui.requestRender();
            },
        };
        return overlay;
    });
}
