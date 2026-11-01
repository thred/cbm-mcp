import { describe, expect, it } from "vitest";
import { C64AnalysisState, C6510Decoder, type C64EntryPoint } from "../src/index.js";

const original = [0xa9, 0x01, 0x8d, 0x00, 0x20, 0xa2, 0x01, 0xe8, 0xca, 0x60];

function capture(state: C64AnalysisState, bytes = original, start = 0x1000, view = "ram", entries?: C64EntryPoint[]) {
    return state.analyze(
        new C6510Decoder(Uint8Array.from(bytes), start),
        view,
        entries ?? [{ address: start, source: "user" }],
    );
}

describe("C64 analysis labels", () => {
    it("renders labels at instruction and data addresses and updates existing graphs on edits", () => {
        const state = new C64AnalysisState("labels");
        const graph = capture(state);
        const code = state.addLabel(graph, 0x1002, "store_value", "code");
        const data = state.addLabel(graph, 0x2000, "counter");
        expect(graph.toString()).toContain("store_value:\n    STA counter");
        expect(graph.labelsAt(0x1002)).toContainEqual(expect.objectContaining({ label: code, status: "unchanged" }));
        state.renameLabel(data.id, "score");
        expect(graph.toString()).toContain("STA score");
        expect(graph.toString()).not.toContain("STA counter");
        state.removeLabel(data.id);
        expect(graph.toString()).toContain("STA mem_2000");
        expect(() => state.removeLabel(data.id)).toThrow("Label not found");
    });

    it("uses labels for branch targets, direct calls, indexed bases and indirect pointers", () => {
        const bytes = [
            0xd0,
            0x07, // BNE $1009
            0x20,
            0x0a,
            0x10, // JSR $100a
            0xbd,
            0x00,
            0x20, // LDA $2000,X
            0x60, // RTS
            0x60, // $1009 RTS
            0x6c,
            0x00,
            0x30, // $100a JMP ($3000)
        ];
        const state = new C64AnalysisState("operands");
        const graph = capture(state, bytes);
        state.addLabel(graph, 0x1009, ".branch", "code");
        state.addLabel(graph, 0x100a, ".routine", "code");
        state.addLabel(graph, 0x2000, ".table");
        state.addLabel(graph, 0x3000, ".pointer");
        const output = graph.toString();
        expect(output).toContain("BNE .branch");
        expect(output).toContain("JSR .routine");
        expect(output).toContain("LDA .table,X");
        expect(output).not.toContain("indexed target unresolved");
        expect(output).toContain("JMP (.pointer)");
        expect(output).toContain("; $100a (entry: call)");
    });

    it("reconciles code labels and requires review before applying modified or relocated candidates", () => {
        const state = new C64AnalysisState("reconcile");
        const first = capture(state);
        const code = state.addLabel(first, 0x1000, ".main", "code");
        const data = state.addLabel(first, 0x2000, ".counter");
        const changed = [...original];
        changed[1] = 0x42;
        const second = capture(state, changed);
        expect(state.matchLabels(second)).toContainEqual(
            expect.objectContaining({ label: code, status: "modified", address: 0x1000 }),
        );
        expect(second.toString()).toContain(".main [modified]: $1000 -> $1000");
        expect(second.toString()).not.toContain("\n.main:");
        expect(state.matchLabels(second)).toContainEqual(
            expect.objectContaining({ label: data, status: "fixed", address: 0x2000 }),
        );
        state.reattachLabel(code.id, second, 0x1000);
        expect(second.toString()).toContain("\n.main:");
        const relocated = capture(state, changed, 0x1100);
        expect(state.matchLabels(relocated)).toContainEqual(
            expect.objectContaining({ status: "relocated", address: 0x1100 }),
        );
        expect(relocated.toString()).toContain(".main [relocated]: $1000 -> $1100");
        expect(relocated.toString()).not.toContain("\n.main:");
        state.reattachLabel(code.id, relocated, 0x1100);
        expect(relocated.toString()).toContain("\n.main:");
        const replaced = capture(state, [0x60], 0x1100);
        expect(state.matchLabels(replaced)).toContainEqual(expect.objectContaining({ status: "orphaned" }));
        expect(replaced.toString()).toContain(".main [orphaned]: $1100");
    });

    it("orphans ambiguous relocations and preserves aliases sharing an origin", () => {
        const state = new C64AnalysisState("ambiguous");
        const first = capture(state, [...original, ...original], 0x1000, "ram", [
            { address: 0x1000, source: "user" },
            { address: 0x100a, source: "user" },
        ]);
        state.addLabel(first, 0x1000, ".first", "code");
        state.addLabel(first, 0x1000, ".alias", "code");
        state.addLabel(first, 0x100a, ".second", "code");
        const moved = capture(state, original, 0x1100);
        expect(state.matchLabels(moved).map((match) => match.status)).toEqual(["orphaned", "orphaned", "orphaned"]);
    });

    it("imports VICE-provided labels without overwriting users, reports conflicts and keeps aliases", () => {
        const state = new C64AnalysisState("vice");
        const graph = capture(state);
        const user = state.addLabel(graph, 0x1000, ".preferred", "code");
        const inputs = [
            { address: 0x1000, name: ".vice_start", kind: "code" as const },
            { address: 0x2000, name: ".variable" },
            { address: 0x3000, name: ".preferred" },
        ];
        expect(state.importViceLabels(graph, inputs)).toEqual({
            imported: 2,
            removed: 0,
            conflicts: [{ name: ".preferred", viceAddress: 0x3000, userAddress: 0x1000 }],
        });
        expect(graph.toString()).toContain(".preferred:\n.vice_start:");
        expect(graph.toString()).toContain("STA .variable");
        const old = state.listLabels("ram").find((label) => label.name === ".vice_start")!;
        state.importViceLabels(graph, inputs);
        expect(state.listLabels("ram").find((label) => label.name === ".vice_start")?.id).toBe(old.id);
        state.renameLabel(old.id, ".edited");
        expect(state.listLabels("ram").find((label) => label.id === old.id)?.source).toBe("user");
        state.importViceLabels(graph, inputs);
        expect(graph.toString()).toContain(".edited:\n.preferred:\n.vice_start:");
        const before = state.serialize();
        expect(() =>
            state.importViceLabels(graph, [
                { address: 0x2000, name: ".x" },
                { address: 0x2001, name: ".x" },
            ]),
        ).toThrow("Duplicate");
        expect(state.serialize()).toBe(before);
        state.removeLabel(user.id);
        const result = state.importViceLabels(graph, [{ address: 0x2000, name: ".variable" }]);
        expect(result.removed).toBe(1);
        expect(graph.toString()).not.toContain(".vice_start:");
    });

    it("does not silently refresh an imported code anchor when VICE reports the same label again", () => {
        const state = new C64AnalysisState("vice-refresh");
        const graph = capture(state);
        const labels = [{ address: 0x1000, name: ".entry", kind: "code" as const }];
        state.importViceLabels(graph, labels);
        const originalLabel = state.listLabels()[0];
        const changed = [...original];
        changed[1] = 0x42;
        const recaptured = capture(state, changed);
        state.importViceLabels(recaptured, labels);
        expect(state.listLabels()[0]).toEqual(originalLabel);
        expect(state.matchLabels(recaptured)[0]).toMatchObject({ status: "modified", address: 0x1000 });
        expect(recaptured.toString()).toContain(".entry [modified]");
        expect(recaptured.toString()).not.toContain("\n.entry:");
    });

    it("persists view-scoped labels and loads older state versions without labels", () => {
        const state = new C64AnalysisState("saved");
        const ram = capture(state);
        state.addLabel(ram, 0x1000, "main", "code");
        state.addLabel(ram, 0x2000, "value");
        const rom = capture(state, original, 0x1000, "rom");
        state.addLabel(rom, 0x2000, "other");
        expect(rom.toString()).toContain("STA other");
        expect(rom.toString()).not.toContain("STA value");
        const saved = state.serialize();
        const restored = C64AnalysisState.deserialize(saved);
        expect(restored.restoreGraph("ram").toString()).toContain("STA value");
        expect(restored.restoreGraph("rom").toString()).toContain("STA other");
        for (const version of [1, 2]) {
            const legacy = JSON.parse(saved);
            legacy.version = version;
            delete legacy.labels;
            expect(C64AnalysisState.deserialize(JSON.stringify(legacy)).listLabels()).toEqual([]);
        }
        const malformed = JSON.parse(saved);
        malformed.labels[0].name = "invalid\nname";
        expect(() => C64AnalysisState.deserialize(JSON.stringify(malformed))).toThrow("Label name");
        const duplicated = JSON.parse(saved);
        duplicated.labels.push({ ...duplicated.labels[0], id: "another" });
        expect(() => C64AnalysisState.deserialize(JSON.stringify(duplicated))).toThrow("duplicate");
    });

    it("validates names, addresses, kinds, duplicate names and stale graphs", () => {
        const state = new C64AnalysisState("invalid");
        const graph = capture(state);
        expect(() => state.addLabel(graph, 0x1000, "bad name")).toThrow("Label name");
        expect(() => state.addLabel(graph, 0x10000, "bad")).toThrow("16-bit");
        expect(() => state.addLabel(graph, 0x2000, "bad", "code")).toThrow("discovered instruction");
        state.addLabel(graph, 0x2000, "value");
        expect(() => state.addLabel(graph, 0x2001, "value")).toThrow("already exists");
        capture(state);
        expect(() => state.addLabel(graph, 0x1000, "stale")).toThrow("not the current");
    });
});
