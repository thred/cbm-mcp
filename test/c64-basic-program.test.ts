import { describe, expect, it } from "vitest";
import { C64BasicTokens, detectC64BasicProgram, formatC64BasicLine, parseC64BasicProgram } from "../src/index.js";

function program(bodies: readonly number[][], start = 0x0801): Uint8Array {
    const bytes: number[] = [];
    for (const [index, body] of bodies.entries()) {
        const next = start + bytes.length + 5 + body.length;
        bytes.push(next & 0xff, next >> 8, (index + 1) * 10, 0, ...body, 0);
    }
    return Uint8Array.from([...bytes, 0, 0]);
}

describe("C64 BASIC V2 tokens and program lines", () => {
    it("formats statement boundaries and IF scope without splitting quoted text or REM", () => {
        const code = (keyword: string) => {
            const token = C64BasicTokens.all.find((item) => item.keyword === keyword);
            if (!token) throw new Error(`Unknown token ${keyword}`);
            return token.code;
        };
        const ascii = (value: string) => [...Buffer.from(value, "ascii")];
        const [conditional, literals, nested] = parseC64BasicProgram(
            program([
                [
                    code("IF"),
                    ...ascii("IP$("),
                    code("INT"),
                    ...ascii("(A/2))"),
                    code("<"),
                    code(">"),
                    ...ascii('""'),
                    code("THEN"),
                    code("POKE"),
                    ...ascii("BA+17+TC,A:"),
                    code("PRINT"),
                    ...ascii('IP$(A/2):IP$(A/2)=""'),
                    ...ascii(":"),
                    code("GOTO"),
                    ...ascii("2300"),
                ],
                [
                    code("DATA"),
                    ...ascii('"A:B",X:'),
                    code("PRINT"),
                    ...ascii('"C:D":'),
                    code("REM"),
                    ...ascii(" COMMENT:STILL COMMENT"),
                ],
                [
                    code("IF"),
                    ...ascii("A"),
                    code("THEN"),
                    code("IF"),
                    ...ascii("B"),
                    code("THEN"),
                    code("PRINT"),
                    ...ascii("1:"),
                    code("PRINT"),
                    ...ascii("2"),
                ],
            ]),
            0x0801,
        );
        expect(formatC64BasicLine(conditional, { multiline: true })).toBe(
            '10 IF IP$(INT(A/2))<>"" THEN POKE BA+17+TC,A:\n        PRINT IP$(A/2):\n        IP$(A/2)="":\n        GOTO 2300',
        );
        expect(formatC64BasicLine(literals, { multiline: true })).toBe(
            '20 DATA "A:B",X:\n    PRINT "C:D":\n    REM COMMENT:STILL COMMENT',
        );
        expect(formatC64BasicLine(nested, { multiline: true })).toBe(
            "30 IF A THEN IF B THEN PRINT 1:\n            PRINT 2",
        );
        expect(formatC64BasicLine(conditional)).toContain('"" THEN POKE');
    });

    it("provides all 76 token codes with BASIC V2 provenance", () => {
        const expected =
            "END FOR NEXT DATA INPUT# INPUT DIM READ LET GOTO RUN IF RESTORE GOSUB RETURN REM " +
            "STOP ON WAIT LOAD SAVE VERIFY DEF POKE PRINT# PRINT CONT LIST CLR CMD SYS OPEN CLOSE GET NEW " +
            "TAB( TO FN SPC( THEN NOT STEP + - * / ↑ AND OR > = < SGN INT ABS USR FRE POS SQR RND LOG " +
            "EXP COS SIN TAN ATN PEEK LEN STR$ VAL ASC CHR$ LEFT$ RIGHT$ MID$ GO";
        expect(C64BasicTokens.all).toHaveLength(76);
        expect(C64BasicTokens.all.map((token) => token.keyword)).toEqual(expected.split(" "));
        for (const [index, token] of C64BasicTokens.all.entries()) {
            expect(C64BasicTokens.getByCode(0x80 + index)).toBe(token);
            expect(token).toMatchObject({
                code: 0x80 + index,
                version: "Commodore BASIC V2",
                source: "https://www.c64-wiki.com/wiki/BASIC_token",
                sourceRevision: 45685,
            });
        }
        expect(C64BasicTokens.getByCode(0xff)).toBeUndefined();
        expect(() => C64BasicTokens.getByCode(256)).toThrow(RangeError);
    });

    it("parses relocated linked lines and discovers literal and unresolved SYS references", () => {
        const bytes = program(
            [
                [0x9e, 0x20, 0x34, 0x39, 0x31, 0x35, 0x32, 0x3a, 0x9e, 0x41],
                [0x8b, 0x41, 0xa7, 0x9e, 0x36, 0x35, 0x35, 0x33, 0x35],
            ],
            0x2000,
        );
        const lines = parseC64BasicProgram(bytes, 0x2000);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ address: 0x2000, nextAddress: 0x200f, number: 10 });
        expect(lines[0].sysReferences).toEqual([
            { address: 0x2004, target: 49152, resolution: "literal" },
            { address: 0x200c, resolution: "unresolved" },
        ]);
        expect(lines[1].sysReferences).toEqual([{ address: 0x2016, target: 65535, resolution: "literal" }]);
        expect(lines[1].tokens.map(({ token }) => token.keyword)).toEqual(["IF", "THEN", "SYS"]);
        expect(parseC64BasicProgram(Uint8Array.of(0, 0), 0x0801)).toEqual([]);
    });

    it("does not mistake strings, DATA or REM for executable SYS tokens", () => {
        const line = [
            0x99, 0x22, 0x9e, 0x22, 0x3a, 0x83, 0x22, 0x3a, 0x9e, 0x22, 0x9e, 0x3a, 0x9e, 0x31, 0x3a, 0x8f, 0x9e, 0x32,
        ];
        const [result] = parseC64BasicProgram(program([line]), 0x0801);
        expect(result.sysReferences).toEqual([{ address: 0x0811, target: 1, resolution: "literal" }]);
        expect(result.tokens.map(({ token }) => token.keyword)).toEqual(["PRINT", "DATA", "SYS", "REM"]);
    });

    it("does not treat expressions, out-of-range numbers or expansion tokens as literal targets", () => {
        const [line] = parseC64BasicProgram(
            program([
                [
                    0x9e, 0x31, 0xaa, 0x32, 0x3a, 0x9e, 0x36, 0x35, 0x35, 0x33, 0x36, 0x3a, 0xcc, 0xff, 0x3a, 0x9e,
                    0x30, 0x2c, 0x41,
                ],
            ]),
            0x0801,
        );
        expect(line.sysReferences.map((ref) => [ref.resolution, ref.target])).toEqual([
            ["unresolved", undefined],
            ["unresolved", undefined],
            ["literal", 0],
        ]);
    });

    it("rejects malformed, truncated and out-of-range program data", () => {
        expect(() => parseC64BasicProgram(Uint8Array.of(0), 0x0801)).toThrow("Truncated");
        expect(() => parseC64BasicProgram(Uint8Array.of(1, 8, 0, 0, 0, 0, 0), 0x0801)).toThrow("Invalid");
        const broken = program([[0x99, 0x41]]);
        broken[5] = 0;
        expect(() => parseC64BasicProgram(broken, 0x0801)).toThrow("Premature");
        expect(() => parseC64BasicProgram(program([[0x99]]).slice(0, -1), 0x0801)).toThrow("truncated");
        expect(() => parseC64BasicProgram(Uint8Array.of(0, 0), 0xffff)).toThrow(RangeError);
    });

    it("renders tokens, literal PETSCII and escaped control or graphics bytes without decoding string contents", () => {
        const [line] = parseC64BasicProgram(
            program([
                [0x99, 0x22, 0x9e, 0x22, 0x3a, 0x83, 0x22, 0x99, 0x22, 0x3a, 0x8f, 0x20, 0x9e, 0x5c, 0x5e, 0x5f, 0x0d],
            ]),
            0x0801,
        );
        expect(formatC64BasicLine(line)).toBe('10 PRINT "{$9e}":DATA "{$99}":REM {$9e}£↑←{$0d}');
        expect(formatC64BasicLine(parseC64BasicProgram(program([[0x9e, 0x32, 0x30, 0x36, 0x31]]), 0x0801)[0])).toBe(
            "10 SYS 2061",
        );
    });

    it("recognizes complete nonempty ordered programs and rejects malformed or implausible candidates", () => {
        const bytes = program([[0x9e, 0x31], [0x80]], 0x2000);
        const result = detectC64BasicProgram(bytes, 0x2000);
        expect(result).toMatchObject({ startAddress: 0x2000, endAddressExclusive: 0x2000 + bytes.length });
        expect(result?.lines.map((line) => line.number)).toEqual([10, 20]);
        expect(detectC64BasicProgram(bytes.slice(0, -1), 0x2000)).toBeUndefined();
        expect(detectC64BasicProgram(Uint8Array.of(0, 0), 0x2000)).toBeUndefined();
        bytes[result!.lines[1].address - 0x2000 + 2] = 5;
        expect(detectC64BasicProgram(bytes, 0x2000)).toBeUndefined();
        expect(() => detectC64BasicProgram(Uint8Array.of(0, 0), 0xffff)).toThrow(RangeError);
    });
});
