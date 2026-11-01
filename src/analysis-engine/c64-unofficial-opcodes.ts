import type { C64CpuRegister, C64StatusFlag, OpCode, OpCodeEffects, OpCodeMode } from "./c64-opcodes.js";

type Mode = Exclude<
    OpCodeMode,
    "indexed" | "indexed-indirect" | "indirect-indexed" | "relative" | "accumulator" | "indirect"
>;
const modes: Record<string, { mode: Mode; operand: string; length: number }> = {
    i: { mode: "implied", operand: "", length: 1 },
    m: { mode: "immediate", operand: " #$nn", length: 2 },
    z: { mode: "zero-page", operand: " $nn", length: 2 },
    zx: { mode: "zero-page-x", operand: " $nn,X", length: 2 },
    zy: { mode: "zero-page-y", operand: " $nn,Y", length: 2 },
    b: { mode: "absolute", operand: " $nnnn", length: 3 },
    bx: { mode: "absolute-x", operand: " $nnnn,X", length: 3 },
    by: { mode: "absolute-y", operand: " $nnnn,Y", length: 3 },
    ix: { mode: "indirect-x", operand: " ($nn,X)", length: 2 },
    iy: { mode: "indirect-y", operand: " ($nn),Y", length: 2 },
};

// Each row covers 16 byte values; "-" is an official encoding.
const rows = [
    "- - KIL:i SLO:ix:8 NOP:z:3 - - SLO:z:5 - - - ANC:m:2 NOP:b:4 - - SLO:b:6",
    "- - KIL:i SLO:iy:8 NOP:zx:4 - - SLO:zx:6 - - NOP:i:2 SLO:by:7 NOP:bx:4 - - SLO:bx:7",
    "- - KIL:i RLA:ix:8 - - - RLA:z:5 - - - ANC:m:2 - - - RLA:b:6",
    "- - KIL:i RLA:iy:8 NOP:zx:4 - - RLA:zx:6 - - NOP:i:2 RLA:by:7 NOP:bx:4 - - RLA:bx:7",
    "- - KIL:i SRE:ix:8 NOP:z:3 - - SRE:z:5 - - - ALR:m:2 - - - SRE:b:6",
    "- - KIL:i SRE:iy:8 NOP:zx:4 - - SRE:zx:6 - - NOP:i:2 SRE:by:7 NOP:bx:4 - - SRE:bx:7",
    "- - KIL:i RRA:ix:8 NOP:z:3 - - RRA:z:5 - - - ARR:m:2 - - - RRA:b:6",
    "- - KIL:i RRA:iy:8 NOP:zx:4 - - RRA:zx:6 - - NOP:i:2 RRA:by:7 NOP:bx:4 - - RRA:bx:7",
    "NOP:m:2 - NOP:m:2 SAX:ix:6 - - - SAX:z:3 - NOP:m:2 - XAA:m:2 - - - SAX:b:4",
    "- - KIL:i AHX:iy:6 - - - SAX:zy:4 - - - TAS:by:5 SHY:bx:5 - SHX:by:5 AHX:by:5",
    "- - - LAX:ix:6 - - - LAX:z:3 - - - LAX:m:2 - - - LAX:b:4",
    "- - KIL:i LAX:iy:5 - - - LAX:zy:4 - - - LAS:by:4 - - - LAX:by:4",
    "- - NOP:m:2 DCP:ix:8 - - - DCP:z:5 - - - AXS:m:2 - - - DCP:b:6",
    "- - KIL:i DCP:iy:8 NOP:zx:4 - - DCP:zx:6 - - NOP:i:2 DCP:by:7 NOP:bx:4 - - DCP:bx:7",
    "- - NOP:m:2 ISC:ix:8 - - - ISC:z:5 - - - SBC:m:2 - - - ISC:b:6",
    "- - KIL:i ISC:iy:8 NOP:zx:4 - - ISC:zx:6 - - NOP:i:2 ISC:by:7 NOP:bx:4 - - ISC:bx:7",
] as const;

const modified = new Set(["SLO", "RLA", "SRE", "RRA", "DCP", "ISC"]);
const stores = new Set(["SAX", "AHX", "TAS", "SHY", "SHX"]);

