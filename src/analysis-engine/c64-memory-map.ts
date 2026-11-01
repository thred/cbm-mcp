import { C64BasicRom, type C64BasicRomEntryKind } from "./c64-basic-rom.js";
import { C64KernalFunctions } from "./c64-kernal-functions.js";
import { C64_MEMORY_BIT_DEFINITIONS, type C64MemoryBitField } from "./c64-memory-bits.js";

export type { C64BitAccess, C64BitValue, C64MemoryBitField } from "./c64-memory-bits.js";

export type C64MemoryView = "cpu-port" | "ram" | "basic-rom" | "kernal-rom" | "character-rom" | "io" | "cartridge";

export interface C64MemoryMapEntry {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly view: C64MemoryView;
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly sourceRevision?: number;
    readonly referenceVersion?: string;
    readonly notes?: readonly string[];
    readonly canonicalId?: string;
    readonly kernalFunction?: string;
    readonly kernalFunctionAddress?: number;
    readonly basicRomEntryAddress?: number;
    readonly basicRomEntryKind?: C64BasicRomEntryKind;
    readonly bitFields?: readonly C64MemoryBitField[];
}

export interface C64MemoryBitQuery {
    readonly view?: C64MemoryView;
    readonly bit?: number;
    readonly access?: "read" | "write";
}

export interface C64MemoryBitMatch {
    readonly entry: C64MemoryMapEntry;
    readonly field: C64MemoryBitField;
}

type EntryOptions = Pick<
    C64MemoryMapEntry,
    | "notes"
    | "kernalFunction"
    | "kernalFunctionAddress"
    | "bitFields"
    | "basicRomEntryAddress"
    | "basicRomEntryKind"
    | "sourceRevision"
    | "referenceVersion"
> & { readonly source?: string };

type Region = readonly [start: number, end: number, name: string, description?: string];

const source = "https://sta.c64.org/cbm64mem.html";
const entries: C64MemoryMapEntry[] = [];

function add(
    view: C64MemoryView,
    start: number,
    end: number,
    name: string,
    description = name,
    options: EntryOptions = {},
): void {
    entries.push({
        id: `${view}:${start.toString(16).padStart(4, "0")}-${end.toString(16).padStart(4, "0")}`,
        start,
        end,
        view,
        name,
        description,
        source,
        ...options,
    });
}

function addRegions(view: C64MemoryView, regions: readonly Region[]): void {
    for (const [start, end, name, description] of regions) {
        add(view, start, end, name, description);
    }
}

add("cpu-port", 0x0000, 0x0000, "6510 port direction", "Data-direction register for the 6510 processor port.");

add(
    "cpu-port",
    0x0001,
    0x0001,
    "6510 processor port",
    "Controls memory mapping and cassette signals; effective pin levels also depend on the direction register.",
);

add(
    "ram",
    0x0002,
    0xffff,
    "Underlying RAM",
    "RAM address space; CPU visibility and write destination depend on mapping and attached hardware.",
);

