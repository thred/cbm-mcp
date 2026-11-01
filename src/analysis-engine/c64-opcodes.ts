import { unofficialOpcodes } from "./c64-unofficial-opcodes.js";

export type OpCodeMode =
    | "immediate"
    | "zero-page"
    | "zero-page-x"
    | "zero-page-y"
    | "absolute"
    | "absolute-x"
    | "absolute-y"
    | "indirect"
    | "indirect-x"
    | "indirect-y"
    | "relative"
    | "accumulator"
    | "implied"
    | "indexed"
    | "indexed-indirect"
    | "indirect-indexed";

export type C64CpuRegister = "A" | "X" | "Y" | "SP";
export type C64StatusFlag = "N" | "V" | "D" | "I" | "Z" | "C";

export interface OpCodeEffects {
    readonly sources: readonly string[];
    readonly version: "NMOS 6502/6510";
    readonly registersRead: readonly C64CpuRegister[];
    readonly registersWritten: readonly C64CpuRegister[];
    readonly flagsRead: readonly C64StatusFlag[];
    readonly operandAccess: "none" | "read" | "write" | "read-modify-write";
    readonly pointerRead: "none" | "zero-page-x" | "zero-page" | "absolute-nmos-wrap";
    readonly flow: "next" | "branch" | "jump" | "call" | "return" | "interrupt-return" | "interrupt" | "halt";
    readonly branchCondition?: { readonly flag: C64StatusFlag; readonly value: 0 | 1 };
    readonly stack: "none" | "push-1" | "push-2" | "push-3" | "pull-1" | "pull-2" | "pull-3" | "set-from-x";
    readonly defaultVectorAddress?: number;
}

export interface OpCode {
    readonly code: number;
    readonly name: string;
    readonly syntax: string;
    readonly length: number;
    readonly cycles: number | null;
    readonly mode: OpCodeMode;
    readonly additionalCycleOnPageBoundaryCrossed: boolean;
    readonly additionalCycleWhenBranchTaken: boolean;
    readonly negativeFlagAffected: boolean;
    readonly zeroFlagAffected: boolean;
    readonly carryFlagAffected: boolean;
    readonly overflowFlagAffected: boolean;
    readonly decimalFlagAffected: boolean;
    readonly interruptDisableFlagAffected: boolean;
    readonly affectedByDecimalFlag: boolean;
    readonly illegal: boolean;
    readonly unstable?: boolean;
    readonly unstableAddress?: boolean;
    readonly architectures: string[];
    readonly effects: OpCodeEffects;
}

const Names = {
    ADC: "Add with Carry",
    AND: "Logical AND",
    ASL: "Arithmetic Shift Left",
    BCC: "Branch if Carry Clear",
    BCS: "Branch if Carry Set",
    BEQ: "Branch if Equal",
    BIT: "Bit Test",
    BMI: "Branch if Minus",
    BNE: "Branch if Not Equal",
    BPL: "Branch if Plus",
    BRK: "Break",
    BVC: "Branch if Overflow Clear",
    BVS: "Branch if Overflow Set",
    CLC: "Clear Carry",
    CLD: "Clear Decimal",
    CLI: "Clear Interrupt Disable",
    CLV: "Clear Overflow",
    CMP: "Compare Accumulator",
    CPX: "Compare X",
    CPY: "Compare Y",
    DEC: "Decrement Memory",
    DEX: "Decrement X",
    DEY: "Decrement Y",
    EOR: "Exclusive OR",
    INC: "Increment Memory",
    INX: "Increment X",
    INY: "Increment Y",
    JMP: "Jump",
    JSR: "Jump to Subroutine",
    LDA: "Load Accumulator",
    LDX: "Load X",
    LDY: "Load Y",
    LSR: "Logical Shift Right",
    NOP: "No Operation",
    ORA: "Logical OR",
    PHA: "Push Accumulator",
    PHP: "Push Processor Status",
    PLA: "Pull Accumulator",
    PLP: "Pull Processor Status",
    ROL: "Rotate Left",
    ROR: "Rotate Right",
    RTI: "Return from Interrupt",
    RTS: "Return from Subroutine",
    SBC: "Subtract with Carry",
    SEC: "Set Carry",
    SED: "Set Decimal",
    SEI: "Set Interrupt Disable",
    STA: "Store Accumulator",
    STX: "Store X",
    STY: "Store Y",
    TAX: "Transfer Accumulator to X",
    TAY: "Transfer Accumulator to Y",
    TSX: "Transfer Stack Pointer to X",
    TXA: "Transfer X to Accumulator",
    TXS: "Transfer X to Stack Pointer",
    TYA: "Transfer Y to Accumulator",
} as const;

