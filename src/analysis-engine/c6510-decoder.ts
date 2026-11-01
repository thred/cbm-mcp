import { OpCodes, type OpCode } from "./c64-opcodes.js";

export type C6510Operand =
    | { readonly kind: "none" }
    | { readonly kind: "accumulator" }
    | { readonly kind: "immediate"; readonly value: number }
    | { readonly kind: "address"; readonly address: number; readonly index?: "X" | "Y"; readonly zeroPage: boolean }
    | {
          readonly kind: "indirect";
          readonly pointerAddress: number;
          readonly pointerWrap: "zero-page" | "nmos-page";
          readonly index?: "X" | "Y";
          readonly indexPosition?: "before" | "after";
      }
    | { readonly kind: "relative"; readonly displacement: number; readonly targetAddress: number };

export interface C6510Instruction {
    readonly kind: "instruction";
    readonly address: number;
    readonly bytes: readonly number[];
    readonly mnemonic: string;
    readonly opcode: OpCode;
    readonly operand: C6510Operand;
    readonly nextAddress: number;
}

export interface C6510UndocumentedOpcode {
    readonly kind: "undocumented-opcode";
    readonly address: number;
    readonly bytes: readonly number[];
}

export interface C6510TruncatedInstruction {
    readonly kind: "truncated";
    readonly address: number;
    readonly bytes: readonly number[];
    readonly opcode: OpCode;
    readonly expectedLength: number;
}

export type C6510DecodeResult = C6510Instruction | C6510UndocumentedOpcode | C6510TruncatedInstruction;

const opcodes = new Map(OpCodes.all.map((opcode) => [opcode.code, opcode]));

export interface C6510DecoderOptions {
    readonly includeIllegalOpcodes?: boolean;
}

export function formatC6510Instruction(
    instruction: C6510Instruction,
    labelAt?: (address: number) => string | undefined,
): string {
    const operand = instruction.operand;
    const hex = (value: number, width: number) => `$${value.toString(16).padStart(width, "0")}`;
    switch (operand.kind) {
        case "none":
            return instruction.mnemonic;
        case "accumulator":
            return `${instruction.mnemonic} A`;
        case "immediate":
            return `${instruction.mnemonic} #${hex(operand.value, 2)}`;
        case "address":
            return `${instruction.mnemonic} ${labelAt?.(operand.address) ?? hex(operand.address, operand.zeroPage ? 2 : 4)}${operand.index ? `,${operand.index}` : ""}`;
        case "indirect": {
            const pointer =
                labelAt?.(operand.pointerAddress) ??
                hex(operand.pointerAddress, operand.pointerWrap === "zero-page" ? 2 : 4);
            const before = operand.indexPosition === "before" ? `,${operand.index}` : "";
            const after = operand.indexPosition === "after" ? `,${operand.index}` : "";
            return `${instruction.mnemonic} (${pointer}${before})${after}`;
        }
        case "relative":
            return `${instruction.mnemonic} ${labelAt?.(operand.targetAddress) ?? hex(operand.targetAddress, 4)}`;
    }
}

function decodeOperand(opcode: OpCode, bytes: readonly number[], address: number): C6510Operand {
    const low = bytes[1];
    const word = low | (bytes[2] << 8);
    switch (opcode.mode) {
        case "implied":
            return { kind: "none" };
        case "accumulator":
            return { kind: "accumulator" };
        case "immediate":
            return { kind: "immediate", value: low };
        case "zero-page":
            return { kind: "address", address: low, zeroPage: true };
        case "zero-page-x":
            return { kind: "address", address: low, zeroPage: true, index: "X" };
        case "zero-page-y":
            return { kind: "address", address: low, zeroPage: true, index: "Y" };
        case "absolute":
            return { kind: "address", address: word, zeroPage: false };
        case "absolute-x":
            return { kind: "address", address: word, zeroPage: false, index: "X" };
        case "absolute-y":
            return { kind: "address", address: word, zeroPage: false, index: "Y" };
        case "indirect":
            return { kind: "indirect", pointerAddress: word, pointerWrap: "nmos-page" };
        case "indirect-x":
            return {
                kind: "indirect",
                pointerAddress: low,
                pointerWrap: "zero-page",
                index: "X",
                indexPosition: "before",
            };
        case "indirect-y":
            return {
                kind: "indirect",
                pointerAddress: low,
                pointerWrap: "zero-page",
                index: "Y",
                indexPosition: "after",
            };
        case "relative": {
            const displacement = low < 0x80 ? low : low - 0x100;
            return { kind: "relative", displacement, targetAddress: (address + 2 + displacement) & 0xffff };
        }
        default:
            throw new Error(`Unsupported opcode addressing mode: ${opcode.mode}.`);
    }
}

