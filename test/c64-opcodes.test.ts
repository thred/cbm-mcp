import { describe, expect, it } from "vitest";
import { OpCodes, type OpCode } from "../src/analysis-engine/c64-opcodes.js";

// Each row covers 16 byte values; "-" denotes an undocumented encoding.
const reference = [
    "BRK:i:7 ORA:ix:6 - - - ORA:z:3 ASL:z:5 - PHP:i:3 ORA:m:2 ASL:a:2 - - ORA:b:4 ASL:b:6 -",
    "BPL:r:2 ORA:iy:5 - - - ORA:zx:4 ASL:zx:6 - CLC:i:2 ORA:by:4 - - - ORA:bx:4 ASL:bx:7 -",
    "JSR:b:6 AND:ix:6 - - BIT:z:3 AND:z:3 ROL:z:5 - PLP:i:4 AND:m:2 ROL:a:2 - BIT:b:4 AND:b:4 ROL:b:6 -",
    "BMI:r:2 AND:iy:5 - - - AND:zx:4 ROL:zx:6 - SEC:i:2 AND:by:4 - - - AND:bx:4 ROL:bx:7 -",
    "RTI:i:6 EOR:ix:6 - - - EOR:z:3 LSR:z:5 - PHA:i:3 EOR:m:2 LSR:a:2 - JMP:b:3 EOR:b:4 LSR:b:6 -",
    "BVC:r:2 EOR:iy:5 - - - EOR:zx:4 LSR:zx:6 - CLI:i:2 EOR:by:4 - - - EOR:bx:4 LSR:bx:7 -",
    "RTS:i:6 ADC:ix:6 - - - ADC:z:3 ROR:z:5 - PLA:i:4 ADC:m:2 ROR:a:2 - JMP:ind:5 ADC:b:4 ROR:b:6 -",
    "BVS:r:2 ADC:iy:5 - - - ADC:zx:4 ROR:zx:6 - SEI:i:2 ADC:by:4 - - - ADC:bx:4 ROR:bx:7 -",
    "- STA:ix:6 - - STY:z:3 STA:z:3 STX:z:3 - DEY:i:2 - TXA:i:2 - STY:b:4 STA:b:4 STX:b:4 -",
    "BCC:r:2 STA:iy:6 - - STY:zx:4 STA:zx:4 STX:zy:4 - TYA:i:2 STA:by:5 TXS:i:2 - - STA:bx:5 - -",
    "LDY:m:2 LDA:ix:6 LDX:m:2 - LDY:z:3 LDA:z:3 LDX:z:3 - TAY:i:2 LDA:m:2 TAX:i:2 - LDY:b:4 LDA:b:4 LDX:b:4 -",
    "BCS:r:2 LDA:iy:5 - - LDY:zx:4 LDA:zx:4 LDX:zy:4 - CLV:i:2 LDA:by:4 TSX:i:2 - LDY:bx:4 LDA:bx:4 LDX:by:4 -",
    "CPY:m:2 CMP:ix:6 - - CPY:z:3 CMP:z:3 DEC:z:5 - INY:i:2 CMP:m:2 DEX:i:2 - CPY:b:4 CMP:b:4 DEC:b:6 -",
    "BNE:r:2 CMP:iy:5 - - - CMP:zx:4 DEC:zx:6 - CLD:i:2 CMP:by:4 - - - CMP:bx:4 DEC:bx:7 -",
    "CPX:m:2 SBC:ix:6 - - CPX:z:3 SBC:z:3 INC:z:5 - INX:i:2 SBC:m:2 NOP:i:2 - CPX:b:4 SBC:b:4 INC:b:6 -",
    "BEQ:r:2 SBC:iy:5 - - - SBC:zx:4 INC:zx:6 - SED:i:2 SBC:by:4 - - - SBC:bx:4 INC:bx:7 -",
];

const modes = {
    i: ["implied", 1],
    a: ["accumulator", 1],
    m: ["immediate", 2],
    z: ["zero-page", 2],
    zx: ["zero-page-x", 2],
    zy: ["zero-page-y", 2],
    b: ["absolute", 3],
    bx: ["absolute-x", 3],
    by: ["absolute-y", 3],
    ind: ["indirect", 3],
    ix: ["indirect-x", 2],
    iy: ["indirect-y", 2],
    r: ["relative", 2],
} as const;