type Mnemonic = keyof typeof Names;
type DocumentedMode = Exclude<OpCodeMode, "indexed" | "indexed-indirect" | "indirect-indexed">;

type RegisterEffects = readonly [reads: readonly C64CpuRegister[], writes: readonly C64CpuRegister[]];
const registerEffects: Record<Mnemonic, RegisterEffects> = {
    ADC: [["A"], ["A"]],
    AND: [["A"], ["A"]],
    ASL: [[], []],
    BCC: [[], []],
    BCS: [[], []],
    BEQ: [[], []],
    BIT: [["A"], []],
    BMI: [[], []],
    BNE: [[], []],
    BPL: [[], []],
    BRK: [[], []],
    BVC: [[], []],
    BVS: [[], []],
    CLC: [[], []],
    CLD: [[], []],
    CLI: [[], []],
    CLV: [[], []],
    CMP: [["A"], []],
    CPX: [["X"], []],
    CPY: [["Y"], []],
    DEC: [[], []],
    DEX: [["X"], ["X"]],
    DEY: [["Y"], ["Y"]],
    EOR: [["A"], ["A"]],
    INC: [[], []],
    INX: [["X"], ["X"]],
    INY: [["Y"], ["Y"]],
    JMP: [[], []],
    JSR: [[], []],
    LDA: [[], ["A"]],
    LDX: [[], ["X"]],
    LDY: [[], ["Y"]],
    LSR: [[], []],
    NOP: [[], []],
    ORA: [["A"], ["A"]],
    PHA: [["A"], []],
    PHP: [[], []],
    PLA: [[], ["A"]],
    PLP: [[], []],
    ROL: [[], []],
    ROR: [[], []],
    RTI: [[], []],
    RTS: [[], []],
    SBC: [["A"], ["A"]],
    SEC: [[], []],
    SED: [[], []],
    SEI: [[], []],
    STA: [["A"], []],
    STX: [["X"], []],
    STY: [["Y"], []],
    TAX: [["A"], ["X"]],
    TAY: [["A"], ["Y"]],
    TSX: [["SP"], ["X"]],
    TXA: [["X"], ["A"]],
    TXS: [["X"], ["SP"]],
    TYA: [["Y"], ["A"]],
};

const branchConditions: Partial<Record<Mnemonic, NonNullable<OpCodeEffects["branchCondition"]>>> = {
    BCC: { flag: "C", value: 0 },
    BCS: { flag: "C", value: 1 },
    BEQ: { flag: "Z", value: 1 },
    BNE: { flag: "Z", value: 0 },
    BMI: { flag: "N", value: 1 },
    BPL: { flag: "N", value: 0 },
    BVC: { flag: "V", value: 0 },
    BVS: { flag: "V", value: 1 },
};

const stackEffects: Partial<Record<Mnemonic, OpCodeEffects["stack"]>> = {
    BRK: "push-3",
    JSR: "push-2",
    PHA: "push-1",
    PHP: "push-1",
    PLA: "pull-1",
    PLP: "pull-1",
    RTI: "pull-3",
    RTS: "pull-2",
    TXS: "set-from-x",
};

