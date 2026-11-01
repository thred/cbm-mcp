import { describe, expect, it } from "vitest";
import { C64AnalysisQueries, C64AnalysisState, C6510Decoder, C64_PRG_DEFAULT_BANKING } from "../src/index.js";

function fixture() {
    const bytes = Uint8Array.from([
        0xa9,
        0x01, // $1000 LDA #1
        0x8d,
        0x20,
        0xd0, // $1002 STA $d020
        0xd0,
        0x04, // $1005 BNE $100b
        0x20,
        0x10,
        0x10, // $1007 JSR $1010
        0x60, // $100a RTS
        0xee,
        0x20,
        0xd0,
        0x60, // $100b INC $d020; RTS
        0x02, // $100f data
        0xb1,
        0xff, // $1010 LDA ($ff),Y
        0xbd,
        0xf0,
        0xff, // $1012 LDA $fff0,X
        0x6c,
        0xff,
        0x12, // $1015 JMP ($12ff)
    ]);
    const state = new C64AnalysisState("synthetic");
    const graph = state.analyze(
        new C6510Decoder(bytes, 0x1000),
        "ram",
        [{ address: 0x1000, source: "user" }],
        C64_PRG_DEFAULT_BANKING,
    );
    state.addLabel(graph, 0x1000, "main", "code");
    state.addAnnotation(graph, "entry", 0x1000, "Display", "Updates the border");
    return { graph, state, queries: new C64AnalysisQueries(graph, state.matchAnnotations(graph)) };
}