function unofficial(code: number, entry: string): OpCode {
    const [mnemonic, modeName, cycleText] = entry.split(":");
    const { mode, operand, length } = modes[modeName];
    const reads = new Set<C64CpuRegister>();
    const writes = new Set<C64CpuRegister>();
    if (
        [
            "SLO",
            "RLA",
            "SRE",
            "RRA",
            "DCP",
            "ISC",
            "ANC",
            "ALR",
            "ARR",
            "XAA",
            "AXS",
            "SAX",
            "AHX",
            "TAS",
            "SBC",
        ].includes(mnemonic) ||
        code === 0xab
    ) {
        reads.add("A");
    }
    if (["XAA", "AXS", "SAX", "AHX", "TAS", "SHX"].includes(mnemonic)) {
        reads.add("X");
    }
    if (mnemonic === "SHY") {
        reads.add("Y");
    }
    if (mnemonic === "LAS") {
        reads.add("SP");
    }
    if (["SLO", "RLA", "SRE", "RRA", "ISC", "ANC", "ALR", "ARR", "XAA", "LAX", "LAS", "SBC"].includes(mnemonic)) {
        writes.add("A");
    }
    if (["LAX", "LAS", "AXS"].includes(mnemonic)) {
        writes.add("X");
    }
    if (["TAS", "LAS"].includes(mnemonic)) {
        writes.add("SP");
    }
    if (["zero-page-x", "absolute-x", "indirect-x"].includes(mode)) {
        reads.add("X");
    }
    if (["zero-page-y", "absolute-y", "indirect-y"].includes(mode)) {
        reads.add("Y");
    }
    const flags = ["RRA", "ISC", "ARR", "SBC"].includes(mnemonic)
        ? "NVZC"
        : ["SLO", "RLA", "SRE", "DCP", "ANC", "ALR", "AXS"].includes(mnemonic)
          ? "NZC"
          : ["LAX", "LAS", "XAA"].includes(mnemonic)
            ? "NZ"
            : "";
    const flagsRead: C64StatusFlag[] = ["RRA", "ISC", "ARR", "SBC"].includes(mnemonic)
        ? ["C", "D"]
        : mnemonic === "RLA"
          ? ["C"]
          : [];
    const memory = mode !== "implied" && mode !== "immediate";
    const access: OpCodeEffects["operandAccess"] = !memory
        ? "none"
        : modified.has(mnemonic)
          ? "read-modify-write"
          : stores.has(mnemonic)
            ? "write"
            : "read";
    const pointerRead: OpCodeEffects["pointerRead"] =
        mode === "indirect-x" ? "zero-page-x" : mode === "indirect-y" ? "zero-page" : "none";
    return {
        code,
        name: mnemonic,
        syntax: mnemonic + operand,
        length,
        mode,
        cycles: cycleText === undefined ? null : Number(cycleText),
        additionalCycleOnPageBoundaryCrossed:
            (mnemonic === "NOP" && mode === "absolute-x") ||
            (["LAX", "LAS"].includes(mnemonic) && ["absolute-y", "indirect-y"].includes(mode)),
        additionalCycleWhenBranchTaken: false,
        negativeFlagAffected: flags.includes("N"),
        zeroFlagAffected: flags.includes("Z"),
        carryFlagAffected: flags.includes("C"),
        overflowFlagAffected: flags.includes("V"),
        decimalFlagAffected: false,
        interruptDisableFlagAffected: false,
        affectedByDecimalFlag: ["RRA", "ISC", "ARR", "SBC"].includes(mnemonic),
        illegal: true,
        unstable: [0x8b, 0xab, 0x93, 0x9b, 0x9c, 0x9e, 0x9f, 0xbb].includes(code),
        unstableAddress: ["AHX", "TAS", "SHX", "SHY"].includes(mnemonic),
        architectures: [],
        effects: {
            sources: [
                "https://www.oxyron.de/html/opcodes02.html",
                "https://www.nesdev.org/wiki/CPU_unofficial_opcodes",
            ],
            version: "NMOS 6502/6510",
            registersRead: [...reads],
            registersWritten: [...writes],
            flagsRead,
            operandAccess: access,
            pointerRead,
            flow: mnemonic === "KIL" ? "halt" : "next",
            stack: "none",
        },
    };
}

export const unofficialOpcodes: readonly OpCode[] = rows.flatMap((row, high) =>
    row.split(" ").flatMap((entry, low) => (entry === "-" ? [] : [unofficial(high * 16 + low, entry)])),
);
