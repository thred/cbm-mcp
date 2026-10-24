import { Jimp } from "jimp";

export const SPRITE_BYTES = 64;
export const SPRITE_WIDTH = 24;
export const SPRITE_HEIGHT = 21;
export const CHAR_BYTES = 8;

/** Pepto's C64 palette, indexed by VIC-II color number. */
export const C64_PALETTE: readonly number[] = [
    0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f, 0x6f4f25, 0x433900, 0x9a6759,
    0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595,
];

export interface SpriteSheetOptions {
    /** Number of sprites per row of the sheet. */
    perRow: number;
    multicolor: boolean;
    /** Palette indexes: background, sprite color ($d027+n), multicolor 1 ($d025), multicolor 2 ($d026). */
    background: number;
    foreground: number;
    multicolor1: number;
    multicolor2: number;
    scale: number;
}

/** Parse the hex bytes of VICE `mem H` output lines such as `>C:0340  78 a9 34 85  01 a2   X.4`. */
export function parseMemoryDump(text: string): number[] {
    const bytes: number[] = [];

    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*>?(?:[A-Za-z0-9]+:)?[0-9a-fA-F]{4,}((?: {1,2}[0-9a-fA-F]{2})+)/.exec(line);

        if (match) {
            bytes.push(
                ...match[1]
                    .trim()
                    .split(/\s+/)
                    .map((byte) => Number.parseInt(byte, 16)),
            );
        }
    }

    return bytes;
}

export interface FontSheetOptions {
    /** Characters per row of the sheet. */
    perRow: number;
    multicolor: boolean;
    /** Palette indexes: background ($d021), character color, multicolor 1 ($d022), multicolor 2 ($d023). */
    background: number;
    foreground: number;
    multicolor1: number;
    multicolor2: number;
    scale: number;
}

interface TileGeometry {
    tileBytes: number;
    bytesPerLine: number;
    lines: number;
    perRow: number;
    scale: number;
    multicolor: boolean;
    hires: [background: number, foreground: number];
    /** Colors for bit pairs 00, 01, 10, 11. */
    pairs: [number, number, number, number];
}

function renderTileSheet(data: Uint8Array, geometry: TileGeometry) {
    const { tileBytes, bytesPerLine, lines, scale } = geometry;
    const tileWidth = bytesPerLine * 8;
    const count = Math.ceil(data.length / tileBytes);
    const perRow = Math.min(geometry.perRow, count);
    const rows = Math.ceil(count / perRow);
    const width = perRow * tileWidth * scale;
    const height = rows * lines * scale;
    const bitmap = Buffer.alloc(width * height * 4);

    const plot = (x: number, y: number, pixelWidth: number, color: number) => {
        const rgb = C64_PALETTE[color];

        for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < pixelWidth * scale; dx++) {
                const offset = ((y * scale + dy) * width + x * scale + dx) * 4;
                bitmap[offset] = (rgb >> 16) & 0xff;
                bitmap[offset + 1] = (rgb >> 8) & 0xff;
                bitmap[offset + 2] = rgb & 0xff;
                bitmap[offset + 3] = 0xff;
            }
        }
    };

    for (let tile = 0; tile < count; tile++) {
        const originX = (tile % perRow) * tileWidth;
        const originY = Math.floor(tile / perRow) * lines;

        for (let line = 0; line < lines; line++) {
            for (let column = 0; column < bytesPerLine; column++) {
                const byte = data[tile * tileBytes + line * bytesPerLine + column] ?? 0;

                if (geometry.multicolor) {
                    for (let pair = 0; pair < 4; pair++) {
                        const value = (byte >> (6 - pair * 2)) & 3;
                        plot(originX + column * 8 + pair * 2, originY + line, 2, geometry.pairs[value]);
                    }
                } else {
                    for (let bit = 0; bit < 8; bit++) {
                        const set = (byte >> (7 - bit)) & 1;
                        plot(originX + column * 8 + bit, originY + line, 1, geometry.hires[set]);
                    }
                }
            }
        }
    }

    return new Jimp({ data: bitmap, width, height });
}

/** Render consecutive 64-byte sprite blocks into an RGBA bitmap sheet. Sprites are always 24 pixels wide. */
export function renderSpriteSheet(data: Uint8Array, options: SpriteSheetOptions) {
    return renderTileSheet(data, {
        tileBytes: SPRITE_BYTES,
        bytesPerLine: 3,
        lines: SPRITE_HEIGHT,
        perRow: options.perRow,
        scale: options.scale,
        multicolor: options.multicolor,
        hires: [options.background, options.foreground],
        pairs: [options.background, options.multicolor1, options.foreground, options.multicolor2],
    });
}

/** Render consecutive 8-byte characters (8x8 pixels) into an RGBA bitmap sheet. */
export function renderFontSheet(data: Uint8Array, options: FontSheetOptions) {
    return renderTileSheet(data, {
        tileBytes: CHAR_BYTES,
        bytesPerLine: 1,
        lines: 8,
        perRow: options.perRow,
        scale: options.scale,
        multicolor: options.multicolor,
        hires: [options.background, options.foreground],
        pairs: [options.background, options.multicolor1, options.multicolor2, options.foreground],
    });
}
