/**
 * Pure logic for the leader-key extension: config loading and key
 * matching. Deliberately free of pi imports so the test suite can load
 * this module directly under tsx (the extension's own imports of
 * @earendil-works/pi-* don't resolve outside pi).
 */

import {
    existsSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types & config
// ---------------------------------------------------------------------------

export type EditorEffect = "grayedOut" | "none";

export interface CommandBinding {
    command: string;
    /** Raw args string — opaque, passed through verbatim (edges trimmed). */
    args?: string;
}

export type BindingAction =
    | CommandBinding
    | { action: "compact" | "shutdown" | "clearEditor" }
    | { exec: string };

/** Compose a command binding into the exact string dispatch submits. */
export function composeCommand(b: CommandBinding): string {
    return b.args ? `${b.command} ${b.args}` : b.command;
}

/**
 * Validate a command name (no args — those live in `args`). Returns an
 * error code ("empty" | "lone-slash" | "missing-slash" | "whitespace")
 * or null when valid.
 */
export function validateCommand(raw: unknown): string | null {
    if (typeof raw !== "string") return "empty";
    const cmd = raw.trim();
    if (cmd.length === 0) return "empty";
    if (cmd === "/") return "lone-slash";
    if (!cmd.startsWith("/")) return "missing-slash";
    if (/\s/.test(cmd)) return "whitespace";
    return null;
}

export interface LeaderConfig {
    leaderKey: string;
    leaderTimeoutMs: number;
    sequenceTimeoutMs: number;
    editorEffect: EditorEffect;
    bindings: Record<string, BindingAction>;
}

export const DEFAULT_CONFIG: LeaderConfig = {
    leaderKey: "ctrl+space",
    leaderTimeoutMs: 3600,
    sequenceTimeoutMs: 750,
    editorEffect: "grayedOut",
    bindings: {},
};

/**
 * Config lives in pi's own config dir (next to settings.json) so it
 * survives package updates — the package itself ships no config file.
 */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "leader-key.json");

/**
 * Why the loader fell back to defaults. "missing" is normal (no config
 * yet), "parse" means the file is not JSON at all, "shape" means it is
 * JSON but not a config object.
 */
export type ConfigError = "missing" | "parse" | "shape" | null;

export interface ConfigResult {
    config: LeaderConfig;
    error: ConfigError;
    /**
     * Keys sanitized away — reported once per session (never silent), each
     * with its reason in `reasons`.
     */
    dropped: string[];
    /** Why each dropped key was dropped (a subset of `dropped`). */
    reasons: Record<string, string>;
    /** File-level problems that aren't tied to one binding key. */
    notes: string[];
}

/** Guard for hand-edited config: only well-shaped bindings reach dispatch. */
export function isBindingAction(v: unknown): v is BindingAction {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if ("command" in o)
        return (
            validateCommand(o.command) === null &&
            (!("args" in o) || typeof o.args === "string")
        );
    if ("action" in o)
        return (
            o.action === "compact" ||
            o.action === "shutdown" ||
            o.action === "clearEditor"
        );
    if ("exec" in o)
        return typeof o.exec === "string" && o.exec.trim().length > 0;
    return false;
}

const BINDING_VARIANTS = ["command", "action", "exec"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sanitize the raw `bindings` map. Entries are rebuilt with
 * Object.fromEntries, which defines properties instead of assigning them,
 * so a binding literally named `__proto__` becomes an own property rather
 * than mutating the prototype (JSON.parse does the same).
 */
function sanitizeBindings(v: unknown): {
    bindings: Record<string, BindingAction>;
    dropped: string[];
    reasons: Record<string, string>;
    /** Set when `bindings` itself was unusable (so the whole map is empty). */
    note?: string;
} {
    const empty = { bindings: {}, dropped: [], reasons: {} } as {
        bindings: Record<string, BindingAction>;
        dropped: string[];
        reasons: Record<string, string>;
        note?: string;
    };
    if (v === undefined || v === null) return empty;
    if (!isPlainObject(v))
        return { ...empty, note: "bindings must be an object — ignoring it" };
    const entries: Array<[string, BindingAction]> = [];
    const dropped: string[] = [];
    const reasons: Record<string, string> = {};
    for (const [k, entry] of Object.entries(v)) {
        const variants = isPlainObject(entry)
            ? BINDING_VARIANTS.filter((name) => name in entry)
            : [];
        if (variants.length > 1) {
            dropped.push(k);
            reasons[k] = `has ${variants.length} binding types (${variants.join(", ")}) — keep exactly one`;
            continue;
        }
        const normalized = normalizeBinding(entry);
        if (normalized) entries.push([k, normalized]);
        else {
            dropped.push(k);
            reasons[k] = isPlainObject(entry)
                ? "invalid binding value"
                : "not an object";
        }
    }
    return { bindings: Object.fromEntries(entries), dropped, reasons };
}

/**
 * Normalize one raw binding: legacy `{ command: "/cmd args" }` splits on
 * the first whitespace run (explicit `args` wins whenever the key is
 * present, even if blank); args edges are trimmed, interior kept
 * verbatim. Returns null when the entry is not a well-shaped binding.
 */
function normalizeBinding(v: unknown): BindingAction | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if ("command" in o && typeof o.command === "string") {
        const text = o.command.trim();
        const ws = text.search(/\s/);
        const head = ws === -1 ? text : text.slice(0, ws);
        const embedded = ws === -1 ? "" : text.slice(ws).trim();
        if (validateCommand(head) !== null) return null;
        const explicit = "args" in o ? o.args : undefined;
        if (explicit !== undefined && typeof explicit !== "string") {
            return null;
        }
        // Explicit args win over the embedded remainder whenever present,
        // including when they are blank — `args: ""` means "no args".
        const args = explicit !== undefined ? explicit.trim() : embedded;
        return args ? { command: head, args } : { command: head };
    }
    return isBindingAction(v) ? (v as BindingAction) : null;
}

