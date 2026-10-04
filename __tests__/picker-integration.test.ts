/**
 * Integration check for the shared command picker's Tab handling.
 *
 * Run: npx tsx --test __tests__/picker-integration.test.ts
 *
 * logic.test.ts can only cover splitCommandLine, the pure half of the
 * command step. This file asks the installed peers instead, because the
 * behaviour that broke was a wiring detail: Tab is a SelectList no-op
 * (pi-tui only knows enter), so without an explicit branch it did
 * nothing, and enter-on-a-name-only-query reported "command must start
 * with /". The peers are peerDependencies resolved by pi at runtime, so
 * a missing peer skips rather than fails.
 */

import assert from "node:assert/strict";
import test from "node:test";

const pickerModule = await (async () => {
    try {
        return await import("../wizard.ts");
    } catch {
        return null;
    }
})();

const suite = pickerModule ? test : test.skip;

type MenuEntry = { value: string; label: string; description: string };

const MENU: MenuEntry[] = [
    { value: "model", label: "/model", description: "switch model" },
    { value: "compact", label: "/compact", description: "compact" },
];

type Picker = {
    handleInput: (data: string) => void;
    selectedValue: () => string | null;
};

function buildPicker() {
    if (!pickerModule) throw new Error("peers not loaded");
    const theme = {
        fg: (_style: string, text: string) => text,
        selectList: {},
    } as unknown as Parameters<typeof pickerModule.makeCommandPicker>[0];

    const picked: string[] = [];
    let cancelled = false;
    let query = "";

    const picker = pickerModule.makeCommandPicker(theme, MENU, {
        getQuery: () => query,
        setQuery: (q: string) => {
            query = q;
        },
        onPick: (value: string) => picked.push(value),
        onCancel: () => {
            cancelled = true;
        },
    }) as Picker;

    return {
        picker,
        picked,
        get query() {
            return query;
        },
        get cancelled() {
            return cancelled;
        },
    };
}

suite("command picker: tab fills the highlighted command", () => {
    suite("with an empty query", () => {
        suite("tab", () => {
            const state = buildPicker();
            state.picker.handleInput("\t");
            assert.deepEqual(state.picked, [MENU[0].value]);
            assert.equal(state.query, "", "the query line is untouched");
        });

        suite("escape cancels", () => {
            const state = buildPicker();
            state.picker.handleInput("\x1b");
            assert.equal(state.cancelled, true);
            assert.deepEqual(state.picked, []);
        });
    });

    suite("after filtering to one match", () => {
        suite("tab takes the fuzzy-filtered match, not the first entry", () => {
            const state = buildPicker();
            // "/compact" typed as a bare name: the filter narrows the
            // list to one row, and tab must hand over that row.
            state.picker.handleInput("c");
            state.picker.handleInput("o");
            assert.equal(state.picker.selectedValue(), "compact");
            state.picker.handleInput("\t");
            assert.deepEqual(state.picked, ["compact"]);
        });

        suite("selectedValue tracks the query", () => {
            const state = buildPicker();
            state.picker.handleInput("m");
            assert.equal(state.picker.selectedValue(), "model");
            state.picker.handleInput("x");
            assert.equal(state.picker.selectedValue(), null);
        });
    });
});
