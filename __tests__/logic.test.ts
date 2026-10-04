/**
 * Tests for the leader-key extension's pure logic.
 *
 * Run: npx tsx __tests__/logic.test.ts
 *   or: node --import tsx __tests__/logic.test.ts
 *
 * Imports the real implementation from logic.ts (kept pi-import-free
 * so it loads standalone under tsx) — no mirrored copies.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DEFAULT_CONFIG,
    buildCommandMenu,
    defaultConfigJson,
    ensureConfig,
    composeCommand,
    isBindingAction,
    isProperPrefix,
    validateCommand,
    isPrintableKey,
    loadConfig,
    processKey,
    capOutput,
    dispatchPlan,
    stripAnsi,
    validateLeaderKey,
    type BindingAction,
    type CommandBinding,
    type LeaderConfig,
    findConflicts,
    mergeBinding,
    shouldRestoreDraft,
    saveBinding,
    validateSequence,
    type PiCommand,
    type MountedEditor,
    focusedEditor,
    isMountedEditor,
    leaderIndicator,
    renderEditor,
} from "../logic.ts";

// Isolated temp config dir — the suite never touches the user's real config.
// Unique per process: recursive mkdirSync returns undefined for pre-existing
// dirs, so reusing a name would crash line 39 on the second run.
const CONFIG_DIR = join(tmpdir(), `leader-key-test-${process.pid}`);
mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = join(CONFIG_DIR, "leader-key.json");

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${label}`);
    }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${label}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

function section(title: string): void {
    console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// isPrintableKey
// ---------------------------------------------------------------------------

section("isPrintableKey");

// Printable ASCII
assert(isPrintableKey("a"), "lowercase a");
assert(isPrintableKey("z"), "lowercase z");
assert(isPrintableKey("A"), "uppercase A");
assert(isPrintableKey("Z"), "uppercase Z");
assert(isPrintableKey("0"), "digit 0");
assert(isPrintableKey("9"), "digit 9");
assert(isPrintableKey(" "), "space");
assert(isPrintableKey("!"), "exclamation");
assert(isPrintableKey("~"), "tilde");
assert(isPrintableKey("."), "dot");
assert(isPrintableKey("-"), "dash");
assert(isPrintableKey("_"), "underscore");

// Non-printable
assert(!isPrintableKey("\x1b"), "escape char");
assert(!isPrintableKey("\x01"), "ctrl-a");
assert(!isPrintableKey("\x7f"), "DEL");
assert(!isPrintableKey("\t"), "tab");
assert(!isPrintableKey("\n"), "newline");
assert(!isPrintableKey("\r"), "carriage return");

// Multi-byte / special
assert(!isPrintableKey("\x1b[A"), "up arrow escape sequence");
assert(!isPrintableKey("ab"), "two chars");
assert(!isPrintableKey(""), "empty string");

// Unicode letters (multi-byte UTF-8) — note: restricted to ASCII 32-126
assert(!isPrintableKey("é"), "e-acute is outside ASCII range");

// ---------------------------------------------------------------------------
// isPrefix
// ---------------------------------------------------------------------------

section("isProperPrefix");

assert(isProperPrefix("g", "gs"), "'g' is proper prefix of 'gs'");
assert(isProperPrefix("g", "gd"), "'g' is proper prefix of 'gd'");
assert(isProperPrefix("ga", "gab"), "'ga' is proper prefix of 'gab'");
assert(isProperPrefix("foo", "foobar"), "'foo' is proper prefix of 'foobar'");

assert(!isProperPrefix("g", "g"), "identical strings => not a proper prefix");
assert(!isProperPrefix("gs", "g"), "longer is not prefix of shorter");
assert(!isProperPrefix("a", "b"), "unrelated strings");
assert(!isProperPrefix("ga", "gb"), "partial match but not prefix");
assert(!isProperPrefix("", "a"), "empty string is not a prefix");

// ---------------------------------------------------------------------------
// processKey — the 4 cases
// ---------------------------------------------------------------------------

section("processKey — unique exact match => fire immediately");

{
    const bindings: Record<string, BindingAction> = {
        w: { command: "/model" },
        q: { action: "shutdown" },
        n: { exec: "true" },
    };
    assertEq(
        processKey("w", bindings),
        { action: "fire", key: "w" },
        "single key 'w'",
    );
    assertEq(
        processKey("q", bindings),
        { action: "fire", key: "q" },
        "single key 'q'",
    );
    assertEq(
        processKey("n", bindings),
        { action: "fire", key: "n" },
        "single key 'n'",
    );
}

section("processKey — exact match that is also a prefix => wait, exact");

{
    const bindings = {
        g: { command: "/git" },
        gs: { exec: "git status" },
        gd: { exec: "git diff" },
    };
    assertEq(
        processKey("g", bindings),
        { action: "wait", exact: true },
        "'g' matches but 'gs'/'gd' exist",
    );
}

{
    const bindings = { f: { command: "/fork" }, foo: { command: "/fork:all" } };
    assertEq(
        processKey("f", bindings),
        { action: "wait", exact: true },
        "'f' matches but 'foo' exists",
    );
}

section("processKey — partial match only (prefix, not exact) => wait");

{
    const bindings = { gs: { exec: "git status" }, gd: { exec: "git diff" } }; // no "g" by itself
    assertEq(
        processKey("g", bindings),
        { action: "wait", exact: false },
        "'g' is prefix of 'gs'/'gd', no exact 'g'",
    );
}

{
    const bindings = { abc: { command: "/abc" }, abd: { command: "/abd" } };
    assertEq(
        processKey("a", bindings),
        { action: "wait", exact: false },
        "'a' is prefix of 'abc'/'abd'",
    );
    assertEq(
        processKey("ab", bindings),
        { action: "wait", exact: false },
        "'ab' is prefix of 'abc'/'abd'",
    );
}

section("processKey — dead end => dismiss");

{
    const bindings: Record<string, BindingAction> = {
        w: { command: "/model" },
        q: { action: "shutdown" },
    };
    assertEq(
        processKey("x", bindings),
        { action: "dismiss" },
        "'x' not in bindings, not a prefix",
    );
    assertEq(
        processKey("z", bindings),
        { action: "dismiss" },
        "'z' not in bindings",
    );
    assertEq(
        processKey("wa", bindings),
        { action: "dismiss" },
        "'wa' not a prefix of anything",
    );
}

section("processKey — multi-key sequences accumulate correctly");

{
    // Simulate: leader → g → s
    const bindings = {
        gs: { exec: "git status" },
        gd: { exec: "git diff" },
        w: { command: "/model" },
    };
    assertEq(
        processKey("g", bindings),
        { action: "wait", exact: false },
        "step 1: after 'g', waiting",
    );
    assertEq(
        processKey("gs", bindings),
        { action: "fire", key: "gs" },
        "step 2: after 'gs', fire",
    );
}

{
    // Simulate: leader → g → z (dead end)
    const bindings = { gs: { exec: "git status" }, gd: { exec: "git diff" } };
    assertEq(
        processKey("g", bindings),
        { action: "wait", exact: false },
        "step 1: after 'g', waiting",
    );
    assertEq(
        processKey("gz", bindings),
        { action: "dismiss" },
        "step 2: 'gz' is dead end",
    );
}

{
    // Simulate: leader → a → b → c
    const bindings = {
        abc: { command: "/abc" },
        abd: { command: "/abd" },
        xyz: { command: "/xyz" },
    };
    assertEq(
        processKey("a", bindings),
        { action: "wait", exact: false },
        "'a' is prefix of 'abc'/'abd'",
    );
    assertEq(
        processKey("ab", bindings),
        { action: "wait", exact: false },
        "'ab' is prefix of 'abc'/'abd'",
    );
    assertEq(
        processKey("abc", bindings),
        { action: "fire", key: "abc" },
        "'abc' is exact, not a prefix of anything longer",
    );
}

section("processKey — edge cases");

{
    // Empty bindings
    const bindings: Record<string, BindingAction> = {};
    assertEq(
        processKey("a", bindings),
        { action: "dismiss" },
        "any key in empty bindings => dismiss",
    );
    assertEq(
        processKey("", bindings),
        { action: "dismiss" },
        "empty buffer in empty bindings => dismiss",
    );
}

{
    // Single binding
    const bindings = { x: { command: "/model" } };
    assertEq(
        processKey("x", bindings),
        { action: "fire", key: "x" },
        "only binding matches",
    );
    assertEq(
        processKey("y", bindings),
        { action: "dismiss" },
        "non-matching in single binding",
    );
}

{
    // Numbers as keys (e.g. binding "0" for something)
    const bindings = {
        "0": { command: "/zero" },
        "1": { command: "/one" },
        "10": { command: "/ten" },
    };
    assertEq(
        processKey("1", bindings),
        { action: "wait", exact: true },
        "'1' matches but '10' is a prefix extension",
    );
    assertEq(
        processKey("10", bindings),
        { action: "fire", key: "10" },
        "'10' is unique exact",
    );
    assertEq(
        processKey("0", bindings),
        { action: "fire", key: "0" },
        "'0' is unique exact",
    );
}

{
    // Many keys sharing prefix
    const bindings: Record<string, BindingAction> = {};
    for (const k of ["ga", "gb", "gc", "gd", "ge", "gf", "gg", "gh"]) {
        bindings[k] = { command: `/${k}` };
    }
    assertEq(
        processKey("g", bindings),
        { action: "wait", exact: false },
        "'g' prefix of 8 bindings",
    );
    assertEq(
        processKey("ga", bindings),
        { action: "fire", key: "ga" },
        "'ga' is exact and not a prefix",
    );
    assertEq(
        processKey("gz", bindings),
        { action: "dismiss" },
        "'gz' not a prefix",
    );
}

// ---------------------------------------------------------------------------
// buildCommandMenu (/leader-commands discovery)
// ---------------------------------------------------------------------------

section("buildCommandMenu");

function cmd(
    overrides: Partial<PiCommand> & Pick<PiCommand, "name">,
): PiCommand {
    return {
        source: "extension",
        sourceInfo: {
            path: "/tmp/x.ts",
            source: "test",
            scope: "user",
            origin: "top-level",
        },
        ...overrides,
    };
}

{
    const menu = buildCommandMenu([
        cmd({ name: "om:view", description: "View the oracle" }),
        cmd({ name: "reload", source: "prompt" }),
        cmd({
            name: "review:1",
            source: "skill",
            description: "Review changes",
        }),
        cmd({ name: "review:2", source: "skill" }),
    ]);

    assertEq(menu.length, 4, "one entry per command");
    // Order preserved (pi's native ordering: extensions, templates, skills)
    assertEq(
        menu.map((e) => e.value),
        ["om:view", "reload", "review:1", "review:2"],
        "native order preserved",
    );
    assertEq(menu[0]!.label, "/om:view", "label is the invokable string");
    assertEq(
        menu[0]!.description,
        "extension — View the oracle",
        "description encodes source then description",
    );
    assertEq(
        menu[1]!.description,
        "prompt",
        "description omits absent description",
    );
    assertEq(menu[2]!.value, "review:1", "suffixed duplicate keeps exact name");
    assertEq(
        menu[3]!.description,
        "skill",
        "second suffixed duplicate distinct",
    );
    // value stays verbatim for echoing /name on selection
    assert(
        menu.every((e) => !e.value.includes("/")),
        "values carry no leading slash",
    );
}

{
    assertEq(buildCommandMenu([]), [], "empty command set => empty menu");
}

// ---------------------------------------------------------------------------
// isBindingAction + loadConfig sanitizing (hand-edited config guard)
// ---------------------------------------------------------------------------

section("isBindingAction");

{
    assert(isBindingAction({ command: "/model" }), "valid command");
    assert(
        isBindingAction({ command: "/model", args: "opus" }),
        "command with split args",
    );
    assert(
        !isBindingAction({ command: "/model opus" }),
        "embedded-args command rejected at guard (sanitize splits it)",
    );
    assert(
        !isBindingAction({ command: "/model", args: 123 }),
        "non-string args rejected",
    );
    assert(isBindingAction({ action: "compact" }), "valid action compact");
    assert(isBindingAction({ action: "shutdown" }), "valid action shutdown");
    assert(
        isBindingAction({ action: "clearEditor" }),
        "valid action clearEditor",
    );
    assert(isBindingAction({ exec: "git status" }), "valid exec");
    assert(!isBindingAction(null), "null rejected");
    assert(!isBindingAction("x"), "string rejected");
    assert(!isBindingAction([]), "array rejected");
    assert(!isBindingAction({}), "empty object rejected");
    assert(!isBindingAction({ command: 123 }), "non-string command rejected");
    assert(!isBindingAction({ command: "  " }), "blank command rejected");
    assert(!isBindingAction({ action: "bogus" }), "unknown action rejected");
    assert(!isBindingAction({ exec: "" }), "blank exec rejected");

    // Malformed entries never reach dispatch: valid survive, rest dropped.
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            bindings: {
                ok: { command: "/model" },
                nul: null,
                empty: {},
                bad: { action: "bogus" },
            },
        }),
    );
    const r = loadConfig(CONFIG_PATH);
    assertEq(Object.keys(r.config.bindings), ["ok"], "invalid dropped");
}

section("validateCommand");

{
    assertEq(validateCommand("/model"), null, "bare command valid");
    assertEq(validateCommand("  /model  "), null, "edges trimmed");
    assertEq(validateCommand(""), "empty", "empty rejected");
    assertEq(validateCommand("   "), "empty", "blank rejected");
    assertEq(validateCommand("/"), "lone-slash", "lone slash rejected");
    assertEq(
        validateCommand("model"),
        "missing-slash",
        "missing leading slash rejected",
    );
    assertEq(
        validateCommand("/mo del"),
        "whitespace",
        "interior whitespace rejected",
    );
}

section("legacy embedded-args normalization");

{
    // Old shape keeps loading: split on the first space, trim both parts.
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            bindings: {
                legacy: { command: "/model opus" },
                split: { command: "/model", args: "opus" },
            },
        }),
    );
    const r = loadConfig(CONFIG_PATH);
    assertEq(
        r.config.bindings.legacy,
        { command: "/model", args: "opus" },
        "legacy embedded args split",
    );
    assertEq(
        r.config.bindings.split,
        { command: "/model", args: "opus" },
        "split form preserved",
    );
    // Both are command bindings; the cast just satisfies the narrower signature.
    assertEq(
        composeCommand(r.config.bindings.legacy as CommandBinding),
        composeCommand(r.config.bindings.split as CommandBinding),
        "both forms dispatch identically",
    );

    // Args are opaque: interior whitespace preserved, edges trimmed.
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            bindings: { q: { command: "/ask", args: "  a  b  " } },
        }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.bindings.q,
        { command: "/ask", args: "a  b" },
        "args edges trimmed, interior kept",
    );
}

section("dropped bindings");

{
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            bindings: {
                ok: { command: "/model" },
                nul: null,
                empty: {},
                bad: { action: "bogus" },
            },
        }),
    );
    const r = loadConfig(CONFIG_PATH);
    assertEq(r.dropped, ["nul", "empty", "bad"], "dropped keys reported");
    assertEq(Object.keys(r.config.bindings), ["ok"], "valid binding survives");

    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ bindings: { ok: { command: "/model" } } }),
    );
    assertEq(loadConfig(CONFIG_PATH).dropped, [], "clean config drops none");

    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    assertEq(loadConfig(CONFIG_PATH).dropped, [], "missing file drops none");
}

section("composeCommand");

{
    assertEq(
        composeCommand({ command: "/model" }),
        "/model",
        "no args composes bare",
    );
    assertEq(
        composeCommand({ command: "/model", args: "opus" }),
        "/model opus",
        "args appended with single space",
    );
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

section("Config loading");

{
    // Test: missing config => defaults, reported as "missing" (normal)
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    const r1 = loadConfig(CONFIG_PATH);
    assertEq(r1.error, "missing", "missing config reports 'missing'");
    assertEq(
        r1.config.leaderKey,
        DEFAULT_CONFIG.leaderKey,
        "default leaderKey",
    );
    assertEq(
        r1.config.leaderTimeoutMs,
        DEFAULT_CONFIG.leaderTimeoutMs,
        "default leaderTimeoutMs",
    );
    assertEq(
        r1.config.sequenceTimeoutMs,
        DEFAULT_CONFIG.sequenceTimeoutMs,
        "default sequenceTimeoutMs",
    );
    assertEq(r1.config.bindings, {}, "default empty bindings");
    assertEq(r1.config.editorEffect, "grayedOut", "default editorEffect");

    // Test: valid config
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            leaderKey: "ctrl+b",
            leaderTimeoutMs: 5000,
            sequenceTimeoutMs: 1000,
            bindings: { w: { command: "/model" } },
        }),
    );
    const r2 = loadConfig(CONFIG_PATH);
    assertEq(r2.error, null, "valid config has no error");
    assertEq(r2.config.leaderKey, "ctrl+b", "custom leaderKey");
    assertEq(r2.config.leaderTimeoutMs, 5000, "custom leaderTimeoutMs");
    assertEq(r2.config.sequenceTimeoutMs, 1000, "custom sequenceTimeoutMs");
    assert(
        typeof r2.config.bindings === "object" && r2.config.bindings !== null,
        "bindings is object",
    );
    assert("w" in r2.config.bindings, "binding 'w' exists");

    // Test: editorEffect field
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            editorEffect: "grayedOut",
            bindings: { a: {} },
        }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.editorEffect,
        "grayedOut",
        "custom editorEffect grayedOut",
    );

    // Test: explicit "none" is the only other supported value
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            editorEffect: "none",
            bindings: { a: {} },
        }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.editorEffect,
        "none",
        "custom editorEffect none",
    );

    // Test: spinner-era config with editorEffect "spinner" coerces to default grayedOut
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            editorEffect: "spinner",
            spinnerName: "aurora",
            bindings: { b: {} },
        }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.editorEffect,
        "grayedOut",
        "spinner-era editorEffect coerces to grayedOut",
    );

    // Test: partial config (some fields missing)
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            bindings: { x: { command: "/model" } },
        }),
    );
    const r3 = loadConfig(CONFIG_PATH);
    assertEq(r3.config.leaderKey, "ctrl+space", "missing leaderKey => default");
    assertEq(
        r3.config.leaderTimeoutMs,
        3600,
        "missing leaderTimeoutMs => default",
    );
    assert("x" in r3.config.bindings, "partial config bindings preserved");

    // Test: wrong-typed fields => rejected to defaults (hand-edited config is
    // an untyped text file; garbage must not reach setTimeout/registerShortcut)
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
            leaderKey: 123,
            leaderTimeoutMs: true,
            sequenceTimeoutMs: "750",
        }),
    );
    const rType = loadConfig(CONFIG_PATH);
    assertEq(
        rType.config.leaderKey,
        DEFAULT_CONFIG.leaderKey,
        "non-string leaderKey => default",
    );
    assertEq(
        rType.config.leaderTimeoutMs,
        DEFAULT_CONFIG.leaderTimeoutMs,
        "non-number leaderTimeoutMs => default",
    );
    assertEq(
        rType.config.sequenceTimeoutMs,
        DEFAULT_CONFIG.sequenceTimeoutMs,
        "non-number sequenceTimeoutMs => default",
    );

    // Test: non-positive timeouts => rejected to defaults (setTimeout with
    // <= 0 / NaN collapses to ~1ms, which reads as "leader key is broken")
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ leaderTimeoutMs: -5, sequenceTimeoutMs: 0 }),
    );
    const rNeg = loadConfig(CONFIG_PATH);
    assertEq(
        rNeg.config.leaderTimeoutMs,
        DEFAULT_CONFIG.leaderTimeoutMs,
        "negative leaderTimeoutMs => default",
    );
    assertEq(
        rNeg.config.sequenceTimeoutMs,
        DEFAULT_CONFIG.sequenceTimeoutMs,
        "zero sequenceTimeoutMs => default",
    );

    // Test: invalid JSON => defaults + "parse" error (surfaces on shortcut press)
    writeFileSync(CONFIG_PATH, "not valid json {{{");
    const rParse = loadConfig(CONFIG_PATH);
    assertEq(rParse.error, "parse", "invalid JSON reports 'parse'");
    assertEq(rParse.config.bindings, {}, "invalid JSON => empty bindings");
    assertEq(
        rParse.config.leaderKey,
        "ctrl+space",
        "invalid JSON => default leaderKey",
    );

    // Test: bindings is not an object (array) => treated as empty
    writeFileSync(CONFIG_PATH, JSON.stringify({ bindings: [1, 2, 3] }));
    const rArray = loadConfig(CONFIG_PATH);
    assertEq(rArray.config.bindings, {}, "array bindings treated as empty");

    // Test: empty file
    writeFileSync(CONFIG_PATH, "");
    const rEmpty = loadConfig(CONFIG_PATH);
    assertEq(rEmpty.config.bindings, {}, "empty file => empty bindings");
    assertEq(rEmpty.error, "parse", "empty file reports 'parse'");

    // Test: valid JSON with no bindings => no error, empty bindings
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    const rEmptyValid = loadConfig(CONFIG_PATH);
    assertEq(rEmptyValid.error, null, "valid empty config has no error");
    assertEq(
        rEmptyValid.config.bindings,
        {},
        "valid empty config => empty bindings",
    );
}

// ---------------------------------------------------------------------------
// ensureConfig — first-run blank config (guarded)
// ---------------------------------------------------------------------------

section("ensureConfig");

const ENSURE_PATH = join(CONFIG_DIR, "ensure-leader-key.json");

{
    // Missing file => created with blank defaults
    const r = ensureConfig(ENSURE_PATH);
    assertEq(r, "created", "missing file => created");
    const written = JSON.parse(readFileSync(ENSURE_PATH, "utf-8"));
    assertEq(written, DEFAULT_CONFIG, "written content is blank defaults");
    assertEq(written.bindings, {}, "written bindings are empty");

    // Second call => exists, file untouched
    assertEq(ensureConfig(ENSURE_PATH), "exists", "existing file => exists");
    assertEq(
        JSON.parse(readFileSync(ENSURE_PATH, "utf-8")),
        DEFAULT_CONFIG,
        "second call left content unchanged",
    );

    // Existing invalid file => exists, never clobbered
    writeFileSync(ENSURE_PATH, "garbage {{{");
    assertEq(
        ensureConfig(ENSURE_PATH),
        "exists",
        "invalid existing file => exists",
    );
    assertEq(
        readFileSync(ENSURE_PATH, "utf-8"),
        "garbage {{{",
        "invalid file content untouched",
    );

    // Unwritable location (missing parent dir) => error, no throw
    assertEq(
        ensureConfig(join(CONFIG_DIR, "nope", "x.json")),
        "error",
        "unwritable path => error",
    );

    // Template is valid JSON on its own
    assertEq(
        JSON.parse(defaultConfigJson()),
        DEFAULT_CONFIG,
        "template parses",
    );

    rmSync(ENSURE_PATH);
}

{
    // ---------------------------------------------------------------------------
    // validateSequence (binding wizard)
    // ---------------------------------------------------------------------------

    section("validateSequence");

    assertEq(validateSequence(""), "empty", "empty string rejected");
    assertEq(validateSequence("   "), "empty", "whitespace-only rejected");
    assertEq(validateSequence(" gs "), null, "surrounding whitespace trimmed");
    assert(validateSequence("g s") !== null, "internal whitespace rejected");
    assert(validateSequence("gsé") !== null, "non-ASCII rejected");
    assertEq(validateSequence("gs\t"), null, "trailing tab trimmed away");
    assertEq(validateSequence("\t"), "empty", "tab-only rejected");
    assertEq(validateSequence("gs"), null, "valid multi-key accepted");
    assertEq(validateSequence("c"), null, "valid single key accepted");

    // ---------------------------------------------------------------------------
    // findConflicts (binding wizard)
    // ---------------------------------------------------------------------------

    section("findConflicts");

    const conflictBindings: Record<string, BindingAction> = {
        c: { action: "compact" },
        gs: { exec: "git status" },
    };

    assertEq(
        findConflicts(conflictBindings, "gs"),
        ["gs"],
        "exact match detected",
    );
    assertEq(
        findConflicts(conflictBindings, "g"),
        ["gs"],
        "new sequence is proper prefix of existing",
    );
    assertEq(
        findConflicts(conflictBindings, "gst"),
        ["gs"],
        "existing key is proper prefix of new sequence",
    );
    assertEq(
        findConflicts(conflictBindings, "gd"),
        [],
        "unrelated sequence clean",
    );
    assertEq(findConflicts({}, "gs"), [], "empty bindings clean");

    // ---------------------------------------------------------------------------
    // mergeBinding (binding wizard)
    // ---------------------------------------------------------------------------

    section("mergeBinding");

    const baseConfig: LeaderConfig = {
        ...DEFAULT_CONFIG,
        bindings: { c: { action: "compact" }, gs: { exec: "git status" } },
    };

    const merged = mergeBinding(baseConfig, "gd", { exec: "git diff" });
    assertEq(Object.keys(merged.bindings).length, 3, "merge adds a binding");
    assertEq(merged.bindings.gd, { exec: "git diff" }, "new binding present");
    assertEq(
        merged.bindings.c,
        { action: "compact" },
        "existing binding preserved",
    );
    assertEq(
        baseConfig.bindings.gd,
        undefined,
        "input config not mutated (add)",
    );
    assertEq(
        merged.leaderKey,
        baseConfig.leaderKey,
        "non-binding fields preserved",
    );

    const replaced = mergeBinding(baseConfig, "gs", { command: "/status" });
    assertEq(
        Object.keys(replaced.bindings).length,
        2,
        "merge replaces, does not duplicate",
    );
    assertEq(
        replaced.bindings.gs,
        { command: "/status" },
        "replaced value present",
    );
    assertEq(
        baseConfig.bindings.gs,
        { exec: "git status" },
        "input config not mutated (replace)",
    );
    assertEq(
        Object.keys(replaced.bindings)[0],
        "c",
        "replaced key keeps its original position",
    );
} // end temp-scope bindings

// ---------------------------------------------------------------------------
// saveBinding (binding wizard — config persistence)
// ---------------------------------------------------------------------------

section("saveBinding");

{
    const SAVE_PATH = join(CONFIG_DIR, "save-binding.json");
    if (existsSync(SAVE_PATH)) unlinkSync(SAVE_PATH);

    // Missing file: create it with the new binding over defaults
    const r1 = saveBinding("gh", { exec: "git log" }, SAVE_PATH);
    assertEq(r1.ok, true, "save to missing file succeeds");
    assertEq(
        loadConfig(SAVE_PATH).config.bindings.gh,
        { exec: "git log" },
        "missing-file save writes the binding",
    );

    // Existing file: merge, preserve everything else
    writeFileSync(
        SAVE_PATH,
        JSON.stringify({
            leaderKey: "ctrl+b",
            bindings: { c: { action: "compact" }, gs: { exec: "git status" } },
        }),
    );
    const r2 = saveBinding("gd", { exec: "git diff" }, SAVE_PATH);
    assertEq(r2.ok, true, "save to existing file succeeds");
    const reloaded = loadConfig(SAVE_PATH).config;
    assertEq(
        reloaded.bindings.gd,
        { exec: "git diff" },
        "new binding persisted",
    );
    assertEq(
        reloaded.bindings.gs,
        { exec: "git status" },
        "prior bindings intact",
    );
    assertEq(reloaded.leaderKey, "ctrl+b", "non-binding fields intact");

    // Overwrite an existing sequence
    const r3 = saveBinding("gs", { command: "/branch" }, SAVE_PATH);
    assertEq(r3.ok, true, "overwrite succeeds");
    assertEq(
        loadConfig(SAVE_PATH).config.bindings.gs,
        { command: "/branch" },
        "overwritten binding persisted",
    );

    // Corrupt file: refuse to write, leave it byte-identical
    const corrupt = "{ not json";
    writeFileSync(SAVE_PATH, corrupt);
    const r4 = saveBinding("gx", { exec: "x" }, SAVE_PATH);
    assertEq(r4.ok, false, "corrupt config refuses to save");
    assertEq(
        readFileSync(SAVE_PATH, "utf-8"),
        corrupt,
        "corrupt file untouched",
    );

    // Unwritable path: reports failure, nothing thrown
    const r5 = saveBinding(
        "gx",
        { exec: "x" },
        join(CONFIG_DIR, "no", "such", "dir.json"),
    );
    assertEq(r5.ok, false, "unwritable path reports failure");

    unlinkSync(SAVE_PATH);
}

// ---------------------------------------------------------------------------
// shouldRestoreDraft (command dispatch — editor draft save/restore)
// ---------------------------------------------------------------------------

section("shouldRestoreDraft");

{
    // Built-in commands (e.g. /model) clear the editor themselves before
    // running → nothing left behind → restore the draft.
    assert(shouldRestoreDraft("", "/model"), "empty after-text restores draft");
    assert(
        shouldRestoreDraft("   ", "/model"),
        "whitespace-only after-text restores draft",
    );

    // Extension commands on pi's idle path don't clear — the buffer still
    // holds the command text we submitted → restore the draft.
    assert(
        shouldRestoreDraft("/model", "/model"),
        "command text left in editor restores draft",
    );
    assert(
        shouldRestoreDraft(" /model ", "/model"),
        "command text comparison ignores surrounding whitespace",
    );

    // The command handler deliberately left new/meaningful text → it wins,
    // the draft is not restored over it.
    assert(
        !shouldRestoreDraft("pick a model:", "/model"),
        "handler's new text is respected over the draft",
    );

    // Empty draft: restoring "" is a harmless no-op either way.
    assert(
        shouldRestoreDraft("", "/x"),
        "empty draft with empty after restores",
    );

    // Composed command + args: the comparison uses the full submitted string.
    assert(
        shouldRestoreDraft("/model opus", "/model opus"),
        "composed command left in editor restores draft",
    );
    assert(
        !shouldRestoreDraft("opus-4.6", "/model opus"),
        "handler output wins over composed command draft",
    );
}

// ---------------------------------------------------------------------------
// Hostile config shapes
// ---------------------------------------------------------------------------

section("config: prototype-polluting binding key");

{
    const p = join(CONFIG_DIR, "proto.json");
    writeFileSync(
        p,
        `{"bindings":{"__proto__":{"command":"/evil"},"g":{"exec":"true"}}}`,
    );
    const r = loadConfig(p);
    assertEq(r.error, null, "load succeeds");
    assertEq(
        Object.keys(r.config.bindings),
        ["__proto__", "g"],
        "__proto__ is a real own key, not lost",
    );
    assertEq(
        ({} as Record<string, unknown>).command,
        undefined,
        "Object.prototype is untouched",
    );
    assertEq(
        Object.getPrototypeOf(r.config.bindings),
        Object.prototype,
        "bindings keeps a normal prototype",
    );
    assertEq(
        processKey("__proto__", r.config.bindings),
        { action: "fire", key: "__proto__" },
        "the __proto__ sequence still dispatches",
    );
    assertEq(r.dropped, [], "nothing dropped");

    // Round-trips through save without losing or mutating anything.
    assertEq(
        saveBinding("__proto__", { command: "/other" }, p).ok,
        true,
        "saving __proto__ succeeds",
    );
    assertEq(
        ({} as Record<string, unknown>).command,
        undefined,
        "save did not pollute the prototype",
    );
    assertEq(
        loadConfig(p).config.bindings["__proto__"],
        { command: "/other" },
        "saved __proto__ binding reads back",
    );
}

section("config: malformed bindings");

{
    const p = join(CONFIG_DIR, "bad-bindings.json");
    writeFileSync(
        p,
        JSON.stringify({
            bindings: {
                both: { command: "/model", exec: "rm -rf /" },
                tri: { command: "/x", action: "compact", exec: "y" },
                notobj: "nope",
                arr: ["command"],
                empty: {},
                noexec: { exec: "   " },
                unknownkey: { teleport: "now" },
                good: { action: "compact" },
            },
        }),
    );
    const r = loadConfig(p);
    assertEq(r.error, null, "file is valid JSON, no parse error");
    assertEq(Object.keys(r.config.bindings), ["good"], "only the valid binding loads");
    assertEq(
        r.dropped.sort(),
        ["arr", "both", "empty", "noexec", "notobj", "tri", "unknownkey"],
        "every bad entry is reported, never silently dropped",
    );
    assert(
        (r.reasons.both ?? "").includes("2 binding types"),
        `multi-type reason is specific: ${r.reasons.both}`,
    );
    assertEq(r.reasons.notobj, "not an object", "non-object reason");
    assertEq(r.reasons.empty, "invalid binding value", "empty-object reason");
    assertEq(r.reasons.unknownkey, "invalid binding value", "unknown-field reason");
}

section("config: unusable shapes");

{
    const cases: Array<[string, string, string]> = [
        ["null.json", "null", "shape"],
        ["array.json", "[1,2]", "shape"],
        ["string.json", '"hello"', "shape"],
        ["number.json", "42", "shape"],
        ["broken.json", "{oops", "parse"],
    ];
    for (const [name, body, expected] of cases) {
        const p = join(CONFIG_DIR, name);
        writeFileSync(p, body);
        const r = loadConfig(p);
        assertEq(r.error, expected, `${body} reports ${expected}`);
        assertEq(r.config, { ...DEFAULT_CONFIG, bindings: {} }, `${body} falls back to defaults`);
    }

    // bindings present but not an object: no throw, explained in notes
    const p = join(CONFIG_DIR, "string-bindings.json");
    writeFileSync(p, JSON.stringify({ bindings: "nope" }));
    const r = loadConfig(p);
    assertEq(r.error, null, "string bindings is not a parse error");
    assertEq(r.config.bindings, {}, "bindings ignored");
    assert(
        r.notes.some((n) => n.includes("bindings must be an object")),
        `string bindings is explained: ${JSON.stringify(r.notes)}`,
    );

    // explicit null bindings must not throw either
    const p2 = join(CONFIG_DIR, "null-bindings.json");
    writeFileSync(p2, JSON.stringify({ bindings: null }));
    assertEq(loadConfig(p2).error, null, "null bindings is not an error");
}

section("config: numeric validation");

{
    const p = join(CONFIG_DIR, "numbers.json");
    writeFileSync(
        p,
        JSON.stringify({
            leaderTimeoutMs: 1e308 * 10, // Infinity once parsed
            sequenceTimeoutMs: Number.POSITIVE_INFINITY,
            bindings: {},
        }),
    );
    const r = loadConfig(p);
    assertEq(
        r.config.leaderTimeoutMs,
        DEFAULT_CONFIG.leaderTimeoutMs,
        "overflowing leaderTimeoutMs falls back (setTimeout would clamp to 1ms)",
    );
    assertEq(
        r.config.sequenceTimeoutMs,
        DEFAULT_CONFIG.sequenceTimeoutMs,
        "Infinity sequenceTimeoutMs falls back",
    );
    for (const bad of [-1, 0, "1000", null, {}]) {
        writeFileSync(p, JSON.stringify({ leaderTimeoutMs: bad, bindings: {} }));
        assertEq(
            loadConfig(p).config.leaderTimeoutMs,
            DEFAULT_CONFIG.leaderTimeoutMs,
            `leaderTimeoutMs ${JSON.stringify(bad)} falls back`,
        );
    }
    for (const bad of [-1, 0, "750", null]) {
        writeFileSync(p, JSON.stringify({ sequenceTimeoutMs: bad, bindings: {} }));
        assertEq(
            loadConfig(p).config.sequenceTimeoutMs,
            DEFAULT_CONFIG.sequenceTimeoutMs,
            `sequenceTimeoutMs ${JSON.stringify(bad)} falls back`,
        );
    }
}

section("validateLeaderKey");

{
    for (const ok of [
        "ctrl+space",
        "ctrl+b",
        "alt+space",
        "shift+enter",
        "ctrl+shift+p",
        "ctrl+alt+left",
        "super+k",
        "  ctrl+space  ",
        "CTRL+SPACE",
    ])
        assertEq(validateLeaderKey(ok), null, `${ok} is valid`);
    // pi never matches these (empty final key, or an unknown modifier it
    // silently ignores) — the shortcut would never fire.
    assertEq(validateLeaderKey("ctrl+\\"), "bad-key", "ctrl+\\ has no key");
    assertEq(validateLeaderKey(""), "empty", "empty string");
    assertEq(validateLeaderKey("   "), "empty", "whitespace only");
    assertEq(validateLeaderKey(42), "empty", "non-string");
    assertEq(validateLeaderKey("space"), "empty", "no modifier");
    assertEq(validateLeaderKey("contorl+space"), "bad-modifier", "typo'd modifier");
    assertEq(validateLeaderKey("ctrl+nosuchkey"), "bad-key", "unknown key name");
    assertEq(validateLeaderKey("ctrl+enter+"), "bad-modifier", "trailing plus");

    // loadConfig falls back and says why
    const p = join(CONFIG_DIR, "leaderkey.json");
    writeFileSync(p, JSON.stringify({ leaderKey: "ctrl+\\", bindings: {} }));
    const r = loadConfig(p);
    assertEq(r.config.leaderKey, DEFAULT_CONFIG.leaderKey, "unmatchable leaderKey falls back");
    assert(
        r.notes.some((n) => n.includes("leaderKey")),
        `bad leaderKey is reported: ${JSON.stringify(r.notes)}`,
    );
    writeFileSync(p, JSON.stringify({ bindings: {} }));
    assertEq(
        loadConfig(p).notes.length,
        0,
        "an absent leaderKey is not a note",
    );
}

section("command args precedence");

{
    // Explicit args win whenever the key is present, even blank.
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ bindings: { m: { command: "/model opus", args: "" } } }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.bindings.m,
        { command: "/model" },
        `args:"" drops the embedded remainder: ${JSON.stringify(loadConfig(CONFIG_PATH).config.bindings.m)}`,
    );
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ bindings: { m: { command: "/model opus", args: "   " } } }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.bindings.m,
        { command: "/model" },
        "blank args drops the embedded remainder",
    );
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ bindings: { m: { command: "/model opus", args: "sonnet" } } }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).config.bindings.m,
        { command: "/model", args: "sonnet" },
        "explicit args replace the embedded remainder",
    );
    // Non-string args are still rejected outright
    writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ bindings: { m: { command: "/model opus", args: 5 } } }),
    );
    assertEq(
        loadConfig(CONFIG_PATH).dropped,
        ["m"],
        "non-string args drops the binding",
    );
}

section("saveBinding is lossless");

{
    const p = join(CONFIG_DIR, "lossless.json");
    writeFileSync(
        p,
        JSON.stringify(
            {
                leaderKey: "ctrl+b",
                unknownTopLevel: { keep: 1 },
                spinnerName: "dots",
                bindings: {
                    keep: { exec: "true" },
                    handEdited: { teleport: "now" },
                    blank: { exec: "   " },
                    multi: { command: "/x", exec: "y" },
                },
            },
            null,
            2,
        ),
    );
    assertEq(saveBinding("new", { action: "compact" }, p).ok, true, "save succeeds");
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    assertEq(raw.unknownTopLevel, { keep: 1 }, "unknown top-level field survives");
    assertEq(raw.spinnerName, "dots", "legacy spinner field survives");
    assertEq(raw.bindings.keep, { exec: "true" }, "existing binding survives");
    assertEq(
        raw.bindings.handEdited,
        { teleport: "now" },
        "binding this version can't parse survives",
    );
    assertEq(raw.bindings.blank, { exec: "   " }, "invalid binding survives");
    assertEq(
        raw.bindings.multi,
        { command: "/x", exec: "y" },
        "ambiguous binding survives",
    );
    assertEq(raw.bindings.new, { action: "compact" }, "new binding written");
    assertEq(
        loadConfig(p).config.bindings.keep,
        { exec: "true" },
        "and still loads afterwards",
    );
    assertEq(
        readdirSync(CONFIG_DIR).filter((f) => f.includes(".tmp")),
        [],
        "no temp file left behind",
    );

    // No existing file at all
    const fresh = join(CONFIG_DIR, "fresh.json");
    assertEq(saveBinding("g", { exec: "git status" }, fresh).ok, true, "save to missing file");
    assertEq(
        loadConfig(fresh).config.bindings.g,
        { exec: "git status" },
        "binding written to a new file",
    );

    // Top level that isn't an object: refuse, don't destroy
    for (const [body, label] of [
        ["[1,2]", "array"],
        ["null", "null"],
        ['"str"', "string"],
    ] as const) {
        const q = join(CONFIG_DIR, `shape-${label}.json`);
        writeFileSync(q, body);
        const r = saveBinding("g", { exec: "x" }, q);
        assertEq(r.ok, false, `${label} top level refuses the save`);
        assertEq(readFileSync(q, "utf-8"), body, `${label} file left byte-identical`);
    }
}

section("dispatchPlan");

{
    assertEq(
        dispatchPlan({ command: "/model" }),
        { kind: "command", text: "/model" },
        "command plan",
    );
    assertEq(
        dispatchPlan({ command: "/model", args: "opus" }),
        { kind: "command", text: "/model opus" },
        "command plan composes args",
    );
    for (const action of ["compact", "shutdown", "clearEditor"] as const)
        assertEq(
            dispatchPlan({ action }),
            { kind: "action", action },
            `${action} plan`,
        );
    assertEq(
        dispatchPlan({ exec: "git status" }),
        { kind: "exec", cmd: "git status" },
        "exec plan keeps the command verbatim",
    );
    // Unreachable through loadConfig, but the planner is total
    assertEq(
        dispatchPlan({ action: "bogus" } as unknown as BindingAction),
        { kind: "unknown" },
        "malformed binding plans as unknown",
    );
    assertEq(
        dispatchPlan({ exec: "  " } as unknown as BindingAction),
        { kind: "unknown" },
        "blank exec plans as unknown",
    );

    // The command matrix, run through the real planner and the real
    // draft-restore rule (replaces the old hand-mirrored matrix file).
    // Rows are already-normalized bindings: dispatchPlan takes what
    // loadConfig produced, so the legacy embedded form is not its input.
    const matrix: Array<[BindingAction, string]> = [
        [{ command: "/model", args: "opus" }, "/model opus"],
        [{ command: "/om:view", args: "--all" }, "/om:view --all"],
        [{ command: "/review:1" }, "/review:1"],
        [{ command: "/reload", args: "a  b" }, "/reload a  b"],
        [{ command: "/nope-not-real", args: "x" }, "/nope-not-real x"],
        // args are opaque once normalized: edges were trimmed at load,
        // interior spacing is passed through untouched
        [{ command: "/spin-up", args: "a  b" }, "/spin-up a  b"],
    ];
    for (const [binding, expected] of matrix) {
        assertEq(
            dispatchPlan(binding),
            { kind: "command", text: expected },
            `matrix: ${JSON.stringify(binding)} → ${expected}`,
        );
    }
    // An unnormalized value is rejected rather than silently mangled
    assertEq(
        dispatchPlan({ command: "/model  opus" }),
        { kind: "unknown" },
        "matrix: unnormalized legacy form is not dispatched raw",
    );
    // A built-in clears the editor, so the draft comes back; an idle
    // handler leaves the command text, so it does not.
    assertEq(
        shouldRestoreDraft("", "/model opus"),
        true,
        "matrix: cleared editor restores the draft",
    );
    assertEq(
        shouldRestoreDraft("/model opus", "/model opus"),
        true,
        "matrix: untouched command text restores the draft",
    );
    assertEq(
        shouldRestoreDraft("handler output", "/model opus"),
        false,
        "matrix: handler output wins over the draft",
    );
}

// ---------------------------------------------------------------------------
// Mounted editor: detection, focus lookup, gray rendering
// ---------------------------------------------------------------------------

section("isMountedEditor");

/** A stand-in for a mounted editor: renders lines, holds text. */
function fakeEditor(lines: string[] = ["one", "two"]): MountedEditor {
    let text = "";
    return {
        render: (width: number) => lines.map((l) => `${l}:${width}`),
        setText: (value: string) => {
            text = value;
        },
        getText: () => text,
    };
}