const LEADER_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const LEADER_KEY_NAMES = new Set([
    "escape", "esc", "space", "tab", "enter", "return", "backspace",
    "insert", "delete", "clear", "home", "end",
    "pageup", "pagedown", "up", "down", "left", "right",
]);

/**
 * Validate a leader key binding the way pi-tui's parseKeyId reads it:
 * modifier prefixes from a fixed set plus a final key name. pi ignores
 * unknown modifiers and never matches an empty key, so a typo'd leaderKey
 * registers a shortcut that silently never fires — catch it at load.
 * Returns an error code ("empty" | "bad-modifier" | "bad-key") or null.
 */
export function validateLeaderKey(raw: unknown): string | null {
    if (typeof raw !== "string") return "empty";
    const parts = raw.trim().toLowerCase().split("+");
    const key = parts[parts.length - 1] ?? "";
    if (raw.trim().length === 0 || parts.length === 1) return "empty";
    for (const mod of parts.slice(0, -1)) {
        if (!LEADER_MODIFIERS.has(mod)) return "bad-modifier";
    }
    if (!key || (!LEADER_KEY_NAMES.has(key) && !/^[a-z0-9]$/.test(key)))
        return "bad-key";
    return null;
}

function positiveMs(raw: unknown, fallback: number): number {
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? raw
        : fallback;
}

export function loadConfig(path: string = CONFIG_PATH): ConfigResult {
    const defaults = { ...DEFAULT_CONFIG, bindings: {} };
    const blank = { config: defaults, dropped: [], reasons: {}, notes: [] };
    try {
        if (!existsSync(path))
            return { ...blank, error: "missing" };
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!isPlainObject(parsed))
            return {
                ...blank,
                error: "shape",
                notes: ["top level is not a JSON object — using defaults"],
            };
        const { bindings, dropped, reasons, note } = sanitizeBindings(
            parsed.bindings,
        );
        const notes = note ? [note] : [];
        const leaderKeyError = validateLeaderKey(parsed.leaderKey);
        if (parsed.leaderKey !== undefined && leaderKeyError !== null)
            notes.push(
                `leaderKey ${JSON.stringify(parsed.leaderKey)} is not a key pi can match — using ${DEFAULT_CONFIG.leaderKey}`,
            );
        return {
            config: {
                leaderKey:
                    leaderKeyError === null
                        ? (parsed.leaderKey as string)
                        : DEFAULT_CONFIG.leaderKey,
                leaderTimeoutMs: positiveMs(
                    parsed.leaderTimeoutMs,
                    DEFAULT_CONFIG.leaderTimeoutMs,
                ),
                sequenceTimeoutMs: positiveMs(
                    parsed.sequenceTimeoutMs,
                    DEFAULT_CONFIG.sequenceTimeoutMs,
                ),
                // Configs from the spinner era may still carry editorEffect: "spinner";
                // anything that isn't "none" falls back to the default (grayedOut).
                editorEffect:
                    parsed.editorEffect === "none"
                        ? "none"
                        : DEFAULT_CONFIG.editorEffect,
                bindings,
            },
            error: null,
            dropped,
            reasons,
            notes,
        };
    } catch {
        return { ...blank, error: "parse" };
    }
}

