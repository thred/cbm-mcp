import { describe, expect, it } from "vitest";
import {
    C64AnalysisState,
    C64_PRG_DEFAULT_BANKING,
    C6510Decoder,
    buildC64ControlFlowGraph,
    c64PossibleMemoryViews,
    type C64BankingContext,
} from "../src/index.js";

function graph(bytes: number[], banking: C64BankingContext = C64_PRG_DEFAULT_BANKING) {
    return buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.from(bytes), 0x1000), {
        programId: "test",
        viewId: "ram",
        entryPoints: [{ address: 0x1000, source: "user" }],
        banking,
    });
}

describe("C64 banking and system annotations", () => {
    it("resolves all eight no-cartridge banking configurations, including write-under-ROM", () => {
        const reads = [
            ["ram", "ram", "ram"],
            ["ram", "character-rom", "ram"],
            ["ram", "character-rom", "kernal-rom"],
            ["basic-rom", "character-rom", "kernal-rom"],
            ["ram", "ram", "ram"],
            ["ram", "io", "ram"],
            ["ram", "io", "kernal-rom"],
            ["basic-rom", "io", "kernal-rom"],
        ];
        for (let data = 0; data < 8; data++) {
            const context: C64BankingContext = { direction: 7, data, cartridge: "none" };
            const addresses = [0xa000, 0xd000, 0xe000];
            expect(addresses.map((address) => c64PossibleMemoryViews(address, "read", context)[0])).toEqual(
                reads[data],
            );
            expect(addresses.map((address) => c64PossibleMemoryViews(address, "write", context)[0])).toEqual([
                "ram",
                reads[data][1] === "io" ? "io" : "ram",
                "ram",
            ]);
        }
    });

    it("accounts for direction, input pins and unknown cartridge mapping", () => {
        expect(
            c64PossibleMemoryViews(0xe000, "read", { direction: 0, data: 0, inputPins: 7, cartridge: "none" }),
        ).toEqual(["kernal-rom"]);
        expect(
            c64PossibleMemoryViews(0xe000, "read", { direction: 0, data: 7, inputPins: 0, cartridge: "none" }),
        ).toEqual(["ram"]);
        expect(c64PossibleMemoryViews(0xe000, "read", { direction: 0, data: 7, cartridge: "none" })).toEqual([
            "ram",
            "kernal-rom",
        ]);
        expect(c64PossibleMemoryViews(0xe000, "read", { direction: 7, data: 0, cartridge: "unknown" })).toEqual([
            "ram",
            "kernal-rom",
            "cartridge",
        ]);
        expect(c64PossibleMemoryViews(0xc000, "read", { cartridge: "unknown" })).toEqual(["ram", "unmapped"]);
        expect(() => c64PossibleMemoryViews(0, "read", { cartridge: "none", direction: 256 })).toThrow("8-bit");
    });

    it("suppresses hidden ROM and I/O annotations, and restores them after remapping", () => {
        const result = graph([
            0xa9,
            0x30,
            0x85,
            0x01, // $1000 bank out ROM and I/O
            0x20,
            0xd2,
            0xff, // $1004 JSR CHROUT address in RAM
            0xa9,
            0x2f,
            0x85,
            0x00, // $1007 restore known DDR
            0xa9,
            0x30,
            0x85,
            0x01, // $100b restore known port
            0xad,
            0x20,
            0xd0, // $100f read RAM, not I/O
            0x20,
            0x8a,
            0xa3, // $1012 BASIC address in RAM
            0xa9,
            0x2f,
            0x85,
            0x00, // $1015 DDR outputs
            0xa9,
            0x37,
            0x85,
            0x01, // $1019 default mapping
            0xad,
            0x20,
            0xd0, // $101d I/O
            0x20,
            0x8a,
            0xa3, // $1020 BASIC
            0x60,
        ]);
        expect(result.possibleViewsAt(0x1004, 0xffd2, "read")).toEqual(["ram"]);
        expect(result.systemAnnotationsFrom(0x1004).some((item) => item.kind === "kernal-call")).toBe(false);
        expect(result.systemAnnotationsFrom(0x100f).some((item) => item.kind === "hardware")).toBe(false);
        expect(result.systemAnnotationsFrom(0x1012).some((item) => item.kind === "basic-rom")).toBe(false);
        expect(result.systemAnnotationsFrom(0x101d)).toContainEqual(
            expect.objectContaining({
                kind: "hardware",
                name: "Border color",
                certainty: "mapped",
                memoryMapEntry: expect.objectContaining({
                    bitFields: expect.arrayContaining([expect.objectContaining({ name: "Color index" })]),
                }),
            }),
        );
        expect(result.systemAnnotationsFrom(0x1020)).toContainEqual(
            expect.objectContaining({
                kind: "basic-rom",
                sourceRevision: 309543,
                referenceVersion: "C64 BASIC V2 and compatible KERNAL",
                basicRomEntry: expect.objectContaining({ address: 0xa38a, kind: "routine" }),
            }),
        );
        expect(result.toString()).not.toContain("KERNAL CHROUT");
    });

    it("tracks port reads and bitwise masks, and labels ROM identity as conditional", () => {
        const result = graph([
            0xa5,
            0x01,
            0x29,
            0xfd,
            0x85,
            0x01, // clear HIRAM using a read of the effective port
            0x20,
            0xd2,
            0xff, // hidden KERNAL
        ]);
        expect(result.possibleViewsAt(0x1006, 0xffd2, "read")).toEqual(["ram"]);
        expect(result.systemAnnotationsFrom(0x1006)).toEqual([]);
        const enabled = graph([0x20, 0xd2, 0xff, 0x60]).systemAnnotationsFrom(0x1000);
        expect(enabled).toContainEqual(
            expect.objectContaining({
                kind: "kernal-call",
                name: "KERNAL CHROUT",
                certainty: "conditional",
                source: "https://sta.c64.org/cbm64krnfunc.html",
                referenceVersion: "Standard C64 KERNAL; source revision unspecified",
                kernalFunction: expect.objectContaining({ name: "CHROUT", inputs: expect.any(Array) }),
            }),
        );
        const restored = graph([0xa9, 0x30, 0x85, 0x01, 0xa9, 0x37, 0x85, 0x01, 0x20, 0xd2, 0xff]);
        expect(restored.possibleViewsAt(0x1008, 0xffd2, "read")).toEqual(["kernal-rom"]);
        expect(restored.systemAnnotationsFrom(0x1008)).toContainEqual(expect.objectContaining({ kind: "kernal-call" }));
        const inputPort = graph([0xa9, 0x00, 0x85, 0x00, 0x20, 0xd2, 0xff]);
        expect(inputPort.possibleViewsAt(0x1004, 0xffd2, "read")).toEqual(["ram", "kernal-rom"]);
        expect(inputPort.systemAnnotationsFrom(0x1004)).toContainEqual(
            expect.objectContaining({ kind: "kernal-call", certainty: "conditional" }),
        );
    });

    it("merges branches and loses certainty after calls, indirect and indexed writes", () => {
        const branched = graph([
            0xd0,
            0x04, // branch past the banking change
            0xa9,
            0x30,
            0x85,
            0x01,
            0x20,
            0xd2,
            0xff,
            0x60,
        ]);
        expect(branched.possibleViewsAt(0x1006, 0xffd2, "read")).toEqual(["ram", "kernal-rom"]);
        expect(branched.systemAnnotationsFrom(0x1006)).toContainEqual(
            expect.objectContaining({ kind: "kernal-call", certainty: "conditional" }),
        );
        const called = graph([0x20, 0x00, 0xc0, 0x20, 0xd2, 0xff, 0x60]);
        expect(called.possibleViewsAt(0x1003, 0xffd2, "read")).toEqual(["ram", "kernal-rom"]);
        const callee = graph([0xa9, 0x30, 0x85, 0x01, 0x20, 0x0a, 0x10, 0x60, 0x02, 0x02, 0x20, 0xd2, 0xff, 0x60]);
        expect(callee.entryPoints).toContainEqual({ address: 0x100a, source: "call" });
        expect(callee.possibleViewsAt(0x100a, 0xffd2, "read")).toEqual(["ram"]);
        expect(callee.systemAnnotationsFrom(0x100a).some((item) => item.kind === "kernal-call")).toBe(false);
        for (const write of [
            [0x91, 0xfb],
            [0x95, 0x80],
            [0x9d, 0xff, 0xff],
        ]) {
            const uncertain = graph([...write, 0x20, 0xd2, 0xff, 0x60]);
            expect(uncertain.possibleViewsAt(0x1000 + write.length, 0xffd2, "read")).toEqual(["ram", "kernal-rom"]);
        }
    });

    it("distinguishes workspace conventions, software vectors, hardware vectors and ROM writes", () => {
        const result = graph([
            0xa5,
            0x2b, // BASIC workspace may be reused
            0x8d,
            0x14,
            0x03, // RAM IRQ software vector
            0x8d,
            0xfe,
            0xff, // RAM under the mapped KERNAL
            0xad,
            0xfe,
            0xff, // hardware vector read from KERNAL
            0x60,
        ]);
        expect(result.systemAnnotationsFrom(0x1000)).toContainEqual(
            expect.objectContaining({
                kind: "workspace",
                certainty: "conventional",
                condition: expect.stringContaining("custom code may reuse"),
            }),
        );
        expect(result.systemAnnotationsFrom(0x1002)).toContainEqual(
            expect.objectContaining({ kind: "vector", view: "ram", certainty: "conventional" }),
        );
        expect(result.systemAnnotationsFrom(0x1005)).toContainEqual(
            expect.objectContaining({ kind: "ram", view: "ram", certainty: "mapped" }),
        );
        expect(result.systemAnnotationsFrom(0x1005)).toContainEqual(
            expect.objectContaining({ kind: "vector", view: "ram" }),
        );
        expect(result.systemAnnotationsFrom(0x1005).some((item) => item.view === "kernal-rom")).toBe(false);
        expect(result.systemAnnotationsFrom(0x1008)).toContainEqual(
            expect.objectContaining({
                kind: "vector",
                view: "kernal-rom",
                condition: expect.stringContaining("contents and mapping at interrupt time"),
            }),
        );
        const interrupt = graph([0x00]);
        expect(interrupt.systemAnnotationsFrom(0x1000)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "vector", address: 0xfffe, condition: expect.stringContaining("NMI") }),
                expect.objectContaining({
                    kind: "vector",
                    address: 0xfffa,
                    condition: expect.stringContaining("hijack"),
                }),
            ]),
        );
        const basicVector = graph([0xad, 0x00, 0xa0, 0x60]);
        expect(basicVector.systemAnnotationsFrom(0x1000)).toContainEqual(
            expect.objectContaining({
                kind: "vector",
                view: "basic-rom",
                basicRomEntry: expect.objectContaining({ kind: "vector" }),
            }),
        );
    });

    it("retains and validates banking evidence in saved snapshots; older states remain unknown", () => {
        const state = new C64AnalysisState("saved");
        const decoder = new C6510Decoder(Uint8Array.of(0x20, 0xd2, 0xff, 0x60), 0x1000);
        state.analyze(decoder, "ram", [{ address: 0x1000, source: "user" }], {
            direction: 7,
            data: 0,
            cartridge: "none",
        });
        const json = state.serialize();
        const restored = C64AnalysisState.deserialize(json);
        const result = restored.restoreGraph("ram");
        expect(result.systemAnnotationsFrom(0x1000).some((item) => item.kind === "kernal-call")).toBe(false);
        expect(result.banking).toMatchObject({ direction: 7, data: 0, cartridge: "none" });
        const legacy = JSON.parse(json);
        legacy.version = 1;
        delete legacy.snapshots[0].banking;
        const unknownGraph = C64AnalysisState.deserialize(JSON.stringify(legacy)).restoreGraph("ram");
        expect(unknownGraph.systemAnnotationsFrom(0x1000)).toContainEqual(
            expect.objectContaining({ kind: "kernal-call", certainty: "conditional" }),
        );
        legacy.version = 2;
        legacy.snapshots[0].banking = { direction: 300, cartridge: "none" };
        expect(() => C64AnalysisState.deserialize(JSON.stringify(legacy))).toThrow("8-bit");
    });
});
