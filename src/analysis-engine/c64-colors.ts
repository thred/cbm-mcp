export interface C64Color {
    readonly code: number;
    readonly name: string;
}

/** VIC-II color indexes as listed at https://sta.c64.org/cbm64col.html. */
export class C64Colors {
    static readonly BLACK: C64Color = { code: 0, name: "black" };
    static readonly WHITE: C64Color = { code: 1, name: "white" };
    static readonly RED: C64Color = { code: 2, name: "red" };
    static readonly CYAN: C64Color = { code: 3, name: "cyan" };
    static readonly PURPLE: C64Color = { code: 4, name: "purple" };
    static readonly GREEN: C64Color = { code: 5, name: "green" };
    static readonly BLUE: C64Color = { code: 6, name: "blue" };
    static readonly YELLOW: C64Color = { code: 7, name: "yellow" };
    static readonly ORANGE: C64Color = { code: 8, name: "orange" };
    static readonly BROWN: C64Color = { code: 9, name: "brown" };
    static readonly PINK: C64Color = { code: 10, name: "pink" };
    static readonly DARK_GREY: C64Color = { code: 11, name: "dark grey" };
    static readonly GREY: C64Color = { code: 12, name: "grey" };
    static readonly LIGHT_GREEN: C64Color = { code: 13, name: "light green" };
    static readonly LIGHT_BLUE: C64Color = { code: 14, name: "light blue" };
    static readonly LIGHT_GREY: C64Color = { code: 15, name: "light grey" };

    static get all(): readonly C64Color[] {
        return Object.values(C64Colors);
    }

    static getByCode(code: number): C64Color {
        if (!Number.isInteger(code) || code < 0 || code > 15) {
            throw new RangeError("Color code must be an integer from 0 to 15.");
        }
        return C64Colors.all[code];
    }
}
