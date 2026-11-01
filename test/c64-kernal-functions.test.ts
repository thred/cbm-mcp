import { describe, expect, it } from "vitest";
import { C64KernalFunctions } from "../src/analysis-engine/c64-kernal-functions.js";

const expected: ReadonlyArray<readonly [string, number, number?]> = [
    ["SCINIT", 0xff5b],
    ["IOINIT", 0xfda3],
    ["RAMTAS", 0xfd50],
    ["RESTOR", 0xfd15],
    ["VECTOR", 0xfd1a],
    ["SETMSG", 0xfe18],
    ["LSTNSA", 0xedb9],
    ["TALKSA", 0xedc7],
    ["MEMTOP", 0xfe25],
    ["MEMBOT", 0xfe34],
    ["SCNKEY", 0xea87],
    ["SETTMO", 0xfe21],
    ["IECIN", 0xee13],
    ["IECOUT", 0xeddd],
    ["UNTALK", 0xedef],
    ["UNLSTN", 0xedfe],
    ["LISTEN", 0xed0c],
    ["TALK", 0xed09],
    ["READST", 0xfe07],
    ["SETLFS", 0xfe00],
    ["SETNAM", 0xfdf9],
    ["OPEN", 0xf34a, 0x031a],
    ["CLOSE", 0xf291, 0x031c],
    ["CHKIN", 0xf20e, 0x031e],
    ["CHKOUT", 0xf250, 0x0320],
    ["CLRCHN", 0xf333, 0x0322],
    ["CHRIN", 0xf157, 0x0324],
    ["CHROUT", 0xf1ca, 0x0326],
    ["LOAD", 0xf49e, 0x0330],
    ["SAVE", 0xf5dd, 0x0332],
    ["SETTIM", 0xf6e4],
    ["RDTIM", 0xf6dd],
    ["STOP", 0xf6ed, 0x0328],
    ["GETIN", 0xf13e, 0x032a],
    ["CLALL", 0xf32f, 0x032c],
    ["UDTIM", 0xf69b],
    ["SCREEN", 0xe505],
    ["PLOT", 0xe50a],
    ["IOBASE", 0xe500],
];

describe("C64 KERNAL function catalog", () => {
    it("covers every documented jump-table entry with its standard-ROM target", () => {
        expect(C64KernalFunctions.all).toHaveLength(39);
        expect(new Set(C64KernalFunctions.all.map((entry) => entry.address)).size).toBe(39);
        expect(new Set(C64KernalFunctions.all.map((entry) => entry.name)).size).toBe(39);

        expected.forEach(([name, target, vector], index) => {
            const address = 0xff81 + 3 * index;
            const entry = C64KernalFunctions.getByAddress(address);
            expect(entry).toMatchObject({
                name,
                address,
                defaultImplementationAddress: target,
            });
            expect(entry?.vectorAddress).toBe(vector);
            expect(entry?.description).toBeTruthy();
            expect(entry?.inputs).toBeInstanceOf(Array);
            expect(entry?.outputs).toBeInstanceOf(Array);
            expect(entry?.usedRegisters.every((register) => ["A", "X", "Y"].includes(register))).toBe(true);
        });
    });

    it("distinguishes jump-table entries from nearby and internal addresses", () => {
        expect(C64KernalFunctions.getByAddress(0xffd2)).toBe(C64KernalFunctions.CHROUT);
        expect(C64KernalFunctions.getByAddress(0xffd3)).toBeUndefined();
        expect(C64KernalFunctions.getByAddress(0xf1ca)).toBeUndefined();
        expect(C64KernalFunctions.getByAddress(0xfff6)).toBeUndefined();
        for (const address of [-1, 0x10000, 1.5, NaN, Infinity]) {
            expect(() => C64KernalFunctions.getByAddress(address)).toThrow(RangeError);
        }
    });

    it("retains calling conventions, preconditions and reference caveats", () => {
        expect(C64KernalFunctions.SETLFS.inputs).toEqual([
            "A: logical file number.",
            "X: device number.",
            "Y: secondary address.",
        ]);
        expect(C64KernalFunctions.SETNAM.inputs).toContain("X/Y: name pointer, low/high byte.");
        expect(C64KernalFunctions.LOAD.outputs.join(" ")).toContain("Carry set: error");
        expect(C64KernalFunctions.SAVE.inputs.join(" ")).toContain("exclusive end address");
        expect(C64KernalFunctions.IECIN.notes).toContain("Call TALK and TALKSA first.");
        expect(C64KernalFunctions.CLRCHN.notes?.join(" ")).toContain("does not close the logical files");
        expect(C64KernalFunctions.PLOT.inputs.join(" ")).toContain("X: row, Y: column");
        expect(C64KernalFunctions.PLOT.outputs.join(" ")).toContain("X: row, Y: column");
        expect(C64KernalFunctions.SETTMO.notes?.join(" ")).toContain("uncertain");
        expect(C64KernalFunctions.LOAD.defaultVectorTargetAddress).toBe(0xf4a5);
        expect(C64KernalFunctions.SAVE.defaultVectorTargetAddress).toBe(0xf5ed);
    });
});
