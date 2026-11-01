import type { C64MemoryView } from "./c64-memory-map.js";
import { C64Colors } from "./c64-colors.js";

export type C64BitAccess = "read" | "write" | "read-write" | "unspecified";

export interface C64BitValue {
    /** Unshifted field value. */
    readonly value: number;
    readonly description: string;
}

export interface C64MemoryBitField {
    readonly name: string;
    readonly mask: number;
    readonly shift: number;
    readonly description: string;
    readonly access: C64BitAccess;
    readonly values?: readonly C64BitValue[];
    readonly condition?: string;
    readonly source?: string;
}

export interface C64MemoryBitDefinition {
    readonly view: C64MemoryView;
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly fields: readonly C64MemoryBitField[];
}

type FieldOptions = Pick<C64MemoryBitField, "access" | "values" | "condition" | "source">;

function field(
    low: number,
    high: number,
    name: string,
    description: string,
    options: Partial<FieldOptions> = {},
): C64MemoryBitField {
    return {
        name,
        mask: ((1 << (high - low + 1)) - 1) << low,
        shift: low,
        description,
        access: options.access ?? "unspecified",
        ...options,
    };
}

function bit(
    position: number,
    name: string,
    description: string,
    options: Partial<FieldOptions> = {},
): C64MemoryBitField {
    return field(position, position, name, description, options);
}

function values(...descriptions: string[]): readonly C64BitValue[] {
    return descriptions.map((description, value) => ({ value, description }));
}

const definitions: C64MemoryBitDefinition[] = [];

function define(
    view: C64MemoryView,
    start: number,
    name: string,
    fields: readonly C64MemoryBitField[],
    end = start,
): void {
    definitions.push({ view, start, end, name, fields });
}

define("cpu-port", 0x0000, "6510 port direction", [
    field(0, 5, "Port data direction", "Each bit selects input (0) or output (1) for the corresponding 6510 port pin."),
]);
define("cpu-port", 0x0001, "6510 processor port", [
    field(
        0,
        2,
        "CPU memory mapping",
        "Effective LORAM/HIRAM/CHAREN pin levels select the read mapping at $a000, $d000 and $e000.",
        {
            condition: "Standard C64 without cartridge or expansion remapping; writes under ROM normally reach RAM.",
            values: values(
                "RAM / RAM / RAM",
                "RAM / character ROM / RAM",
                "RAM / character ROM / KERNAL ROM",
                "BASIC ROM / character ROM / KERNAL ROM",
                "RAM / RAM / RAM",
                "RAM / I/O / RAM",
                "RAM / I/O / KERNAL ROM",
                "BASIC ROM / I/O / KERNAL ROM",
            ),
        },
    ),
    bit(0, "LORAM", "With HIRAM, controls BASIC and I/O/character-ROM mapping; use effective pin levels."),
    bit(
        1,
        "HIRAM",
        "Controls KERNAL visibility and participates in BASIC and I/O mapping; cartridge signals can override it.",
    ),
    bit(2, "CHAREN", "Selects I/O rather than character ROM when LORAM or HIRAM enables the $d000 window."),
    bit(3, "Cassette write", "Cassette write output signal."),
    bit(4, "Cassette sense", "Cassette button sense: 0 means at least one transport button is pressed."),
    bit(5, "Cassette motor", "Cassette motor control: 0 on, 1 off."),
]);