function instructionEffects(mnemonic: Mnemonic, mode: DocumentedMode): OpCodeEffects {
    const [baseReads, baseWrites] = registerEffects[mnemonic];
    const reads = new Set(baseReads);
    const writes = new Set(baseWrites);
    if (mode === "zero-page-x" || mode === "absolute-x" || mode === "indirect-x") {
        reads.add("X");
    }
    if (mode === "zero-page-y" || mode === "absolute-y" || mode === "indirect-y") {
        reads.add("Y");
    }
    if (mode === "accumulator") {
        reads.add("A");
        writes.add("A");
    }

    const stack = stackEffects[mnemonic] ?? "none";
    if (stack !== "none" && stack !== "set-from-x") {
        reads.add("SP");
        writes.add("SP");
    }
    const condition = branchConditions[mnemonic];
    const flagsRead: C64StatusFlag[] = condition
        ? [condition.flag]
        : mnemonic === "ADC" || mnemonic === "SBC"
          ? ["C", "D"]
          : mnemonic === "ROL" || mnemonic === "ROR"
            ? ["C"]
            : mnemonic === "PHP" || mnemonic === "BRK"
              ? ["N", "V", "D", "I", "Z", "C"]
              : [];
    const memoryOperand = !["immediate", "implied", "accumulator", "relative"].includes(mode);
    const operandAccess: OpCodeEffects["operandAccess"] =
        !memoryOperand || mnemonic === "JMP" || mnemonic === "JSR"
            ? "none"
            : ["STA", "STX", "STY"].includes(mnemonic)
              ? "write"
              : ["ASL", "LSR", "ROL", "ROR", "INC", "DEC"].includes(mnemonic)
                ? "read-modify-write"
                : "read";
    const pointerRead: OpCodeEffects["pointerRead"] =
        mode === "indirect-x"
            ? "zero-page-x"
            : mode === "indirect-y"
              ? "zero-page"
              : mode === "indirect"
                ? "absolute-nmos-wrap"
                : "none";
    const flow: OpCodeEffects["flow"] = condition
        ? "branch"
        : mnemonic === "JMP"
          ? "jump"
          : mnemonic === "JSR"
            ? "call"
            : mnemonic === "RTS"
              ? "return"
              : mnemonic === "RTI"
                ? "interrupt-return"
                : mnemonic === "BRK"
                  ? "interrupt"
                  : "next";
    return {
        sources: [
            "https://www.nesdev.org/obelisk-6502-guide/reference.html",
            "https://www.nesdev.org/wiki/CPU_addressing_modes",
        ],
        version: "NMOS 6502/6510",
        registersRead: [...reads],
        registersWritten: [...writes],
        flagsRead,
        operandAccess,
        pointerRead,
        flow,
        ...(condition ? { branchCondition: condition } : {}),
        stack,
        ...(mnemonic === "BRK" ? { defaultVectorAddress: 0xfffe } : {}),
    };
}

const modes: Record<DocumentedMode, { operand: string; length: number }> = {
    immediate: { operand: " #$nn", length: 2 },
    "zero-page": { operand: " $nn", length: 2 },
    "zero-page-x": { operand: " $nn,X", length: 2 },
    "zero-page-y": { operand: " $nn,Y", length: 2 },
    absolute: { operand: " $nnnn", length: 3 },
    "absolute-x": { operand: " $nnnn,X", length: 3 },
    "absolute-y": { operand: " $nnnn,Y", length: 3 },
    indirect: { operand: " ($nnnn)", length: 3 },
    "indirect-x": { operand: " ($nn,X)", length: 2 },
    "indirect-y": { operand: " ($nn),Y", length: 2 },
    relative: { operand: " $nn", length: 2 },
    accumulator: { operand: " A", length: 1 },
    implied: { operand: "", length: 1 },
};

function opcode(
    code: number,
    mnemonic: Mnemonic,
    mode: DocumentedMode,
    cycles: number,
    flags = "",
    pageCross = false,
): OpCode {
    const branch = mode === "relative";
    return {
        code,
        name: Names[mnemonic],
        syntax: mnemonic + modes[mode].operand,
        length: modes[mode].length,
        cycles,
        mode,
        negativeFlagAffected: flags.includes("N"),
        zeroFlagAffected: flags.includes("Z"),
        carryFlagAffected: flags.includes("C"),
        overflowFlagAffected: flags.includes("V"),
        decimalFlagAffected: flags.includes("D"),
        interruptDisableFlagAffected: flags.includes("I"),
        affectedByDecimalFlag: mnemonic === "ADC" || mnemonic === "SBC",
        additionalCycleWhenBranchTaken: branch,
        additionalCycleOnPageBoundaryCrossed: branch || pageCross,
        illegal: false,
        architectures: [],
        effects: instructionEffects(mnemonic, mode),
    };
}