addRegions("ram", [
    [0x0002, 0x0002, "BASIC workspace $02"],
    [0x0003, 0x0004, "Floating-point to integer vector"],
    [0x0005, 0x0006, "Integer to floating-point vector"],
    [0x0007, 0x0008, "BASIC temporary search and operand bytes"],
    [0x0009, 0x0009, "SPC/TAB column"],
    [0x000a, 0x000a, "BASIC load or verify flag"],
    [0x000b, 0x000b, "BASIC token and array scratch"],
    [0x000c, 0x000c, "BASIC array operation flag"],
    [0x000d, 0x000d, "BASIC expression type"],
    [0x000e, 0x000e, "BASIC numeric type"],
    [0x000f, 0x000f, "BASIC quote and garbage collection flags"],
    [0x0010, 0x0010, "BASIC variable-name flag"],
    [0x0011, 0x0011, "GET/INPUT/READ selector"],
    [0x0012, 0x0012, "Trigonometric sign"],
    [0x0013, 0x0013, "BASIC current I/O device"],
    [0x0014, 0x0015, "BASIC line number and address scratch"],
    [0x0016, 0x0016, "Next temporary string descriptor"],
    [0x0017, 0x0018, "Previous temporary string descriptor"],
    [0x0019, 0x0021, "Temporary string descriptor stack"],
    [0x0022, 0x0025, "BASIC temporary workspace"],
    [0x0026, 0x0029, "Arithmetic auxiliary register"],
    [0x002a, 0x002a, "BASIC workspace $2a"],
    [0x002b, 0x002c, "BASIC program start pointer"],
    [0x002d, 0x002e, "BASIC variables start pointer"],
    [0x002f, 0x0030, "BASIC arrays start pointer"],
    [0x0031, 0x0032, "BASIC arrays end pointer"],
    [0x0033, 0x0034, "BASIC string space pointer"],
    [0x0035, 0x0036, "Current string allocation pointer"],
    [0x0037, 0x0038, "BASIC memory limit pointer"],
    [0x0039, 0x003a, "Current BASIC line number"],
    [0x003b, 0x003c, "CONT line number"],
    [0x003d, 0x003e, "CONT instruction pointer"],
    [0x003f, 0x0040, "DATA line number"],
    [0x0041, 0x0042, "DATA item pointer"],
    [0x0043, 0x0044, "BASIC input pointer"],
    [0x0045, 0x0046, "Current BASIC variable name"],
    [0x0047, 0x0048, "BASIC variable value pointer"],
    [0x0049, 0x004a, "LET variable pointer"],
    [0x004b, 0x004c, "Saved BASIC instruction pointer"],
    [0x004d, 0x004d, "BASIC comparison operator flags"],
    [0x004e, 0x004f, "BASIC FN pointer"],
    [0x0050, 0x0051, "String allocation pointer"],
    [0x0052, 0x0052, "BASIC workspace $52"],
    [0x0053, 0x0053, "String garbage collection step"],
    [0x0054, 0x0056, "BASIC function jump"],
    [0x0057, 0x005b, "Arithmetic register 3"],
    [0x005c, 0x0060, "Arithmetic register 4"],
    [0x0061, 0x0065, "Floating-point accumulator FAC"],
    [0x0066, 0x0066, "FAC sign"],
    [0x0067, 0x0067, "Polynomial degree count"],
    [0x0068, 0x0068, "Arithmetic scratch"],
    [0x0069, 0x006d, "Floating-point argument ARG"],
    [0x006e, 0x006e, "ARG sign"],
    [0x006f, 0x0070, "String comparison pointer"],
    [0x0071, 0x0072, "Array operation pointer"],
    [
        0x0073,
        0x008a,
        "CHRGET routine",
        "RAM-resident BASIC character-fetch routine; its text pointer is at $007a-$007b.",
    ],
    [0x007a, 0x007b, "BASIC text pointer"],
    [0x008b, 0x008f, "Previous RND value"],
    [0x0090, 0x0090, "KERNAL I/O status", "Device status exposed as BASIC ST."],
    [0x0091, 0x0091, "RUN/STOP indicator"],
    [0x0092, 0x0092, "Tape input scratch $92"],
    [0x0093, 0x0093, "KERNAL load or verify flag"],
    [0x0094, 0x0095, "Serial output buffer and status"],
    [0x0096, 0x0096, "Tape I/O scratch $96"],
    [0x0097, 0x0097, "RS-232 saved Y register"],
    [0x0098, 0x0098, "Open file count"],
    [0x0099, 0x0099, "Current input device"],
    [0x009a, 0x009a, "Current output device"],
    [0x009b, 0x009c, "Tape I/O scratch $9b-$9c"],
    [0x009d, 0x009d, "System message control"],
    [0x009e, 0x009f, "Tape and RS-232 output scratch"],
    [0x00a0, 0x00a2, "Software clock", "Software time-of-day counter exposed as BASIC TI."],
    [0x00a3, 0x00a6, "Serial input/output scratch"],
    [0x00a7, 0x00ab, "RS-232 receive scratch"],
    [0x00ac, 0x00ad, "Serial SAVE start pointer"],
    [0x00ae, 0x00af, "Serial LOAD pointer"],
    [0x00b0, 0x00b1, "KERNAL workspace $b0-$b1"],
    [0x00b2, 0x00b3, "Tape buffer pointer"],
    [0x00b4, 0x00b6, "RS-232 transmit scratch"],
    [0x00b7, 0x00b7, "File name length"],
    [0x00b8, 0x00b8, "Logical file number"],
    [0x00b9, 0x00b9, "File secondary address"],
    [0x00ba, 0x00ba, "File device number"],
    [0x00bb, 0x00bc, "File name pointer"],
    [0x00bd, 0x00c0, "Tape and RS-232 I/O scratch"],
    [0x00c1, 0x00c2, "Tape and serial transfer start pointer"],
    [0x00c3, 0x00c4, "LOAD secondary-address-zero pointer"],
    [0x00c5, 0x00c5, "Previous key matrix code"],
    [0x00c6, 0x00c6, "Keyboard buffer length"],
    [0x00c7, 0x00c7, "Screen reverse mode"],
    [0x00c8, 0x00c8, "Screen input line length"],
    [0x00c9, 0x00ca, "Screen input cursor position"],
    [0x00cb, 0x00cb, "Current key matrix code"],
    [0x00cc, 0x00cf, "Cursor blink and character state"],
    [0x00d0, 0x00d0, "Screen input end-of-line flag"],
    [0x00d1, 0x00d2, "Current screen line pointer"],
    [0x00d3, 0x00d3, "Cursor column"],
    [0x00d4, 0x00d4, "Screen quote mode"],
    [0x00d5, 0x00d5, "Screen line length"],
    [0x00d6, 0x00d6, "Cursor row"],
    [0x00d7, 0x00d7, "Screen I/O PETSCII character"],
    [0x00d8, 0x00d8, "Screen insertion count"],
    [0x00d9, 0x00f1, "Screen line pointer high bytes"],
    [0x00f2, 0x00f2, "Screen scrolling scratch"],
    [0x00f3, 0x00f4, "Current color RAM line pointer"],
    [0x00f5, 0x00f6, "Keyboard translation table pointer"],
    [0x00f7, 0x00f8, "RS-232 input buffer pointer"],
    [0x00f9, 0x00fa, "RS-232 output buffer pointer"],
    [0x00fb, 0x00fe, "Zero-page user workspace", "Conventionally available workspace; a program may already use it."],
    [0x00ff, 0x010a, "Floating-point conversion buffer"],
    [0x0100, 0x013d, "Tape error pointer buffer"],
    [0x0100, 0x01ff, "CPU stack", "The 6510 hardware stack and BASIC stack data occupy page one."],
    [0x0200, 0x0258, "BASIC input buffer"],
    [0x0259, 0x0262, "Logical file number table"],
    [0x0263, 0x026c, "File device number table"],
    [0x026d, 0x0276, "File secondary address table"],
    [0x0277, 0x0280, "Keyboard buffer"],
    [0x0281, 0x0282, "Tested BASIC memory start"],
    [0x0283, 0x0284, "Tested BASIC memory limit"],
    [0x0285, 0x0285, "Serial timeout workspace"],
    [0x0286, 0x0286, "Current text color"],
    [0x0287, 0x0287, "Color under cursor"],
    [0x0288, 0x0288, "Screen editor base high byte"],
    [0x0289, 0x0289, "Keyboard buffer capacity"],
    [0x028a, 0x028c, "Keyboard repeat state"],
    [0x028d, 0x028e, "Current and previous shift-key state"],
    [0x028f, 0x0290, "Keyboard translation routine vector"],
    [0x0291, 0x0292, "Keyboard and scrolling flags"],
    [0x0293, 0x0294, "RS-232 control and command"],
    [0x0295, 0x0296, "RS-232 output timer"],
    [0x0297, 0x0298, "RS-232 status and bit count"],
    [0x0299, 0x029a, "RS-232 input timer"],
    [0x029b, 0x029e, "RS-232 buffer offsets"],
    [0x029f, 0x02a4, "Tape and RS-232 saved interrupt state"],
    [0x02a5, 0x02a5, "Screen scrolling line"],
    [0x02a6, 0x02a6, "PAL/NTSC flag"],
    [0x02a7, 0x02ff, "System workspace $02a7-$02ff"],
    [0x0300, 0x0301, "BASIC warm-start vector"],
    [0x0302, 0x0303, "BASIC idle-loop vector"],
    [0x0304, 0x0305, "BASIC tokenizer vector"],
    [0x0306, 0x0307, "BASIC token decoder vector"],
    [0x0308, 0x0309, "BASIC instruction execution vector"],
    [0x030a, 0x030b, "BASIC expression evaluation vector"],
    [0x030c, 0x030f, "SYS register values"],
    [0x0310, 0x0312, "USR function jump"],
    [0x0313, 0x0313, "System workspace $0313"],
    [0x0314, 0x0315, "KERNAL IRQ vector"],
    [0x0316, 0x0317, "KERNAL BRK vector"],
    [0x0318, 0x0319, "KERNAL NMI vector"],
    [0x032e, 0x032f, "System workspace $032e-$032f"],
    [0x0334, 0x033b, "System workspace $0334-$033b"],
    [0x033c, 0x03fb, "Cassette buffer"],
    [0x03fc, 0x03ff, "System workspace $03fc-$03ff"],
    [0x0400, 0x07e7, "Default screen memory", "Default screen location only; actual screen placement is configurable."],
    [0x07e8, 0x07f7, "Default screen-page workspace"],
    [
        0x07f8,
        0x07ff,
        "Default sprite pointers",
        "Default sprite pointer location only; pointers follow the selected VIC screen base.",
    ],
    [0x0800, 0x0800, "Byte before default BASIC program"],
    [0x0801, 0x9fff, "Default BASIC workspace", "Default BASIC area; pointers and program use can change."],
    [0xc000, 0xcfff, "Upper RAM"],
]);

