export type TextEncoding = "ascii" | "petscii" | "screen_codes";

export function encodeCommodoreText(text: unknown, encoding: TextEncoding): number[] {
    if (typeof text !== "string" || text.length < 1 || text.length > 256) {
        throw new Error("text must contain 1-256 printable ASCII characters.");
    }
    return Array.from(text, (character) => {
        let code = character.charCodeAt(0);
        if (code < 32 || code > 126) {
            throw new Error("text must contain only printable ASCII characters.");
        }
        if (encoding === "ascii") {
            return code;
        }
        if (code >= 97 && code <= 122) {
            code -= 32;
        }
        if (code > 93 || code === 92) {
            throw new Error("Unsupported C64 text character; use bytes for graphics or custom glyphs.");
        }
        return encoding === "screen_codes" && code >= 64 ? code - 64 : code;
    });
}
