import { describe, expect, it } from "vitest";
import { buildC64ControlFlowGraph, C6510Decoder, type C64EntryPoint } from "../src/index.js";

function graph(bytes: number[], entryPoints: C64EntryPoint[] = [{ address: 0x1000, source: "user" }]) {
    return buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.from(bytes), 0x1000, { includeIllegalOpcodes: true }), {
        programId: "test",
        viewId: "ram",
        entryPoints,
    });
}

describe("C64 control-flow graph", () => {
    it("treats undocumented bytes as data evidence by default", () => {
        const result = buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.of(0xea, 0x02, 0x60), 0x1000), {
            programId: "default",
            viewId: "ram",
            entryPoints: [{ address: 0x1000, source: "user" }],
        });
        expect(result.instructions).toEqual([]);
        expect(result.diagnostics).toContainEqual({ kind: "undocumented-opcode", address: 0x1001, bytes: [0x02] });
        expect(result.memoryRegionAt(0x1000)?.kind).toBe("likely-data");
    });

    it("discovers branches, calls and blocks without linearly treating all bytes as code", () => {
        const result = graph([
            0xa9,
            0x01, // $1000 LDA #$01
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
            0x02, // $100f unreachable data
            0xa1,
            0xff, // $1010 LDA ($ff,X)
            0xb1,
            0xff, // $1012 LDA ($ff),Y
            0x91,
            0xff, // $1014 STA ($ff),Y
            0xbd,
            0xf0,
            0xff, // $1016 LDA $fff0,X
            0x6c,
            0xff,
            0x12, // $1019 JMP ($12ff)
        ]);
        expect(result.blocks.map((block) => block.start)).toEqual([0x1000, 0x1007, 0x100a, 0x100b, 0x1010]);
        expect(result.instructions.some((instruction) => instruction.address === 0x100f)).toBe(false);
        expect(result.entryPoints).toContainEqual({ address: 0x1010, source: "call" });
        expect(result.edges).toEqual(
            expect.arrayContaining([
                { from: 0x1005, kind: "branch", target: 0x100b, targetCaptured: true, evidence: "static" },
                { from: 0x1005, kind: "fallthrough", target: 0x1007, targetCaptured: true, evidence: "static" },
                { from: 0x1007, kind: "call", target: 0x1010, targetCaptured: true, evidence: "static" },
                { from: 0x1007, kind: "fallthrough", target: 0x100a, targetCaptured: true, evidence: "static" },
                { from: 0x1019, kind: "jump", evidence: "static" },
            ]),
        );
        expect(result.callsTo(0x1010)).toEqual(result.callsFrom(0x1007));
        expect(result.referencesTo(0xd020).filter((ref) => ref.target.kind === "direct")).toEqual([
            expect.objectContaining({ from: 0x1002, access: "write", purpose: "operand" }),
            expect.objectContaining({ from: 0x100b, access: "read", purpose: "operand" }),
            expect.objectContaining({ from: 0x100b, access: "write", purpose: "operand" }),
        ]);
        expect(result.referencesFrom(0x1012)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    access: "read",
                    purpose: "pointer",
                    target: { kind: "direct", address: 0xff },
                }),
                expect.objectContaining({
                    access: "read",
                    purpose: "pointer",
                    target: { kind: "direct", address: 0x00 },
                }),
                expect.objectContaining({
                    access: "read",
                    purpose: "operand",
                    target: expect.objectContaining({ kind: "indirect" }),
                }),
            ]),
        );
        expect(result.referencesFrom(0x1019)).toEqual([
            expect.objectContaining({ purpose: "pointer", target: { kind: "direct", address: 0x12ff } }),
            expect.objectContaining({ purpose: "pointer", target: { kind: "direct", address: 0x1200 } }),
        ]);
        expect(result.referencesTo(0x0010)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    from: 0x1016,
                    target: { kind: "indexed", base: 0xfff0, index: "X", wrap: "16-bit" },
                }),
            ]),
        );
        expect(result.unresolvedReferences()).toHaveLength(3);
    });

    it("reports external targets and truncated code, and models a halt", () => {
        const result = graph(
            [0x20, 0xd2, 0xff, 0xa9],
            [
                { address: 0x1000, source: "user" },
                { address: 0x2000, source: "vector" },
            ],
        );
        expect(result.callsTo(0xffd2)).toEqual([
            { from: 0x1000, kind: "call", target: 0xffd2, targetCaptured: false, evidence: "static" },
        ]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                { kind: "outside-capture", address: 0x2000 },
                { kind: "truncated", address: 0x1003, bytes: [0xa9] },
            ]),
        );
        const halted = graph([0x02, 0x60]);
        expect(halted.instructions.map((instruction) => instruction.mnemonic)).toEqual(["KIL"]);
        expect(halted.edges).toContainEqual({ from: 0x1000, kind: "halt", evidence: "static" });
    });

    it("retains overlapping interpretations and splits blocks where paths merge", () => {
        const result = graph(
            [0xa9, 0xea, 0x60],
            [
                { address: 0x1000, source: "user" },
                { address: 0x1001, source: "user" },
            ],
        );
        expect(result.diagnostics).toContainEqual({
            kind: "overlapping-instructions",
            address: 0x1000,
            otherAddress: 0x1001,
        });
        expect(result.blocks.map((block) => block.start)).toEqual([0x1000, 0x1001, 0x1002]);
        expect(result.blocks.map((block) => block.instructions.map((instruction) => instruction.address))).toEqual([
            [0x1000],
            [0x1001],
            [0x1002],
        ]);
    });

    it("honors excluded bytes even when a candidate instruction straddles the boundary", () => {
        const decoder = new C6510Decoder(Uint8Array.of(0xad, 0x00, 0x20, 0x60), 0x1000);
        const result = buildC64ControlFlowGraph(decoder, {
            programId: "p",
            viewId: "ram",
            entryPoints: [{ address: 0x1000, source: "user" }],
            excludedRanges: [{ start: 0x1002, end: 0x1002 }],
        });
        expect(result.instructions).toEqual([]);
        expect(result.diagnostics).toEqual([{ kind: "overlaps-excluded", address: 0x1000 }]);
        expect(result.memoryRegionAt(0x1002)).toMatchObject({ kind: "likely-data", evidence: ["excluded"] });
    });

    it("preserves candidate paths ending in a halt without following the halted path", () => {
        const result = graph([
            0xd0,
            0x05, // BNE $1007
            0xa9,
            0x42, // LDA #$42
            0xad,
            0x10,
            0x10, // LDA $1010
            0x02, // KIL (also branch target)
            0x60,
        ]);
        expect(result.instructions.map((instruction) => instruction.address)).toEqual([0x1000, 0x1002, 0x1004, 0x1007]);
        expect(result.memoryRegionAt(0x1002)?.kind).toBe("code");
        expect(result.referencesFrom(0x1004)).toHaveLength(1);
        expect(result.memoryRegionAt(0x1007)).toMatchObject({
            kind: "code",
            evidence: expect.arrayContaining(["control-flow-target", "instruction"]),
        });
        const rejected = graph([0xd0, 0x04, 0xa9, 0x42, 0xea, 0x02, 0x60]);
        expect(rejected.instructions.map((instruction) => instruction.address)).toEqual([
            0x1000, 0x1002, 0x1004, 0x1005, 0x1006,
        ]);
        expect(rejected.edges).toContainEqual({ from: 0x1005, kind: "halt", evidence: "static" });
    });

    it("records accesses and competing code/data evidence without expanding indexed targets", () => {
        const result = graph([
            0xad,
            0x00,
            0x10, // LDA $1000
            0x8d,
            0x0d,
            0x10, // STA $100d
            0xbd,
            0x0e,
            0x10, // LDA $100e,X
            0x60,
            0x41,
            0x42,
            0x43,
            0x44,
            0x45,
            0x46,
        ]);
        expect(result.memoryRegionAt(0x1000)).toMatchObject({
            kind: "mixed",
            evidence: expect.arrayContaining(["instruction", "read"]),
        });
        expect(result.memoryRegionAt(0x100d)).toMatchObject({ kind: "likely-data", evidence: ["write"] });
        expect(result.memoryRegionAt(0x100e)).toMatchObject({ kind: "likely-data", evidence: ["indexed-base"] });
        expect(result.memoryRegionAt(0x100f)?.kind).toBe("unknown");
        expect(result.memoryRegionAt(0x1010)).toBeUndefined();
        expect(() => result.memoryRegionAt(0x10000)).toThrow(RangeError);
        expect(result.toString()).toContain(".byte $44 ; $100d");
    });

    it("keeps truncated paths and unreachable bytes uncertain rather than treating them as invalid code", () => {
        const result = graph([0xea, 0xa9]);
        expect(result.instructions.map((instruction) => instruction.address)).toEqual([0x1000]);
        expect(result.memoryRegionAt(0x1001)).toMatchObject({ kind: "unknown", bytes: [0xa9] });
        expect(result.diagnostics).toContainEqual({ kind: "truncated", address: 0x1001, bytes: [0xa9] });
        const unreachable = graph([0x60, 0x02]);
        expect(unreachable.memoryRegionAt(0x1001)?.kind).toBe("unknown");
    });

    it("preserves explicit call entries and retains overlapping candidate bytes as mixed", () => {
        const result = graph(
            [0xa9, 0xea, 0x02, 0x60],
            [
                { address: 0x1000, source: "user" },
                { address: 0x1001, source: "call" },
                { address: 0x1003, source: "observed" },
            ],
        );
        expect(result.entryPoints).toContainEqual({ address: 0x1001, source: "call" });
        expect(result.instructions.map((instruction) => instruction.address)).toEqual([0x1000, 0x1001, 0x1002, 0x1003]);
        expect(result.diagnostics).toContainEqual({
            kind: "overlapping-instructions",
            address: 0x1000,
            otherAddress: 0x1001,
        });

        const overlapping = graph(
            [0xa9, 0x60, 0x02],
            [
                { address: 0x1000, source: "user" },
                { address: 0x1001, source: "user" },
            ],
        );
        expect(overlapping.instructions.map((instruction) => instruction.address)).toEqual([0x1000, 0x1001, 0x1002]);
        expect(overlapping.diagnostics).toContainEqual({
            kind: "overlapping-instructions",
            address: 0x1000,
            otherAddress: 0x1001,
        });
    });

    it("rejects invalid identities, entries, exclusions and reference queries", () => {
        const decoder = new C6510Decoder(Uint8Array.of(0x60), 0x1000);
        expect(() => buildC64ControlFlowGraph(decoder, { programId: "", viewId: "ram", entryPoints: [] })).toThrow();
        expect(() =>
            buildC64ControlFlowGraph(decoder, {
                programId: "p",
                viewId: "ram",
                entryPoints: [{ address: -1, source: "user" }],
            }),
        ).toThrow(RangeError);
        expect(() =>
            buildC64ControlFlowGraph(decoder, {
                programId: "p",
                viewId: "ram",
                entryPoints: [],
                excludedRanges: [{ start: 2, end: 1 }],
            }),
        ).toThrow(RangeError);
        expect(() => graph([0x60]).referencesTo(65536)).toThrow(RangeError);
    });
});
