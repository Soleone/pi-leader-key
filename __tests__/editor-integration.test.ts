/**
 * Integration check for the leader-dimming path: renderEditor() and
 * focusedEditor() against pi's real editor component.
 *
 * Run: npx tsx --test __tests__/editor-integration.test.ts
 *
 * logic.test.ts covers these helpers with fakes, which cannot catch a
 * mismatch with the actual component — a wrong EditorTheme shape, an
 * editor that renders something other than plain lines, a focus lookup
 * that pi's TUI does not answer. This file asks the installed peers
 * instead. They are peerDependencies, resolved by pi at runtime, so a
 * missing peer skips rather than fails.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { focusedEditor, renderEditor } from "../logic.ts";

type Peers = {
    tui: typeof import("@earendil-works/pi-tui");
    agent: typeof import("@earendil-works/pi-coding-agent");
};

const peers = await (async (): Promise<Peers | null> => {
    try {
        const [tui, agent] = await Promise.all([
            import("@earendil-works/pi-tui"),
            import("@earendil-works/pi-coding-agent"),
        ]);
        return { tui, agent };
    } catch {
        return null;
    }
})();

const suite = peers ? test : test.skip;

/** A terminal the TUI can hold without a real TTY behind it. */
function stubTerminal() {
    return {
        columns: 80,
        rows: 24,
        isTTY: true,
        write: () => {},
        on: () => {},
        off: () => {},
    };
}

function buildEditor() {
    if (!peers) throw new Error("peers not loaded");
    const tui = new peers.tui.TuiMainScreen(
        stubTerminal() as unknown as ConstructorParameters<
            typeof peers.tui.TuiMainScreen
        >[0],
    );
    const theme = {
        // Marked so the test can tell the editor's own border from the
        // muted one renderEditor() swaps in.
        borderColor: (s: string) => `own(${s})`,
        selectList: {},
    } as unknown as ConstructorParameters<
        typeof peers.agent.CustomEditor
    >[1];
    // CustomEditor keeps the manager for key handling; leader mode never
    // types into the editor, so an empty one is enough.
    const keybindings = {} as unknown as ConstructorParameters<
        typeof peers.agent.CustomEditor
    >[2];
    const editor = new peers.agent.CustomEditor(tui, theme, keybindings);
    editor.setText("hello world");
    return { tui, editor };
}

suite("focusedEditor() against pi's TUI", () => {
    test("finds the editor pi has focused", () => {
        const { tui, editor } = buildEditor();
        assert.equal(focusedEditor(tui), null, "nothing focused yet");

        const widget = { render: () => ["a widget"], invalidate: () => {} };
        tui.setFocus(widget);
        assert.equal(
            focusedEditor(tui),
            null,
            "a focused component that is not an editor yields null",
        );

        tui.setFocus(editor);
        assert.equal(
            focusedEditor(tui),
            editor,
            "the focused editor comes back as-is",
        );
    });
});

suite("the capture sequence", () => {
    test("grays the captured editor while an overlay owns focus", () => {
        const { tui, editor } = buildEditor();
        tui.setFocus(editor);

        // What the overlay factory does: take the reference now, then take
        // focus for itself.
        const captured = focusedEditor(tui);
        assert.ok(captured, "the editor is captured before focus moves");
        tui.setFocus({
            render: () => ["> leader"],
            invalidate: () => {},
        });

        const lines = renderEditor(captured, 60, {
            dim: true,
            borderColor: (s: string) => `muted(${s})`,
        });
        assert.ok(
            lines.some((line) => line.includes("hello world")),
            "the overlay renders the editor's own text, grayed",
        );
        assert.ok(
            !lines.some((line) => line.includes("> leader")),
            "and nothing but the editor — the overlay draws no chrome",
        );

        // And what happens on release: focus goes back and the editor is
        // exactly as it was, never unmounted or replaced.
        tui.setFocus(editor);
        const after = renderEditor(editor, 60, { dim: false });
        assert.ok(
            after.some((line) => line.includes("own(")),
            "the editor's own border colour is back after leader mode",
        );
        assert.ok(
            !after.some((line) => line.includes("muted(")),
            "nothing of the overlay is left behind",
        );
    });
});

suite("renderEditor() against pi's editor", () => {
    test("dims off leaves the render untouched", () => {
        const { editor } = buildEditor();
        const lines = renderEditor(editor, 60, { dim: false });
        assert.ok(lines.length > 0, "the editor renders lines");
        assert.ok(
            lines.some((line) => line.includes("own(")),
            "the editor's own border colour is used",
        );
        assert.equal(editor.getText(), "hello world", "text is untouched");
    });

    test("dims every line and restores the border afterwards", () => {
        const { editor } = buildEditor();
        const plain = renderEditor(editor, 60, { dim: false });
        const dim = renderEditor(editor, 60, {
            dim: true,
            borderColor: (s: string) => `muted(${s})`,
        });

        assert.equal(dim.length, plain.length, "same lines, just grayed");
        assert.ok(
            dim.every(
                (line) =>
                    line.startsWith("\u001B[90m") && line.endsWith("\u001B[0m"),
            ),
            "every line is wrapped in bright black",
        );
        assert.ok(
            dim.some((line) => line.includes("muted(")),
            "the border is muted while rendering",
        );
        assert.ok(
            !plain.some((line) => line.includes("muted(")),
            "and the editor's own border colour is back",
        );
        assert.equal(
            editor.getText(),
            "hello world",
            "graying does not disturb the editor's text",
        );
    });
});
