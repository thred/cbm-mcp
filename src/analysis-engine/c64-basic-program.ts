export interface C64BasicToken {
    readonly code: number;
    readonly keyword: string;
    readonly source: string;
    readonly sourceRevision: number;
    readonly version: "Commodore BASIC V2";
}

const source = "https://www.c64-wiki.com/wiki/BASIC_token";
const keywords = [
    "END",
    "FOR",
    "NEXT",
    "DATA",
    "INPUT#",
    "INPUT",
    "DIM",
    "READ",
    "LET",
    "GOTO",
    "RUN",
    "IF",
    "RESTORE",
    "GOSUB",
    "RETURN",
    "REM",
    "STOP",
    "ON",
    "WAIT",
    "LOAD",
    "SAVE",
    "VERIFY",
    "DEF",
    "POKE",
    "PRINT#",
    "PRINT",
    "CONT",
    "LIST",
    "CLR",
    "CMD",
    "SYS",
    "OPEN",
    "CLOSE",
    "GET",
    "NEW",
    "TAB(",
    "TO",
    "FN",
    "SPC(",
    "THEN",
    "NOT",
    "STEP",
    "+",
    "-",
    "*",
    "/",
    "↑",
    "AND",
    "OR",
    ">",
    "=",
    "<",
    "SGN",
    "INT",
    "ABS",
    "USR",
    "FRE",
    "POS",
    "SQR",
    "RND",
    "LOG",
    "EXP",
    "COS",
    "SIN",
    "TAN",
    "ATN",
    "PEEK",
    "LEN",
    "STR$",
    "VAL",
    "ASC",
    "CHR$",
    "LEFT$",
    "RIGHT$",
    "MID$",
    "GO",
] as const;

const tokens: readonly C64BasicToken[] = keywords.map((keyword, index) => ({
    code: 0x80 + index,
    keyword,
    source,
    sourceRevision: 45685,
    version: "Commodore BASIC V2",
}));

export class C64BasicTokens {
    static get all(): readonly C64BasicToken[] {
        return tokens;
    }

    static getByCode(code: number): C64BasicToken | undefined {
        if (!Number.isInteger(code) || code < 0 || code > 0xff) {
            throw new RangeError("Token code must be a byte.");
        }
        return tokens[code - 0x80];
    }
}

export interface C64BasicTokenOccurrence {
    readonly address: number;
    readonly token: C64BasicToken;
}

export interface C64BasicSysReference {
    readonly address: number;
    readonly target?: number;
    readonly resolution: "literal" | "unresolved";
}

export interface C64BasicLine {
    readonly address: number;
    readonly nextAddress: number;
    readonly number: number;
    readonly body: Uint8Array;
    readonly tokens: readonly C64BasicTokenOccurrence[];
    readonly sysReferences: readonly C64BasicSysReference[];
}

export interface C64BasicProgram {
    readonly startAddress: number;
    readonly endAddressExclusive: number;
    readonly lines: readonly C64BasicLine[];
}

class C64BasicParseError extends Error {}

