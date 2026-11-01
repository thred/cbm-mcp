import { describe, expect, it } from "vitest";
import { C64Colors } from "../src/index.js";
import { C64_PALETTE } from "../src/vice/sprite-export.js";

describe("C64 color catalog", () => {
    it("lists all 16 VIC-II color codes in reference order", () => {
        const names = [
            "black",
            "white",
            "red",
            "cyan",
            "purple",
            "green",
            "blue",
            "yellow",
            "orange",
            "brown",
            "pink",
            "dark grey",
            "grey",
            "light green",
            "light blue",
            "light grey",
        ];
        expect(C64Colors.all).toHaveLength(16);
        expect(C64_PALETTE).toHaveLength(16);
        expect(C64Colors.all.map((color) => color.name)).toEqual(names);
        for (let code = 0; code < names.length; code++) {
            expect(C64Colors.getByCode(code)).toEqual({ code, name: names[code] });
            expect(C64Colors.getByCode(code)).toBe(C64Colors.all[code]);
        }
    });

    it("rejects values that are not color codes rather than masking them", () => {
        for (const code of [-1, 16, 255, 1.5, NaN, Infinity]) {
            expect(() => C64Colors.getByCode(code)).toThrow(RangeError);
        }
    });
});