const flags: Record<string, string> = {
    ADC: "NVZC",
    AND: "NZ",
    ASL: "NZC",
    BIT: "NVZ",
    BRK: "I",
    CLC: "C",
    CLD: "D",
    CLI: "I",
    CLV: "V",
    CMP: "NZC",
    CPX: "NZC",
    CPY: "NZC",
    DEC: "NZ",
    DEX: "NZ",
    DEY: "NZ",
    EOR: "NZ",
    INC: "NZ",
    INX: "NZ",
    INY: "NZ",
    LDA: "NZ",
    LDX: "NZ",
    LDY: "NZ",
    LSR: "NZC",
    ORA: "NZ",
    PLA: "NZ",
    PLP: "NVZDIC",
    ROL: "NZC",
    ROR: "NZC",
    RTI: "NVZDIC",
    SBC: "NVZC",
    SEC: "C",
    SED: "D",
    SEI: "I",
    TAX: "NZ",
    TAY: "NZ",
    TSX: "NZ",
    TXA: "NZ",
    TYA: "NZ",
};

describe("documented NMOS 6502 opcode catalog", () => {
    it("includes every unofficial encoding, including terminal and unstable instructions", () => {
        const all = OpCodes.all;
        const illegal = all.filter((entry) => entry.illegal);
        expect(all).toHaveLength(256);
        expect(new Set(all.map((entry) => entry.code)).size).toBe(256);
        expect(illegal).toHaveLength(105);
        expect(illegal.filter((entry) => entry.effects.flow === "halt")).toHaveLength(12);
        for (const [code, mnemonic, mode, cycles] of [
            [0x03, "SLO", "indirect-x", 8],
            [0x17, "SLO", "zero-page-x", 6],
            [0x2f, "RLA", "absolute", 6],
            [0x53, "SRE", "indirect-y", 8],
            [0x7b, "RRA", "absolute-y", 7],
            [0x87, "SAX", "zero-page", 3],
            [0xa3, "LAX", "indirect-x", 6],
            [0xd3, "DCP", "indirect-y", 8],
            [0xff, "ISC", "absolute-x", 7],
            [0x0b, "ANC", "immediate", 2],
            [0x4b, "ALR", "immediate", 2],
            [0x6b, "ARR", "immediate", 2],
            [0xcb, "AXS", "immediate", 2],
            [0xeb, "SBC", "immediate", 2],
            [0x1c, "NOP", "absolute-x", 4],
            [0x02, "KIL", "implied", null],
            [0x93, "AHX", "indirect-y", 6],
            [0x9b, "TAS", "absolute-y", 5],
            [0x9c, "SHY", "absolute-x", 5],
            [0x9e, "SHX", "absolute-y", 5],
            [0x9f, "AHX", "absolute-y", 5],
            [0xbb, "LAS", "absolute-y", 4],
            [0x8b, "XAA", "immediate", 2],
            [0xab, "LAX", "immediate", 2],
        ] as const) {
            expect(all.find((entry) => entry.code === code)).toMatchObject({
                illegal: true,
                mode,
                cycles,
                syntax: expect.stringMatching(new RegExp(`^${mnemonic}(?: |$)`)),
            });
        }
        expect(all.find((entry) => entry.code === 0x03)?.effects).toMatchObject({
            operandAccess: "read-modify-write",
            pointerRead: "zero-page-x",
            registersRead: ["A", "X"],
            registersWritten: ["A"],
        });
        expect(all.find((entry) => entry.code === 0x1c)?.additionalCycleOnPageBoundaryCrossed).toBe(true);
        expect(all.find((entry) => entry.code === 0x9e)).toMatchObject({ unstable: true, unstableAddress: true });
        expect(all.find((entry) => entry.code === 0x02)?.effects.flow).toBe("halt");
    });

    it("matches all composite read-modify-write families and unofficial NOP encodings", () => {
        const byCode = new Map(OpCodes.all.map((entry) => [entry.code, entry]));
        for (const [base, mnemonic] of [
            [0x00, "SLO"],
            [0x20, "RLA"],
            [0x40, "SRE"],
            [0x60, "RRA"],
            [0xc0, "DCP"],
            [0xe0, "ISC"],
        ] as const) {
            for (const [offset, mode, cycles] of [
                [0x03, "indirect-x", 8],
                [0x07, "zero-page", 5],
                [0x0f, "absolute", 6],
                [0x13, "indirect-y", 8],
                [0x17, "zero-page-x", 6],
                [0x1b, "absolute-y", 7],
                [0x1f, "absolute-x", 7],
            ] as const) {
                expect(byCode.get(base + offset)).toMatchObject({
                    syntax: expect.stringMatching(new RegExp(`^${mnemonic} `)),
                    mode,
                    cycles,
                    effects: { operandAccess: "read-modify-write" },
                    illegal: true,
                });
            }
        }
        for (const [codes, mode, cycles, pageCross] of [
            [[0x04, 0x44, 0x64], "zero-page", 3, false],
            [[0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4], "zero-page-x", 4, false],
            [[0x0c], "absolute", 4, false],
            [[0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc], "absolute-x", 4, true],
            [[0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa], "implied", 2, false],
            [[0x80, 0x82, 0x89, 0xc2, 0xe2], "immediate", 2, false],
        ] as const) {
            for (const code of codes) {
                expect(byCode.get(code)).toMatchObject({
                    syntax: expect.stringMatching(/^NOP(?: |$)/),
                    mode,
                    cycles,
                    illegal: true,
                    additionalCycleOnPageBoundaryCrossed: pageCross,
                });
            }
        }
    });

    it("matches all 256 byte positions, modes, lengths and base cycles", () => {
        const entries = OpCodes.all.filter((entry) => !entry.illegal);
        const byCode = new Map(entries.map((entry) => [entry.code, entry]));
        expect(entries).toHaveLength(151);
        expect(byCode.size).toBe(151);
        expect(new Set(entries.map((entry) => entry.syntax.slice(0, 3))).size).toBe(56);
        expect(reference).toHaveLength(16);

        reference.forEach((row, high) => {
            const cells = row.split(" ");
            expect(cells).toHaveLength(16);
            cells.forEach((cell, low) => {
                const code = high * 16 + low;
                const entry = byCode.get(code);
                if (cell === "-") {
                    expect(entry, `opcode $${code.toString(16)}`).toBeUndefined();
                    return;
                }

                const [mnemonic, modeKey, cycles] = cell.split(":");
                const [mode, length] = modes[modeKey as keyof typeof modes];
                expect(entry, `opcode $${code.toString(16)}`).toMatchObject({
                    code,
                    mode,
                    length,
                    cycles: Number(cycles),
                    illegal: false,
                });
                expect(entry?.syntax.slice(0, 3)).toBe(mnemonic);
            });
        });
    });

    it("describes flag effects and decimal arithmetic for every encoding", () => {
        for (const entry of OpCodes.all.filter((entry) => !entry.illegal)) {
            const mnemonic = entry.syntax.slice(0, 3);
            const affected = flags[mnemonic] ?? "";
            expect(entry, mnemonic).toMatchObject({
                negativeFlagAffected: affected.includes("N"),
                overflowFlagAffected: affected.includes("V"),
                decimalFlagAffected: affected.includes("D"),
                interruptDisableFlagAffected: affected.includes("I"),
                zeroFlagAffected: affected.includes("Z"),
                carryFlagAffected: affected.includes("C"),
                affectedByDecimalFlag: mnemonic === "ADC" || mnemonic === "SBC",
            });
        }
    });

    it("distinguishes taken branches, indexed reads and fixed-time writes", () => {
        for (const entry of OpCodes.all.filter((entry) => !entry.illegal)) {
            const mnemonic = entry.syntax.slice(0, 3);
            const branch = entry.mode === "relative";
            const indexedRead =
                ["ADC", "AND", "CMP", "EOR", "LDA", "LDX", "LDY", "ORA", "SBC"].includes(mnemonic) &&
                ["absolute-x", "absolute-y", "indirect-y"].includes(entry.mode);
            expect(entry.additionalCycleWhenBranchTaken, entry.syntax).toBe(branch);
            expect(entry.additionalCycleOnPageBoundaryCrossed, entry.syntax).toBe(branch || indexedRead);
        }
    });

    it("classifies operand access for all documented encodings", () => {
        const reads = new Set(["ADC", "AND", "BIT", "CMP", "CPX", "CPY", "EOR", "LDA", "LDX", "LDY", "ORA", "SBC"]);
        const writes = new Set(["STA", "STX", "STY"]);
        const modifies = new Set(["ASL", "LSR", "ROL", "ROR", "INC", "DEC"]);
        for (const entry of OpCodes.all.filter((entry) => !entry.illegal)) {
            const mnemonic = entry.syntax.slice(0, 3);
            const memory = !["immediate", "implied", "accumulator", "relative"].includes(entry.mode);
            const expected = !memory
                ? "none"
                : writes.has(mnemonic)
                  ? "write"
                  : modifies.has(mnemonic)
                    ? "read-modify-write"
                    : reads.has(mnemonic)
                      ? "read"
                      : "none";
            expect(entry.effects.operandAccess, entry.syntax).toBe(expected);
            const pointer =
                entry.mode === "indirect-x"
                    ? "zero-page-x"
                    : entry.mode === "indirect-y"
                      ? "zero-page"
                      : entry.mode === "indirect"
                        ? "absolute-nmos-wrap"
                        : "none";
            expect(entry.effects.pointerRead, entry.syntax).toBe(pointer);
        }
    });

    it("describes flag dependencies, control flow, registers and stack operations", () => {
        const branches = {
            BCC: ["C", 0],
            BCS: ["C", 1],
            BEQ: ["Z", 1],
            BNE: ["Z", 0],
            BMI: ["N", 1],
            BPL: ["N", 0],
            BVC: ["V", 0],
            BVS: ["V", 1],
        } as const;
        for (const [name, [flag, value]] of Object.entries(branches)) {
            const entry = OpCodes.all.find((op) => op.syntax.startsWith(name));
            expect(entry?.effects).toMatchObject({
                flow: "branch",
                branchCondition: { flag, value },
                flagsRead: [flag],
            });
        }
        expect(OpCodes.ADC_INDIRECT_Y.effects).toMatchObject({
            registersRead: ["A", "Y"],
            registersWritten: ["A"],
            flagsRead: ["C", "D"],
            operandAccess: "read",
            pointerRead: "zero-page",
        });
        expect(OpCodes.STA_INDIRECT_X.effects).toMatchObject({
            registersRead: ["A", "X"],
            registersWritten: [],
            operandAccess: "write",
            pointerRead: "zero-page-x",
        });
        expect(OpCodes.ROL_ACCUMULATOR.effects).toMatchObject({
            registersRead: ["A"],
            registersWritten: ["A"],
            flagsRead: ["C"],
            operandAccess: "none",
        });
        expect(OpCodes.ASL_ABSOLUTE.effects.operandAccess).toBe("read-modify-write");
        expect(OpCodes.JSR_ABSOLUTE.effects).toMatchObject({ flow: "call", stack: "push-2", operandAccess: "none" });
        expect(OpCodes.JMP_INDIRECT.effects).toMatchObject({ flow: "jump", pointerRead: "absolute-nmos-wrap" });
        expect(OpCodes.BRK_IMPLIED.effects).toMatchObject({
            flow: "interrupt",
            stack: "push-3",
            defaultVectorAddress: 0xfffe,
        });
        expect(OpCodes.RTS_IMPLIED.effects).toMatchObject({ flow: "return", stack: "pull-2" });
        expect(OpCodes.RTI_IMPLIED.effects).toMatchObject({ flow: "interrupt-return", stack: "pull-3" });
        expect(OpCodes.TXS_IMPLIED.effects).toMatchObject({
            registersRead: ["X"],
            registersWritten: ["SP"],
            stack: "set-from-x",
        });
    });

    it("preserves the existing ADC constants and operand syntax", () => {
        const entry: OpCode = { ...OpCodes.ADC_IMMEDIATE };
        expect(Object.getPrototypeOf(OpCodes.ADC_IMMEDIATE)).toBe(Object.prototype);
        expect(entry).toMatchObject({ illegal: false, architectures: [] });
        expect(OpCodes.ADC_IMMEDIATE).toMatchObject({
            code: 0x69,
            name: "Add with Carry",
            syntax: "ADC #$nn",
            length: 2,
            cycles: 2,
            mode: "immediate",
            affectedByDecimalFlag: true,
        });
        expect(OpCodes.ADC_INDIRECT_X.syntax).toBe("ADC ($nn,X)");
        expect(OpCodes.ADC_INDIRECT_Y.syntax).toBe("ADC ($nn),Y");
        expect(OpCodes.JMP_INDIRECT.syntax).toBe("JMP ($nnnn)");
    });
});