define("ram", 0x000e, "BASIC numeric type", [bit(7, "Integer type", "0: floating point; 1: integer.")]);
define("ram", 0x000f, "BASIC quote and garbage collection flags", [
    bit(6, "Tokenization quote mode", "0: normal tokenization; 1: inside a quoted string.", {
        condition: "During tokenization",
    }),
    bit(7, "Garbage collection attempted", "Set after garbage collection has been attempted.", {
        condition: "During string allocation",
    }),
]);
for (const [address, part] of [
    [0x0045, "first"],
    [0x0046, "second"],
] as const) {
    define("ram", address, `Variable name ${part} byte`, [
        field(
            0,
            6,
            "Variable name character",
            `The ${part} name character; a zero second character means a one-character name.`,
        ),
        bit(
            7,
            "Variable type bit",
            "Together with bit 7 of the other name byte, identifies floating-point, string, FN or integer type.",
            {
                condition: "Combined $0045/$0046 high bits: 00 float, 01 string, 10 FN, 11 integer.",
            },
        ),
    ]);
}
define("ram", 0x004d, "BASIC comparison operator flags", [
    bit(1, "Greater-than operator", "Set when the expression contains >."),
    bit(2, "Equal operator", "Set when the expression contains =."),
    bit(3, "Less-than operator", "Set when the expression contains <."),
]);
for (const [address, name] of [
    [0x0066, "FAC sign"],
    [0x006e, "ARG sign"],
] as const) {
    define("ram", address, name, [bit(7, "Sign", "0: positive; 1: negative.")]);
}
define("ram", 0x0090, "KERNAL I/O status", [
    bit(0, "Serial timeout direction", "0: input; 1: output.", { condition: "Serial bus" }),
    bit(1, "Serial timeout", "Set when a timeout occurs.", { condition: "Serial bus" }),
    bit(2, "Tape block too short", "Set for a tape block shorter than 192 bytes.", { condition: "Datasette" }),
    bit(3, "Tape block too long", "Set for a tape block longer than 192 bytes.", { condition: "Datasette" }),
    bit(4, "Verify error", "Set on a verify mismatch; tape input can also report uncorrected read errors.", {
        condition: "Serial bus or datasette",
    }),
    bit(5, "Tape checksum error", "Set on a checksum error.", { condition: "Datasette" }),
    bit(6, "End of file", "Set when end of file is reached; tape semantics depend on file type.", {
        condition: "Serial bus or datasette",
    }),
    bit(7, "Device absent", "Set if the serial device is absent.", { condition: "Serial bus" }),
]);
define("ram", 0x0094, "Serial output cache status", [
    bit(7, "Output cache dirty", "Set when the cached byte must be sent."),
]);
define("ram", 0x009d, "System message control", [
    bit(6, "I/O errors", "1 enables I/O error messages."),
    bit(7, "System messages", "1 enables system messages."),
]);
define("ram", 0x00a3, "Serial EOI flag", [
    bit(7, "EOI delay", "1 requests an end-of-information delay before sending."),
]);
define("ram", 0x00b4, "RS-232 transmit bit counter", [
    field(0, 6, "Bit count", "Number of bits remaining in the RS-232 output operation."),
    bit(7, "Stop bit", "0: data bit; 1: stop bit."),
]);
define("ram", 0x00b5, "RS-232 transmit bit buffer", [bit(2, "Transmit bit", "Buffered bit for RS-232 output.")]);
define("ram", 0x028a, "Keyboard repeat state", [
    field(6, 7, "Key repeat mode", "00: selected keys repeat; 01: none repeat; 1x: all repeat."),
]);
for (const [address, when] of [
    [0x028d, "currently"],
    [0x028e, "at the previous scan"],
] as const) {
    define("ram", address, "Shift-key state", [
        bit(0, "Shift", `Shift or shift lock active ${when}.`),
        bit(1, "Commodore key", `Commodore key active ${when}.`),
        bit(2, "Control key", `Control key active ${when}.`),
    ]);
}
define("ram", 0x0291, "Commodore-Shift control", [
    bit(7, "Character-set switch disabled", "1 disables switching character sets with Commodore-Shift."),
]);
define("ram", 0x0293, "RS-232 control", [
    field(0, 3, "Baud rate", "Baud-rate selection; 0 uses a user-specified timer.", {
        values: values(
            "user specified",
            "50",
            "75",
            "110",
            "150",
            "300",
            "600",
            "1200",
            "2400",
            "1800",
            "2400",
            "3600",
            "4800",
            "7200",
            "9600",
            "19200",
        ),
    }),
    field(5, 6, "Data bits", "Number of data bits per character.", {
        values: values("8 bits", "7 bits", "6 bits", "5 bits"),
    }),
    bit(7, "Stop bits", "0: one stop bit; 1: two stop bits."),
]);
define("ram", 0x0294, "RS-232 command", [
    bit(0, "Handshake mode", "0: three-line mode; 1: extended-line mode."),
    bit(4, "Duplex mode", "0: full duplex; 1: half duplex."),
    field(5, 7, "Parity", "Even field values disable parity; 1: odd, 3: even, 5: mark, 7: space."),
]);
define("ram", 0x0297, "RS-232 status", [
    bit(0, "Parity error", "Set on parity error."),
    bit(1, "Framing error", "Set on framing error."),
    bit(2, "Receive buffer overrun", "Set when incoming data cannot be stored before the buffer is read."),
    bit(3, "Receive buffer empty", "Set when the input buffer is empty."),
    bit(4, "CTS unavailable", "0: clear to send; 1: not ready."),
    bit(6, "DSR unavailable", "0: data set ready; 1: not ready."),
    bit(7, "Carrier lost", "Set when carrier loss is detected."),
]);

