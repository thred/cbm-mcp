export type C64BasicRomEntryKind = "routine" | "data" | "vector";
export type C64BasicRomView = "basic-rom" | "kernal-rom";

export interface C64BasicRomEntry {
    readonly address: number;
    readonly endAddress?: number;
    readonly name: string;
    readonly kind: C64BasicRomEntryKind;
    readonly view: C64BasicRomView;
    readonly description: string;
    readonly source: string;
    readonly sourceRevision: number;
    readonly version: "C64 BASIC V2 and compatible KERNAL";
    readonly inputs?: readonly string[];
    readonly outputs?: readonly string[];
    readonly notes?: readonly string[];
}

type EntryOptions = Pick<C64BasicRomEntry, "inputs" | "outputs" | "notes" | "endAddress"> &
    Partial<Pick<C64BasicRomEntry, "source" | "sourceRevision">>;
const source = "https://www.c64-wiki.de/wiki/BASIC-ROM";

function entry(
    address: number,
    kind: C64BasicRomEntryKind,
    name: string,
    description = name,
    options: EntryOptions = {},
): C64BasicRomEntry {
    return {
        address,
        name,
        kind,
        view: address >= 0xe000 ? "kernal-rom" : "basic-rom",
        description,
        source,
        sourceRevision: 309543,
        version: "C64 BASIC V2 and compatible KERNAL",
        ...options,
    };
}

const routine = (address: number, name: string, description?: string, options?: EntryOptions) =>
    entry(address, "routine", name, description, options);
const data = (address: number, name: string, description?: string, endAddress?: number) =>
    entry(address, "data", name, description, { endAddress });
const vector = (address: number, name: string, description: string) =>
    entry(address, "vector", name, description, { endAddress: address + 1 });

