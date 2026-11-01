import { describe, expect, it } from "vitest";
import { C64BasicRom } from "../src/analysis-engine/c64-basic-rom.js";
import { C64MemoryMap } from "../src/analysis-engine/c64-memory-map.js";

const referenceAddresses = `
A000 A002 A004 A00C A052 A080 A09E A129 A140 A14D A19E A328
A364 A38A A3B8 A3BF A3FB A408 A435 A437 A480 A49C A533 A560
A579 A613 A642 A65E A68E A69C A717 A742 A7AE A7C4 A7E1 A7ED
A81D A82C A82F A831 A857 A871 A883 A8A0 A8D2 A8F8 A906 A928
A93B A94B A96B A9A5 A9C4 A9D6 A9D9 A9E3 AA27 AA2C AA80 AA86
AA9A AAA0 AAB8 AACA AAD7 AAF8 AB1E AB3B AB3F AB42 AB45 AB47
AB4D AB7B ABA5 ABBF ABEA ABF9 AC06 AC35 ACFC AD1D AD61 AD8A
AD9E AE83 AEA8 AEF1 AEF7 AEFA AEFD AF08 AF0D AF14 AF28 AF48
AFA7 AFB1 AFD1 AFE6 B016 B01B B02E B081 B08B B0E7 B113 B11D
B194 B1A5 B1AA B1B2 B1BF B1D1 B218 B245 B248 B24D B261 B30E
B34C B37D B391 B39E B3A2 B3A6 B3AE B3B3 B3E1 B3F4 B465 B475
B487 B4CA B4F4 B526 B606 B63D B67A B6A3 B6DB B6EC B700 B72C
B737 B761 B77C B782 B78B B79B B7AD B7EB B7F7 B80D B824 B82D
B849 B850 B853 B862 B867 B86A B947 B97E B983 B9BC B9C1 B9C2
B9C7 B9CC B9D1 B9D6 B9DB B9E0 B9E5 B9EA BA28 BA30 BA59 BA8C
BAB7 BAE2 BAF9 BAFE BB0F BB14 BB8A BBA2 BBC7 BBCA BBD0 BBFC
BC0C BC1B BC2B BC39 BC58 BC5B BC9B BCCC BCF3 BDB3 BDB8 BDBD
BDC2 BDCD BDDD BE68 BF11 BF16 BF3A BF71 BF78 BF7B BFB4 BFBF
BFC4 BFC5 BFCA BFCF BFD4 BFD9 BFDE BFE3 BFE8 BFED E043 E059
E264 E26B E2B4 E30E
`
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 16));