for (const routine of C64KernalFunctions.all) {
    const address = routine.vectorAddress;

    if (address === undefined) {
        continue;
    }

    const target = routine.defaultVectorTargetAddress ?? routine.defaultImplementationAddress;

    add(
        "ram",
        address,
        address + 1,
        `${routine.name} vector`,
        `RAM vector for ${routine.name}; the standard default target is $${target.toString(16)}.`,
        { kernalFunction: routine.name, kernalFunctionAddress: routine.address },
    );
}

add(
    "cartridge",
    0x8000,
    0x9fff,
    "Cartridge ROM",
    "Optional cartridge mapping; GAME/EXROM and cartridge hardware determine visibility.",
);

add(
    "basic-rom",
    0xa000,
    0xbfff,
    "BASIC ROM",
    "Standard BASIC ROM; may be replaced or hidden by RAM or cartridge mapping.",
);

add(
    "kernal-rom",
    0xe000,
    0xffff,
    "KERNAL ROM",
    "Standard KERNAL ROM; may be replaced or hidden by RAM or cartridge mapping.",
);

for (const item of C64BasicRom.all) {
    add(item.view, item.address, item.endAddress ?? item.address, `BASIC ${item.name}`, item.description, {
        source: item.source,
        sourceRevision: item.sourceRevision,
        referenceVersion: item.version,
        basicRomEntryAddress: item.address,
        basicRomEntryKind: item.kind,
    });
}