assert(isMountedEditor(fakeEditor()), "an editor-shaped object is an editor");
assertEq(isMountedEditor(null), false, "null is not an editor");
assertEq(isMountedEditor(undefined), false, "undefined is not an editor");
assertEq(isMountedEditor("editor"), false, "a string is not an editor");
assertEq(
    isMountedEditor({ render: (w: number) => [`${w}`] }),
    false,
    "render alone is not enough — a selector renders too",
);
assertEq(
    isMountedEditor({ setText: () => {}, getText: () => "" }),
    false,
    "no render means not an editor",
);
assert(
    !isMountedEditor({ render: 1, setText: () => {}, getText: () => "" }),
    "non-function render is rejected",
);
assert(
    isMountedEditor(
        Object.create({
            render: () => [],
            setText: () => {},
            getText: () => "",
        }),
    ),
    "inherited methods count — pi's own editor keeps them on its prototype",
);
section("focusedEditor");

const editor = fakeEditor();
assertEq(
    focusedEditor({ getFocusedComponent: () => editor }),
    editor,
    "focused editor is returned as-is",
);
assertEq(
    focusedEditor({ getFocusedComponent: () => ({ render: () => [] }) }),
    null,
    "a focused non-editor component yields null",
);
assertEq(
    focusedEditor({ getFocusedComponent: () => null }),
    null,
    "no focus yields null",
);
assertEq(
    focusedEditor({ getFocusedComponent: 42 }),
    null,
    "a non-callable getFocusedComponent yields null",
);
assertEq(focusedEditor({}), null, "TUI without the method yields null");
assertEq(focusedEditor(null), null, "null TUI yields null");
assertEq(
    focusedEditor({
        getFocusedComponent(this: { marker: string }) {
            return this.marker === "editor" ? editor : null;
        },
        marker: "editor",
    }),
    editor,
    "getFocusedComponent is called with the TUI as `this`",
);