function spriteBits(
    name: string,
    description: (sprite: number) => string,
    access: C64BitAccess = "unspecified",
): C64MemoryBitField[] {
    return Array.from({ length: 8 }, (_, sprite) => bit(sprite, `${name} ${sprite}`, description(sprite), { access }));
}

for (let sprite = 0; sprite < 8; sprite++) {
    define("io", 0xd000 + sprite * 2, `Sprite ${sprite} X`, [
        field(0, 7, "Sprite X low byte", `Low eight bits of sprite ${sprite} horizontal position.`),
    ]);
    define("io", 0xd001 + sprite * 2, `Sprite ${sprite} Y`, [
        field(0, 7, "Sprite Y position", `Vertical position of sprite ${sprite}.`),
    ]);
}
define(
    "io",
    0xd010,
    "Sprite X high bits",
    spriteBits("Sprite X high bit", (n) => `Bit 8 of sprite ${n} horizontal position.`),
);
define("io", 0xd011, "VIC screen control 1", [
    field(0, 2, "Vertical scroll", "Vertical fine-scroll offset."),
    bit(3, "Screen height", "0: 24 rows; 1: 25 rows."),
    bit(4, "Display enable", "0: blank screen; 1: display enabled."),
    bit(5, "Bitmap mode", "0: text; 1: bitmap."),
    bit(6, "Extended background mode", "1 enables extended background color mode."),
    bit(7, "Raster high bit", "Bit 8 of the current raster line.", { access: "read" }),
    bit(7, "Raster IRQ high bit", "Bit 8 of the raster IRQ compare value.", { access: "write" }),
]);
define("io", 0xd012, "Raster line", [
    field(0, 7, "Raster low byte", "Low byte of the current raster line.", { access: "read" }),
    field(0, 7, "Raster IRQ low byte", "Low byte of the raster IRQ compare value.", { access: "write" }),
]);
define("io", 0xd013, "Light pen X", [
    field(0, 7, "Light pen X position", "Horizontal position bits 1-8; bit 0 of the position is not stored.", {
        access: "read",
    }),
]);
define("io", 0xd014, "Light pen Y", [
    field(0, 7, "Light pen Y position", "Light pen vertical position.", { access: "read" }),
]);
define(
    "io",
    0xd015,
    "Sprite enable",
    spriteBits("Sprite enable", (n) => `1 enables sprite ${n}.`),
);
define("io", 0xd016, "VIC screen control 2", [
    field(0, 2, "Horizontal scroll", "Horizontal fine-scroll offset."),
    bit(3, "Screen width", "0: 38 columns; 1: 40 columns."),
    bit(4, "Multicolor mode", "1 enables multicolor mode."),
]);
define(
    "io",
    0xd017,
    "Sprite vertical expansion",
    spriteBits("Sprite vertical expansion", (n) => `1 doubles sprite ${n} height.`),
);
define("io", 0xd018, "VIC memory layout", [
    field(
        1,
        3,
        "Character memory offset",
        "Character-set base within the VIC bank is the field value times $0800; character ROM can overlay it.",
        { condition: "Text mode" },
    ),
    bit(3, "Bitmap memory offset", "0: bank offset $0000; 1: bank offset $2000.", { condition: "Bitmap mode" }),
    field(4, 7, "Screen memory offset", "Screen base within the VIC bank is the field value times $0400."),
]);
const vicInterrupts = ["Raster", "Sprite-background collision", "Sprite-sprite collision", "Light pen"];
define("io", 0xd019, "VIC interrupt status", [
    ...vicInterrupts.map((name, position) =>
        bit(position, `${name} interrupt pending`, "1 indicates a pending source.", { access: "read" }),
    ),
    bit(7, "VIC IRQ asserted", "1 indicates an enabled pending interrupt.", { access: "read" }),
    ...vicInterrupts.map((name, position) =>
        bit(position, `${name} interrupt acknowledge`, "Write 1 to acknowledge this source.", { access: "write" }),
    ),
]);
define(
    "io",
    0xd01a,
    "VIC interrupt enable",
    vicInterrupts.map((name, position) =>
        bit(position, `${name} interrupt enable`, "1 enables this interrupt source."),
    ),
);
define(
    "io",
    0xd01b,
    "Sprite priority",
    spriteBits("Sprite priority", (n) => `0: sprite ${n} in front; 1: behind foreground graphics.`),
);
define(
    "io",
    0xd01c,
    "Sprite multicolor mode",
    spriteBits("Sprite multicolor", (n) => `1 enables multicolor for sprite ${n}.`),
);
define(
    "io",
    0xd01d,
    "Sprite horizontal expansion",
    spriteBits("Sprite horizontal expansion", (n) => `1 doubles sprite ${n} width.`),
);
define(
    "io",
    0xd01e,
    "Sprite-sprite collision",
    spriteBits(
        "Sprite collision",
        (n) => `1 indicates sprite ${n} collided with another sprite; reading clears the collision latch.`,
        "read",
    ),
);
define(
    "io",
    0xd01f,
    "Sprite-background collision",
    spriteBits(
        "Sprite-background collision",
        (n) => `1 indicates sprite ${n} collided with foreground graphics; reading clears the collision latch.`,
        "read",
    ),
);
const colorValues = C64Colors.all.map((color) => ({ value: color.code, description: color.name }));
for (let address = 0xd020; address <= 0xd02e; address++) {
    define("io", address, "VIC color", [
        field(0, 3, "Color index", "Four-bit VIC-II color code from 0 to 15.", { values: colorValues }),
    ]);
}
define(
    "io",
    0xd800,
    "Color RAM",
    [
        field(0, 3, "Color index", "Only the low nibble is stored; upper read bits are not stored color.", {
            values: colorValues,
        }),
    ],
    0xdbe7,
);
define(
    "io",
    0xdbe8,
    "Color RAM tail",
    [field(0, 3, "Color index", "Only the low nibble is stored.", { values: colorValues })],
    0xdbff,
);