// Entry points and data locations are specific to the standard C64 BASIC V2 ROM and compatible KERNAL.
const entries: readonly C64BasicRomEntry[] = [
    vector(0xa000, "BASIC cold-start vector", "Standard vector points to $e394 in KERNAL ROM."),
    vector(0xa002, "BASIC warm-start vector", "Standard vector points to $e37b in KERNAL ROM."),
    data(0xa004, "BASIC ROM signature", "The cbmbasic identification string.", 0xa00b),
    data(0xa00c, "BASIC statement dispatch table", "35 two-byte statement addresses stored minus one.", 0xa051),
    data(0xa052, "BASIC function dispatch table", "23 two-byte addresses for BASIC functions.", 0xa07f),
    data(0xa080, "BASIC operator table", "Precedence codes and operator addresses stored minus one.", 0xa09d),
    data(0xa09e, "BASIC statement keywords", "PETSCII keyword table; the last character has bit 7 set."),
    data(
        0xa129,
        "BASIC auxiliary keywords",
        "Keywords without statement dispatch entries; final characters have bit 7 set.",
    ),
    data(0xa140, "BASIC operator keywords", "Operator names and symbols with bit 7 set on the final character."),
    data(0xa14d, "BASIC function keywords", "Function names with bit 7 set on the final character."),
    data(0xa19e, "BASIC error messages", "Error message strings with bit 7 set on their final character."),
    data(0xa328, "BASIC error message pointers"),
    data(0xa364, "BASIC interpreter messages", "Interpreter status and error-prefix messages."),
    routine(0xa38a, "Search BASIC stack", "Search FOR/NEXT and GOSUB stack frames."),
    routine(0xa3b8, "Make room for BASIC line", "Check available space and prepare insertion of a BASIC program line."),
    routine(0xa3bf, "Move memory block"),
    routine(0xa3fb, "Check stack space"),
    routine(0xa408, "Make room in memory"),
    routine(0xa435, "OUT OF MEMORY error"),
    routine(0xa437, "Report BASIC error", "Report the error identified by X, then enter the BASIC error path.", {
        inputs: ["X: error number."],
        notes: ["Execution uses the RAM vector at $0300."],
    }),
    routine(0xa480, "BASIC input loop", "Enter the BASIC input loop through the RAM vector at $0302."),
    routine(0xa49c, "Edit BASIC program line", "Tokenize and insert or delete a BASIC program line."),
    routine(0xa533, "Relink BASIC lines", "Rebuild next-line pointers in the BASIC program."),
    routine(0xa560, "Read BASIC input line"),
    routine(0xa579, "Tokenize BASIC line", "Convert input to BASIC tokens via the RAM vector at $0304."),
    routine(0xa613, "Find BASIC line address"),
    routine(0xa642, "NEW", "Execute the BASIC NEW statement."),
    routine(0xa65e, "CLR", "Execute the BASIC CLR statement."),
    routine(0xa68e, "Reset BASIC text pointer", "Set $7a/$7b to one byte before the BASIC program start."),
    routine(0xa69c, "LIST", "Execute the BASIC LIST statement."),
    routine(0xa717, "Detokenize BASIC line", "Convert BASIC tokens to text through the RAM vector at $0306."),
    routine(0xa742, "FOR", "Execute FOR and create a loop stack frame.", {
        notes: [
            "The 18-byte frame stores the continuation pointer, line number, limit, step sign, step value, variable pointer and FOR token.",
        ],
    }),
    routine(0xa7ae, "BASIC interpreter loop"),
    routine(0xa7c4, "Check BASIC program end"),
    routine(0xa7e1, "Execute BASIC statement", "Dispatch a BASIC statement through the RAM vector at $0308."),
    routine(0xa7ed, "Dispatch BASIC keyword"),
    routine(0xa81d, "RESTORE", "Reset the BASIC DATA pointer to the start of the program."),
    routine(0xa82c, "Stop or end BASIC program"),
    routine(0xa82f, "STOP", "Execute the BASIC STOP statement."),
    routine(0xa831, "END", "Execute the BASIC END statement."),
    routine(0xa857, "CONT", "Execute the BASIC CONT statement."),
    routine(0xa871, "RUN", "Execute the BASIC RUN statement."),
    routine(0xa883, "GOSUB", "Push a return frame and transfer control to a BASIC subroutine.", {
        notes: ["The five-byte frame stores the continuation pointer, line number and GOSUB token."],
    }),
    routine(0xa8a0, "GOTO", "Execute the BASIC GOTO statement."),
    routine(0xa8d2, "RETURN", "Execute the BASIC RETURN statement."),
    routine(0xa8f8, "DATA", "Handle the BASIC DATA statement."),
    routine(0xa906, "Find next BASIC delimiter"),
    routine(0xa928, "IF", "Execute the BASIC IF statement."),
    routine(0xa93b, "REM", "Handle the BASIC REM statement."),
    routine(0xa94b, "ON", "Execute the BASIC ON statement."),
    routine(0xa96b, "Read BASIC line number", "Read an integer from BASIC text into $14/$15.", {
        outputs: ["$14/$15: parsed value, low/high byte."],
    }),
    routine(0xa9a5, "LET", "Execute the BASIC LET assignment."),
    routine(0xa9c4, "Assign integer variable"),
    routine(0xa9d6, "Assign floating-point variable"),
    routine(0xa9d9, "Assign string variable"),
    routine(0xa9e3, "Assign TI$"),
    routine(0xaa27, "Add PETSCII digit to FAC"),
    routine(0xaa2c, "Assign ordinary string"),
    routine(0xaa80, "PRINT#", "Execute the BASIC PRINT# statement."),
    routine(0xaa86, "CMD", "Execute the BASIC CMD statement."),
    routine(0xaa9a, "PRINT string continuation"),
    routine(0xaaa0, "PRINT", "Execute the BASIC PRINT statement."),
    routine(0xaab8, "Print BASIC value"),
    routine(0xaaca, "Terminate string", "Append a zero byte to a string."),
    routine(0xaad7, "Print newline", "Output carriage return; line feed may follow for the relevant output channel."),
    routine(0xaaf8, "TAB and SPC", "Handle TAB( or SPC( according to the carry flag.", {
        inputs: ["Carry set: TAB(; carry clear: SPC(."],
    }),
    routine(
        0xab1e,
        "Print zero- or quote-terminated string",
        "Print the text pointed to by A/Y until a zero or quote.",
        {
            inputs: ["A/Y: string address, low/high byte."],
        },
    ),
    routine(0xab3b, "Print cursor-right or space"),
    routine(0xab3f, "Print space"),
    routine(0xab42, "Print cursor-right"),
    routine(0xab45, "Print question mark"),
    routine(0xab47, "Print PETSCII character", "Output the PETSCII character in A.", {
        inputs: ["A: PETSCII character."],
    }),
    routine(0xab4d, "Report BASIC input error"),
    routine(0xab7b, "GET", "Execute the BASIC GET statement."),
    routine(0xaba5, "INPUT#", "Execute the BASIC INPUT# statement."),
    routine(0xabbf, "INPUT", "Execute the BASIC INPUT statement."),
    routine(0xabea, "Read BASIC input buffer"),
    routine(0xabf9, "Print input prompt"),
    routine(0xac06, "READ", "Shared READ, GET and INPUT processing; $11 selects the operation."),
    routine(0xac35, "Read BASIC input item"),
    data(0xacfc, "BASIC input messages", "Messages for extra input and retrying an input line."),
    routine(0xad1d, "NEXT", "Execute the BASIC NEXT statement."),
    routine(0xad61, "Validate FOR loop"),
    routine(0xad8a, "FRMNUM", "Evaluate a BASIC expression and require a numeric result."),
    routine(0xad9e, "FRMEVL", "Evaluate a BASIC expression and set the type flags at $0d and $0e.", {
        outputs: ["FAC: numeric result when the expression is numeric.", "$0d/$0e: expression type indicators."],
    }),
    routine(0xae83, "EVAL", "Evaluate the next expression element through the RAM vector at $030a."),
    data(0xaea8, "Pi constant", "Pi in the BASIC five-byte floating-point format."),
    routine(0xaef1, "Evaluate parenthesized expression"),
    routine(0xaef7, "Require closing parenthesis"),
    routine(0xaefa, "Require opening parenthesis"),
    routine(0xaefd, "Require comma"),
    routine(0xaf08, "SYNTAX ERROR"),
    routine(0xaf0d, "NOT", "Evaluate the BASIC NOT operator."),
    routine(0xaf14, "Check reserved variable", "Check whether FAC refers to a reserved BASIC system variable."),
    routine(0xaf28, "GETVAR", "Read a BASIC variable, including system variables."),
    routine(0xaf48, "Read TI$", "Convert the software clock to a TI$ string."),
    routine(0xafa7, "Evaluate BASIC function"),
    routine(0xafb1, "Evaluate string function argument"),
    routine(0xafd1, "Evaluate numeric function"),
    routine(0xafe6, "OR and AND", "Evaluate OR or AND; the operation flag is at $0b."),
    routine(0xb016, "Compare BASIC expressions"),
    routine(0xb01b, "Compare numbers"),
    routine(0xb02e, "Compare strings"),
    routine(0xb081, "DIM", "Execute the BASIC DIM statement."),
    routine(0xb08b, "PTRGET", "Parse and find or create a BASIC variable.", {
        outputs: ["A/Y: pointer to variable value, low/high byte."],
    }),
    routine(0xb0e7, "ORDVAR", "Find or create a scalar BASIC variable."),
    routine(0xb113, "Check BASIC letter"),
    routine(0xb11d, "Create BASIC variable"),
    routine(0xb194, "Find first array element"),
    data(0xb1a5, "Integer lower bound constant", "The value -32768 in BASIC floating-point format."),
    routine(0xb1aa, "FAC to integer", "Convert FAC to an integer returned in Y/A."),
    routine(0xb1b2, "Read positive integer expression"),
    routine(0xb1bf, "Convert FAC to integer"),
    routine(0xb1d1, "Read BASIC array variable"),
    routine(0xb218, "Find BASIC array"),
    routine(0xb245, "BAD SUBSCRIPT error"),
    routine(0xb248, "ILLEGAL QUANTITY error"),
    routine(0xb24d, "REDIM'D ARRAY error"),
    routine(0xb261, "Create BASIC array"),
    routine(0xb30e, "Calculate array element address"),
    routine(0xb34c, "Calculate array element offset"),
    routine(0xb37d, "FRE", "Evaluate the BASIC FRE function."),
    routine(0xb391, "Integer to FAC", "Convert a 16-bit integer in Y/A to FAC."),
    routine(0xb39e, "POS", "Evaluate the BASIC POS function."),
    routine(0xb3a2, "Byte to FAC", "Convert the byte in Y to FAC."),
    routine(0xb3a6, "Check direct mode"),
    routine(0xb3ae, "UNDEF'D FUNCTION error"),
    routine(0xb3b3, "DEF FN", "Execute the BASIC DEF FN statement."),
    routine(0xb3e1, "Check FN syntax"),
    routine(0xb3f4, "FN", "Evaluate a user-defined BASIC function."),
    routine(0xb465, "STR$", "Evaluate the BASIC STR$ function."),
    routine(0xb475, "Make room for string"),
    routine(0xb487, "Fetch string"),
    routine(0xb4ca, "Push string descriptor"),
    routine(0xb4f4, "Allocate string heap space", "Reserve string storage for a length supplied in A.", {
        inputs: ["A: string length."],
    }),
    routine(0xb526, "String garbage collection"),
    routine(0xb606, "Find next garbage collection string"),
    routine(0xb63d, "Concatenate strings"),
    routine(0xb67a, "Move string to heap"),
    routine(0xb6a3, "FRESTR", "Attempt to release string storage."),
    routine(0xb6db, "Remove string descriptor"),
    routine(0xb6ec, "CHR$", "Evaluate the BASIC CHR$ function."),
    routine(0xb700, "LEFT$", "Evaluate the BASIC LEFT$ function."),
    routine(0xb72c, "RIGHT$", "Evaluate the BASIC RIGHT$ function."),
    routine(0xb737, "MID$", "Evaluate the BASIC MID$ function."),
    routine(0xb761, "Get string descriptor", "Place the descriptor pointer in $50/$51 and length in A and X."),
    routine(0xb77c, "LEN", "Evaluate the BASIC LEN function."),
    routine(0xb782, "Get string length", "Get a string argument length in Y and switch to numeric result type."),
    routine(0xb78b, "ASC", "Evaluate the BASIC ASC function."),
    routine(0xb79b, "Get byte expression", "Evaluate a byte expression into X and FAC+4."),
    routine(0xb7ad, "VAL", "Evaluate the BASIC VAL function."),
    routine(0xb7eb, "GETADR and GETBYT", "Read a 16-bit address and an 8-bit value from BASIC text.", {
        outputs: ["$14/$15: 16-bit address, low/high byte.", "X: 8-bit value."],
    }),
    routine(0xb7f7, "FAC to address", "Convert FAC to a 16-bit value in $14/$15 and Y/A."),
    routine(0xb80d, "PEEK", "Evaluate the BASIC PEEK function."),
    routine(0xb824, "POKE", "Execute the BASIC POKE statement."),
    routine(0xb82d, "WAIT", "Execute the BASIC WAIT statement."),
    routine(0xb849, "Round FAC by adding one half"),
    routine(0xb850, "FSUB", "Subtract FAC from the floating-point value addressed by A/Y."),
    routine(0xb853, "FSUBT", "Subtract FAC from ARG and place the result in FAC."),
    routine(0xb862, "Align floating-point exponents"),
    routine(0xb867, "FADD", "Add FAC to the floating-point value addressed by A/Y."),
    routine(0xb86a, "FADDT", "Add ARG to FAC."),
    routine(0xb947, "Negate FAC mantissa"),
    routine(0xb97e, "OVERFLOW error"),
    routine(0xb983, "Multiply by byte"),
    data(0xb9bc, "LOG constant 1.0"),
    data(0xb9c1, "LOG polynomial degree"),
    data(0xb9c2, "LOG coefficient 1", "Approximate constant 0.434255942."),
    data(0xb9c7, "LOG coefficient 2", "Approximate constant 0.576584541."),
    data(0xb9cc, "LOG coefficient 3", "Approximate constant 0.961800759."),
    data(0xb9d1, "LOG coefficient 4", "Approximate constant 2.885390073."),
    data(0xb9d6, "LOG constant 1/sqrt(2)"),
    data(0xb9db, "LOG constant sqrt(2)"),
    data(0xb9e0, "LOG constant -0.5"),
    data(0xb9e5, "LOG constant ln(2)"),
    routine(0xb9ea, "LOG", "Evaluate the BASIC LOG function."),
    routine(0xba28, "FMULT", "Multiply FAC by the floating-point value addressed by A/Y."),
    routine(0xba30, "FMULTT", "Multiply FAC by ARG."),
    routine(0xba59, "Multiply FAC by byte"),
    routine(0xba8c, "CONUPK", "Load ARG from the floating-point value addressed by A/Y."),
    routine(0xbab7, "Check FAC and ARG"),
    routine(0xbae2, "MUL10", "Multiply FAC by ten."),
    data(0xbaf9, "Floating-point constant 10"),
    routine(0xbafe, "Divide FAC by ten"),
    routine(0xbb0f, "FDIV", "Divide the floating-point value addressed by A/Y by FAC."),
    routine(0xbb14, "FDIVT", "Divide ARG by FAC."),
    routine(0xbb8a, "DIVISION BY ZERO error"),
    routine(0xbba2, "MOVFM", "Load FAC from the floating-point value addressed by A/Y."),
    routine(0xbbc7, "Copy FAC to arithmetic register 4"),
    routine(0xbbca, "Copy FAC to arithmetic register 3"),
    routine(0xbbd0, "Store FAC in variable"),
    routine(0xbbfc, "Copy ARG to FAC"),
    routine(0xbc0c, "Copy rounded FAC to ARG"),
    routine(0xbc1b, "Round FAC"),
    routine(0xbc2b, "Get FAC sign", "Return the sign of FAC in A.", {
        outputs: ["A: $00 for zero, $01 for positive, $ff for negative."],
    }),
    routine(0xbc39, "SGN", "Evaluate the BASIC SGN function."),
    routine(0xbc58, "ABS", "Evaluate the BASIC ABS function."),
    routine(0xbc5b, "Compare FAC with memory", "Compare FAC with the floating-point value addressed by A/Y.", {
        inputs: ["A/Y: address of floating-point value, low/high byte."],
        outputs: ["A: $00 if equal, $01 if FAC is greater, $ff if FAC is smaller."],
    }),
    routine(0xbc9b, "Convert FAC to 32-bit integer"),
    routine(0xbccc, "INT", "Evaluate the BASIC INT function."),
    routine(0xbcf3, "PETSCII to floating point"),
    data(0xbdb3, "Numeric formatting constant 9999999.9"),
    data(0xbdb8, "Numeric formatting constant 99999999"),
    data(0xbdbd, "Numeric formatting constant 1000000000"),
    routine(0xbdc2, "Print BASIC line number context"),
    routine(0xbdcd, "Print positive integer"),
    routine(0xbddd, "FAC to PETSCII", "Convert FAC to a zero-terminated string at $0100.", {
        outputs: ["A/Y: resulting string address, low/high byte."],
    }),
    routine(0xbe68, "TI to PETSCII", "Convert the software clock to a zero-terminated string at $0100."),
    data(0xbf11, "Numeric formatting constant 0.5"),
    data(0xbf16, "Numeric formatting constants"),
    data(0xbf3a, "TI$ formatting constants"),
    routine(0xbf71, "SQR", "Evaluate the BASIC SQR function."),
    routine(0xbf78, "Power with memory exponent", "Raise ARG to the power addressed by A/Y."),
    routine(0xbf7b, "Power with FAC exponent", "Raise ARG to the power in FAC."),
    routine(0xbfb4, "Negate FAC"),
    data(0xbfbf, "EXP constant 1/ln(2)"),
    data(0xbfc4, "EXP polynomial degree"),
    data(0xbfc5, "EXP coefficient 1", "Approximate constant 2.149875e-5."),
    data(0xbfca, "EXP coefficient 2", "Approximate constant 1.435231e-4."),
    data(0xbfcf, "EXP coefficient 3", "Approximate constant 1.342263e-3."),
    data(0xbfd4, "EXP coefficient 4", "Approximate constant 9.6414017e-3."),
    data(0xbfd9, "EXP coefficient 5", "Approximate constant 5.550513e-2."),
    data(
        0xbfde,
        "EXP coefficient 6",
        "Approximate constant 2.40226385e-1; the source page lists a different exponent.",
    ),
    data(0xbfe3, "EXP coefficient 7", "Approximate constant 6.931471e-1."),
    data(0xbfe8, "EXP constant 1.0"),
    routine(0xbfed, "EXP", "Evaluate the BASIC EXP function."),
    routine(0xe043, "POLYX", "Evaluate a polynomial; this BASIC interpreter routine resides in KERNAL ROM."),
    routine(0xe059, "POLY", "Evaluate a polynomial; this BASIC interpreter routine resides in KERNAL ROM."),
    routine(0xe12a, "SYS", "Call a machine-language subroutine at the address given by a BASIC expression.", {
        endAddress: 0xe155,
        inputs: ["An address expression in the range 0-65535.", "$030c-$030f: initial A, X, Y and status."],
        outputs: ["$030c-$030f: A, X, Y and status after the called routine returns."],
        notes: ["The called routine normally returns to BASIC with RTS; it can also consume BASIC parameters."],
        source: "https://www.c64-wiki.com/wiki/SYS",
        sourceRevision: 39060,
    }),
    routine(0xe264, "COS", "Evaluate the BASIC COS function in KERNAL ROM."),
    routine(0xe26b, "SIN", "Evaluate the BASIC SIN function in KERNAL ROM."),
    routine(0xe2b4, "TAN", "Evaluate the BASIC TAN function in KERNAL ROM."),
    routine(0xe30e, "ATN", "Evaluate the BASIC ATN function in KERNAL ROM."),
];

/** Standard ROM reference; this does not verify that those ROMs are currently mapped. */
export class C64BasicRom {
    static get all(): readonly C64BasicRomEntry[] {
        return entries.slice();
    }

    static getByAddress(address: number): C64BasicRomEntry | undefined {
        if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
            throw new RangeError("Address must be an integer from 0 to 65535.");
        }
        return entries.find((item) => item.address === address);
    }

    static search(text: string): readonly C64BasicRomEntry[] {
        const query = text.trim().toLowerCase();
        if (!query) {
            throw new Error("Search text must not be empty.");
        }
        return entries.filter((item) =>
            [item.name, item.description, ...(item.inputs ?? []), ...(item.outputs ?? []), ...(item.notes ?? [])].some(
                (value) => value.toLowerCase().includes(query),
            ),
        );
    }
}