// Documented NMOS 6502/6510 encodings: https://6502.org/tutorials/6502opcodes.html
export class OpCodes {
    static readonly ADC_IMMEDIATE = opcode(0x69, "ADC", "immediate", 2, "NVZC");
    static readonly ADC_ZERO_PAGE = opcode(0x65, "ADC", "zero-page", 3, "NVZC");
    static readonly ADC_ZERO_PAGE_X = opcode(0x75, "ADC", "zero-page-x", 4, "NVZC");
    static readonly ADC_ABSOLUTE = opcode(0x6d, "ADC", "absolute", 4, "NVZC");
    static readonly ADC_ABSOLUTE_X = opcode(0x7d, "ADC", "absolute-x", 4, "NVZC", true);
    static readonly ADC_ABSOLUTE_Y = opcode(0x79, "ADC", "absolute-y", 4, "NVZC", true);
    static readonly ADC_INDIRECT_X = opcode(0x61, "ADC", "indirect-x", 6, "NVZC");
    static readonly ADC_INDIRECT_Y = opcode(0x71, "ADC", "indirect-y", 5, "NVZC", true);

    static readonly AND_IMMEDIATE = opcode(0x29, "AND", "immediate", 2, "NZ");
    static readonly AND_ZERO_PAGE = opcode(0x25, "AND", "zero-page", 3, "NZ");
    static readonly AND_ZERO_PAGE_X = opcode(0x35, "AND", "zero-page-x", 4, "NZ");
    static readonly AND_ABSOLUTE = opcode(0x2d, "AND", "absolute", 4, "NZ");
    static readonly AND_ABSOLUTE_X = opcode(0x3d, "AND", "absolute-x", 4, "NZ", true);
    static readonly AND_ABSOLUTE_Y = opcode(0x39, "AND", "absolute-y", 4, "NZ", true);
    static readonly AND_INDIRECT_X = opcode(0x21, "AND", "indirect-x", 6, "NZ");
    static readonly AND_INDIRECT_Y = opcode(0x31, "AND", "indirect-y", 5, "NZ", true);

    static readonly ASL_ACCUMULATOR = opcode(0x0a, "ASL", "accumulator", 2, "NZC");
    static readonly ASL_ZERO_PAGE = opcode(0x06, "ASL", "zero-page", 5, "NZC");
    static readonly ASL_ZERO_PAGE_X = opcode(0x16, "ASL", "zero-page-x", 6, "NZC");
    static readonly ASL_ABSOLUTE = opcode(0x0e, "ASL", "absolute", 6, "NZC");
    static readonly ASL_ABSOLUTE_X = opcode(0x1e, "ASL", "absolute-x", 7, "NZC");

    static readonly BCC_RELATIVE = opcode(0x90, "BCC", "relative", 2);
    static readonly BCS_RELATIVE = opcode(0xb0, "BCS", "relative", 2);
    static readonly BEQ_RELATIVE = opcode(0xf0, "BEQ", "relative", 2);
    static readonly BMI_RELATIVE = opcode(0x30, "BMI", "relative", 2);
    static readonly BNE_RELATIVE = opcode(0xd0, "BNE", "relative", 2);
    static readonly BPL_RELATIVE = opcode(0x10, "BPL", "relative", 2);
    static readonly BVC_RELATIVE = opcode(0x50, "BVC", "relative", 2);
    static readonly BVS_RELATIVE = opcode(0x70, "BVS", "relative", 2);
    static readonly BIT_ZERO_PAGE = opcode(0x24, "BIT", "zero-page", 3, "NVZ");
    static readonly BIT_ABSOLUTE = opcode(0x2c, "BIT", "absolute", 4, "NVZ");
    static readonly BRK_IMPLIED = opcode(0x00, "BRK", "implied", 7, "I");

    static readonly CLC_IMPLIED = opcode(0x18, "CLC", "implied", 2, "C");
    static readonly CLD_IMPLIED = opcode(0xd8, "CLD", "implied", 2, "D");
    static readonly CLI_IMPLIED = opcode(0x58, "CLI", "implied", 2, "I");
    static readonly CLV_IMPLIED = opcode(0xb8, "CLV", "implied", 2, "V");