const sidAttackTimes = values(
    "2 ms",
    "8 ms",
    "16 ms",
    "24 ms",
    "38 ms",
    "56 ms",
    "68 ms",
    "80 ms",
    "100 ms",
    "250 ms",
    "500 ms",
    "800 ms",
    "1 s",
    "3 s",
    "5 s",
    "8 s",
);
const sidDecayReleaseTimes = values(
    "6 ms",
    "24 ms",
    "48 ms",
    "72 ms",
    "114 ms",
    "168 ms",
    "204 ms",
    "240 ms",
    "300 ms",
    "750 ms",
    "1.5 s",
    "2.4 s",
    "3 s",
    "9 s",
    "15 s",
    "24 s",
);
for (let voice = 0; voice < 3; voice++) {
    const base = 0xd400 + voice * 7;
    define("io", base + 3, `SID voice ${voice + 1} pulse width high`, [
        field(0, 3, "Pulse width high bits", "Upper four bits of the 12-bit pulse width.", { access: "write" }),
    ]);
    define("io", base + 4, `SID voice ${voice + 1} control`, [
        bit(0, "Gate", "0: release; 1: attack/decay/sustain.", { access: "write" }),
        bit(1, "Oscillator synchronization", "1 enables synchronization.", { access: "write" }),
        bit(2, "Ring modulation", "1 enables ring modulation.", { access: "write" }),
        bit(3, "Test", "1 holds the oscillator reset.", { access: "write" }),
        bit(4, "Triangle waveform", "1 selects triangle waveform.", { access: "write" }),
        bit(5, "Sawtooth waveform", "1 selects sawtooth waveform.", { access: "write" }),
        bit(6, "Pulse waveform", "1 selects pulse waveform.", { access: "write" }),
        bit(7, "Noise waveform", "1 selects noise waveform.", { access: "write" }),
    ]);
    define("io", base + 5, `SID voice ${voice + 1} attack/decay`, [
        field(0, 3, "Decay rate", "Approximate decay time selected by this index.", {
            access: "write",
            values: sidDecayReleaseTimes,
        }),
        field(4, 7, "Attack rate", "Approximate attack time selected by this index.", {
            access: "write",
            values: sidAttackTimes,
        }),
    ]);
    define("io", base + 6, `SID voice ${voice + 1} sustain/release`, [
        field(0, 3, "Release rate", "Approximate release time selected by this index.", {
            access: "write",
            values: sidDecayReleaseTimes,
        }),
        field(4, 7, "Sustain level", "Sustain-level index.", { access: "write" }),
    ]);
}
define("io", 0xd415, "SID filter cutoff low", [
    field(0, 2, "Filter cutoff low bits", "Low three bits of the filter cutoff.", { access: "write" }),
]);
define("io", 0xd416, "SID filter cutoff high", [
    field(0, 7, "Filter cutoff high bits", "Upper eight bits of the filter cutoff.", { access: "write" }),
]);
define("io", 0xd417, "SID filter routing", [
    ...["Voice 1", "Voice 2", "Voice 3", "External input"].map((name, position) =>
        bit(position, `${name} filter routing`, "1 routes this source through the filter.", { access: "write" }),
    ),
    field(4, 7, "Filter resonance", "Four-bit filter resonance.", { access: "write" }),
]);
define("io", 0xd418, "SID volume and filter mode", [
    field(0, 3, "Master volume", "Four-bit master volume.", { access: "write" }),
    bit(4, "Low-pass filter", "1 enables low-pass output.", { access: "write" }),
    bit(5, "Band-pass filter", "1 enables band-pass output.", { access: "write" }),
    bit(6, "High-pass filter", "1 enables high-pass output.", { access: "write" }),
    bit(7, "Voice 3 off", "1 disconnects voice 3 from the direct output.", { access: "write" }),
]);