addRegions("character-rom", [
    [0xd000, 0xdfff, "Character ROM", "CPU character-ROM view; VIC-II accesses its own character-ROM windows."],
    [0xd000, 0xd7ff, "Uppercase and graphics character set"],
    [0xd800, 0xdfff, "Lowercase and uppercase character set"],
]);

for (const entry of C64KernalFunctions.all) {
    add("kernal-rom", entry.address, entry.address + 2, `KERNAL ${entry.name}`, entry.description, {
        kernalFunction: entry.name,
        kernalFunctionAddress: entry.address,
    });
}

for (const view of ["ram", "kernal-rom"] as const) {
    addRegions(view, [
        [0xfffa, 0xfffb, "Hardware NMI vector"],
        [0xfffc, 0xfffd, "Hardware reset vector"],
        [0xfffe, 0xffff, "Hardware IRQ/BRK vector"],
    ]);
}

add("io", 0xd000, 0xd3ff, "VIC-II", "VIC-II registers; repeated every $40 bytes.");

add("io", 0xd400, 0xd7ff, "SID", "SID registers; repeated every $20 bytes.");

add("io", 0xd800, 0xdbe7, "Color RAM", "Screen color memory; only the low four bits are stored.");

add(
    "io",
    0xdbe8,
    0xdbff,
    "Color RAM tail",
    "Extra color RAM locations beyond the default 1000-cell screen; only the low four bits are stored.",
);

add("io", 0xdc00, 0xdcff, "CIA 1", "CIA 1 registers; repeated every $10 bytes.");

add("io", 0xdd00, 0xddff, "CIA 2", "CIA 2 registers; repeated every $10 bytes.");

add("io", 0xde00, 0xdeff, "Expansion I/O 1", "Behavior depends on attached expansion hardware.");

add("io", 0xdf00, 0xdfff, "Expansion I/O 2", "Behavior depends on attached expansion hardware.");