describe("bounded analysis queries", () => {
    it("reports unofficial opcodes and conservatively treats unstable store addresses as unresolved", () => {
        const state = new C64AnalysisState("unstable");
        const graph = state.analyze(
            new C6510Decoder(Uint8Array.of(0x9e, 0xff, 0x12, 0x02), 0x1000, { includeIllegalOpcodes: true }),
            "ram",
            [{ address: 0x1000, source: "user" }],
        );
        const queries = new C64AnalysisQueries(graph);
        expect(queries.search("unstable", { kind: "instruction" }).items).toContainEqual(
            expect.objectContaining({ address: 0x1000, illegal: true, unstable: true }),
        );
        expect(queries.references(0x1300).items).toEqual([]);
        expect(queries.references(0x1300, 0x1300, { includeUnresolved: true }).items).toContainEqual(
            expect.objectContaining({
                kind: "memory",
                match: "unresolved",
                reference: expect.objectContaining({ target: { kind: "unstable", base: 0x12ff } }),
            }),
        );
    });

    it("lists filtered regions with full boundaries, evidence and stable pagination", () => {
        const { queries } = fixture();
        const first = queries.regions({ limit: 1 });
        expect(first.total).toBeGreaterThan(1);
        expect(first.nextOffset).toBe(1);
        const second = queries.regions({ limit: 1, offset: first.nextOffset! });
        expect(second.items[0].start).toBeGreaterThan(first.items[0].start);
        const firstRegion = first.items[0];
        const overlap = queries.regions({ start: firstRegion.start, end: firstRegion.start });
        expect(overlap.items[0]).toEqual(firstRegion);
        expect(queries.regions({ minimumLength: 65536 }).items).toEqual([]);
        expect(queries.regions({ kind: "code" }).items.every((item) => item.kind === "code")).toBe(true);
        expect(firstRegion).not.toHaveProperty("bytes");
        expect(() => queries.regions({ start: 5, end: 4 })).toThrow();
        expect(() => queries.regions({ minimumLength: 0 })).toThrow();
        expect(() => queries.regions({ limit: 101 })).toThrow();
    });

    it("searches instructions, labels, system and user annotations with snapshot metadata and stable pages", () => {
        const { graph, queries } = fixture();
        expect(queries.search("entry", { kind: "entry" }).items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ address: 0x1000, source: "user" }),
                expect.objectContaining({ address: 0x1010, source: "call" }),
            ]),
        );
        expect(queries.search("lda", { kind: "instruction" }).items.map((item) => item.address)).toEqual([
            0x1000, 0x1010, 0x1012,
        ]);
        expect(queries.search("read-modify-write", { kind: "instruction" }).items).toContainEqual(
            expect.objectContaining({ address: 0x100b, operandAccess: "read-modify-write", mode: "absolute" }),
        );
        expect(queries.search("MAIN", { kind: "label" }).items).toContainEqual(
            expect.objectContaining({ address: 0x1000, text: "main", status: "unchanged", source: "user" }),
        );
        expect(queries.search("border", { kind: "annotation" }).items).toContainEqual(
            expect.objectContaining({ address: 0x1000, status: "unchanged", source: "user" }),
        );
        expect(queries.search("border", { kind: "system" }).items).toContainEqual(
            expect.objectContaining({ address: 0x1002, status: "mapped" }),
        );
        const first = queries.search("lda", { kind: "instruction", limit: 1 });
        const next = queries.search("lda", { kind: "instruction", limit: 1, offset: first.nextOffset! });
        expect(first).toMatchObject({
            programId: "synthetic",
            viewId: "ram",
            snapshotId: graph.snapshotId,
            evidence: "static-candidates",
            total: 3,
            nextOffset: 1,
        });
        expect(next.items[0].address).toBe(0x1010);
        expect(queries.search("lda", { kind: "instruction", start: 0x1010, end: 0x1010 }).total).toBe(1);
        expect(queries.search("lda", { offset: 100 }).items).toEqual([]);
        expect(() => queries.search(" ")).toThrow();
        expect(() => queries.search("x", { limit: 101 })).toThrow();
        expect(() => queries.search("x", { start: 2, end: 1 })).toThrow();
    });

    it("distinguishes exact, possible indexed and unresolved references, including wraparound", () => {
        const { queries } = fixture();
        const border = queries.references(0xd020);
        expect(border.items.filter((item) => item.kind === "memory" && item.match === "direct")).toHaveLength(3);
        expect(queries.references(0xd020, 0xd020, { access: "write" }).total).toBe(2);
        expect(border.items).toContainEqual(
            expect.objectContaining({
                kind: "memory",
                match: "direct",
                possibleViews: ["io"],
                reference: expect.objectContaining({ from: 0x1002, access: "write" }),
            }),
        );
        expect(queries.references(0x1010).items).toContainEqual(
            expect.objectContaining({ kind: "control-flow", match: "direct", from: 0x1007, edge: "call" }),
        );
        expect(queries.references(0x0010).items).toContainEqual(
            expect.objectContaining({
                kind: "memory",
                match: "possible",
                reference: expect.objectContaining({ from: 0x1012 }),
            }),
        );
        expect(queries.references(0x0100).items).not.toContainEqual(
            expect.objectContaining({ reference: expect.objectContaining({ from: 0x1012 }) }),
        );
        expect(queries.references(0x8000, 0x8001, { includeUnresolved: true }).items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "memory",
                    match: "unresolved",
                    reference: expect.objectContaining({ from: 0x1010 }),
                }),
                expect.objectContaining({ kind: "control-flow", match: "unresolved", from: 0x1015 }),
            ]),
        );
        expect(() => queries.references(-1)).toThrow();
        expect(() => queries.references(2, 1)).toThrow();
    });

    it("caps search item text and retains matches beyond the displayed prefix", () => {
        const { graph, state } = fixture();
        state.addAnnotation(graph, "block", 0x100b, "Long", `${"x".repeat(300)} unique`);
        const item = new C64AnalysisQueries(graph, state.matchAnnotations(graph)).search("unique", {
            kind: "annotation",
        }).items[0];
        expect(item.truncated).toBe(true);
        expect(item.text).toHaveLength(256);
    });

    it("explores reachable blocks without following calls or looping, exposing calls, references and exits", () => {
        const { queries } = fixture();
        const main = queries.routine(0x1000, { limit: 100 });
        expect(main.items).toContainEqual(expect.objectContaining({ kind: "callee", from: 0x1007, target: 0x1010 }));
        expect(main.items).toContainEqual(
            expect.objectContaining({
                kind: "memory",
                reference: expect.objectContaining({ from: 0x1002, access: "write" }),
            }),
        );
        expect(main.items).not.toContainEqual(expect.objectContaining({ kind: "instruction", address: 0x1010 }));
        const callee = queries.routine(0x1010, { limit: 100 });
        expect(callee.items).toContainEqual(expect.objectContaining({ kind: "caller", from: 0x1007 }));
        expect(callee.items).toContainEqual(expect.objectContaining({ kind: "exit", from: 0x1015, edge: "jump" }));
        expect(() => queries.routine(0x1002)).toThrow("entry point");
        const first = queries.routine(0x1000, { limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextOffset).toBe(2);
    });

    it("exposes BASIC SYS callers and unresolved expressions without claiming execution", () => {
        const bytes = Uint8Array.of(0x0e, 0x08, 10, 0, 0x9e, 0x32, 0x30, 0x36, 0x34, 0x3a, 0x9e, 0x41, 0, 0, 0, 0x60);
        const state = new C64AnalysisState("basic");
        const graph = state.analyze(new C6510Decoder(bytes, 0x0801), "ram", [{ address: 0x0810, source: "basic-sys" }]);
        const queries = new C64AnalysisQueries(graph);
        expect(queries.search("SYS", { kind: "basic" }).total).toBe(1);
        expect(queries.references(0x0810, 0x0810, { includeUnresolved: true }).items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "basic-sys", match: "direct", target: 0x0810 }),
                expect.objectContaining({ kind: "basic-sys", match: "unresolved" }),
            ]),
        );
        expect(queries.routine(0x0810).items).toContainEqual(
            expect.objectContaining({ kind: "caller", edge: "basic-sys", from: 0x0805 }),
        );
    });

    it("lists diagnostics and terminates routine exploration on loops", () => {
        const state = new C64AnalysisState("loops");
        const graph = state.analyze(
            new C6510Decoder(Uint8Array.of(0xd0, 0xfe, 0x60, 0x02), 0x1000, { includeIllegalOpcodes: true }),
            "ram",
            [
                { address: 0x1000, source: "user" },
                { address: 0x1003, source: "user" },
            ],
        );
        const queries = new C64AnalysisQueries(graph);
        expect(queries.routine(0x1000, { limit: 100 }).items.filter((item) => item.kind === "block")).toHaveLength(2);
        expect(queries.search("KIL", { kind: "instruction" }).items).toContainEqual(
            expect.objectContaining({ address: 0x1003, illegal: true, flow: "halt" }),
        );
        expect(queries.routine(0x1003).items).toContainEqual(expect.objectContaining({ kind: "exit", edge: "halt" }));
    });
});
