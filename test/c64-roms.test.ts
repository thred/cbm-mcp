import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { C64Roms } from "../src/index.js";

describe("C64 ROM identification", () => {
    it("indexes published standard BASIC and KERNAL fingerprints by kind and SHA-1", () => {
        expect(C64Roms.all.map((entry) => [entry.kind, entry.partNumber, entry.sha1])).toEqual([
            ["basic", "901226-01", "79015323128650c742a3694c9429aa91f355905e"],
            ["kernal", "901227-01", "87cc04d61fc748b82df09856847bb5c2754a2033"],
            ["kernal", "901227-02", "0e2e4ee3f2d41f00bed72f9ab588b83e306fdb13"],
            ["kernal", "901227-03", "1d503e56df85a62fee696e7618dc5b4e781df1bb"],
        ]);
        for (const entry of C64Roms.all) {
            expect(C64Roms.getBySha1(entry.kind, entry.sha1.toUpperCase())).toBe(entry);
            expect(entry.length).toBe(8192);
            expect(entry.source).toContain("7ffae3686de8d00cbb829fa953eeda29ad45f944");
        }
        expect(C64Roms.getBySha1("basic", C64Roms.all[1].sha1)).toBeUndefined();
        expect(() => C64Roms.getBySha1("basic", "bad")).toThrow(RangeError);
    });

    it("reports an unrecognized image rather than treating it as standard ROM", () => {
        const image = new Uint8Array(8192);
        const sha1 = createHash("sha1").update(image).digest("hex");
        expect(C64Roms.identify("basic", image)).toEqual({ status: "unknown", sha1 });
        expect(C64Roms.identify("kernal", image)).toEqual({ status: "unknown", sha1 });
        expect(() => C64Roms.identify("basic", image.slice(1))).toThrow(RangeError);
        expect(() => C64Roms.identify("invalid" as never, image)).toThrow("ROM kind");
        expect(() => C64Roms.getBySha1("invalid" as never, sha1)).toThrow("ROM kind");
    });
});