section("leaderIndicator");

assertEq(
    leaderIndicator("grayedOut", true),
    { dim: true, status: undefined, warnNoEditor: false },
    "grayedOut with an editor grays it and stays quiet",
);
assertEq(
    leaderIndicator("grayedOut", false),
    { dim: false, status: "LEADER", warnNoEditor: true },
    "grayedOut without an editor falls back to the status line and warns",
);
assertEq(
    leaderIndicator("none", true),
    { dim: false, status: "LEADER", warnNoEditor: false },
    "none leaves the editor alone and never warns",
);
assertEq(
    leaderIndicator("none", false),
    { dim: false, status: "LEADER", warnNoEditor: false },
    "none without an editor is still just the status line",
);

section("renderEditor");

const plain = fakeEditor(["a", "b"]);
assertEq(
    renderEditor(plain, 40, { dim: false }),
    ["a:40", "b:40"],
    "dim off renders the editor untouched",
);
assertEq(
    renderEditor(plain, 40, {
        dim: false,
        borderColor: () => "MUTED",
    }),
    ["a:40", "b:40"],
    "dim off leaves borderColor alone",
);

const dimmed = renderEditor(plain, 40, {
    dim: true,
    borderColor: () => "MUTED",
});
assertEq(dimmed.length, 2, "dim keeps the editor's line count");
assert(
    dimmed.every((line) => line.startsWith("\u001B[90m") && line.endsWith("\u001B[0m")),
    `every line is wrapped in gray: ${JSON.stringify(dimmed)}`,
);
assert(
    dimmed[0].includes("a:40"),
    "grayed lines still carry the editor's own output",
);