    static readonly CMP_IMMEDIATE = opcode(0xc9, "CMP", "immediate", 2, "NZC");
    static readonly CMP_ZERO_PAGE = opcode(0xc5, "CMP", "zero-page", 3, "NZC");
    static readonly CMP_ZERO_PAGE_X = opcode(0xd5, "CMP", "zero-page-x", 4, "NZC");
    static readonly CMP_ABSOLUTE = opcode(0xcd, "CMP", "absolute", 4, "NZC");
    static readonly CMP_ABSOLUTE_X = opcode(0xdd, "CMP", "absolute-x", 4, "NZC", true);
    static readonly CMP_ABSOLUTE_Y = opcode(0xd9, "CMP", "absolute-y", 4, "NZC", true);
    static readonly CMP_INDIRECT_X = opcode(0xc1, "CMP", "indirect-x", 6, "NZC");
    static readonly CMP_INDIRECT_Y = opcode(0xd1, "CMP", "indirect-y", 5, "NZC", true);
    static readonly CPX_IMMEDIATE = opcode(0xe0, "CPX", "immediate", 2, "NZC");
    static readonly CPX_ZERO_PAGE = opcode(0xe4, "CPX", "zero-page", 3, "NZC");
    static readonly CPX_ABSOLUTE = opcode(0xec, "CPX", "absolute", 4, "NZC");
    static readonly CPY_IMMEDIATE = opcode(0xc0, "CPY", "immediate", 2, "NZC");
    static readonly CPY_ZERO_PAGE = opcode(0xc4, "CPY", "zero-page", 3, "NZC");
    static readonly CPY_ABSOLUTE = opcode(0xcc, "CPY", "absolute", 4, "NZC");

    static readonly DEC_ZERO_PAGE = opcode(0xc6, "DEC", "zero-page", 5, "NZ");
    static readonly DEC_ZERO_PAGE_X = opcode(0xd6, "DEC", "zero-page-x", 6, "NZ");
    static readonly DEC_ABSOLUTE = opcode(0xce, "DEC", "absolute", 6, "NZ");
    static readonly DEC_ABSOLUTE_X = opcode(0xde, "DEC", "absolute-x", 7, "NZ");
    static readonly DEX_IMPLIED = opcode(0xca, "DEX", "implied", 2, "NZ");
    static readonly DEY_IMPLIED = opcode(0x88, "DEY", "implied", 2, "NZ");

    static readonly EOR_IMMEDIATE = opcode(0x49, "EOR", "immediate", 2, "NZ");
    static readonly EOR_ZERO_PAGE = opcode(0x45, "EOR", "zero-page", 3, "NZ");
    static readonly EOR_ZERO_PAGE_X = opcode(0x55, "EOR", "zero-page-x", 4, "NZ");
    static readonly EOR_ABSOLUTE = opcode(0x4d, "EOR", "absolute", 4, "NZ");
    static readonly EOR_ABSOLUTE_X = opcode(0x5d, "EOR", "absolute-x", 4, "NZ", true);
    static readonly EOR_ABSOLUTE_Y = opcode(0x59, "EOR", "absolute-y", 4, "NZ", true);
    static readonly EOR_INDIRECT_X = opcode(0x41, "EOR", "indirect-x", 6, "NZ");
    static readonly EOR_INDIRECT_Y = opcode(0x51, "EOR", "indirect-y", 5, "NZ", true);

    static readonly INC_ZERO_PAGE = opcode(0xe6, "INC", "zero-page", 5, "NZ");
    static readonly INC_ZERO_PAGE_X = opcode(0xf6, "INC", "zero-page-x", 6, "NZ");
    static readonly INC_ABSOLUTE = opcode(0xee, "INC", "absolute", 6, "NZ");
    static readonly INC_ABSOLUTE_X = opcode(0xfe, "INC", "absolute-x", 7, "NZ");
    static readonly INX_IMPLIED = opcode(0xe8, "INX", "implied", 2, "NZ");
    static readonly INY_IMPLIED = opcode(0xc8, "INY", "implied", 2, "NZ");
    static readonly JMP_ABSOLUTE = opcode(0x4c, "JMP", "absolute", 3);
    static readonly JMP_INDIRECT = opcode(0x6c, "JMP", "indirect", 5);
    static readonly JSR_ABSOLUTE = opcode(0x20, "JSR", "absolute", 6);