define("io", 0xdc00, "CIA 1 port A", [
    ...["Up", "Down", "Left", "Right", "Fire"].map((name, position) =>
        bit(position, `Joystick 2 ${name}`, "0 indicates the joystick input is active.", { access: "read" }),
    ),
    ...Array.from({ length: 8 }, (_, position) =>
        bit(
            position,
            `Keyboard column ${position}`,
            "0 selects this keyboard matrix column when the pin is configured as an output.",
            { access: "write" },
        ),
    ),
    field(6, 7, "Paddle selection", "Paddle selection on port A.", {
        access: "write",
        values: [
            { value: 1, description: "Paddle pair 1" },
            { value: 2, description: "Paddle pair 2" },
        ],
    }),
]);
define("io", 0xdc01, "CIA 1 port B", [
    ...Array.from({ length: 8 }, (_, position) =>
        bit(position, `Keyboard row ${position}`, "0 indicates a key in this row is active for the selected column.", {
            access: "read",
        }),
    ),
    ...["Up", "Down", "Left", "Right", "Fire"].map((name, position) =>
        bit(position, `Joystick 1 ${name}`, "0 indicates the joystick input is active.", { access: "read" }),
    ),
]);
define("io", 0xdd00, "CIA 2 port A", [
    field(0, 1, "VIC bank", "Inverted bank selection; check CIA 2 port A direction and effective pin levels.", {
        values: values("$c000-$ffff", "$8000-$bfff", "$4000-$7fff", "$0000-$3fff"),
    }),
    bit(2, "RS-232 TXD", "RS-232 transmit output."),
    bit(3, "Serial ATN output", "Serial attention output; 1 drives the line low."),
    bit(4, "Serial clock output", "Serial clock output; 1 drives the line low."),
    bit(5, "Serial data output", "Serial data output; 1 drives the line low."),
    bit(6, "Serial clock input", "Serial clock input; 0 is low and 1 is high.", { access: "read" }),
    bit(7, "Serial data input", "Serial data input; 0 is low and 1 is high.", { access: "read" }),
]);
define("io", 0xdd01, "CIA 2 port B", [
    bit(0, "RS-232 RXD", "RS-232 receive input.", { access: "read" }),
    bit(1, "RS-232 RTS", "Request to send output.", { access: "write" }),
    bit(2, "RS-232 DTR", "Data terminal ready output.", { access: "write" }),
    bit(3, "RS-232 RI", "Ring indicator line."),
    bit(4, "RS-232 DCD", "Data carrier detect line."),
    bit(5, "User port H", "User port H signal."),
    bit(6, "RS-232 CTS", "Clear to send input.", { access: "read" }),
    bit(7, "RS-232 DSR", "Data set ready input.", { access: "read" }),
]);

