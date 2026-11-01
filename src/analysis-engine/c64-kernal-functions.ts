export type C64KernalRegister = "A" | "X" | "Y";

export interface C64KernalFunction {
    readonly name: string;
    readonly address: number;
    readonly description: string;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly usedRegisters: readonly C64KernalRegister[];
    readonly defaultImplementationAddress: number;
    readonly vectorAddress?: number;
    readonly defaultVectorTargetAddress?: number;
    readonly notes?: readonly string[];
}

/**
 * C64 KERNAL jump table, based on https://sta.c64.org/cbm64krnfunc.html.
 * Implementation addresses and vectors describe the standard ROM, not custom ROMs.
 * Used registers are those listed by the source, not a complete preservation guarantee.
 */
export class C64KernalFunctions {
    static readonly SCINIT: C64KernalFunction = {
        name: "SCINIT",
        address: 0xff81,
        description: "Initialize the screen editor and VIC, restore keyboard and screen I/O, and clear the screen.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xff5b,
        notes: ["Also configures the PAL/NTSC setting and interrupt timer."],
    };

    static readonly IOINIT: C64KernalFunction = {
        name: "IOINIT",
        address: 0xff84,
        description: "Initialize the CIAs, SID volume, memory configuration and interrupt timer.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xfda3,
    };

    static readonly RAMTAS: C64KernalFunction = {
        name: "RAMTAS",
        address: 0xff87,
        description: "Initialize and test RAM and set the BASIC memory limits and default screen and tape buffers.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xfd50,
        notes: ["Clears $0002-$0101 and $0200-$03ff."],
    };

    static readonly RESTOR: C64KernalFunction = {
        name: "RESTOR",
        address: 0xff8a,
        description: "Restore the default KERNAL vector table.",
        inputs: [],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xfd15,
        notes: ["The vector table occupies $0314-$0333."],
    };

    static readonly VECTOR: C64KernalFunction = {
        name: "VECTOR",
        address: 0xff8d,
        description: "Transfer the KERNAL vector table to or from a user table.",
        inputs: [
            "Carry clear: install the user table; carry set: read the current table.",
            "X/Y: user-table pointer, low/high byte.",
        ],
        outputs: [],
        usedRegisters: ["A", "Y"],
        defaultImplementationAddress: 0xfd1a,
        notes: ["The vector table occupies $0314-$0333."],
    };