    static readonly LDA_IMMEDIATE = opcode(0xa9, "LDA", "immediate", 2, "NZ");
    static readonly LDA_ZERO_PAGE = opcode(0xa5, "LDA", "zero-page", 3, "NZ");
    static readonly LDA_ZERO_PAGE_X = opcode(0xb5, "LDA", "zero-page-x", 4, "NZ");
    static readonly LDA_ABSOLUTE = opcode(0xad, "LDA", "absolute", 4, "NZ");
    static readonly LDA_ABSOLUTE_X = opcode(0xbd, "LDA", "absolute-x", 4, "NZ", true);
    static readonly LDA_ABSOLUTE_Y = opcode(0xb9, "LDA", "absolute-y", 4, "NZ", true);
    static readonly LDA_INDIRECT_X = opcode(0xa1, "LDA", "indirect-x", 6, "NZ");
    static readonly LDA_INDIRECT_Y = opcode(0xb1, "LDA", "indirect-y", 5, "NZ", true);
    static readonly LDX_IMMEDIATE = opcode(0xa2, "LDX", "immediate", 2, "NZ");
    static readonly LDX_ZERO_PAGE = opcode(0xa6, "LDX", "zero-page", 3, "NZ");
    static readonly LDX_ZERO_PAGE_Y = opcode(0xb6, "LDX", "zero-page-y", 4, "NZ");
    static readonly LDX_ABSOLUTE = opcode(0xae, "LDX", "absolute", 4, "NZ");
    static readonly LDX_ABSOLUTE_Y = opcode(0xbe, "LDX", "absolute-y", 4, "NZ", true);
    static readonly LDY_IMMEDIATE = opcode(0xa0, "LDY", "immediate", 2, "NZ");
    static readonly LDY_ZERO_PAGE = opcode(0xa4, "LDY", "zero-page", 3, "NZ");
    static readonly LDY_ZERO_PAGE_X = opcode(0xb4, "LDY", "zero-page-x", 4, "NZ");
    static readonly LDY_ABSOLUTE = opcode(0xac, "LDY", "absolute", 4, "NZ");
    static readonly LDY_ABSOLUTE_X = opcode(0xbc, "LDY", "absolute-x", 4, "NZ", true);
    static readonly LSR_ACCUMULATOR = opcode(0x4a, "LSR", "accumulator", 2, "NZC");
    static readonly LSR_ZERO_PAGE = opcode(0x46, "LSR", "zero-page", 5, "NZC");
    static readonly LSR_ZERO_PAGE_X = opcode(0x56, "LSR", "zero-page-x", 6, "NZC");
    static readonly LSR_ABSOLUTE = opcode(0x4e, "LSR", "absolute", 6, "NZC");
    static readonly LSR_ABSOLUTE_X = opcode(0x5e, "LSR", "absolute-x", 7, "NZC");
    static readonly NOP_IMPLIED = opcode(0xea, "NOP", "implied", 2);

    static readonly ORA_IMMEDIATE = opcode(0x09, "ORA", "immediate", 2, "NZ");
    static readonly ORA_ZERO_PAGE = opcode(0x05, "ORA", "zero-page", 3, "NZ");
    static readonly ORA_ZERO_PAGE_X = opcode(0x15, "ORA", "zero-page-x", 4, "NZ");
    static readonly ORA_ABSOLUTE = opcode(0x0d, "ORA", "absolute", 4, "NZ");
    static readonly ORA_ABSOLUTE_X = opcode(0x1d, "ORA", "absolute-x", 4, "NZ", true);
    static readonly ORA_ABSOLUTE_Y = opcode(0x19, "ORA", "absolute-y", 4, "NZ", true);
    static readonly ORA_INDIRECT_X = opcode(0x01, "ORA", "indirect-x", 6, "NZ");
    static readonly ORA_INDIRECT_Y = opcode(0x11, "ORA", "indirect-y", 5, "NZ", true);
    static readonly PHA_IMPLIED = opcode(0x48, "PHA", "implied", 3);
    static readonly PHP_IMPLIED = opcode(0x08, "PHP", "implied", 3);
    static readonly PLA_IMPLIED = opcode(0x68, "PLA", "implied", 4, "NZ");
    static readonly PLP_IMPLIED = opcode(0x28, "PLP", "implied", 4, "NVZDIC");