describe("C64 BASIC ROM catalog", () => {
    it("covers the reference's 232 addresses exactly once", () => {
        expect(referenceAddresses).toHaveLength(232);
        const all = C64BasicRom.all;
        expect(all.filter((entry) => entry.source.endsWith("/BASIC-ROM")).map((entry) => entry.address)).toEqual(
            referenceAddresses,
        );
        expect(new Set(all.map((entry) => entry.address)).size).toBe(233);
        for (const entry of all) {
            expect(C64BasicRom.getByAddress(entry.address)).toBe(entry);
            expect(entry.name).toBeTruthy();
            expect(entry.description).toBeTruthy();
            expect(entry.sourceRevision).toBe(entry.address === 0xe12a ? 39060 : 309543);
            expect(entry.version).toBe("C64 BASIC V2 and compatible KERNAL");
            expect(entry.view).toBe(entry.address >= 0xe000 ? "kernal-rom" : "basic-rom");
            if (entry.endAddress !== undefined) {
                expect(entry.endAddress).toBeGreaterThanOrEqual(entry.address);
                expect(entry.endAddress).toBeLessThan(0x10000);
            }
        }
    });

    it("distinguishes code, data and vectors without guessing routine extents", () => {
        expect(C64BasicRom.getByAddress(0xa000)).toMatchObject({
            kind: "vector",
            address: 0xa000,
            endAddress: 0xa001,
            view: "basic-rom",
        });
        expect(C64BasicRom.getByAddress(0xa00c)).toMatchObject({ kind: "data", endAddress: 0xa051 });
        expect(C64BasicRom.getByAddress(0xad9e)).toMatchObject({ kind: "routine", name: "FRMEVL" });
        expect(C64BasicRom.getByAddress(0xad9e)?.endAddress).toBeUndefined();
        expect(C64BasicRom.getByAddress(0xad9f)).toBeUndefined();
        expect(C64BasicRom.getByAddress(0xe2b4)).toMatchObject({ kind: "routine", name: "TAN", view: "kernal-rom" });
        expect(C64BasicRom.getByAddress(0xe12a)).toMatchObject({
            name: "SYS",
            endAddress: 0xe155,
            source: "https://www.c64-wiki.com/wiki/SYS",
            sourceRevision: 39060,
        });
        expect(C64BasicRom.getByAddress(0xbfde)?.description).toContain("2.40226385e-1");
    });

    it("preserves available calling and interpreter details", () => {
        expect(C64BasicRom.getByAddress(0xa437)?.inputs).toContain("X: error number.");
        expect(C64BasicRom.getByAddress(0xa742)?.notes?.join(" ")).toContain("18-byte");
        expect(C64BasicRom.getByAddress(0xa883)?.notes?.join(" ")).toContain("five-byte");
        expect(C64BasicRom.getByAddress(0xb08b)?.outputs?.join(" ")).toContain("A/Y");
        expect(C64BasicRom.getByAddress(0xb4f4)?.inputs).toContain("A: string length.");
        expect(C64BasicRom.getByAddress(0xbc5b)?.outputs?.join(" ")).toContain("$ff");
        expect(C64BasicRom.search("  FRMEVL  ").some((entry) => entry.address === 0xad9e)).toBe(true);
        expect(C64BasicRom.search("string length").some((entry) => entry.address === 0xb4f4)).toBe(true);
    });

    it("exposes the reference in memory-map queries only for the appropriate ROM view", () => {
        for (const entry of C64BasicRom.all) {
            const mapEntry = C64MemoryMap.at(entry.address, entry.view).find(
                (item) => item.basicRomEntryAddress === entry.address,
            );
            expect(mapEntry).toMatchObject({
                start: entry.address,
                end: entry.endAddress ?? entry.address,
                basicRomEntryKind: entry.kind,
                source: entry.source,
                sourceRevision: entry.sourceRevision,
                referenceVersion: entry.version,
            });
        }
        expect(C64MemoryMap.at(0xa001, "basic-rom").find((item) => item.basicRomEntryAddress === 0xa000)).toBeDefined();
        expect(C64MemoryMap.at(0xa051, "basic-rom").find((item) => item.basicRomEntryAddress === 0xa00c)).toBeDefined();
        expect(
            C64MemoryMap.at(0xa052, "basic-rom").find((item) => item.basicRomEntryAddress === 0xa00c),
        ).toBeUndefined();
        expect(
            C64MemoryMap.at(0xad9f, "basic-rom").find((item) => item.basicRomEntryAddress === 0xad9e),
        ).toBeUndefined();
        expect(C64MemoryMap.at(0xad9e, "ram").some((item) => item.basicRomEntryAddress !== undefined)).toBe(false);
        expect(C64MemoryMap.search("FRMEVL", "basic-rom").some((item) => item.start === 0xad9e)).toBe(true);
        expect(C64MemoryMap.at(0xe26b, "kernal-rom").some((item) => item.basicRomEntryAddress === 0xe26b)).toBe(true);
        expect(
            C64MemoryMap.at(0xe130, "kernal-rom").find((item) => item.basicRomEntryAddress === 0xe12a),
        ).toMatchObject({
            source: "https://www.c64-wiki.com/wiki/SYS",
            sourceRevision: 39060,
            referenceVersion: "C64 BASIC V2 and compatible KERNAL",
        });
    });

    it("rejects malformed addresses and empty searches", () => {
        for (const address of [-1, 0x10000, 1.5, NaN, Infinity]) {
            expect(() => C64BasicRom.getByAddress(address)).toThrow(RangeError);
        }
        expect(C64BasicRom.getByAddress(0x0000)).toBeUndefined();
        expect(() => C64BasicRom.search(" ")).toThrow("Search text must not be empty.");
    });
});
