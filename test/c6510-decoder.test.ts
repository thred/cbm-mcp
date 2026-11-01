import { describe, expect, it } from "vitest";
import { C6510Decoder, C64Prg, formatC6510Instruction, OpCodes, type C6510Instruction } from "../src/index.js";

function instruction(bytes: number[], address = 0x2000): C6510Instruction {
    const result = new C6510Decoder(Uint8Array.from(bytes), address).decodeAt(address);
    if (result.kind !== "instruction") {
        throw new Error(`Expected a decoded instruction, got ${result.kind}.`);
    }
    return result;
}

describe("6510 instruction decoder", () => {
    it("rejects all unofficial encodings by default but decodes them on opt-in", () => {
        for (const opcode of OpCodes.all.filter((item) => item.illegal)) {
            const bytes = Uint8Array.of(opcode.code, 0x34, 0x12);
            expect(new C6510Decoder(bytes, 0x1000).decodeAt(0x1000)).toEqual({
                kind: "undocumented-opcode",
                address: 0x1000,
                bytes: [opcode.code],
            });
            expect(new C6510Decoder(bytes, 0x1000, { includeIllegalOpcodes: true }).decodeAt(0x1000)).toMatchObject({
                kind: "instruction",
                opcode: { code: opcode.code, illegal: true },
            });
        }
    });

    it("decodes all 256 NMOS opcode encodings", () => {
        const byCode = new Map(OpCodes.all.map((opcode) => [opcode.code, opcode]));
        expect(byCode.size).toBe(256);
        for (let code = 0; code <= 0xff; code++) {
            const result = new C6510Decoder(Uint8Array.of(code, 0x34, 0x12), 0x1000, {
                includeIllegalOpcodes: true,
            }).decodeAt(0x1000);
            const opcode = byCode.get(code);
            if (!opcode) {
                expect(result).toEqual({ kind: "undocumented-opcode", address: 0x1000, bytes: [code] });
                continue;
            }
            expect(result).toMatchObject({
                kind: "instruction",
                address: 0x1000,
                bytes: [code, 0x34, 0x12].slice(0, opcode.length),
                mnemonic: opcode.syntax.slice(0, 3),
                opcode,
                nextAddress: 0x1000 + opcode.length,
            });
        }
    });

    it.each([
        [[0xea], "NOP", { kind: "none" }],
        [[0x0a], "ASL A", { kind: "accumulator" }],
        [[0xa9, 0xfe], "LDA #$fe", { kind: "immediate", value: 0xfe }],
        [[0xa5, 0xfe], "LDA $fe", { kind: "address", address: 0xfe, zeroPage: true }],
        [[0xb5, 0xfe], "LDA $fe,X", { kind: "address", address: 0xfe, zeroPage: true, index: "X" }],
        [[0xb6, 0xfe], "LDX $fe,Y", { kind: "address", address: 0xfe, zeroPage: true, index: "Y" }],
        [[0xad, 0x34, 0x12], "LDA $1234", { kind: "address", address: 0x1234, zeroPage: false }],
        [[0xbd, 0x34, 0x12], "LDA $1234,X", { kind: "address", address: 0x1234, zeroPage: false, index: "X" }],
        [[0xb9, 0x34, 0x12], "LDA $1234,Y", { kind: "address", address: 0x1234, zeroPage: false, index: "Y" }],
        [[0x6c, 0xff, 0x12], "JMP ($12ff)", { kind: "indirect", pointerAddress: 0x12ff, pointerWrap: "nmos-page" }],
        [
            [0xa1, 0xff],
            "LDA ($ff,X)",
            {
                kind: "indirect",
                pointerAddress: 0xff,
                pointerWrap: "zero-page",
                index: "X",
                indexPosition: "before",
            },
        ],
        [
            [0xb1, 0xff],
            "LDA ($ff),Y",
            {
                kind: "indirect",
                pointerAddress: 0xff,
                pointerWrap: "zero-page",
                index: "Y",
                indexPosition: "after",
            },
        ],
        [[0xd0, 0xfe], "BNE $2000", { kind: "relative", displacement: -2, targetAddress: 0x2000 }],
    ])("decodes and formats %s as %s", (bytes, text, operand) => {
        const result = instruction(bytes);
        expect(result.operand).toEqual(operand);
        expect(formatC6510Instruction(result)).toBe(text);
    });

    it("calculates signed branch targets and wraps the 16-bit program counter", () => {
        expect(instruction([0xd0, 0x80], 0x0000).operand).toEqual({
            kind: "relative",
            displacement: -128,
            targetAddress: 0xff82,
        });
        expect(instruction([0xd0, 0x7f], 0xfffe)).toMatchObject({
            nextAddress: 0,
            operand: { kind: "relative", displacement: 127, targetAddress: 0x007f },
        });
        expect(instruction([0xd0, 0x00], 0x20fe).operand).toEqual({
            kind: "relative",
            displacement: 0,
            targetAddress: 0x2100,
        });
        expect(instruction([0xea], 0xffff).nextAddress).toBe(0);
    });

    it("reports truncated instructions at both the image and requested-range boundaries", () => {
        const decoder = new C6510Decoder(Uint8Array.of(0xea, 0x20, 0x34, 0x12), 0x1000);
        expect(decoder.decodeRange(0x1000, 3)).toMatchObject([
            { kind: "instruction", address: 0x1000 },
            { kind: "truncated", address: 0x1001, bytes: [0x20, 0x34], expectedLength: 3 },
        ]);
        expect(decoder.decodeRange(0x1001, 1)).toMatchObject([
            { kind: "truncated", address: 0x1001, bytes: [0x20], expectedLength: 3 },
        ]);
        expect(new C6510Decoder(Uint8Array.of(0x20, 0x34), 0xfffe).decodeAt(0xfffe)).toMatchObject({
            kind: "truncated",
            bytes: [0x20, 0x34],
            expectedLength: 3,
        });
        expect(decoder.decodeAt(0x1001)).toMatchObject({ kind: "instruction", operand: { address: 0x1234 } });
    });

    it("stops a linear scan at a halt opcode", () => {
        const decoder = new C6510Decoder(Uint8Array.of(0xea, 0x02, 0xa9, 0x42), 0x1000, {
            includeIllegalOpcodes: true,
        });
        expect(decoder.decodeRange()).toMatchObject([
            { kind: "instruction", address: 0x1000 },
            { kind: "instruction", address: 0x1001, bytes: [0x02], mnemonic: "KIL" },
        ]);
        expect(decoder.decodeAt(0x1002)).toMatchObject({ kind: "instruction", mnemonic: "LDA" });
        expect(decoder.decodeRange(0x1004, 0)).toEqual([]);
    });

    it("copies the memory image and rejects invalid ranges", () => {
        const bytes = Uint8Array.of(0xea, 0x60);
        const decoder = new C6510Decoder(bytes, 0x1000);
        bytes[0] = 0x02;
        decoder.getBytes()[0] = 0x02;
        expect(decoder.decodeAt(0x1000)).toMatchObject({ kind: "instruction", mnemonic: "NOP" });
        for (const address of [-1, 1.5, 0x10000, NaN]) {
            expect(() => new C6510Decoder(bytes, address)).toThrow(RangeError);
        }
        expect(() => new C6510Decoder(bytes, 0xffff)).toThrow(RangeError);
        for (const [start, length] of [
            [0x0fff, 1],
            [0x1000, -1],
            [0x1001, 2],
            [0x1000, 1.5],
            [NaN, 0],
        ]) {
            expect(() => decoder.decodeRange(start, length)).toThrow(RangeError);
        }
        expect(() => decoder.decodeAt(0x1002)).toThrow(RangeError);
    });
});

