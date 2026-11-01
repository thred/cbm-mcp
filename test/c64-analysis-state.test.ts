import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { C64AnalysisState, C6510Decoder, type C64EntryPoint } from "../src/index.js";

const original = [0xa9, 0x01, 0x8d, 0x00, 0x20, 0xa2, 0x01, 0xe8, 0xca, 0x60];
const entries: C64EntryPoint[] = [{ address: 0x1000, source: "user" }];

function analyze(state: C64AnalysisState, bytes = original, start = 0x1000, view = "ram", points = entries) {
    return state.analyze(new C6510Decoder(Uint8Array.from(bytes), start), view, points);
}

describe("persistent C64 analysis state", () => {
    it("persists and changes the per-view unofficial opcode policy", () => {
        const state = new C64AnalysisState("policy");
        let graph = state.analyze(new C6510Decoder(Uint8Array.of(0xea, 0x02), 0x1000), "ram", entries);
        expect(graph.includeIllegalOpcodes).toBe(false);
        expect(graph.diagnostics).toContainEqual({ kind: "undocumented-opcode", address: 0x1001, bytes: [0x02] });
        state.setIncludeIllegalOpcodes("ram", true);
        graph = state.restoreGraph("ram");
        expect(graph.includeIllegalOpcodes).toBe(true);
        expect(graph.instructions.map((item) => item.mnemonic)).toEqual(["NOP", "KIL"]);
        const restored = C64AnalysisState.deserialize(state.serialize());
        expect(restored.restoreGraph("ram").instructions.map((item) => item.mnemonic)).toEqual(["NOP", "KIL"]);
        restored.setIncludeIllegalOpcodes("ram", false);
        expect(restored.restoreGraph("ram").includeIllegalOpcodes).toBe(false);
        const legacy = JSON.parse(state.serialize());
        legacy.version = 4;
        delete legacy.snapshots[0].includeIllegalOpcodes;
        expect(C64AnalysisState.deserialize(JSON.stringify(legacy)).restoreGraph("ram").includeIllegalOpcodes).toBe(
            false,
        );
        const invalid = JSON.parse(state.serialize());
        invalid.snapshots[0].includeIllegalOpcodes = "yes";
        expect(() => C64AnalysisState.deserialize(JSON.stringify(invalid))).toThrow("includeIllegalOpcodes");
    });

    it("validates version 4 capture metadata and reads prior versions", () => {
        const state = new C64AnalysisState("migration");
        const graph = state.analyze(new C6510Decoder(Uint8Array.from(original), 0x1000), "ram", entries, undefined, {
            source: "vice",
            machine: "c64",
            space: "C:",
            bank: "ram",
            capturedAt: "2025-01-01T00:00:00.000Z",
            pc: 0x1000,
            direction: 0x2f,
            port: 0x37,
        });
        state.addLabel(graph, 0x1000, "main", "code");
        const serialized = JSON.parse(state.serialize());
        expect(C64AnalysisState.deserialize(JSON.stringify(serialized)).captureMetadata("ram")).toMatchObject({
            pc: 0x1000,
            bank: "ram",
        });
        serialized.snapshots[0].capture.bank = "io";
        expect(() => C64AnalysisState.deserialize(JSON.stringify(serialized))).toThrow("capture identity");
        delete serialized.snapshots[0].capture;
        delete serialized.dataSections;
        serialized.version = 3;
        const v3 = C64AnalysisState.deserialize(JSON.stringify(serialized));
        expect(v3.listLabels("ram")).toMatchObject([{ name: "main" }]);
        serialized.version = 2;
        delete serialized.labels;
        expect(C64AnalysisState.deserialize(JSON.stringify(serialized)).listLabels()).toEqual([]);
        serialized.version = 1;
        delete serialized.snapshots[0].banking;
        expect(C64AnalysisState.deserialize(JSON.stringify(serialized)).listLabels()).toEqual([]);
    });

    it("reconciles typed data and exclusions conservatively across snapshots and views", () => {
        const state = new C64AnalysisState("data");
        const first = analyze(state);
        const section = state.addDataSection(first, 0x1001, 0x1002, "sprite", "Candidate sprite");
        const correction = state.excludeRange(first, 0x1001, 0x1002, "Treat as data");
        const rebuilt = state.restoreGraph("ram");
        expect(state.dataSectionStatuses(rebuilt)[0].status).toBe("active");
        expect(state.correctionStatuses(rebuilt)[0].status).toBe("active");
        const changed = [...original];
        changed[1] = 0xff;
        const next = analyze(state, changed);
        expect(state.dataSectionStatuses(next)[0].status).toBe("stale");
        expect(state.correctionStatuses(next)[0]).toMatchObject({ status: "stale", correction: { id: correction.id } });
        const other = analyze(state, changed, 0x1000, "rom");
        expect(state.dataSectionStatuses(other)[0].status).toBe("other-view");
        state.updateDataSection(section.id, "text", "Updated");
        state.reattachDataSection(section.id, next, 0x1001, 0x1002);
        const restored = C64AnalysisState.deserialize(state.serialize());
        expect(restored.dataSectionStatuses(restored.restoreGraph("ram"))[0]).toMatchObject({
            status: "active",
            section: { id: section.id, type: "text", description: "Updated" },
        });
        restored.removeDataSection(section.id);
        expect(restored.dataSectionStatuses(restored.restoreGraph("ram"))).toEqual([]);
    });

    it("preserves annotations on unchanged and substantially modified blocks without silently confirming them", () => {
        const state = new C64AnalysisState("example");
        const first = analyze(state);
        const annotation = state.addAnnotation(first, "entry", 0x1000, "Main", "Draws a frame.");
        expect(state.matchAnnotations(first)[0]).toMatchObject({ status: "unchanged", address: 0x1000 });
        const modified = [...original];
        modified[1] = 0x42;
        const second = analyze(state, modified);
        expect(() => state.matchAnnotations(first)).toThrow("not the current");
        expect(state.matchAnnotations(second)[0]).toMatchObject({
            status: "modified",
            address: 0x1000,
            opcodeSimilarity: 1,
            byteSimilarity: 5 / 6,
        });
        state.updateAnnotation(annotation.id, "Main loop", "Updated documentation.");
        const third = analyze(state, [0xa9, 0xff, 0x60]);
        expect(state.matchAnnotations(third)[0]).toMatchObject({
            status: "orphaned",
            annotation: { id: annotation.id, name: "Main loop", description: "Updated documentation." },
        });
        const fourth = analyze(state);
        expect(state.matchAnnotations(fourth)[0]).toMatchObject({ status: "unchanged" });
        expect(state.matchAnnotations(fourth)[0].annotation.instructions[0]).toEqual([0xa9, 0x01]);
    });

    it("enforces the documented opcode and byte similarity thresholds", () => {
        const state = new C64AnalysisState("thresholds");
        const bytes = [0xa9, 1, 0xa2, 2, 0xa0, 3, 0xe8, 0x60];
        const first = analyze(state, bytes);
        state.addAnnotation(first, "block", 0x1000, "", "");
        const changedOperands = [...bytes];
        changedOperands[1] = 4;
        changedOperands[3] = 5;
        const second = analyze(state, changedOperands);
        expect(state.matchAnnotations(second)[0]).toMatchObject({
            status: "modified",
            opcodeSimilarity: 1,
            byteSimilarity: 0.6,
        });
        changedOperands[5] = 6;
        expect(state.matchAnnotations(analyze(state, changedOperands))[0].status).toBe("orphaned");
        const changedOpcode = [...bytes];
        changedOpcode[6] = 0xca;
        expect(state.matchAnnotations(analyze(state, changedOpcode))[0]).toMatchObject({
            status: "modified",
            opcodeSimilarity: 0.8,
            byteSimilarity: 0.8,
        });
    });

    it("matches large routines conservatively without quadratic comparison", () => {
        const state = new C64AnalysisState("large");
        const bytes = [...Array.from({ length: 300 }, (_, index) => [0xa9, index & 0xff]).flat(), 0x60];
        const first = analyze(state, bytes);
        state.addAnnotation(first, "entry", 0x1000, "Large routine", "");
        const changed = [...bytes];
        changed[1] = 0xff;
        const match = state.matchAnnotations(analyze(state, changed))[0];
        expect(match).toMatchObject({ status: "modified", opcodeSimilarity: 1 });
        expect(match.byteSimilarity).toBeCloseTo(300 / 301);
    });

    it("matches relocated entry signatures that reach code before the entry address", () => {
        const state = new C64AnalysisState("loop");
        const bytes = [0xa9, 1, 0xa2, 2, 0xe8, 0xd0, 0xf9, 0x60];
        const first = analyze(state, bytes, 0x1000, "ram", [{ address: 0x1005, source: "user" }]);
        state.addAnnotation(first, "entry", 0x1005, "Loop", "");
        const relocated = analyze(state, bytes, 0x1100, "ram", [{ address: 0x1105, source: "user" }]);
        expect(state.matchAnnotations(relocated)[0]).toMatchObject({ status: "relocated", address: 0x1105 });
    });

    it("requires strong unique evidence for relocation and orphans ambiguous matches", () => {
        const state = new C64AnalysisState("example");
        const first = analyze(state);
        state.addAnnotation(first, "block", 0x1000, "Work", "Original.");
        const moved = analyze(state, original, 0x1100, "ram", [{ address: 0x1100, source: "user" }]);
        expect(state.matchAnnotations(moved)[0]).toMatchObject({ status: "relocated", address: 0x1100 });
        const twice = [...original, ...original];
        const ambiguous = analyze(state, twice, 0x1100, "ram", [
            { address: 0x1100, source: "user" },
            { address: 0x110a, source: "user" },
        ]);
        expect(state.matchAnnotations(ambiguous)[0]).toMatchObject({ status: "orphaned" });
        state.reattachAnnotation(state.matchAnnotations(ambiguous)[0].annotation.id, ambiguous, 0x110a);
        expect(state.matchAnnotations(ambiguous)[0]).toMatchObject({ status: "unchanged", address: 0x110a });
    });

    it("does not automatically relocate tiny blocks or merge different annotation origins", () => {
        const tiny = new C64AnalysisState("tiny");
        const first = analyze(tiny, [0x60]);
        tiny.addAnnotation(first, "block", 0x1000, "Return", "");
        const second = analyze(tiny, [0x60], 0x1100, "ram", [{ address: 0x1100, source: "user" }]);
        expect(tiny.matchAnnotations(second)[0].status).toBe("orphaned");

        const state = new C64AnalysisState("example");
        const two = analyze(state, [...original, ...original], 0x1000, "ram", [
            { address: 0x1000, source: "user" },
            { address: 0x100a, source: "user" },
        ]);
        state.addAnnotation(two, "block", 0x1000, "First", "");
        state.addAnnotation(two, "block", 0x100a, "Second", "");
        const one = analyze(state, original, 0x1100, "ram", [{ address: 0x1100, source: "user" }]);
        expect(state.matchAnnotations(one).map((match) => match.status)).toEqual(["orphaned", "orphaned"]);
    });

    it("isolates views and preserves independently saved snapshots", () => {
        const state = new C64AnalysisState("example");
        const ram = analyze(state);
        state.addAnnotation(ram, "entry", 0x1000, "RAM routine", "");
        const rom = analyze(state, original, 0x1000, "rom");
        expect(state.matchAnnotations(rom)[0].status).toBe("other-view");
        expect(state.matchAnnotations(ram)[0].status).toBe("unchanged");
        const restored = C64AnalysisState.deserialize(state.serialize());
        expect(restored.restoreGraph("ram").snapshotId).toBe(ram.snapshotId);
        expect(restored.restoreGraph("rom").snapshotId).toBe(rom.snapshotId);
        expect(restored.matchAnnotations(restored.restoreGraph("ram"))[0].status).toBe("unchanged");
    });

    it("does not share saved entry point objects with a returned graph", () => {
        const state = new C64AnalysisState("example");
        const first = analyze(state);
        Reflect.set(first.entryPoints[0], "address", 0x2000);
        expect(state.restoreGraph("ram").entryPoints).toContainEqual({ address: 0x1000, source: "user" });
    });

    it("anchors entry documentation to reachable routine blocks without merging callees", () => {
        const state = new C64AnalysisState("routines");
        const bytes = [
            0x20,
            0x0a,
            0x10, // $1000 JSR $100a
            0x4c,
            0x06,
            0x10, // $1003 JMP $1006
            0xa9,
            0x01,
            0xe8,
            0x60, // $1006 LDA #1; INX; RTS
            0xa9,
            0x02,
            0x60, // $100a callee
        ];
        const first = analyze(state, bytes);
        const annotation = state.addAnnotation(first, "entry", 0x1000, "Main", "");
        expect(annotation.instructions).toEqual([[0x20, 0x0a, 0x10], [0x4c, 0x06, 0x10], [0xa9, 1], [0xe8], [0x60]]);
        const calleeChanged = [...bytes];
        calleeChanged[11] = 0x42;
        const second = analyze(state, calleeChanged);
        expect(state.matchAnnotations(second)[0].status).toBe("unchanged");
        const bodyChanged = [...bytes];
        bodyChanged[3] = 0x60;
        const third = analyze(state, bodyChanged);
        expect(state.matchAnnotations(third)[0].status).toBe("orphaned");
    });

    it("persists corrections and entries but disables a correction when its bytes change", () => {
        const state = new C64AnalysisState("example");
        const bytes = [0xea, 0x60, 0x02, 0x60];
        const first = analyze(state, bytes);
        const correction = state.excludeRange(first, 0x1001, 0x1001, "Known data");
        expect(() => state.matchAnnotations(first)).toThrow("not the current");
        let current = state.restoreGraph("ram");
        expect(current.instructions.map((instruction) => instruction.address)).toEqual([0x1000]);
        expect(current.diagnostics).toContainEqual({ kind: "excluded", address: 0x1001 });
        expect(state.correctionStatuses(current)[0].status).toBe("active");
        state.addEntryPoint("ram", 0x1003);
        current = state.restoreGraph("ram");
        expect(current.instructions.map((instruction) => instruction.address)).toEqual([0x1000, 0x1003]);
        const loaded = C64AnalysisState.deserialize(state.serialize());
        expect(loaded.restoreGraph("ram").instructions.map((instruction) => instruction.address)).toEqual([
            0x1000, 0x1003,
        ]);
        const changed = analyze(loaded, [0xea, 0xea, 0x02, 0x60]);
        expect(loaded.correctionStatuses(changed)[0].status).toBe("stale");
        expect(changed.instructions.map((instruction) => instruction.address)).toEqual([0x1003]);
        expect(changed.memoryRegionAt(0x1000)?.kind).toBe("likely-data");
        const restoredChanged = C64AnalysisState.deserialize(loaded.serialize()).restoreGraph("ram");
        expect(restoredChanged.memoryRegions).toEqual(changed.memoryRegions);
        loaded.removeCorrection(correction.id);
        loaded.removeEntryPoint("ram", 0x1003);
        const without = loaded.restoreGraph("ram");
        expect(without.instructions).toEqual([]);
        expect(without.memoryRegionAt(0x1000)?.kind).toBe("likely-data");
        expect(without.diagnostics).toContainEqual({ kind: "undocumented-opcode", address: 0x1002, bytes: [0x02] });
    });

    it("saves and reloads a versioned state atomically without exposing its temporary file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "cbm-analysis-"));
        const file = join(directory, "state.json");
        try {
            const state = new C64AnalysisState("example");
            const graph = analyze(state);
            state.addAnnotation(graph, "block", 0x1000, "Initialization", "Sets state.");
            await state.save(file);
            const serialized = JSON.parse(await readFile(file, "utf8"));
            expect(serialized.version).toBe(5);
            expect(await readdir(directory)).toEqual(["state.json"]);
            const restored = await C64AnalysisState.load(file);
            const restoredGraph = restored.restoreGraph("ram");
            expect(restoredGraph.instructions.map((instruction) => instruction.bytes)).toEqual(
                graph.instructions.map((instruction) => instruction.bytes),
            );
            expect(restored.matchAnnotations(restoredGraph)[0]).toMatchObject({
                status: "unchanged",
                annotation: { name: "Initialization", description: "Sets state." },
            });
            await restored.save(file);
        } finally {
            await unlink(file);
            await rmdir(directory);
        }
    });

    it("rejects malformed or duplicate persisted state and stale graphs", () => {
        const state = new C64AnalysisState("example");
        const graph = analyze(state);
        const other = new C64AnalysisState("other");
        expect(() => other.addAnnotation(graph, "block", 0x1000, "", "")).toThrow("different program");
        expect(() => C64AnalysisState.deserialize("{}")).toThrow("version");
        const parsed = JSON.parse(state.serialize());
        parsed.snapshots.push(parsed.snapshots[0]);
        expect(() => C64AnalysisState.deserialize(JSON.stringify(parsed))).toThrow("duplicate");
        parsed.snapshots.pop();
        parsed.snapshots[0].bytes = [256];
        expect(() => C64AnalysisState.deserialize(JSON.stringify(parsed))).toThrow("bytes");
    });
});