/**
 * Decodes a copied, contiguous 16-bit memory range, without classifying it as code.
 */
export class C6510Decoder {
    private readonly bytes: Uint8Array;
    readonly startAddress: number;
    readonly endAddressExclusive: number;
    readonly includeIllegalOpcodes: boolean;

    constructor(bytes: Uint8Array, startAddress: number, options: C6510DecoderOptions = {}) {
        if (
            !Number.isInteger(startAddress) ||
            startAddress < 0 ||
            startAddress > 0xffff ||
            startAddress + bytes.length > 0x10000
        ) {
            throw new RangeError("Memory range must fit in the 16-bit address space.");
        }
        if (options.includeIllegalOpcodes !== undefined && typeof options.includeIllegalOpcodes !== "boolean") {
            throw new Error("includeIllegalOpcodes must be a boolean.");
        }
        this.bytes = Uint8Array.from(bytes);
        this.startAddress = startAddress;
        this.endAddressExclusive = startAddress + bytes.length;
        this.includeIllegalOpcodes = options.includeIllegalOpcodes ?? false;
    }

    get byteLength(): number {
        return this.bytes.length;
    }

    getBytes(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }

    decodeAt(address: number): C6510DecodeResult {
        this.validateRange(address, 1);
        return this.decodeWithin(address, this.endAddressExclusive);
    }

    decodeRange(
        startAddress = this.startAddress,
        length = this.endAddressExclusive - startAddress,
    ): C6510DecodeResult[] {
        this.validateRange(startAddress, length);
        const end = startAddress + length;
        const results: C6510DecodeResult[] = [];
        for (let address = startAddress; address < end;) {
            const result = this.decodeWithin(address, end);
            results.push(result);
            if (result.kind !== "instruction") {
                break;
            }
            address += result.bytes.length;
            if (result.opcode.effects.flow === "halt") {
                break;
            }
        }
        return results;
    }

    private validateRange(startAddress: number, length: number): void {
        if (
            !Number.isInteger(startAddress) ||
            !Number.isInteger(length) ||
            length < 0 ||
            startAddress < this.startAddress ||
            startAddress > this.endAddressExclusive ||
            startAddress + length > this.endAddressExclusive
        ) {
            throw new RangeError("Decode range must be within the captured memory range.");
        }
    }

    private decodeWithin(address: number, end: number): C6510DecodeResult {
        const offset = address - this.startAddress;
        const opcode = opcodes.get(this.bytes[offset]);
        if (!opcode || (opcode.illegal && !this.includeIllegalOpcodes)) {
            return { kind: "undocumented-opcode", address, bytes: [this.bytes[offset]] };
        }
        const bytes = Array.from(
            this.bytes.subarray(offset, Math.min(offset + opcode.length, end - this.startAddress)),
        );
        if (bytes.length < opcode.length) {
            return { kind: "truncated", address, bytes, opcode, expectedLength: opcode.length };
        }
        return {
            kind: "instruction",
            address,
            bytes,
            mnemonic: opcode.syntax.slice(0, 3),
            opcode,
            operand: decodeOperand(opcode, bytes, address),
            nextAddress: (address + opcode.length) & 0xffff,
        };
    }
}