for (let sprite = 0; sprite < 8; sprite++) {
    add(
        "io",
        0xd000 + sprite * 2,
        0xd000 + sprite * 2,
        `Sprite ${sprite} X`,
        "Low eight bits of sprite horizontal position.",
    );

    add("io", 0xd001 + sprite * 2, 0xd001 + sprite * 2, `Sprite ${sprite} Y`, "Sprite vertical position.");

    add("io", 0xd027 + sprite, 0xd027 + sprite, `Sprite ${sprite} color`, "Sprite color in the low four bits.");
}

addRegions("io", [
    [0xd010, 0xd010, "Sprite X high bits"],
    [
        0xd011,
        0xd011,
        "VIC screen control 1",
        "Screen control and raster high bit; raster read and IRQ-compare write differ.",
    ],
    [0xd012, 0xd012, "Raster line", "Reads return the current raster line; writes set the IRQ comparison line."],
    [0xd013, 0xd013, "Light pen X"],
    [0xd014, 0xd014, "Light pen Y"],
    [0xd015, 0xd015, "Sprite enable"],
    [0xd016, 0xd016, "VIC screen control 2"],
    [0xd017, 0xd017, "Sprite vertical expansion"],
    [0xd018, 0xd018, "VIC memory layout", "Selects screen and character or bitmap offsets in the current VIC bank."],
    [0xd019, 0xd019, "VIC interrupt status", "Write one bits to acknowledge corresponding interrupt sources."],
    [0xd01a, 0xd01a, "VIC interrupt enable"],
    [0xd01b, 0xd01b, "Sprite priority"],
    [0xd01c, 0xd01c, "Sprite multicolor mode"],
    [0xd01d, 0xd01d, "Sprite horizontal expansion"],
    [0xd01e, 0xd01e, "Sprite-sprite collision", "Reading may clear collision state."],
    [0xd01f, 0xd01f, "Sprite-background collision", "Reading may clear collision state."],
    [0xd020, 0xd020, "Border color"],
    [0xd021, 0xd021, "Background color 0"],
    [0xd022, 0xd022, "Background color 1"],
    [0xd023, 0xd023, "Background color 2"],
    [0xd024, 0xd024, "Background color 3"],
    [0xd025, 0xd025, "Sprite shared color 0"],
    [0xd026, 0xd026, "Sprite shared color 1"],
    [0xd02f, 0xd03f, "Unused VIC register offsets"],
]);

for (let voice = 0; voice < 3; voice++) {
    const base = 0xd400 + voice * 7;
    const label = `SID voice ${voice + 1}`;
    addRegions("io", [
        [base, base + 1, `${label} frequency`],
        [base + 2, base + 3, `${label} pulse width`],
        [base + 4, base + 4, `${label} control`],
        [base + 5, base + 5, `${label} attack/decay`],
        [base + 6, base + 6, `${label} sustain/release`],
    ]);
}

addRegions("io", [
    [0xd415, 0xd416, "SID filter cutoff"],
    [0xd417, 0xd417, "SID filter routing and resonance"],
    [0xd418, 0xd418, "SID volume and filter mode"],
    [0xd419, 0xd419, "SID paddle X"],
    [0xd41a, 0xd41a, "SID paddle Y"],
    [0xd41b, 0xd41b, "SID voice 3 oscillator output"],
    [0xd41c, 0xd41c, "SID voice 3 envelope output"],
    [0xd41d, 0xd41f, "Unused SID register offsets"],
]);

for (const [base, cia] of [
    [0xdc00, 1],
    [0xdd00, 2],
] as const) {
    addRegions("io", [
        [
            base,
            base,
            `CIA ${cia} port A`,
            cia === 1 ? "Keyboard columns and joystick 2." : "VIC bank selection and serial bus signals.",
        ],
        [
            base + 1,
            base + 1,
            `CIA ${cia} port B`,
            cia === 1 ? "Keyboard rows and joystick 1." : "User port and RS-232 signals.",
        ],
        [base + 2, base + 2, `CIA ${cia} port A direction`],
        [base + 3, base + 3, `CIA ${cia} port B direction`],
        [base + 4, base + 5, `CIA ${cia} timer A`, "Read the counter; write the timer latch."],
        [base + 6, base + 7, `CIA ${cia} timer B`, "Read the counter; write the timer latch."],
        [base + 8, base + 8, `CIA ${cia} clock tenths`],
        [base + 9, base + 9, `CIA ${cia} clock seconds`],
        [base + 10, base + 10, `CIA ${cia} clock minutes`],
        [base + 11, base + 11, `CIA ${cia} clock hours`],
        [base + 12, base + 12, `CIA ${cia} serial shift register`],
        [
            base + 13,
            base + 13,
            `CIA ${cia} interrupt control`,
            "Read status acknowledges pending interrupts; writes change the interrupt mask.",
        ],
        [base + 14, base + 14, `CIA ${cia} timer A control`],
        [base + 15, base + 15, `CIA ${cia} timer B control`],
    ]);
}