    static readonly SETMSG: C64KernalFunction = {
        name: "SETMSG",
        address: 0xff90,
        description: "Set the system message control byte at $009d.",
        inputs: ["A: message control value."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xfe18,
    };

    static readonly LSTNSA: C64KernalFunction = {
        name: "LSTNSA",
        address: 0xff93,
        description: "Send a secondary address to a listening serial device.",
        inputs: ["A: secondary address."],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xedb9,
        notes: ["Call LISTEN first."],
    };

    static readonly TALKSA: C64KernalFunction = {
        name: "TALKSA",
        address: 0xff96,
        description: "Send a secondary address to a talking serial device.",
        inputs: ["A: secondary address."],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xedc7,
        notes: ["Call TALK first."],
    };

    static readonly MEMTOP: C64KernalFunction = {
        name: "MEMTOP",
        address: 0xff99,
        description: "Get or set the upper BASIC memory limit.",
        inputs: [
            "Carry clear: set the limit from X/Y; carry set: get the limit.",
            "X/Y: address low/high byte when setting.",
        ],
        outputs: ["X/Y: address low/high byte when getting."],
        usedRegisters: ["X", "Y"],
        defaultImplementationAddress: 0xfe25,
    };

    static readonly MEMBOT: C64KernalFunction = {
        name: "MEMBOT",
        address: 0xff9c,
        description: "Get or set the lower BASIC memory limit.",
        inputs: [
            "Carry clear: set the limit from X/Y; carry set: get the limit.",
            "X/Y: address low/high byte when setting.",
        ],
        outputs: ["X/Y: address low/high byte when getting."],
        usedRegisters: ["X", "Y"],
        defaultImplementationAddress: 0xfe34,
    };

    static readonly SCNKEY: C64KernalFunction = {
        name: "SCNKEY",
        address: 0xff9f,
        description: "Scan the keyboard and update keyboard state and buffer.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xea87,
        notes: ["Updates the current matrix code at $00cb and shift-key state at $028d."],
    };

    static readonly SETTMO: C64KernalFunction = {
        name: "SETTMO",
        address: 0xffa2,
        description: "Set the serial bus timeout control.",
        inputs: ["A: timeout value."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xfe21,
        notes: ["The reference describes this routine's behavior as uncertain."],
    };

    static readonly IECIN: C64KernalFunction = {
        name: "IECIN",
        address: 0xffa5,
        description: "Receive a byte from the serial bus.",
        inputs: [],
        outputs: ["A: received byte."],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xee13,
        notes: ["Call TALK and TALKSA first."],
    };

    static readonly IECOUT: C64KernalFunction = {
        name: "IECOUT",
        address: 0xffa8,
        description: "Send a byte on the serial bus.",
        inputs: ["A: byte to send."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xeddd,
        notes: ["Call LISTEN and LSTNSA first."],
    };

    static readonly UNTALK: C64KernalFunction = {
        name: "UNTALK",
        address: 0xffab,
        description: "Send the serial bus UNTALK command.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xedef,
    };

    static readonly UNLSTN: C64KernalFunction = {
        name: "UNLSTN",
        address: 0xffae,
        description: "Send the serial bus UNLISTEN command.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xedfe,
    };

    static readonly LISTEN: C64KernalFunction = {
        name: "LISTEN",
        address: 0xffb1,
        description: "Address a serial device as a listener.",
        inputs: ["A: device number."],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xed0c,
    };

    static readonly TALK: C64KernalFunction = {
        name: "TALK",
        address: 0xffb4,
        description: "Address a serial device as a talker.",
        inputs: ["A: device number."],
        outputs: [],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xed09,
    };

    static readonly READST: C64KernalFunction = {
        name: "READST",
        address: 0xffb7,
        description: "Read the current I/O status, corresponding to BASIC's ST variable.",
        inputs: [],
        outputs: ["A: device status."],
        usedRegisters: ["A"],
        defaultImplementationAddress: 0xfe07,
        notes: ["Reading RS-232 status clears it."],
    };

    static readonly SETLFS: C64KernalFunction = {
        name: "SETLFS",
        address: 0xffba,
        description: "Set the logical file, device and secondary addresses.",
        inputs: ["A: logical file number.", "X: device number.", "Y: secondary address."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xfe00,
    };

    static readonly SETNAM: C64KernalFunction = {
        name: "SETNAM",
        address: 0xffbd,
        description: "Set the file name used by file operations.",
        inputs: ["A: name length.", "X/Y: name pointer, low/high byte."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xfdf9,
    };

    static readonly OPEN: C64KernalFunction = {
        name: "OPEN",
        address: 0xffc0,
        description: "Open a logical file.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf34a,
        vectorAddress: 0x031a,
        notes: ["Set file parameters with SETLFS and SETNAM first."],
    };

    static readonly CLOSE: C64KernalFunction = {
        name: "CLOSE",
        address: 0xffc3,
        description: "Close a logical file.",
        inputs: ["A: logical file number."],
        outputs: [],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf291,
        vectorAddress: 0x031c,
    };

    static readonly CHKIN: C64KernalFunction = {
        name: "CHKIN",
        address: 0xffc6,
        description: "Select an open file as the default input channel.",
        inputs: ["X: logical file number."],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf20e,
        vectorAddress: 0x031e,
        notes: ["Open the file first."],
    };

    static readonly CHKOUT: C64KernalFunction = {
        name: "CHKOUT",
        address: 0xffc9,
        description: "Select an open file as the default output channel.",
        inputs: ["X: logical file number."],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf250,
        vectorAddress: 0x0320,
        notes: ["Open the file first."],
    };

    static readonly CLRCHN: C64KernalFunction = {
        name: "CLRCHN",
        address: 0xffcc,
        description: "Restore default input and output to keyboard and screen.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf333,
        vectorAddress: 0x0322,
        notes: ["Terminates serial talk/listen as appropriate; does not close the logical files."],
    };

    static readonly CHRIN: C64KernalFunction = {
        name: "CHRIN",
        address: 0xffcf,
        description: "Read a byte from the default input channel.",
        inputs: [],
        outputs: ["A: input byte."],
        usedRegisters: ["A", "Y"],
        defaultImplementationAddress: 0xf157,
        vectorAddress: 0x0324,
        notes: [
            "For non-keyboard input, open a file and select it with CHKIN first.",
            "Keyboard input reads a line from the screen.",
        ],
    };

    static readonly CHROUT: C64KernalFunction = {
        name: "CHROUT",
        address: 0xffd2,
        description: "Write a byte to the default output channel.",
        inputs: ["A: output byte."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xf1ca,
        vectorAddress: 0x0326,
        notes: ["For non-screen output, open a file and select it with CHKOUT first."],
    };

    static readonly LOAD: C64KernalFunction = {
        name: "LOAD",
        address: 0xffd5,
        description: "Load or verify a file in memory.",
        inputs: [
            "A: zero to load, nonzero to verify.",
            "X/Y: load address low/high byte when secondary address is zero.",
        ],
        outputs: [
            "Carry clear: success; X/Y contains the resulting end address.",
            "Carry set: error; A contains the KERNAL error code.",
        ],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf49e,
        vectorAddress: 0x0330,
        defaultVectorTargetAddress: 0xf4a5,
        notes: ["Set file parameters with SETLFS and SETNAM first."],
    };

    static readonly SAVE: C64KernalFunction = {
        name: "SAVE",
        address: 0xffd8,
        description: "Save a memory range to a file.",
        inputs: ["A: zero-page address containing the start pointer.", "X/Y: exclusive end address, low/high byte."],
        outputs: ["Carry clear: success.", "Carry set: error; A contains the KERNAL error code."],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf5dd,
        vectorAddress: 0x0332,
        defaultVectorTargetAddress: 0xf5ed,
        notes: ["Set file parameters with SETLFS and SETNAM first."],
    };

    static readonly SETTIM: C64KernalFunction = {
        name: "SETTIM",
        address: 0xffdb,
        description: "Set the software time-of-day clock at $00a0-$00a2.",
        inputs: ["A/X/Y: new clock value."],
        outputs: [],
        usedRegisters: [],
        defaultImplementationAddress: 0xf6e4,
    };

    static readonly RDTIM: C64KernalFunction = {
        name: "RDTIM",
        address: 0xffde,
        description: "Read the software time-of-day clock at $00a0-$00a2.",
        inputs: [],
        outputs: ["A/X/Y: current clock value."],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf6dd,
    };

    static readonly STOP: C64KernalFunction = {
        name: "STOP",
        address: 0xffe1,
        description: "Check the RUN/STOP key indicator.",
        inputs: [],
        outputs: ["Zero set and carry set when STOP is pressed; zero clear otherwise."],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf6ed,
        vectorAddress: 0x0328,
        notes: ["When pressed, restores default channels and clears the keyboard buffer."],
    };

    static readonly GETIN: C64KernalFunction = {
        name: "GETIN",
        address: 0xffe4,
        description: "Get a byte from the default input channel.",
        inputs: [],
        outputs: ["A: input byte."],
        usedRegisters: ["A", "X", "Y"],
        defaultImplementationAddress: 0xf13e,
        vectorAddress: 0x032a,
        notes: ["For non-keyboard input, open a file and select it with CHKIN first."],
    };

    static readonly CLALL: C64KernalFunction = {
        name: "CLALL",
        address: 0xffe7,
        description: "Clear the logical file table and restore default channels.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf32f,
        vectorAddress: 0x032c,
    };

    static readonly UDTIM: C64KernalFunction = {
        name: "UDTIM",
        address: 0xffea,
        description: "Update the software clock and RUN/STOP indicator.",
        inputs: [],
        outputs: [],
        usedRegisters: ["A", "X"],
        defaultImplementationAddress: 0xf69b,
        notes: ["Clock: $00a0-$00a2; RUN/STOP indicator: $0091."],
    };

    static readonly SCREEN: C64KernalFunction = {
        name: "SCREEN",
        address: 0xffed,
        description: "Get the screen dimensions.",
        inputs: [],
        outputs: ["X: columns (40 on a standard C64).", "Y: rows (25 on a standard C64)."],
        usedRegisters: ["X", "Y"],
        defaultImplementationAddress: 0xe505,
    };

    static readonly PLOT: C64KernalFunction = {
        name: "PLOT",
        address: 0xfff0,
        description: "Get or set the cursor position.",
        inputs: ["Carry clear: set the cursor from X/Y; carry set: get the cursor.", "X: row, Y: column when setting."],
        outputs: ["X: row, Y: column when getting."],
        usedRegisters: ["X", "Y"],
        defaultImplementationAddress: 0xe50a,
        notes: ["X is the row and Y the column; see https://www.c64-wiki.com/wiki/PLOT."],
    };

    static readonly IOBASE: C64KernalFunction = {
        name: "IOBASE",
        address: 0xfff3,
        description: "Get the CIA 1 base address.",
        inputs: [],
        outputs: ["X/Y: CIA 1 base address low/high byte ($dc00)."],
        usedRegisters: ["X", "Y"],
        defaultImplementationAddress: 0xe500,
    };

    static get all(): readonly C64KernalFunction[] {
        return Object.values(C64KernalFunctions);
    }

    static getByAddress(address: number): C64KernalFunction | undefined {
        if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
            throw new RangeError("Address must be an integer from 0 to 65535.");
        }
        return C64KernalFunctions.all.find((entry) => entry.address === address);
    }
}
