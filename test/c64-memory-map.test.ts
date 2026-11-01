import { describe, expect, it } from "vitest";
import { C64BasicRom } from "../src/analysis-engine/c64-basic-rom.js";
import { C64KernalFunctions } from "../src/analysis-engine/c64-kernal-functions.js";
import { C64MemoryMap } from "../src/analysis-engine/c64-memory-map.js";

describe("C64 memory map reference", () => {
    it("covers the CPU address range while retaining overlapping views", () => {
        expect(new Set(C64MemoryMap.all.map((entry) => entry.id)).size).toBe(C64MemoryMap.all.length);
        for (let address = 0; address <= 0xffff; address++) {
            expect(C64MemoryMap.at(address).length, `$${address.toString(16)}`).toBeGreaterThan(0);
        }
        expect(C64MemoryMap.at(0xa000).map((entry) => entry.view)).toEqual(
            expect.arrayContaining(["ram", "basic-rom"]),
        );
        expect(C64MemoryMap.at(0xd020).map((entry) => entry.view)).toEqual(
            expect.arrayContaining(["ram", "character-rom", "io"]),
        );
        expect(C64MemoryMap.at(0xe000).map((entry) => entry.view)).toEqual(
            expect.arrayContaining(["ram", "kernal-rom"]),
        );
        expect(C64MemoryMap.at(0x0001, "ram")).toEqual([]);
        expect(C64MemoryMap.at(0x0001, "cpu-port").map((entry) => entry.name)).toContain("6510 processor port");
    });

    it("finds range overlaps, including pointers and larger surrounding regions", () => {
        const results = C64MemoryMap.overlapping(0x002c, 0x0030, "ram");
        expect(results.map((entry) => entry.name)).toEqual(
            expect.arrayContaining([
                "BASIC program start pointer",
                "BASIC variables start pointer",
                "BASIC arrays start pointer",
            ]),
        );
        expect(C64MemoryMap.at(0x0102, "ram").map((entry) => entry.name)).toEqual(
            expect.arrayContaining(["Floating-point conversion buffer", "Tape error pointer buffer", "CPU stack"]),
        );
        expect(C64MemoryMap.at(0x007a, "ram").map((entry) => entry.name)).toEqual(
            expect.arrayContaining(["CHRGET routine", "BASIC text pointer"]),
        );
    });

    it("resolves every mirrored hardware register to its canonical entry", () => {
        const all = C64MemoryMap.all;
        const byId = new Map(all.map((entry) => [entry.id, entry]));
        for (const [base, period, limit] of [
            [0xd000, 0x40, 0xd400],
            [0xd400, 0x20, 0xd800],
            [0xdc00, 0x10, 0xdd00],
            [0xdd00, 0x10, 0xde00],
        ]) {
            for (let offset = period; base + offset < limit; offset += period) {
                for (const original of all.filter(
                    (entry) => entry.view === "io" && entry.start >= base && entry.end < base + period,
                )) {
                    const mirror = C64MemoryMap.at(original.start + offset, "io").find(
                        (entry) => entry.canonicalId === original.id,
                    );
                    expect(mirror, `${original.id} + ${offset}`).toMatchObject({
                        start: original.start + offset,
                        end: original.end + offset,
                        name: original.name,
                    });
                    expect(byId.get(mirror!.canonicalId!)).toBe(original);
                }
            }
        }
        expect(C64MemoryMap.at(0xd060, "io").find((entry) => entry.name === "Border color")?.canonicalId).toBe(
            "io:d020-d020",
        );
        expect(
            C64MemoryMap.at(0xdc1d, "io").find((entry) => entry.name === "CIA 1 interrupt control")?.description,
        ).toContain("acknowledges");
    });

    it("links KERNAL jump table and vector entries to the routine catalog", () => {
        for (const routine of C64KernalFunctions.all) {
            const entry = C64MemoryMap.at(routine.address, "kernal-rom").find(
                (item) => item.kernalFunction === routine.name,
            );
            expect(entry?.kernalFunctionAddress).toBe(routine.address);
            expect(C64KernalFunctions.getByAddress(entry!.kernalFunctionAddress!)).toBe(routine);
        }
        const loadVector = C64MemoryMap.at(0x0331, "ram").find((entry) => entry.kernalFunction === "LOAD");
        expect(loadVector?.kernalFunctionAddress).toBe(C64KernalFunctions.LOAD.address);
        expect(loadVector?.description).toContain("$f4a5");
        expect(C64MemoryMap.at(0x0332, "ram").find((entry) => entry.kernalFunction === "SAVE")?.description).toContain(
            "$f5ed",
        );
    });

    it("supports text and view search without asserting current hardware state", () => {
        expect(C64MemoryMap.search("  BORDER COLOR ", "io").some((entry) => entry.start === 0xd020)).toBe(true);
        expect(C64MemoryMap.search("chROut", "ram").some((entry) => entry.start === 0x0326)).toBe(true);
        expect(C64MemoryMap.search("KERNAL CHROUT", "kernal-rom").some((entry) => entry.start === 0xffd2)).toBe(true);
        expect(
            C64MemoryMap.at(0x07f8, "ram").find((entry) => entry.name === "Default sprite pointers")?.description,
        ).toContain("Default");
        expect(C64MemoryMap.at(0xd012, "io").find((entry) => entry.name === "Raster line")?.description).toContain(
            "writes",
        );
        expect(
            C64MemoryMap.at(0xd01e, "io").find((entry) => entry.name === "Sprite-sprite collision")?.description,
        ).toContain("clear");
        expect(
            C64MemoryMap.all.every(
                (entry) =>
                    entry.source ===
                    (entry.basicRomEntryAddress === undefined
                        ? "https://sta.c64.org/cbm64mem.html"
                        : C64BasicRom.getByAddress(entry.basicRomEntryAddress)?.source),
            ),
        ).toBe(true);
    });

    it("describes CIA timer pulse and toggle modes using the corrected source, including mirrors", () => {
        for (const address of [0xdc0e, 0xdc0f, 0xdd0e, 0xdd0f, 0xdc1e, 0xdd1f]) {
            const field = C64MemoryMap.bitsAt(address, { view: "io", bit: 2 }).find(
                (match) => match.field.name === "Timer output mode",
            )?.field;
            expect(field?.description).toBe("0 generates a one-cycle pulse; 1 toggles the port bit on underflow.");
            expect(field?.source).toContain("mamedev/mame/blob/7ffae3686de8d00cbb829fa953eeda29ad45f944");
        }
    });

    it("attaches structured bit fields for documented CPU, RAM and hardware registers", () => {
        const addresses: readonly [number, "cpu-port" | "ram" | "io"][] = [
            [0x0000, "cpu-port"],
            [0x0001, "cpu-port"],
            [0x000e, "ram"],
            [0x000f, "ram"],
            [0x0045, "ram"],
            [0x0046, "ram"],
            [0x004d, "ram"],
            [0x0066, "ram"],
            [0x006e, "ram"],
            [0x0090, "ram"],
            [0x0094, "ram"],
            [0x009d, "ram"],
            [0x00a3, "ram"],
            [0x00b4, "ram"],
            [0x00b5, "ram"],
            [0x028a, "ram"],
            [0x028d, "ram"],
            [0x028e, "ram"],
            [0x0291, "ram"],
            [0x0293, "ram"],
            [0x0294, "ram"],
            [0x0297, "ram"],
            [0xd010, "io"],
            [0xd000, "io"],
            [0xd001, "io"],
            [0xd011, "io"],
            [0xd012, "io"],
            [0xd013, "io"],
            [0xd014, "io"],
            [0xd015, "io"],
            [0xd016, "io"],
            [0xd017, "io"],
            [0xd018, "io"],
            [0xd019, "io"],
            [0xd01a, "io"],
            [0xd01b, "io"],
            [0xd01c, "io"],
            [0xd01d, "io"],
            [0xd01e, "io"],
            [0xd01f, "io"],
            [0xd020, "io"],
            [0xd02e, "io"],
            [0xd403, "io"],
            [0xd404, "io"],
            [0xd405, "io"],
            [0xd406, "io"],
            [0xd40b, "io"],
            [0xd412, "io"],
            [0xd415, "io"],
            [0xd416, "io"],
            [0xd417, "io"],
            [0xd418, "io"],
            [0xd800, "io"],
            [0xdbff, "io"],
            [0xdc00, "io"],
            [0xdc01, "io"],
            [0xdc02, "io"],
            [0xdc03, "io"],
            [0xdc0b, "io"],
            [0xdc0d, "io"],
            [0xdc0e, "io"],
            [0xdc0f, "io"],
            [0xdd00, "io"],
            [0xdd01, "io"],
            [0xdd02, "io"],
            [0xdd03, "io"],
            [0xdd0b, "io"],
            [0xdd0d, "io"],
            [0xdd0e, "io"],
            [0xdd0f, "io"],
        ];
        for (const [address, view] of addresses) {
            const matches = C64MemoryMap.bitsAt(address, { view });
            expect(matches.length, `$${address.toString(16)}`).toBeGreaterThan(0);
            expect(C64MemoryMap.at(address, view).some((entry) => entry.bitFields?.length)).toBe(true);
            for (const { entry, field } of matches) {
                expect(entry.source).toBe("https://sta.c64.org/cbm64mem.html");
                expect(field.mask).toBeGreaterThan(0);
                expect(field.mask).toBeLessThanOrEqual(255);
                expect(field.mask & ((1 << field.shift) - 1)).toBe(0);
                expect(field.mask & (1 << field.shift)).not.toBe(0);
                for (const value of field.values ?? []) {
                    expect(value.value).toBeGreaterThanOrEqual(0);
                    expect(value.value).toBeLessThanOrEqual(field.mask >> field.shift);
                }
            }
        }
    });

    it("distinguishes overlapping fields, context, access and aliases", () => {
        const rasterRead = C64MemoryMap.bitsAt(0xd011, { view: "io", bit: 7, access: "read" });
        const rasterWrite = C64MemoryMap.bitsAt(0xd011, { view: "io", bit: 7, access: "write" });
        expect(rasterRead.map(({ field }) => field.name)).toEqual(["Raster high bit"]);
        expect(rasterWrite.map(({ field }) => field.name)).toEqual(["Raster IRQ high bit"]);
        const mirror = C64MemoryMap.bitsAt(0xd051, { view: "io", bit: 7, access: "write" });
        expect(mirror[0].entry.canonicalId).toBe("io:d011-d011");
        expect(mirror[0].field).toEqual(rasterWrite[0].field);

        expect(C64MemoryMap.bitsAt(0xd018, { view: "io", bit: 3 }).map(({ field }) => field.condition)).toEqual([
            "Text mode",
            "Bitmap mode",
        ]);
        expect(C64MemoryMap.bitsAt(0xdc0d, { view: "io", bit: 0, access: "write" })[0].field.description).toContain(
            "bit 7",
        );
        expect(C64MemoryMap.bitsAt(0xdc1d, { view: "io", bit: 0, access: "read" })[0].field.description).toContain(
            "acknowledges",
        );
        expect(C64MemoryMap.bitsAt(0xd404, { view: "io", bit: 0, access: "read" })).toEqual([]);
        expect(C64MemoryMap.bitsAt(0xd424, { view: "io", bit: 0, access: "write" })[0].field.name).toBe("Gate");
        expect(C64MemoryMap.bitsAt(0xd800, { view: "character-rom" })).toEqual([]);
    });

    it("exposes field values and permits text searches within them", () => {
        const bank = C64MemoryMap.bitsAt(0xdd00, { view: "io", bit: 0 }).find(({ field }) => field.name === "VIC bank");
        expect(bank?.field).toMatchObject({
            mask: 3,
            shift: 0,
            values: [
                { value: 0, description: "$c000-$ffff" },
                { value: 1, description: "$8000-$bfff" },
                { value: 2, description: "$4000-$7fff" },
                { value: 3, description: "$0000-$3fff" },
            ],
        });
        const mapping = C64MemoryMap.bitsAt(0x0001, { view: "cpu-port" }).find(
            ({ field }) => field.name === "CPU memory mapping",
        );
        expect(mapping?.field.values).toHaveLength(8);
        expect(mapping?.field.values?.[7].description).toBe("BASIC ROM / I/O / KERNAL ROM");
        const color = C64MemoryMap.bitsAt(0xd021, { view: "io" }).find(({ field }) => field.name === "Color index");
        expect(color?.field.values?.[14]).toEqual({ value: 14, description: "light blue" });
        const attack = C64MemoryMap.bitsAt(0xd405, { view: "io", bit: 7 })[0].field;
        expect(attack.values?.[15]).toEqual({ value: 15, description: "8 s" });
        expect(C64MemoryMap.search("raster irq high bit", "io").some((entry) => entry.start === 0xd011)).toBe(true);
        expect(C64MemoryMap.search("light blue", "io").some((entry) => entry.start === 0xd021)).toBe(true);
    });

    it("rejects malformed ranges, addresses, views and empty searches", () => {
        for (const address of [-1, 0x10000, 1.5, NaN, Infinity]) {
            expect(() => C64MemoryMap.at(address)).toThrow(RangeError);
        }
        expect(() => C64MemoryMap.overlapping(2, 1)).toThrow(RangeError);
        expect(() => C64MemoryMap.search("  ")).toThrow();
        // @ts-expect-error Exercise validation for untyped callers.
        expect(() => C64MemoryMap.at(0xd020, "invalid")).toThrow("Unknown C64 memory view");
        for (const bit of [-1, 8, 1.5, NaN]) {
            expect(() => C64MemoryMap.bitsAt(0xd011, { bit })).toThrow(RangeError);
        }
        // @ts-expect-error Exercise validation for untyped callers.
        expect(() => C64MemoryMap.bitsAt(0xd011, { access: "execute" })).toThrow("Unknown bit access");
    });
});