assertEq(
    renderEditor(plain, 40, { dim: true }),
    ["\u001B[90ma:40\u001B[0m", "\u001B[90mb:40\u001B[0m"],
    "dim without borderColor still grays",
);

// Border colour is swapped around the render and put back.
let seenDuringRender: unknown;
const bordered: MountedEditor = {
    ...fakeEditor(["x"]),
    render(width: number) {
        seenDuringRender = this.borderColor?.("> ");
        return [`x:${width}`];
    },
    borderColor: (text: string) => `own(${text})`,
};
const out = renderEditor(bordered, 10, {
    dim: true,
    borderColor: (text: string) => `muted(${text})`,
});
assertEq(seenDuringRender, "muted(> )", "border is muted during the render");
assertEq(
    bordered.borderColor?.("> "),
    "own(> )",
    "the editor's own border colour is restored",
);
assertEq(out, ["\u001B[90mx:10\u001B[0m"], "bordered editor renders gray");

// An editor that had no borderColor must not keep one afterwards.
const unbordered: MountedEditor = {
    ...fakeEditor(["y"]),
    render(width: number) {
        return [`y:${width}`];
    },
};
renderEditor(unbordered, 10, {
    dim: true,
    borderColor: () => "<muted>",
});
assertEq(
    "borderColor" in unbordered,
    false,
    "no borderColor is left behind on an editor that had none",
);