// ---------------------------------------------------------------------------
// First-run config bootstrap
// ---------------------------------------------------------------------------

/** Pretty-printed blank config — the template written on first startup. */
export function defaultConfigJson(): string {
    return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}

export type EnsureConfigResult = "created" | "exists" | "error";

/**
 * Write the default config on first startup. Guarded: never touches an
 * existing file (even an invalid one), and a failed write just reports —
 * loadConfig's in-memory defaults keep the extension working.
 */
export function ensureConfig(path: string = CONFIG_PATH): EnsureConfigResult {
    if (existsSync(path)) return "exists";
    try {
        writeFileSync(path, defaultConfigJson());
        return "created";
    } catch {
        return "error";
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Decide whether a command dispatch should restore the user's pre-dispatch
 * editor draft. Restore when the command handler left nothing behind
 * (built-in commands clear the editor themselves) or only the command text
 * (extension commands on the idle path don't clear) — anything else is the
 * handler's deliberate output and wins.
 */
export function shouldRestoreDraft(
    afterText: string,
    command: string,
): boolean {
    const after = afterText.trim();
    return after === "" || after === command.trim();
}

// ---------------------------------------------------------------------------
// Command discovery menu (/leader-commands)
// ---------------------------------------------------------------------------

/**
 * Structural shape of a pi.getCommands() entry (see pi's docs/extensions.md).
 * Declared here so this module loads standalone under the test runner —
 * the handler passes pi's objects straight in, no import needed.
 */
export interface PiCommand {
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo: {
        path: string;
        source: string;
        scope: "user" | "project" | "temporary";
        origin: "package" | "top-level";
        baseDir?: string;
    };
}

export interface CommandMenuEntry {
    /** Exact invokable name (without leading slash), echoed on selection. */
    value: string;
    /** Display line: /name */
    label: string;
    /** Provenance + description: "extension — View the oracle" */
    description: string;
}

/** Map getCommands() output to picker entries, preserving pi's native order. */
export function buildCommandMenu(commands: PiCommand[]): CommandMenuEntry[] {
    return commands.map((c) => ({
        value: c.name,
        label: `/${c.name}`,
        description: [c.source, c.description].filter(Boolean).join(" — "),
    }));
}

// ---------------------------------------------------------------------------
// Key matching
// ---------------------------------------------------------------------------

export function isPrintableKey(data: string): boolean {
    if (data.length === 1) {
        const code = data.charCodeAt(0);
        return code >= 32 && code <= 126;
    }
    return false;
}

/** Proper prefix: candidate is longer than prefix and starts with it. */
export function isProperPrefix(prefix: string, candidate: string): boolean {
    if (prefix.length === 0) return false;
    return candidate.startsWith(prefix) && candidate.length > prefix.length;
}

// ---------------------------------------------------------------------------
// Dispatch planning + exec output sanitizing
// ---------------------------------------------------------------------------

/**
 * What a binding means, decided without touching pi. index.ts only
 * executes the plan, so the routing rules stay testable.
 */
export type DispatchPlan =
    | { kind: "command"; text: string }
    | { kind: "action"; action: "compact" | "shutdown" | "clearEditor" }
    | { kind: "exec"; cmd: string }
    | { kind: "unknown" };

export function dispatchPlan(binding: BindingAction): DispatchPlan {
    if (!isBindingAction(binding)) return { kind: "unknown" };
    if ("command" in binding)
        return { kind: "command", text: composeCommand(binding) };
    if ("action" in binding) return { kind: "action", action: binding.action };
    return { kind: "exec", cmd: binding.exec };
}

/**
 * CSI, OSC and two-byte escapes, so a shell command's output can't move the
 * cursor, recolor the transcript, or rewrite the terminal title when it is
 * echoed back into the session.
 */
const ANSI_RE = new RegExp(
    [
        "[\\u001B\\u009B]\\[[0-9;?]*[ -/]*[@-~]", // CSI ... final byte
        "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", // OSC ... BEL or ST
        "\\u001B[@-Z\\\\-_]", // two-byte escapes
        "\\u001B.", // any other escape
    ].join("|"),
    "g",
);

/** Strip terminal control sequences from command output. */
export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
}

/** Strip control sequences, drop carriage returns, and cap the length. */
export function capOutput(s: string, limit = 2000): string {
    const clean = stripAnsi(s).replace(/\r/g, "").trim();
    return clean.length > limit
        ? `${clean.slice(0, limit)}\n… (${clean.length - limit} more characters)`
        : clean;
}

/**
 * Sequence matching engine — pure function that determines the result
 * of a keypress given the current buffer and bindings.
 *
 * Returns:
 *   { action: "fire", key }        — dispatch immediately
 *   { action: "wait", exact }      — start/keep the sequence timer;
 *                                    exact means an exact match is also a
 *                                    prefix (fire after the timeout), false
 *                                    means prefix-only (dismiss after it)
 *   { action: "dismiss" }          — dead end, dismiss
 */
export type SeqResult =
    | { action: "fire"; key: string }
    | { action: "wait"; exact: boolean }
    | { action: "dismiss" };

export function processKey(
    buffer: string,
    bindings: Record<string, BindingAction>,
): SeqResult {
    const exact = Object.hasOwn(bindings, buffer);
    const isPrefixOfAnother = Object.keys(bindings).some((k) =>
        isProperPrefix(buffer, k),
    );

    if (exact && !isPrefixOfAnother) return { action: "fire", key: buffer };
    if (exact && isPrefixOfAnother) return { action: "wait", exact: true };
    if (!exact && isPrefixOfAnother) return { action: "wait", exact: false };
    return { action: "dismiss" };
}

// ---------------------------------------------------------------------------
// Binding wizard — sequence validation, conflict detection, merging
// ---------------------------------------------------------------------------

/**
 * Validate a sequence typed in the binding wizard. Returns an error code
 * ("empty" | "whitespace" | "non-printable") or null when valid.
 */
export function validateSequence(raw: string): string | null {
    const seq = raw.trim();
    if (seq.length === 0) return "empty";
    if (/\s/.test(seq)) return "whitespace";
    for (const ch of seq) {
        if (!isPrintableKey(ch)) return "non-printable";
    }
    return null;
}

/**
 * Keys that collide with `seq` under the runtime matching rules: an exact
 * match, or a proper-prefix relation in either direction (a new prefix
 * would force an existing binding behind a timeout, and vice versa).
 */
export function findConflicts(
    bindings: Record<string, BindingAction>,
    seq: string,
): string[] {
    const conflicts: string[] = [];
    for (const key of Object.keys(bindings)) {
        if (
            key === seq ||
            isProperPrefix(seq, key) ||
            isProperPrefix(key, seq)
        ) {
            conflicts.push(key);
        }
    }
    return conflicts;
}

/**
 * Return a NEW config with `bindings[seq]` set to `binding` — input is
 * never mutated. Replacing an existing key keeps its position; other keys
 * and all non-binding fields are preserved.
 */
export function mergeBinding(
    config: LeaderConfig,
    seq: string,
    binding: BindingAction,
): LeaderConfig {
    return { ...config, bindings: { ...config.bindings, [seq]: binding } };
}

// ---------------------------------------------------------------------------
// Config persistence (binding wizard)
// ---------------------------------------------------------------------------

export type SaveResult = { ok: true } | { ok: false; error: string };

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Merge one binding into the config file on disk: read → merge → write.
 * A corrupt or unreadable existing file is never overwritten (a failed
 * write must not lose user config); the result object carries the error
 * so the caller decides how to surface it.
 */
/**
 * Merge one binding into the config file on disk: read → merge → write.
 *
 * The merge is done against the RAW parsed file, not the normalized
 * config, so fields this version doesn't model (and bindings it can't
 * parse) survive a save instead of being silently deleted. The write goes
 * to a temp file and is renamed into place, so an interrupted write can't
 * leave a truncated config. A corrupt or unreadable existing file is never
 * overwritten; the result object carries the error so the caller decides
 * how to surface it.
 */
export function saveBinding(
    seq: string,
    binding: BindingAction,
    path: string = CONFIG_PATH,
): SaveResult {
    let raw: Record<string, unknown> = {};
    if (existsSync(path)) {
        let text: string;
        try {
            text = readFileSync(path, "utf-8");
        } catch (err) {
            return {
                ok: false,
                error: `cannot read config file: ${describe(err)}`,
            };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return {
                ok: false,
                error: "config file is not valid JSON — fix or remove it first",
            };
        }
        if (!isPlainObject(parsed))
            return {
                ok: false,
                error: "config file is not a JSON object — fix or remove it first",
            };
        raw = parsed;
    }
    const existing = isPlainObject(raw.bindings) ? raw.bindings : {};
    const next = {
        ...raw,
        // Object.fromEntries defines keys instead of assigning them, so a
        // sequence named `__proto__` stays an ordinary binding.
        bindings: Object.fromEntries([
            ...Object.entries(existing),
            [seq, binding],
        ]),
    };
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        renameSync(tmp, path);
        return { ok: true };
    } catch (err) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            // best effort — the original file is untouched either way
        }
        return { ok: false, error: describe(err) };
    }
}
