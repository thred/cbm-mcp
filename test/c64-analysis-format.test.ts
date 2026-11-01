import { describe, expect, it } from "vitest";
import {
    C64AnalysisState,
    C64_PRG_DEFAULT_BANKING,
    C6510Decoder,
    buildC64ControlFlowGraph,
    formatC64ControlFlowGraph,
} from "../src/index.js";

describe("C64 analysis text output", () => {
    it("groups contiguous BASIC lines and splits their statements without repeating the heading", () => {
        const bytes = Uint8Array.of(
            0x0d,
            0x08,
            10,
            0,
            0x99,
            0x22,
            0x41,
            0x22,
            0x3a,
            0x99,
            0x42,
            0,
            0x14,
            0x08,
            20,
            0,
            0x99,
            0x43,
            0,
            0,
            0,
        );
        const graph = buildC64ControlFlowGraph(new C6510Decoder(bytes, 0x0801), {
            programId: "basic",
            viewId: "ram",
            entryPoints: [],
        });
        const output = graph.toString();
        expect(output.match(/BASIC V2 candidate/g)).toHaveLength(1);
        expect(output).toContain(
            '; $0801-$0813 BASIC V2 candidate\n    10 PRINT "A":\n        PRINT B\n    20 PRINT C',
        );
    });

    it("hides low-memory raw data while retaining code, and supports an explicit override", () => {
        const bytes = new Uint8Array(0x220);
        bytes.set([0xea, 0x60], 0x70);
        bytes[0x200] = 0x42;
        const graph = buildC64ControlFlowGraph(new C6510Decoder(bytes, 0), {
            programId: "ram",
            viewId: "ram",
            entryPoints: [{ address: 0x70, source: "observed" }],
        });
        const listing = graph.toString();
        expect(listing).toContain("Raw data in $0000-$01ff omitted");
        expect(listing.match(/Raw data in \$0000-\$01ff omitted/g)).toHaveLength(1);
        expect(listing).toContain("; $0070 (entry: observed)");
        expect(listing).toContain("NOP");
        expect(
            listing
                .split("\n")
                .filter((line) => line.includes(".byte"))
                .every((line) => {
                    const address = /; \$([0-9a-f]{4})/.exec(line);
                    return address !== null && parseInt(address[1], 16) >= 0x0200;
                }),
        ).toBe(true);
        expect(listing).toContain(".byte $42");
        expect(formatC64ControlFlowGraph(graph, { includeLowMemoryData: true })).toContain(".byte $00");
        const lowOnly = buildC64ControlFlowGraph(new C6510Decoder(new Uint8Array(0x100), 0), {
            programId: "low",
            viewId: "ram",
            entryPoints: [],
        });
        expect(lowOnly.toString().match(/Raw data in \$0000-\$01ff omitted/g)).toHaveLength(1);
    });

    it("omits only active unused ranges from listings, retaining partial instructions and allowing override", () => {
        const state = new C64AnalysisState("unused");
        const bytes = Uint8Array.of(0x41, 0x42, 0xea, 0xa9, 0x01, 0x60, 0x43);
        const graph = state.analyze(new C6510Decoder(bytes, 0x1000), "ram", [{ address: 0x1002, source: "user" }]);
        const unused = state.addDataSection(graph, 0x1001, 0x1003, "unused", "Candidate gap");
        const options = { dataSections: state.dataSectionStatuses(graph) };
        const text = formatC64ControlFlowGraph(graph, options);
        expect(text).toContain('user-marked "unused"');
        expect(text).not.toContain("    NOP");
        expect(text).toContain("    LDA #$01");
        expect(text).toContain("$1001-$1003 unused [active]");
        expect(formatC64ControlFlowGraph(graph, { ...options, includeUnused: true })).toContain("    NOP");
        const restored = C64AnalysisState.deserialize(state.serialize());
        const restoredGraph = restored.restoreGraph("ram");
        expect(
            formatC64ControlFlowGraph(restoredGraph, { dataSections: restored.dataSectionStatuses(restoredGraph) }),
        ).not.toContain("    NOP");
        expect(graph.instructions.map((instruction) => instruction.address)).toContain(0x1002);
        const changed = bytes.slice();
        changed[1] = 0xff;
        const next = state.analyze(new C6510Decoder(changed, 0x1000), "ram", [{ address: 0x1002, source: "user" }]);
        expect(state.dataSectionStatuses(next)[0]).toMatchObject({ status: "stale", section: { id: unused.id } });
        expect(formatC64ControlFlowGraph(next, { dataSections: state.dataSectionStatuses(next) })).toContain("    NOP");
    });

    it("renders candidate blocks, references, calls and diagnostics without claiming a mapping", () => {
        const decoder = new C6510Decoder(
            Uint8Array.of(0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x20, 0xd2, 0xff, 0xb1, 0xff, 0xd0, 0x01, 0x60, 0x02),
            0x1000,
        );
        const graph = buildC64ControlFlowGraph(decoder, {
            programId: "example",
            viewId: "ram",
            entryPoints: [{ address: 0x1000, source: "user" }],
        });
        const output = graph.toString();
        expect(output).toContain("Program: example");
        expect(output).toContain("Capture: $1000-$100d (14 bytes)");
        expect(output).toContain("execution and mapping are not proven");
        expect(output).toContain("; $1000 (entry: user)\nloc_1000:");
        expect(output).toContain("    LDA #$01");
        expect(output).toContain("    STA mem_d020");
        expect(output).toContain("    JSR loc_ffd2");
        expect(output).toContain("loc_ffd2 = $ffd2");
        expect(output).not.toContain("If I/O is mapped");
        expect(output).not.toContain("If the compatible standard KERNAL is present");
        expect(output).not.toContain("indirect target unresolved");
        expect(output).toContain("$100d: undocumented-opcode");
        expect(output).toContain(".byte $02 ; $100d");
        expect(output).not.toContain("a9 01");
        expect(formatC64ControlFlowGraph(graph)).toBe(output);
    });

    it("keeps system descriptions and provenance available on request without duplicating compact hints", () => {
        const graph = buildC64ControlFlowGraph(
            new C6510Decoder(Uint8Array.of(0xb1, 0x19, 0xad, 0x00, 0xa0, 0x20, 0xd2, 0xff, 0x60), 0x1000),
            {
                programId: "example",
                viewId: "ram",
                entryPoints: [{ address: 0x1000, source: "user" }],
            },
        );
        const compact = graph.toString();
        const pointerLine = compact.split("\n").find((line) => line.includes("LDA (zb_19"));
        expect(pointerLine).toBe("    LDA (zb_19),Y");
        expect(graph.references).toContainEqual(
            expect.objectContaining({ from: 0x1000, target: expect.objectContaining({ kind: "indirect" }) }),
        );
        expect(formatC64ControlFlowGraph(graph, { systemAnnotationDetails: true })).not.toContain(
            "indirect target unresolved",
        );
        expect(compact).not.toContain("Names containing _maybe_ are conventional");
        expect(compact).not.toContain("https://");

        const detailed = formatC64ControlFlowGraph(graph, { systemAnnotationDetails: true });
        expect(detailed).toContain("read $0019 | ram | Temporary string descriptor stack [conventional]");
        expect(detailed).toContain("read $001a | ram | Temporary string descriptor stack [conventional]");
        expect(detailed).toContain("Condition: Conventional use only; custom code may reuse");
        expect(detailed).toContain("Source: https://www.c64-wiki.de/wiki/BASIC-ROM, revision 309543");
        expect(detailed).toContain("Source: https://sta.c64.org/cbm64krnfunc.html");
        expect(graph.systemAnnotationsFrom(0x1000)[0].condition).toContain("custom code may reuse");
    });

    it("retains unofficial opcode hints for indirect instructions without redundant target comments", () => {
        const graph = buildC64ControlFlowGraph(
            new C6510Decoder(Uint8Array.of(0x03, 0x19, 0x60), 0x1000, { includeIllegalOpcodes: true }),
            { programId: "example", viewId: "ram", entryPoints: [{ address: 0x1000, source: "user" }] },
        );
        const output = graph.toString();
        expect(output).toContain("SLO (zb_19,X) ; unofficial");
        expect(output).not.toContain("indirect target unresolved");
    });

    it("keeps the workspace and hardware-vector example concise without dropping references", () => {
        const graph = buildC64ControlFlowGraph(
            new C6510Decoder(
                Uint8Array.of(
                    0xa5,
                    0x53,
                    0x8d,
                    0xf6,
                    0x9f,
                    0xa5,
                    0x54,
                    0x8d,
                    0xf7,
                    0x9f,
                    0xa5,
                    0x55,
                    0x8d,
                    0xf8,
                    0x9f,
                    0xa9,
                    0xb1,
                    0x8d,
                    0xfa,
                    0xff,
                    0xa9,
                    0x0a,
                    0x8d,
                    0xfb,
                    0xff,
                    0x60,
                ),
                0x0880,
            ),
            {
                programId: "example",
                viewId: "ram",
                entryPoints: [{ address: 0x0880, source: "user" }],
                banking: C64_PRG_DEFAULT_BANKING,
            },
        );
        const output = graph.toString();
        const instructionLines = output.split("\n").filter((line) => /^    [A-Z]{3}(?: |$)/.test(line));
        expect(instructionLines).toHaveLength(11);
        expect(Math.max(...instructionLines.map((line) => line.length))).toBeLessThanOrEqual(100);
        expect(output).toContain("LDA zb_53");
        expect(output).toContain("STA vector_ram_nmi_fffa");
        expect(output).toContain("vector_ram_nmi_fffa = $fffa");
        expect(output).not.toContain("zp_maybe_");
        expect(output).not.toContain("8d fa ff");
        expect(output).toContain("vector contents and interrupt-time mapping are unknown");
    });

    it("includes matched and orphaned user annotations when supplied", () => {
        const state = new C64AnalysisState("example");
        const graph = state.analyze(new C6510Decoder(Uint8Array.of(0xea, 0x60), 0x1000), "ram", [
            { address: 0x1000, source: "user" },
        ]);
        state.addAnnotation(graph, "block", 0x1000, "Startup", "Line one\nLine two");
        const text = formatC64ControlFlowGraph(graph, { annotations: state.matchAnnotations(graph) });
        expect(text).toContain("; block annotation [unchanged]: Startup");
        expect(text).toContain(";   Line one\n;   Line two");
        const changed = state.analyze(new C6510Decoder(Uint8Array.of(0x60), 0x1000), "ram", [
            { address: 0x1000, source: "user" },
        ]);
        const orphan = formatC64ControlFlowGraph(changed, { annotations: state.matchAnnotations(changed) });
        expect(orphan).toContain("block $1000 (ram) [orphaned]: Startup\n;   Line one\n;   Line two");
    });

    it("interleaves captured bytes and code in address order from the start of the capture", () => {
        const graph = buildC64ControlFlowGraph(
            new C6510Decoder(Uint8Array.of(0x10, 0x20, 0xa9, 0x01, 0x60, 0x41, 0x42, 0xea, 0x60, 0x99), 0x1000),
            {
                programId: "example",
                viewId: "ram",
                entryPoints: [
                    { address: 0x1002, source: "user" },
                    { address: 0x1007, source: "user" },
                ],
            },
        );
        const output = graph.toString();
        const parts = [
            "; $1000-$1001 unknown",
            ".byte $10, $20 ; $1000",
            "; $1002 (entry: user)",
            "LDA #$01",
            "; $1005-$1006 unknown",
            ".byte $41, $42 ; $1005",
            "; $1007 (entry: user)",
            "NOP",
            "; $1009-$1009 unknown",
            ".byte $99 ; $1009",
        ];
        let previous = -1;
        for (const part of parts) {
            const position = output.indexOf(part);
            expect(position, part).toBeGreaterThan(previous);
            previous = position;
        }
    });

    it("interleaves mixed bytes within a block and marks its continuation", () => {
        const graph = buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.of(0xad, 0x01, 0x10, 0xea, 0x60), 0x1000), {
            programId: "example",
            viewId: "ram",
            entryPoints: [{ address: 0x1000, source: "user" }],
        });
        const output = graph.toString();
        expect(output).toContain(
            "LDA mem_1001\n\n; $1001-$1001 mixed; instruction, read\n    .byte $01 ; $1001\n\n; $1003 (continuation of block $1000)\n    NOP\n    RTS",
        );
        expect(output).toContain("mem_1001 = $1001");
    });

    it("renders a detected BASIC program before machine code and rebuilds it from saved state", () => {
        const bytes = Uint8Array.of(0xff, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0x60);
        const state = new C64AnalysisState("example");
        const graph = state.analyze(new C6510Decoder(bytes, 0x0800), "ram", [{ address: 0x080d, source: "user" }]);
        const output = graph.toString();
        expect(graph.basicPrograms).toHaveLength(1);
        expect(graph.basicPrograms[0]).toMatchObject({ startAddress: 0x0801, endAddressExclusive: 0x080d });
        expect(output).toContain("; $0800-$0800 unknown\n    .byte $ff ; $0800");
        expect(output).toContain("; $0801-$080a BASIC V2 candidate\n    10 SYS 2061");
        expect(output).toContain("; $080b-$080c BASIC V2 end marker");
        expect(output.indexOf("10 SYS 2061")).toBeLessThan(output.indexOf("; $080d (entry: user)"));
        expect(output).not.toContain(".byte $0b, $08");
        expect(C64AnalysisState.deserialize(state.serialize()).restoreGraph("ram").basicPrograms).toEqual(
            graph.basicPrograms,
        );
    });

    it("shows both BASIC and byte/code interpretations when machine code overlaps the BASIC program", () => {
        const bytes = Uint8Array.of(0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00);
        const graph = buildC64ControlFlowGraph(new C6510Decoder(bytes, 0x0801), {
            programId: "example",
            viewId: "ram",
            entryPoints: [{ address: 0x0808, source: "user" }],
        });
        const output = graph.toString();
        expect(output).toContain("10 SYS 2061");
        expect(output).toContain(".byte $0b, $08");
        expect(output).toContain("; $0808 (entry: user)");
        expect(output).toContain("ROL");
        expect(output).toContain("; $080b-$080c BASIC V2 end marker");
        expect(graph.memoryRegionAt(0x0801)?.bytes.slice(0, 2)).toEqual([0x0b, 0x08]);
    });

    it("renders an empty capture and undiscovered entry points", () => {
        const graph = buildC64ControlFlowGraph(new C6510Decoder(new Uint8Array(), 0x2000), {
            programId: "empty",
            viewId: "ram",
            entryPoints: [{ address: 0x2000, source: "user" }],
        });
        expect(graph.toString()).toContain("Capture: empty at $2000");
        expect(graph.toString()).toContain("$2000: outside-capture");
    });
});