for (const definition of C64_MEMORY_BIT_DEFINITIONS) {
    const index = entries.findIndex(
        (entry) => entry.view === definition.view && entry.start === definition.start && entry.end === definition.end,
    );

    if (index === -1) {
        add(definition.view, definition.start, definition.end, definition.name, definition.name, {
            bitFields: definition.fields,
        });
    } else {
        entries[index] = { ...entries[index], bitFields: definition.fields };
    }
}

for (const [base, period, limit] of [
    [0xd000, 0x40, 0xd400],
    [0xd400, 0x20, 0xd800],
    [0xdc00, 0x10, 0xdd00],
    [0xdd00, 0x10, 0xde00],
] as const) {
    const originals = entries.filter(
        (entry) => entry.view === "io" && entry.start >= base && entry.end < base + period,
    );

    for (let offset = period; base + offset < limit; offset += period) {
        for (const entry of originals) {
            const start = entry.start + offset;
            const end = entry.end + offset;
            entries.push({
                ...entry,
                id: `io:${start.toString(16).padStart(4, "0")}-${end.toString(16).padStart(4, "0")}`,
                start,
                end,
                canonicalId: entry.id,
            });
        }
    }
}

function checkAddress(address: number): void {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
        throw new RangeError("Address must be an integer from 0 to 65535.");
    }
}

function checkView(view: C64MemoryView | undefined): void {
    if (
        view !== undefined &&
        !["cpu-port", "ram", "basic-rom", "kernal-rom", "character-rom", "io", "cartridge"].includes(view)
    ) {
        throw new Error(`Unknown C64 memory view: ${view}`);
    }
}

/** Descriptive reference data, not a resolver for current CPU or VIC mapping. */
export class C64MemoryMap {
    static get all(): readonly C64MemoryMapEntry[] {
        return entries.slice();
    }

    static at(address: number, view?: C64MemoryView): readonly C64MemoryMapEntry[] {
        return C64MemoryMap.overlapping(address, address, view);
    }

    static overlapping(start: number, end: number, view?: C64MemoryView): readonly C64MemoryMapEntry[] {
        checkAddress(start);

        checkAddress(end);

        checkView(view);

        if (end < start) {
            throw new RangeError("End address must not precede start address.");
        }
        return entries.filter(
            (entry) => entry.start <= end && entry.end >= start && (view === undefined || entry.view === view),
        );
    }

    static bitsAt(address: number, query: C64MemoryBitQuery = {}): readonly C64MemoryBitMatch[] {
        const { view, bit, access } = query;
        if (bit !== undefined && (!Number.isInteger(bit) || bit < 0 || bit > 7)) {
            throw new RangeError("Bit must be an integer from 0 to 7.");
        }
        if (access !== undefined && access !== "read" && access !== "write") {
            throw new Error(`Unknown bit access: ${access}`);
        }
        return C64MemoryMap.at(address, view).flatMap((entry) =>
            (entry.bitFields ?? [])
                .filter(
                    (field) =>
                        (bit === undefined || (field.mask & (1 << bit)) !== 0) &&
                        (access === undefined ||
                            field.access === "unspecified" ||
                            field.access === "read-write" ||
                            field.access === access),
                )
                .map((field) => ({ entry, field })),
        );
    }

    static search(text: string, view?: C64MemoryView): readonly C64MemoryMapEntry[] {
        const query = text.trim().toLowerCase();

        if (!query) {
            throw new Error("Search text must not be empty.");
        }
        checkView(view);

        return entries.filter(
            (entry) =>
                (view === undefined || entry.view === view) &&
                [
                    entry.name,
                    entry.description,
                    entry.kernalFunction ?? "",
                    ...(entry.notes ?? []),
                    ...(entry.bitFields ?? []).flatMap((field) => [
                        field.name,
                        field.description,
                        field.condition ?? "",
                        ...(field.values ?? []).map((value) => value.description),
                    ]),
                ].some((value) => value.toLowerCase().includes(query)),
        );
    }
}