for (const [base, cia] of [
    [0xdc00, 1],
    [0xdd00, 2],
] as const) {
    for (const [offset, port] of [
        [2, "A"],
        [3, "B"],
    ] as const) {
        define("io", base + offset, `CIA ${cia} port ${port} direction`, [
            field(
                0,
                7,
                `Port ${port} direction bits`,
                "Each bit selects input (0) or output (1) for the corresponding port pin.",
            ),
        ]);
    }
    define("io", base + 11, `CIA ${cia} clock hours`, [
        field(0, 5, "Hours", "Clock hours in BCD.", { access: "read" }),
        bit(7, "AM/PM", "0: AM; 1: PM.", { access: "read" }),
        field(0, 5, "Hours to set", "BCD hour field; control register B selects clock or alarm.", { access: "write" }),
        bit(7, "AM/PM to set", "0: AM; 1: PM.", { access: "write" }),
    ]);
    const sources = ["Timer A underflow", "Timer B underflow", "TOD alarm", "Serial byte complete", "FLAG input"];
    define("io", base + 13, `CIA ${cia} interrupt control`, [
        ...sources.map((name, position) =>
            bit(
                position,
                `${name} interrupt pending`,
                "1 indicates this event occurred; reading acknowledges pending flags.",
                { access: "read" },
            ),
        ),
        bit(
            7,
            "Interrupt asserted",
            "1 indicates an enabled interrupt was generated; reading acknowledges pending flags.",
            { access: "read" },
        ),
        ...sources.map((name, position) =>
            bit(
                position,
                `${name} interrupt mask`,
                "Write 1 to select this source for mask update; bit 7 chooses set or clear.",
                { access: "write" },
            ),
        ),
        bit(
            7,
            "Interrupt mask set/clear",
            "For selected source bits, 1 sets the mask and 0 clears it; unselected bits are unchanged.",
            { access: "write" },
        ),
    ]);
    for (const [offset, timer, portBit] of [
        [14, "A", 6],
        [15, "B", 7],
    ] as const) {
        const common = [
            bit(0, "Timer start", "0 stops the timer; 1 starts it."),
            bit(1, "Timer output enable", `1 enables timer output on port B bit ${portBit}.`),
            bit(2, "Timer output mode", "0 generates a one-cycle pulse; 1 toggles the port bit on underflow.", {
                source: "https://github.com/mamedev/mame/blob/7ffae3686de8d00cbb829fa953eeda29ad45f944/src/devices/machine/mos6526.cpp",
            }),
            bit(3, "Timer one-shot", "0 restarts after underflow; 1 stops after underflow."),
            bit(4, "Force load", "Writing 1 loads the latch into the timer."),
        ];
        const extra =
            timer === "A"
                ? [
                      bit(5, "Timer A input", "0: system clock; 1: CNT pin edges."),
                      bit(6, "Serial direction", "0: input; 1: output."),
                      bit(7, "TOD input frequency", "0: 60 Hz; 1: 50 Hz."),
                  ]
                : [
                      field(5, 6, "Timer B input", "Selects the timer B clock source.", {
                          values: values(
                              "system clock",
                              "CNT pin edges",
                              "timer A underflows",
                              "timer A underflows while CNT is high",
                          ),
                      }),
                      bit(7, "TOD write target", "0: write time; 1: write alarm."),
                  ];
        define("io", base + offset, `CIA ${cia} timer ${timer} control`, [...common, ...extra]);
    }
}

export const C64_MEMORY_BIT_DEFINITIONS: readonly C64MemoryBitDefinition[] = definitions;