/** Render a BASIC line without interpreting quoted, DATA or REM bytes as tokens. */
export function formatC64BasicLine(line: C64BasicLine, options: { multiline?: boolean } = {}): string {
    const occurrences = new Map(line.tokens.map((occurrence) => [occurrence.address, occurrence.token]));
    let text = `${line.number} `;
    let quoted = false;
    let remark = false;
    let pendingIf = 0;
    let conditionalDepth = 0;
    for (let i = 0; i < line.body.length; i++) {
        const byte = line.body[i];
        const token = occurrences.get(line.address + 4 + i);
        if (token) {
            if (token.keyword === "THEN" && !/\s$/.test(text)) {
                text += " ";
            }
            text += token.keyword;
            const next = line.body[i + 1];
            const nextToken = occurrences.get(line.address + 5 + i);
            if (
                /[A-Z#$]$/.test(token.keyword) &&
                next !== undefined &&
                (/[A-Za-z0-9"]/.test(String.fromCharCode(next)) ||
                    (nextToken !== undefined && /^[A-Z]/.test(nextToken.keyword)))
            ) {
                text += " ";
            }
            if (token.keyword === "IF") {
                pendingIf++;
            } else if (token.keyword === "THEN" && pendingIf > 0) {
                pendingIf--;
                conditionalDepth++;
            } else if (token.keyword === "REM") {
                remark = true;
            }
        } else if (byte === 0x3a && !quoted && !remark) {
            text += options.multiline ? `:\n${"    ".repeat(1 + conditionalDepth)}` : ":";
        } else if (byte >= 0x20 && byte <= 0x5b) {
            text += String.fromCharCode(byte);
        } else if (byte === 0x5c) {
            text += "£";
        } else if (byte === 0x5d) {
            text += "]";
        } else if (byte === 0x5e) {
            text += "↑";
        } else if (byte === 0x5f) {
            text += "←";
        } else {
            text += `{$${byte.toString(16).padStart(2, "0")}}`;
        }
        if (byte === 0x22 && !remark) {
            quoted = !quoted;
        }
    }
    return text;
}

/** Try to recognize a nonempty, ordered, completely captured BASIC V2 program. */
export function detectC64BasicProgram(bytes: Uint8Array, startAddress: number): C64BasicProgram | undefined {
    let lines: readonly C64BasicLine[];
    try {
        lines = parseC64BasicProgram(bytes, startAddress);
    } catch (error) {
        if (error instanceof C64BasicParseError) {
            return undefined;
        }
        throw error;
    }
    if (
        lines.length === 0 ||
        lines.some((line, index) => line.number > 63999 || (index > 0 && line.number <= lines[index - 1].number))
    ) {
        return undefined;
    }
    return {
        startAddress,
        endAddressExclusive: lines[lines.length - 1].nextAddress + 2,
        lines,
    };
}

/**
 * Parses a contiguous, relocated BASIC V2 program, including its two-byte end marker.
 * The supplied start address must be the actual memory address of bytes[0].
 */
export function parseC64BasicProgram(bytes: Uint8Array, startAddress: number): readonly C64BasicLine[] {
    if (
        !Number.isInteger(startAddress) ||
        startAddress < 0 ||
        startAddress > 0xffff ||
        startAddress + bytes.length > 0x10000
    ) {
        throw new RangeError("BASIC program range must fit in the 16-bit address space.");
    }
    const lines: C64BasicLine[] = [];
    let offset = 0;
    while (true) {
        if (offset + 2 > bytes.length) {
            throw new C64BasicParseError("Truncated BASIC line pointer or end marker.");
        }
        const nextAddress = bytes[offset] | (bytes[offset + 1] << 8);
        if (nextAddress === 0) {
            return lines;
        }
        const nextOffset = nextAddress - startAddress;
        if (
            offset + 5 > bytes.length ||
            nextOffset < offset + 5 ||
            nextOffset + 2 > bytes.length ||
            bytes[nextOffset - 1] !== 0
        ) {
            throw new C64BasicParseError(
                `Invalid or truncated BASIC line at $${(startAddress + offset).toString(16)}.`,
            );
        }
        const body = bytes.slice(offset + 4, nextOffset - 1);
        if (body.includes(0)) {
            throw new C64BasicParseError(
                `Premature BASIC line terminator at $${(startAddress + offset).toString(16)}.`,
            );
        }
        const occurrences: C64BasicTokenOccurrence[] = [];
        const sysReferences: C64BasicSysReference[] = [];
        let quoted = false;
        let data = false;
        for (let i = 0; i < body.length; i++) {
            const byte = body[i];
            if (byte === 0x22) {
                quoted = !quoted;
                continue;
            }
            if (quoted) {
                continue;
            }
            if (data) {
                if (byte === 0x3a) {
                    data = false;
                }
                continue;
            }
            const token = C64BasicTokens.getByCode(byte);
            if (!token) {
                continue;
            }
            const address = startAddress + offset + 4 + i;
            occurrences.push({ address, token });
            if (byte === 0x8f) {
                break;
            }
            if (byte === 0x83) {
                data = true;
            }
            if (byte === 0x9e) {
                let end = i + 1;
                while (body[end] === 0x20) {
                    end++;
                }
                const first = end;
                while (body[end] >= 0x30 && body[end] <= 0x39) {
                    end++;
                }
                const digits = body.slice(first, end);
                while (body[end] === 0x20) {
                    end++;
                }
                const delimiter = end === body.length || body[end] === 0x3a || body[end] === 0x2c;
                const target = Number(String.fromCharCode(...digits));
                if (digits.length > 0 && delimiter && target <= 0xffff) {
                    sysReferences.push({ address, target, resolution: "literal" });
                } else {
                    sysReferences.push({ address, resolution: "unresolved" });
                }
            }
        }
        lines.push({
            address: startAddress + offset,
            nextAddress,
            number: bytes[offset + 2] | (bytes[offset + 3] << 8),
            body,
            tokens: occurrences,
            sysReferences,
        });
        offset = nextOffset;
    }
}