    static readonly ROL_ACCUMULATOR = opcode(0x2a, "ROL", "accumulator", 2, "NZC");
    static readonly ROL_ZERO_PAGE = opcode(0x26, "ROL", "zero-page", 5, "NZC");
    static readonly ROL_ZERO_PAGE_X = opcode(0x36, "ROL", "zero-page-x", 6, "NZC");
    static readonly ROL_ABSOLUTE = opcode(0x2e, "ROL", "absolute", 6, "NZC");
    static readonly ROL_ABSOLUTE_X = opcode(0x3e, "ROL", "absolute-x", 7, "NZC");
    static readonly ROR_ACCUMULATOR = opcode(0x6a, "ROR", "accumulator", 2, "NZC");
    static readonly ROR_ZERO_PAGE = opcode(0x66, "ROR", "zero-page", 5, "NZC");
    static readonly ROR_ZERO_PAGE_X = opcode(0x76, "ROR", "zero-page-x", 6, "NZC");
    static readonly ROR_ABSOLUTE = opcode(0x6e, "ROR", "absolute", 6, "NZC");
    static readonly ROR_ABSOLUTE_X = opcode(0x7e, "ROR", "absolute-x", 7, "NZC");
    static readonly RTI_IMPLIED = opcode(0x40, "RTI", "implied", 6, "NVZDIC");
    static readonly RTS_IMPLIED = opcode(0x60, "RTS", "implied", 6);

    static readonly SBC_IMMEDIATE = opcode(0xe9, "SBC", "immediate", 2, "NVZC");
    static readonly SBC_ZERO_PAGE = opcode(0xe5, "SBC", "zero-page", 3, "NVZC");
    static readonly SBC_ZERO_PAGE_X = opcode(0xf5, "SBC", "zero-page-x", 4, "NVZC");
    static readonly SBC_ABSOLUTE = opcode(0xed, "SBC", "absolute", 4, "NVZC");
    static readonly SBC_ABSOLUTE_X = opcode(0xfd, "SBC", "absolute-x", 4, "NVZC", true);
    static readonly SBC_ABSOLUTE_Y = opcode(0xf9, "SBC", "absolute-y", 4, "NVZC", true);
    static readonly SBC_INDIRECT_X = opcode(0xe1, "SBC", "indirect-x", 6, "NVZC");
    static readonly SBC_INDIRECT_Y = opcode(0xf1, "SBC", "indirect-y", 5, "NVZC", true);
    static readonly SEC_IMPLIED = opcode(0x38, "SEC", "implied", 2, "C");
    static readonly SED_IMPLIED = opcode(0xf8, "SED", "implied", 2, "D");
    static readonly SEI_IMPLIED = opcode(0x78, "SEI", "implied", 2, "I");
    static readonly STA_ZERO_PAGE = opcode(0x85, "STA", "zero-page", 3);
    static readonly STA_ZERO_PAGE_X = opcode(0x95, "STA", "zero-page-x", 4);
    static readonly STA_ABSOLUTE = opcode(0x8d, "STA", "absolute", 4);
    static readonly STA_ABSOLUTE_X = opcode(0x9d, "STA", "absolute-x", 5);
    static readonly STA_ABSOLUTE_Y = opcode(0x99, "STA", "absolute-y", 5);
    static readonly STA_INDIRECT_X = opcode(0x81, "STA", "indirect-x", 6);
    static readonly STA_INDIRECT_Y = opcode(0x91, "STA", "indirect-y", 6);
    static readonly STX_ZERO_PAGE = opcode(0x86, "STX", "zero-page", 3);
    static readonly STX_ZERO_PAGE_Y = opcode(0x96, "STX", "zero-page-y", 4);
    static readonly STX_ABSOLUTE = opcode(0x8e, "STX", "absolute", 4);
    static readonly STY_ZERO_PAGE = opcode(0x84, "STY", "zero-page", 3);
    static readonly STY_ZERO_PAGE_X = opcode(0x94, "STY", "zero-page-x", 4);
    static readonly STY_ABSOLUTE = opcode(0x8c, "STY", "absolute", 4);
    static readonly TAX_IMPLIED = opcode(0xaa, "TAX", "implied", 2, "NZ");
    static readonly TAY_IMPLIED = opcode(0xa8, "TAY", "implied", 2, "NZ");
    static readonly TSX_IMPLIED = opcode(0xba, "TSX", "implied", 2, "NZ");
    static readonly TXA_IMPLIED = opcode(0x8a, "TXA", "implied", 2, "NZ");
    static readonly TXS_IMPLIED = opcode(0x9a, "TXS", "implied", 2);
    static readonly TYA_IMPLIED = opcode(0x98, "TYA", "implied", 2, "NZ");

    static get all(): readonly OpCode[] {
        return [...Object.values(OpCodes), ...unofficialOpcodes];
    }
}
