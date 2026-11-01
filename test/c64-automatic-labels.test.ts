import { describe, expect, it } from "vitest";
import {
    C64AnalysisState,
    C64_PRG_DEFAULT_BANKING,
    C6510Decoder,
    buildC64ControlFlowGraph,
    type C64BankingContext,
} from "../src/index.js";

function graph(bytes: number[], banking?: C64BankingContext) {
    return buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.from(bytes), 0x1000), {
        programId: "test",
        viewId: "ram",
        entryPoints: [{ address: 0x1000, source: "user" }],
        banking,
    });
}

describe("automatic symbolic labels", () => {
    it("labels branches, direct calls, memory operands and indirect pointers without byte listings", () => {
        const result = graph(
            [
                0xd0,
                0x08, // BNE $100a
                0x20,
                0x0b,
                0x10, // JSR $100b
                0xad,
                0x00,
                0x20, // LDA $2000
                0xb1,
                0xfb, // LDA ($fb),Y
                0x60, // $100a RTS
                0x6c,
                0x00,
                0x30, // $100b JMP ($3000)
            ],
            C64_PRG_DEFAULT_BANKING,
        );
        const output = result.toString();
        expect(output).toContain("loc_1000:\n    BNE loc_100a");
        expect(output).toContain("JSR loc_100b");
        expect(output).toContain("LDA mem_2000");
        expect(output).toContain("JMP (mem_3000)");
        expect(output).toContain("mem_2000 = $2000");
        expect(output).toContain("mem_3000 = $3000");
        expect(output).not.toContain("  d0 08");
        expect(result.automaticLabelsAt(0x2000)).toContainEqual(
            expect.objectContaining({ name: "mem_2000", kind: "memory", source: "generated" }),
        );
        expect(() => result.automaticLabelsAt(0x10000)).toThrow("16-bit");
    });

    it("uses neutral zero-page names for direct and indexed-indirect references", () => {
        const result = graph([0xa5, 0x19, 0x81, 0x19, 0x60], C64_PRG_DEFAULT_BANKING);
        const labels = result.automaticLabelsAt(0x19);
        expect(labels).toHaveLength(1);
        expect(labels[0]).toMatchObject({
            name: "zb_19",
            kind: "zero-page",
            source: "generated",
        });
        expect(result.toString()).toContain(`LDA ${labels[0].name}`);
        expect(result.toString()).toContain(`STA (${labels[0].name},X)`);
        expect(result.toString()).toContain("zb_19 = $0019");
        expect(result.toString()).not.toContain("conventional use");
        expect(result.systemAnnotationsTo(0x19)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "Temporary string descriptor stack", certainty: "conventional" }),
            ]),
        );
    });

    it("keeps processor-port names and uses neutral labels for other zero-page addressing modes", () => {
        const result = graph([0xa5, 0x00, 0x85, 0x01, 0xa1, 0x00, 0xb1, 0xff, 0xad, 0x54, 0x00, 0x60]);
        const output = result.toString();
        expect(output).toContain("LDA cpu_port_direction");
        expect(output).toContain("STA cpu_port");
        expect(output).toContain("LDA (zb_00,X)");
        expect(output).toContain("LDA (zb_ff),Y");
        expect(output).toContain("LDA zb_54");
        expect(output).not.toContain("zp_maybe_");
        expect(output).not.toContain("vector_maybe_basic");
    });

    it("distinguishes zero-page data accesses from code targets at the same address", () => {
        const result = buildC64ControlFlowGraph(new C6510Decoder(Uint8Array.of(0xa5, 0x14, 0xd0, 0x00, 0x60), 0x10), {
            programId: "test",
            viewId: "ram",
            entryPoints: [{ address: 0x10, source: "user" }],
        });
        expect(result.toString()).toContain("LDA zb_14");
        expect(result.toString()).toContain("BNE loc_0014");
        expect(result.toString()).toContain("loc_0014:");
        expect(result.toString()).toContain("zb_14 = $0014");
    });

    it("uses KERNAL and BASIC names only when the corresponding ROM can be proven mapped", () => {
        const enabled = graph([0x20, 0xd2, 0xff, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(enabled.toString()).toContain("JSR kernal_chrout");
        expect(enabled.resolveLabel(0x1000, 0xffd2)).toBe("kernal_chrout");
        expect(() => enabled.resolveLabel(0x1234, 0xffd2)).toThrow("discovered instruction");
        expect(enabled.automaticLabelsAt(0xffd2)).toContainEqual(
            expect.objectContaining({
                name: "kernal_chrout",
                kind: "kernal",
                condition: expect.stringContaining("compatible"),
            }),
        );
        const disabled = graph([0xa9, 0x35, 0x85, 0x01, 0x20, 0xd2, 0xff, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(disabled.toString()).toContain("JSR loc_ffd2");
        expect(disabled.resolveLabel(0x1004, 0xffd2)).toBe("loc_ffd2");
        expect(disabled.automaticLabelsAt(0xffd2).some((label) => label.kind === "kernal")).toBe(false);
        const unknown = graph([0x20, 0xd2, 0xff, 0x60]);
        expect(unknown.toString()).toContain("JSR loc_ffd2");
        expect(unknown.toString()).not.toContain("kernal_chrout");
        const basic = graph([0x4c, 0x8a, 0xa3], C64_PRG_DEFAULT_BANKING);
        expect(basic.toString()).toContain("JMP basic_search_basic_stack");
        expect(basic.toString()).toContain("basic_search_basic_stack = $a38a ; requires compatible ROM and mapping");
    });

    it("distinguishes banked ROM reads and RAM writes and I/O from hidden I/O", () => {
        const basic = graph([0xad, 0x00, 0xa0, 0x8d, 0x00, 0xa0, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(basic.toString()).toContain("LDA basic_cold_start_vector");
        expect(basic.toString()).toContain("STA mem_a000");
        expect(
            basic
                .automaticLabelsAt(0xa000)
                .map((label) => label.kind)
                .sort(),
        ).toEqual(["basic", "memory"]);
        const rmw = graph([0xee, 0x00, 0xa0, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(rmw.toString()).toContain("INC mem_a000");
        expect(rmw.automaticLabelsAt(0xa000).every((label) => label.kind !== "basic")).toBe(true);
        const io = graph([0xad, 0x20, 0xd0, 0xa9, 0x33, 0x85, 0x01, 0x8d, 0x20, 0xd0, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(io.toString()).toContain("LDA io_border_color_d020");
        expect(io.toString()).toContain("STA mem_d020");
        expect(
            io
                .automaticLabelsAt(0xd020)
                .map((label) => label.kind)
                .sort(),
        ).toEqual(["hardware", "memory"]);
    });

    it("labels vector addresses without asserting their contents or interrupt-time mapping", () => {
        const result = graph([0xad, 0x14, 0x03, 0x8d, 0xfa, 0xff, 0xad, 0xfa, 0xff, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(result.toString()).toContain("LDA vector_maybe_kernal_irq_0314");
        expect(result.toString()).toContain("STA vector_ram_nmi_fffa");
        expect(result.toString()).toContain("LDA vector_kernal_nmi_fffa");
        expect(result.toString()).toContain("vector contents and interrupt-time mapping are unknown");
        expect(result.automaticLabelsAt(0xfffa).map((label) => label.kind)).toEqual(["vector", "vector"]);
    });

    it("gives editable user labels priority and prevents generated name collisions", () => {
        const state = new C64AnalysisState("labels");
        const decoder = new C6510Decoder(Uint8Array.of(0xad, 0x00, 0x20, 0x60), 0x1000);
        const result = state.analyze(decoder, "ram", [{ address: 0x1000, source: "user" }], C64_PRG_DEFAULT_BANKING);
        const label = state.addLabel(result, 0x2000, "loc_1000");
        expect(result.toString()).toContain("loc_1000_1000:\n    LDA loc_1000");
        expect(result.toString()).toContain("loc_1000 = $2000");
        expect(result.automaticLabelsAt(0x2000)).toEqual([]);
        state.renameLabel(label.id, "score");
        expect(result.toString()).toContain("loc_1000:\n    LDA score");
        expect(result.automaticLabelsAt(0x1000)[0].name).toBe("loc_1000");
        state.removeLabel(label.id);
        expect(result.toString()).toContain("LDA mem_2000");
    });

    it("respects user labels and name collisions for neutral zero-page labels", () => {
        const state = new C64AnalysisState("zero-page");
        const decoder = new C6510Decoder(Uint8Array.of(0xa5, 0x19, 0xa5, 0x20, 0x60), 0x1000);
        const result = state.analyze(decoder, "ram", [{ address: 0x1000, source: "user" }]);
        state.addLabel(result, 0x19, "counter");
        state.addLabel(result, 0x2000, "zb_20");
        expect(result.toString()).toContain("LDA counter");
        expect(result.toString()).toContain("LDA zb_20_0020");
        expect(result.toString()).toContain("zb_20_0020 = $0020");
    });

    it("disambiguates generated reference names from user names at different addresses", () => {
        const state = new C64AnalysisState("collision");
        const decoder = new C6510Decoder(Uint8Array.of(0x20, 0xd2, 0xff, 0x60), 0x1000);
        const result = state.analyze(decoder, "ram", [{ address: 0x1000, source: "user" }], C64_PRG_DEFAULT_BANKING);
        state.addLabel(result, 0x2000, "kernal_chrout");
        expect(result.toString()).toContain("JSR kernal_chrout_ffd2");
        expect(result.toString()).toContain("kernal_chrout = $2000");
        expect(result.toString()).toContain("kernal_chrout_ffd2 = $ffd2");
    });

    it("defines outside-capture branch targets without claiming they are decoded code", () => {
        const result = graph([0xd0, 0x7f, 0x60], C64_PRG_DEFAULT_BANKING);
        expect(result.toString()).toContain("BNE loc_1081");
        expect(result.toString()).toContain("loc_1081 = $1081 ; outside discovered code");
        expect(result.edges).toContainEqual(
            expect.objectContaining({ kind: "branch", target: 0x1081, targetCaptured: false }),
        );
    });
});