// An own property holding undefined is not a border: a class field under
// useDefineForClassFields reads as present. Restoring "undefined" there
// would leave the editor borderless for the rest of the session.
const undefinedBorder: MountedEditor = {
    ...fakeEditor(["z"]),
    render(width: number) {
        return [`z:${width}`];
    },
    borderColor: undefined as unknown as (text: string) => string,
};
renderEditor(undefinedBorder, 10, {
    dim: true,
    borderColor: () => "<muted>",
});
assertEq(
    "borderColor" in undefinedBorder,
    false,
    "an undefined border is cleaned up rather than restored",
);

// An inherited accessor with no setter must not throw out of render().
const accessorEditor = Object.defineProperty(
    { ...fakeEditor(["a"]), render: (width: number) => [`a:${width}`] },
    "borderColor",
    { get: () => (s: string) => `get(${s})`, configurable: true },
) as MountedEditor;
let accessorThrew = false;
try {
    renderEditor(accessorEditor, 10, {
        dim: true,
        borderColor: () => "<muted>",
    });
} catch {
    accessorThrew = true;
}
assertEq(accessorThrew, false, "a getter-only borderColor does not throw");
assertEq(
    accessorEditor.borderColor?.("> "),
    "get(> )",
    "the getter's border is still what the editor sees",
);