describe("C64 PRG files", () => {
    it("loads the two-byte little-endian address separately from the program bytes", () => {
        const file = Uint8Array.of(
            0x01,
            0x08,
            0x0b,
            0x08,
            0x0a,
            0x00,
            0x9e,
            0x32,
            0x30,
            0x36,
            0x31,
            0x00,
            0x00,
            0x00,
            0xa9,
            0x42,
            0x60,
        );
        const prg = C64Prg.fromBytes(file);
        expect(prg).toMatchObject({ loadAddress: 0x0801, endAddressExclusive: 0x0810, byteLength: 15 });
        expect(prg.parseBasicProgram()[0].sysReferences).toEqual([
            { address: 0x0805, target: 2061, resolution: "literal" },
        ]);
        expect(prg.decoder.decodeRange(0x080d)).toMatchObject([
            { kind: "instruction", address: 0x080d, mnemonic: "LDA", operand: { kind: "immediate", value: 0x42 } },
            { kind: "instruction", address: 0x080f, mnemonic: "RTS" },
        ]);
        file[14] = 0x02;
        expect(prg.decoder.decodeAt(0x080d)).toMatchObject({ kind: "instruction", mnemonic: "LDA" });
    });

    it("allows an empty payload but rejects missing headers and address-space overflow", () => {
        expect(C64Prg.fromBytes(Uint8Array.of(0x00, 0x20)).decoder.decodeRange()).toEqual([]);
        expect(() => C64Prg.fromBytes(Uint8Array.of(0))).toThrow("two-byte load address");
        expect(() => C64Prg.fromBytes(Uint8Array.of(0xff, 0xff, 0xea, 0x60))).toThrow(RangeError);
        expect(C64Prg.fromBytes(Uint8Array.of(0xff, 0xff, 0xea)).endAddressExclusive).toBe(0x10000);
        expect(() => C64Prg.fromBytes(Uint8Array.of(0, 0x20)).parseBasicProgram()).toThrow("Truncated");
    });
});