// A throwing render must still restore the border.
const thrower: MountedEditor = {
    ...fakeEditor(),
    render: () => {
        throw new Error("boom");
    },
    borderColor: (text: string) => `own(${text})`,
};
let threw = false;
try {
    renderEditor(thrower, 10, {
        dim: true,
        borderColor: () => "<muted>",
    });
} catch {
    threw = true;
}
assert(threw, "a render failure propagates");
assertEq(
    thrower.borderColor?.("> "),
    "own(> )",
    "the border colour is restored even when the render throws",
);

section("stripAnsi + capOutput (exec output)");
{
    assertEq(stripAnsi("\u001B[31mred\u001B[0m"), "red", "CSI color stripped");
    assertEq(
        stripAnsi("git status\u001B[?25lhidden cursor"),
        "git statushidden cursor",
        "private CSI stripped",
    );
    assertEq(stripAnsi("plain output"), "plain output", "plain text untouched");
    assertEq(capOutput("  a\u001B[0m\r\nb  "), "a\nb", "capOutput trims and drops CR");
    const long = "x".repeat(5000);
    const capped = capOutput(long, 100);
    assert(capped.startsWith("x".repeat(100)), "cap keeps the head");
    assert(capped.includes("4900 more characters"), `cap reports the tail size: ${capped.slice(-40)}`);
    assertEq(capOutput(long, 100).length < 200, true, "cap is bounded");
}

rmSync(CONFIG_DIR, { recursive: true, force: true });

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log("All tests passed.");
}
