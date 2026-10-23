import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
    McpUtils,
    type FormattedArguments,
    type McpToolMetadata,
    type ToolArguments,
    type ToolField,
} from "../mcp-utils.js";
import type { MonitorClient } from "./monitor-client.js";
import { encodeCommodoreText, type TextEncoding } from "./text-encoding.js";

type Tokens = FormattedArguments;
type DispatchMode = "reply" | "send" | "assemble";
type Field = ToolField;

export class ViceMonitorTools {
    static readonly EMPTY_INPUT: Tool["inputSchema"] = { type: "object", properties: {}, additionalProperties: false };

    static readonly START_SCHEMA = {
        type: "integer",
        minimum: 0,
        maximum: 65535,
        description: "Start address as a decimal JSON integer.",
    };

    static readonly LENGTH_SCHEMA = {
        type: "integer",
        minimum: 1,
        maximum: 256,
        default: 64,
        description: "Number of bytes in the inclusive address range (not instruction count). No address wraparound.",
    };

    static readonly RANGE_SCHEMA: Tool["inputSchema"] = {
        type: "object",
        properties: { start: this.START_SCHEMA, length: this.LENGTH_SCHEMA },
        required: ["start"],
        additionalProperties: false,
    };

    static readonly CHECKPOINT_SCHEMA = {
        type: "integer",
        minimum: 1,
        maximum: 2147483647,
        description: "Checkpoint ID returned by VICE, not a memory address.",
    };

    static readonly LABEL = /^\.[A-Za-z_][A-Za-z0-9_.]*$/;

    static readonly ADDRESS = /^(?:\.[A-Za-z_][A-Za-z0-9_.]*|(?:(?:[Cc]|8|9|10|11):)?\$[0-9a-fA-F]{1,4})$/;

    static readonly EXPRESSION = /^[A-Za-z0-9_.$%:@[\]()+\-*/&|!<>= \t]+$/;

    static readonly number = McpUtils.numberField;

    static readonly enumeration = McpUtils.enumerationField;

    static readonly text = McpUtils.textField;

    static readonly quoted = McpUtils.quotedField;

    static readonly keyboardText = McpUtils.keyboardTextField;

    static readonly optional = McpUtils.optionalField;

    static readonly array = McpUtils.arrayField;

    static readonly parts = McpUtils.joinArguments;

    static readonly expression: Field = {
        schema: { type: "string", minLength: 1, maxLength: 1024 },
        format: this.formatExpression,
    };

    static readonly space = this.enumeration(["C:", "8:", "9:", "10:", "11:"]);

    static readonly identifier = this.text(/^[A-Za-z_][A-Za-z0-9_]*$/, "an identifier", 64);

    static readonly label = this.text(this.LABEL, "a label beginning with a dot", 128);

    static readonly path = this.quoted("a path on the VICE host");

    static readonly checkpoint = this.number(1, 2147483647, true);

    static readonly fileDevice = this.enumeration([0, 8, 9, 10, 11]);

    static readonly mediaDevice = this.enumeration([1, 2, 8, 9, 10, 11, 32], true);

    static readonly state = this.enumeration(["on", "off", "toggle"]);

    static readonly bytes = this.array(this.number(0, 255));

    static readonly range = { start: this.address(), end: this.optional(this.address()) };

    static readonly fileInput = {
        path: this.path,
        device: this.fileDevice,
        address: this.optional(this.address()),
    };

    static readonly instruction: Field = {
        schema: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "one assembly instruction, without colon or semicolon",
        },
        format: (value) => {
            if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) {
                throw new Error(
                    "Expected one assembly instruction, without colon or semicolon (maximum 256 characters).",
                );
            }
            if (value.includes(":") || value.includes(";")) {
                throw new Error("Expected one assembly instruction, without colon or semicolon.");
            }
            const [mnemonic, ...operandParts] = value.trim().split(/[ \t]+/);
            if (!/^[A-Za-z]{2,5}$/.test(mnemonic)) {
                throw new Error("Expected one assembly instruction, without colon or semicolon.");
            }
            const operand = operandParts.join(" ");
            const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.$%#()+,\\-/<>=[] ' \t";
            if (operand && [...operand].some((character) => !allowed.includes(character))) {
                throw new Error("Expected one assembly instruction, without colon or semicolon.");
            }
            return value;
        },
    };
    static fieldTool(
        name: string,
        description: string,
        fields: Record<string, Field>,
        destructive = true,
    ): McpToolMetadata {
        return McpUtils.toolMetadata(`vice_${name}`, `${description} Auto-connects and may pause emulation.`, fields, {
            readOnlyHint: false,
            destructiveHint: destructive,
        });
    }

    static formatExpression(value: unknown): string {
        if (
            typeof value !== "string" ||
            !value.trim() ||
            value.length > 1024 ||
            /[\r\n]/.test(value) ||
            !ViceMonitorTools.EXPRESSION.test(value)
        ) {
            throw new Error(
                "Expected a single-line VICE expression without quotes or command separators (maximum 1024 characters).",
            );
        }
        return value.trim();
    }

    static addresses(args: Tokens): string {
        const end = args.end || args.start;
        if (
            /^\$[0-9a-f]+$/i.test(args.start) &&
            /^\$[0-9a-f]+$/i.test(end) &&
            parseInt(end.slice(1), 16) < parseInt(args.start.slice(1), 16)
        ) {
            throw new Error("The end address must not precede the start address.");
        }
        return `${args.start} ${end}`;
    }

    static address(): Field {
        return {
            schema: {
                oneOf: [
                    { type: "integer", minimum: 0, maximum: 65535 },
                    { type: "string", pattern: this.ADDRESS.source },
                ],
                description:
                    "Numeric address or .label in the current device; numeric strings may include C:/8:/9:/10:/11: prefixes.",
            },
            format: (value) => {
                if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535) {
                    return `$${value.toString(16).padStart(4, "0")}`;
                }
                if (typeof value === "string" && !/[\r\n]/.test(value) && this.ADDRESS.test(value)) {
                    return value;
                }
                throw new Error(
                    "Expected an address from 0 to 65535, a .label, or a space-qualified address such as 8:$1000.",
                );
            },
        };
    }

    constructor(private readonly monitor: MonitorClient) {}

    private async fieldCommand(
        args: ToolArguments,
        fields: Record<string, Field>,
        command: (tokens: Tokens) => string,
        mode: DispatchMode = "reply",
    ): Promise<string> {
        const tokens = McpUtils.formatArguments(args, fields);
        const line = command(tokens);
        if (mode === "send") {
            await this.monitor.send(line);
            return "Command sent; connection closed. Execution or command success is not acknowledged by VICE. Inspect again to reconnect.";
        }
        if (mode === "assemble") {
            return this.monitor.assemble(line);
        }
        return this.monitor.execute(line);
    }

    @McpUtils.tool({
        name: "vice_status",
        description: "Report local connection state and configured endpoint without contacting or pausing VICE.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    status(): string {
        return JSON.stringify({ host: this.monitor.host, port: this.monitor.port, connected: this.monitor.connected });
    }

    @McpUtils.tool({
        name: "vice_connect",
        description:
            "Connect to the configured VICE text monitor. Reads registers to synchronize and pauses emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    async connect(): Promise<string> {
        await this.monitor.connect();
        return `Connected to ${this.monitor.host}:${this.monitor.port}. Emulation is paused in the monitor.`;
    }

    @McpUtils.tool({
        name: "vice_disconnect",
        description: "Close the monitor socket without quitting VICE or explicitly resuming emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    async disconnect(): Promise<string> {
        await this.monitor.disconnect();
        return "Disconnected. No resume or quit command was sent.";
    }

    @McpUtils.tool({
        name: "vice_registers",
        description:
            "Display CPU registers in the current monitor address space. Auto-connects and may pause emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    registers(): Promise<string> {
        return this.monitor.execute("registers");
    }

    @McpUtils.tool({
        name: "vice_memory",
        description:
            "Read 1-256 computer-memory bytes as hex, PETSCII, or screen-code text. Auto-connects and pauses; respects sidefx.",
        inputSchema: {
            ...ViceMonitorTools.RANGE_SCHEMA,
            properties: {
                start: ViceMonitorTools.START_SCHEMA,
                length: ViceMonitorTools.LENGTH_SCHEMA,
                format: { type: "string", enum: ["hex", "petscii", "screen_codes"], default: "hex" },
            },
        },
    })
    memory(args: ToolArguments): Promise<string> {
        const start = McpUtils.integer(args, "start", 0, 65535);
        const length = McpUtils.integer(args, "length", 1, 256, 64);
        if (start + length > 65536) {
            throw new Error("The address range must not wrap past $ffff.");
        }
        const format = McpUtils.choice(args, "format", ["hex", "petscii", "screen_codes"], "hex");
        const command = format === "hex" ? "mem H" : format === "petscii" ? "i" : "ii";
        return this.monitor.execute(`${command} C:${McpUtils.hex(start)} C:${McpUtils.hex(start + length - 1)}`);
    }

    @McpUtils.tool({
        name: "vice_disassemble",
        description:
            "Disassemble a computer-memory byte range. The last instruction may extend beyond the range. Auto-connects and may pause.",
        inputSchema: ViceMonitorTools.RANGE_SCHEMA,
    })
    disassemble(args: ToolArguments): Promise<string> {
        const start = McpUtils.integer(args, "start", 0, 65535);
        const length = McpUtils.integer(args, "length", 1, 256, 64);
        if (start + length > 65536) {
            throw new Error("The address range must not wrap past $ffff.");
        }
        return this.monitor.execute(`disass C:${McpUtils.hex(start)} C:${McpUtils.hex(start + length - 1)}`);
    }

    @McpUtils.tool({
        name: "vice_step",
        description:
            "Advance the current CPU and return to the monitor: into uses step, over uses next. Changes machine state.",
        inputSchema: {
            type: "object",
            properties: {
                count: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
                mode: { type: "string", enum: ["into", "over"], default: "into" },
            },
            additionalProperties: false,
        },
    })
    step(args: ToolArguments): Promise<string> {
        const count = McpUtils.integer(args, "count", 1, 1000, 1);
        const mode = args.mode === undefined ? "into" : args.mode;
        if (mode !== "into" && mode !== "over") {
            throw new Error("mode must be into or over.");
        }
        return this.monitor.execute(`${mode === "into" ? "step" : "next"} ${McpUtils.hex(count)}`);
    }

    @McpUtils.tool({
        name: "vice_breakpoints",
        description:
            "List VICE checkpoints, including breakpoints and watchpoints. Auto-connects and may pause emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    breakpoints(): Promise<string> {
        return this.monitor.execute("break");
    }

    @McpUtils.tool({
        name: "vice_breakpoint_set",
        description:
            "Create a computer-memory breakpoint for exec, load, and/or store. Returns its checkpoint ID. Does not resume.",
        inputSchema: {
            type: "object",
            properties: {
                start: ViceMonitorTools.START_SCHEMA,
                end: {
                    ...ViceMonitorTools.START_SCHEMA,
                    description: "Inclusive end address; defaults to start. No wraparound.",
                },
                operations: {
                    type: "array",
                    items: { type: "string", enum: ["exec", "load", "store"] },
                    minItems: 1,
                    maxItems: 3,
                    uniqueItems: true,
                    default: ["exec"],
                },
            },
            required: ["start"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    })
    breakpointSet(args: ToolArguments): Promise<string> {
        const start = McpUtils.integer(args, "start", 0, 65535);
        const end = McpUtils.integer(args, "end", start, 65535, start);
        const operations = args.operations ?? ["exec"];
        if (
            !Array.isArray(operations) ||
            operations.length < 1 ||
            operations.length > 3 ||
            new Set(operations).size !== operations.length ||
            operations.some((operation) => !["exec", "load", "store"].includes(operation as string))
        ) {
            throw new Error("operations must contain 1-3 unique entries from exec, load, store.");
        }
        return this.monitor.execute(`break ${operations.join(" ")} C:${McpUtils.hex(start)} C:${McpUtils.hex(end)}`);
    }

    @McpUtils.tool({
        name: "vice_checkpoint_delete",
        description: "Delete exactly one checkpoint by ID. Never deletes all checkpoints implicitly.",
        inputSchema: {
            type: "object",
            properties: { id: ViceMonitorTools.CHECKPOINT_SCHEMA },
            required: ["id"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
    })
    checkpointDelete(args: ToolArguments): Promise<string> {
        return this.monitor.execute(`delete ${McpUtils.integer(args, "id", 1, 2147483647)}`);
    }

    @McpUtils.tool({
        name: "vice_checkpoint_toggle",
        description: "Enable or disable exactly one checkpoint by ID, without deleting it or resuming execution.",
        inputSchema: {
            type: "object",
            properties: { id: ViceMonitorTools.CHECKPOINT_SCHEMA, enabled: { type: "boolean" } },
            required: ["id", "enabled"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    })
    checkpointToggle(args: ToolArguments): Promise<string> {
        const id = McpUtils.integer(args, "id", 1, 2147483647);
        if (typeof args.enabled !== "boolean") {
            throw new Error("enabled must be a boolean.");
        }
        return this.monitor.execute(`${args.enabled ? "enable" : "disable"} ${id}`);
    }

    @McpUtils.tool({
        name: "vice_register_set",
        description:
            "Set one 6502 register in the current address space. PC is 16-bit; A/X/Y/SP/FL are 8-bit. Changes CPU state without resuming.",
        inputSchema: {
            type: "object",
            properties: {
                register: { type: "string", enum: ["PC", "A", "X", "Y", "SP", "FL"] },
                value: { type: "integer", minimum: 0, maximum: 65535 },
            },
            required: ["register", "value"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
    })
    registerSet(args: ToolArguments): Promise<string> {
        const register = McpUtils.choice(args, "register", ["PC", "A", "X", "Y", "SP", "FL"]);
        const value = McpUtils.integer(args, "value", 0, register === "PC" ? 65535 : 255);
        return this.monitor.execute(`registers ${register} = ${McpUtils.hex(value)}`);
    }

    @McpUtils.tool({
        name: "vice_memory_write",
        description:
            "Write bytes or encoded text (exclusive) to computer memory. C64 text folds letters to uppercase. Can overwrite code or trigger I/O; does not resume.",
        inputSchema: {
            type: "object",
            properties: {
                start: ViceMonitorTools.START_SCHEMA,
                bytes: {
                    type: "array",
                    items: { type: "integer", minimum: 0, maximum: 255 },
                    minItems: 1,
                    maxItems: 256,
                },
                text: { type: "string", minLength: 1, maxLength: 256 },
                encoding: { type: "string", enum: ["ascii", "petscii", "screen_codes"], default: "petscii" },
            },
            required: ["start"],
            oneOf: [{ required: ["bytes"] }, { required: ["text"] }],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
    })
    memoryWrite(args: ToolArguments): Promise<string> {
        const start = McpUtils.integer(args, "start", 0, 65535);
        if ((args.bytes === undefined) === (args.text === undefined)) {
            throw new Error("Supply bytes or text, not both.");
        }
        if (args.bytes !== undefined && args.encoding !== undefined) {
            throw new Error("encoding applies only to text.");
        }
        const values =
            args.text === undefined
                ? args.bytes
                : encodeCommodoreText(
                      args.text,
                      McpUtils.choice(
                          args,
                          "encoding",
                          ["ascii", "petscii", "screen_codes"],
                          "petscii",
                      ) as TextEncoding,
                  );
        if (
            !Array.isArray(values) ||
            values.length < 1 ||
            values.length > 256 ||
            values.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)
        ) {
            throw new Error("bytes must contain 1-256 integer values from 0 to 255.");
        }
        if (start + values.length > 65536) {
            throw new Error("The address range must not wrap past $ffff.");
        }
        return this.monitor.execute(
            `> C:${McpUtils.hex(start)} ${values.map((byte: number) => McpUtils.hex(byte, 2)).join(" ")}`,
        );
    }

    @McpUtils.tool({
        name: "vice_help",
        description:
            "Show monitor help, optionally for one command. This is documentation, not arbitrary command execution. May pause emulation.",
        inputSchema: {
            type: "object",
            properties: { command: { type: "string", pattern: "^(?:[A-Za-z][A-Za-z0-9_]{0,31}|>)$" } },
            additionalProperties: false,
        },
    })
    help(args: ToolArguments): Promise<string> {
        if (args.command === undefined) {
            return this.monitor.execute("help");
        }
        if (typeof args.command !== "string" || !/^(?:[A-Za-z][A-Za-z0-9_]{0,31}|>)$/.test(args.command)) {
            throw new Error("command must be a single monitor command name or >.");
        }
        return this.monitor.execute(`help ${args.command}`);
    }

    @McpUtils.tool({
        name: "vice_backtrace",
        description:
            "Heuristic JSR chain, not a reliable source-level stack. Validate with disassembly. Auto-connects and may pause emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    backtrace(): Promise<string> {
        return this.monitor.execute("backtrace");
    }

    @McpUtils.tool({
        name: "vice_screen",
        description:
            "Text dump with screen address and history, not bitmap graphics; does not establish current CPU activity. Auto-connects and may pause emulation.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    screen(): Promise<string> {
        return this.monitor.execute("screen");
    }

    @McpUtils.tool({
        name: "vice_sidefx",
        description:
            "Query monitor read side effects, or set them with enabled. Affects subsequent inspections, not CPU execution or writes.",
        inputSchema: {
            type: "object",
            properties: { enabled: { type: "boolean" } },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    })
    sideEffects(args: ToolArguments): Promise<string> {
        if (args.enabled === undefined) {
            return this.monitor.execute("sidefx");
        }
        if (typeof args.enabled !== "boolean") {
            throw new Error("enabled must be a boolean.");
        }
        return this.monitor.execute(`sidefx ${args.enabled ? "on" : "off"}`);
    }

    @McpUtils.tool({
        name: "vice_resume",
        description:
            "Resume execution with exit (not quit) and close the socket. The next inspection reconnects and pauses VICE again.",
        inputSchema: ViceMonitorTools.EMPTY_INPUT,
    })
    async resume(): Promise<string> {
        await this.monitor.resume();
        return "Resume command sent. Monitor connection closed.";
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "evaluate",
            "Evaluate a VICE expression. Numeric literals inside expressions follow VICE syntax/radix; use explicit prefixes.",
            { expression: ViceMonitorTools.expression },
            false,
        ),
    )
    evaluate(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { expression: ViceMonitorTools.expression },
            (values) => `print ${values.expression}`,
        );
    }

    @McpUtils.tool({
        name: "vice_convert",
        description:
            "Convert a number via VICE (may pause), or locally encode text as ASCII/PETSCII/screen_codes. C64 text folds letters to uppercase; returns encoding and bytes.",
        inputSchema: {
            type: "object",
            properties: {
                value: { type: "integer", minimum: 0, maximum: 4294967295 },
                text: { type: "string", minLength: 1, maxLength: 256 },
                encoding: { type: "string", enum: ["ascii", "petscii", "screen_codes"], default: "petscii" },
            },
            oneOf: [{ required: ["value"] }, { required: ["text"] }],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
    })
    async convert(args: ToolArguments): Promise<string> {
        if ((args.value === undefined) === (args.text === undefined)) {
            throw new Error("Supply value or text, not both.");
        }
        if (args.text !== undefined) {
            const encoding = McpUtils.choice(
                args,
                "encoding",
                ["ascii", "petscii", "screen_codes"],
                "petscii",
            ) as TextEncoding;
            return JSON.stringify({ encoding, bytes: encodeCommodoreText(args.text, encoding) });
        }
        if (args.encoding !== undefined) {
            throw new Error("encoding applies only to text.");
        }
        const value = McpUtils.integer(args, "value", 0, 4294967295);
        return this.monitor.execute(`~ ${McpUtils.hex(value, 1)}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "device",
            "Select the current monitor CPU/address space. With no argument, VICE selects the computer.",
            {
                space: ViceMonitorTools.optional(ViceMonitorTools.space),
            },
        ),
    )
    device(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { space: ViceMonitorTools.optional(ViceMonitorTools.space) }, (values) =>
            ViceMonitorTools.parts("device", values.space),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("bank", "List memory banks, or select a bank for the current address space.", {
            name: ViceMonitorTools.optional(ViceMonitorTools.identifier),
        }),
    )
    bank(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { name: ViceMonitorTools.optional(ViceMonitorTools.identifier) }, (values) =>
            ViceMonitorTools.parts("bank", values.name),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("cpu", "Select the active CPU type; machine support varies.", {
            type: ViceMonitorTools.enumeration(["6502", "z80"]),
        }),
    )
    cpu(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { type: ViceMonitorTools.enumeration(["6502", "z80"]) },
            (values) => `cpu ${values.type}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "radix",
            "Query or change the default monitor radix. Expressions without prefixes follow this setting.",
            {
                radix: ViceMonitorTools.optional(ViceMonitorTools.enumeration(["H", "D", "O", "B"])),
            },
        ),
    )
    radix(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { radix: ViceMonitorTools.optional(ViceMonitorTools.enumeration(["H", "D", "O", "B"])) },
            (values) => ViceMonitorTools.parts("radix", values.radix),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "goto",
            "Set the current CPU's PC and continue execution. Returns after sending, not after a breakpoint.",
            {
                address: ViceMonitorTools.address(),
            },
        ),
    )
    goto(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { address: ViceMonitorTools.address() },
            (values) => `goto ${values.address}`,
            "send",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "step_out",
            "Run until RTS/RTI and return the stopped monitor output. Can time out if no return executes; timeout does not undo execution.",
            {},
        ),
    )
    stepOut(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "return");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "run_until",
            "Run to an address using a temporary breakpoint. Waits for a monitor prompt; timeout does not cancel execution or remove the checkpoint.",
            { address: ViceMonitorTools.address() },
        ),
    )
    runUntil(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { address: ViceMonitorTools.address() }, (values) => `until ${values.address}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "io",
            "Decode I/O registers, optionally for one chip address. Reads follow the sidefx setting.",
            {
                address: ViceMonitorTools.optional(ViceMonitorTools.address()),
            },
            false,
        ),
    )
    io(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { address: ViceMonitorTools.optional(ViceMonitorTools.address()) }, (values) =>
            ViceMonitorTools.parts("io", values.address),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("stopwatch", "Read the cycle counter, or reset it explicitly.", {
            action: ViceMonitorTools.optional(ViceMonitorTools.enumeration(["reset"])),
        }),
    )
    stopwatch(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { action: ViceMonitorTools.optional(ViceMonitorTools.enumeration(["reset"])) },
            (values) => ViceMonitorTools.parts("stopwatch", values.action),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "cpu_history",
            "Display instruction history; requires VICE CPU-history support.",
            {
                count: ViceMonitorTools.optional(ViceMonitorTools.number(1, 10000, true)),
                spaces: ViceMonitorTools.optional(ViceMonitorTools.array(ViceMonitorTools.space, 5, true)),
            },
            false,
        ),
    )
    cpuHistory(args: ToolArguments): Promise<string> {
        const fields = {
            count: ViceMonitorTools.optional(ViceMonitorTools.number(1, 10000, true)),
            spaces: ViceMonitorTools.optional(ViceMonitorTools.array(ViceMonitorTools.space, 5, true)),
        };
        return this.fieldCommand(args, fields, (values) =>
            ViceMonitorTools.parts("cpuhistory", values.count, values.spaces),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "reset",
            "Reset/power-cycle the machine or reset a drive. No success acknowledgment; changes program state. Requires confirm=true.",
            {
                type: ViceMonitorTools.enumeration([0, 1, 8, 9, 10, 11], true),
                confirm: ViceMonitorTools.enumeration([true]),
            },
        ),
    )
    reset(args: ToolArguments): Promise<string> {
        const fields = {
            type: ViceMonitorTools.enumeration([0, 1, 8, 9, 10, 11], true),
            confirm: ViceMonitorTools.enumeration([true]),
        };
        return this.fieldCommand(args, fields, (values) => `reset ${values.type}`, "send");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "quit",
            "Terminate the VICE emulator immediately. Requires confirm=true; does not merely disconnect.",
            {
                confirm: {
                    schema: { type: "boolean", const: true },
                    format: (value) => {
                        if (value !== true) {
                            throw new Error("confirm must be true.");
                        }
                        return "";
                    },
                },
            },
        ),
    )
    quit(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            {
                confirm: {
                    schema: { type: "boolean", const: true },
                    format: (value) => {
                        if (value !== true) {
                            throw new Error("confirm must be true.");
                        }
                        return "";
                    },
                },
            },
            () => "quit",
            "send",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("warp", "Query or change warp mode.", {
            state: ViceMonitorTools.optional(ViceMonitorTools.state),
        }),
    )
    warp(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { state: ViceMonitorTools.optional(ViceMonitorTools.state) }, (values) =>
            ViceMonitorTools.parts("warp", values.state),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "cartridge_freeze",
            "Trigger cartridge freeze, if the attached cartridge supports it.",
            {},
        ),
    )
    cartridgeFreeze(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "cartfreeze", "send");
    }

    @McpUtils.tool(ViceMonitorTools.fieldTool("expansions", "List attached expansion-port devices.", {}, false))
    expansions(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "export");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "keyboard",
            "Queue exactly one input form: text or PETSCII codes, never both. submit:true appends Return. Resume to process input, then inspect before retrying; inspection may pause loading.",
            {
                text: ViceMonitorTools.optional(
                    ViceMonitorTools.keyboardText("literal keyboard text without control characters or backslashes"),
                ),
                codes: ViceMonitorTools.optional(ViceMonitorTools.array(ViceMonitorTools.number(0, 255))),
                submit: ViceMonitorTools.optional(ViceMonitorTools.enumeration([true, false])),
            },
        ),
    )
    keyboard(args: ToolArguments): Promise<string> {
        const fields = {
            text: ViceMonitorTools.optional(
                ViceMonitorTools.keyboardText("literal keyboard text without control characters or backslashes"),
            ),
            codes: ViceMonitorTools.optional(ViceMonitorTools.array(ViceMonitorTools.number(0, 255))),
            submit: ViceMonitorTools.optional(ViceMonitorTools.enumeration([true, false])),
        };
        return this.fieldCommand(args, fields, (values) => {
            if (values.text && values.codes) {
                throw new Error("Supply text or codes, not both.");
            }
            if (values.text) {
                return `keybuf ${values.text}${values.submit === "true" ? "\\x0d" : ""}`;
            }
            if (!values.codes) {
                throw new Error("Supply text or codes.");
            }
            const escaped = values.codes
                .split(" ")
                .map((code) => `\\x${parseInt(code.slice(1), 16).toString(16).padStart(2, "0")}`)
                .join("");
            return `keybuf ${escaped}${values.submit === "true" ? "\\x0d" : ""}`;
        });
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_compare",
            "Compare a range with another memory location.",
            {
                ...ViceMonitorTools.range,
                destination: ViceMonitorTools.address(),
            },
            false,
        ),
    )
    memoryCompare(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { ...ViceMonitorTools.range, destination: ViceMonitorTools.address() },
            (values) => `compare ${ViceMonitorTools.addresses(values)} ${values.destination}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("memory_move", "Copy a memory range to another address; regions may overlap.", {
            ...ViceMonitorTools.range,
            destination: ViceMonitorTools.address(),
        }),
    )
    memoryMove(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { ...ViceMonitorTools.range, destination: ViceMonitorTools.address() },
            (values) => `move ${ViceMonitorTools.addresses(values)} ${values.destination}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("memory_fill", "Fill a memory range with a repeating byte pattern.", {
            ...ViceMonitorTools.range,
            bytes: ViceMonitorTools.bytes,
        }),
    )
    memoryFill(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { ...ViceMonitorTools.range, bytes: ViceMonitorTools.bytes },
            (values) => `fill ${ViceMonitorTools.addresses(values)} ${values.bytes}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_hunt",
            "Search a memory range for bytes; use the string xx for a wildcard byte.",
            {
                ...ViceMonitorTools.range,
                bytes: ViceMonitorTools.array({
                    schema: { oneOf: [{ type: "integer", minimum: 0, maximum: 255 }, { const: "xx" }] },
                    format: (value) => (value === "xx" ? "xx" : ViceMonitorTools.number(0, 255).format(value)),
                }),
            },
            false,
        ),
    )
    memoryHunt(args: ToolArguments): Promise<string> {
        const fields = {
            ...ViceMonitorTools.range,
            bytes: ViceMonitorTools.array({
                schema: { oneOf: [{ type: "integer", minimum: 0, maximum: 255 }, { const: "xx" }] },
                format: (value) => (value === "xx" ? "xx" : ViceMonitorTools.number(0, 255).format(value)),
            }),
        };
        return this.fieldCommand(
            args,
            fields,
            (values) => `hunt ${ViceMonitorTools.addresses(values)} ${values.bytes}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("memory_petscii", "Display memory as PETSCII text.", ViceMonitorTools.range, false),
    )
    memoryPetscii(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, ViceMonitorTools.range, (values) => `i ${ViceMonitorTools.addresses(values)}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_screen_codes",
            "Display memory as screen-code text.",
            ViceMonitorTools.range,
            false,
        ),
    )
    memoryScreenCodes(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, ViceMonitorTools.range, (values) => `ii ${ViceMonitorTools.addresses(values)}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_characters",
            "Display memory as character graphics.",
            ViceMonitorTools.range,
            false,
        ),
    )
    memoryCharacters(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            ViceMonitorTools.range,
            (values) => `memchar ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_sprites",
            "Display memory as sprite graphics.",
            ViceMonitorTools.range,
            false,
        ),
    )
    memorySprites(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            ViceMonitorTools.range,
            (values) => `memsprite ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memory_range",
            "Read an explicit memory range, supporting labels and drive address spaces.",
            ViceMonitorTools.range,
            false,
        ),
    )
    memoryRange(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            ViceMonitorTools.range,
            (values) => `mem H ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "disassemble_range",
            "Disassemble an explicit memory range, supporting labels and drive address spaces.",
            ViceMonitorTools.range,
            false,
        ),
    )
    disassembleRange(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            ViceMonitorTools.range,
            (values) => `disass ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memmap_show",
            "Show memory-access history; requires a VICE build with CPU-history support.",
            {
                mask: ViceMonitorTools.optional(ViceMonitorTools.number(0, 255)),
                start: ViceMonitorTools.optional(ViceMonitorTools.address()),
                end: ViceMonitorTools.optional(ViceMonitorTools.address()),
            },
            false,
        ),
    )
    memoryMapShow(args: ToolArguments): Promise<string> {
        const fields = {
            mask: ViceMonitorTools.optional(ViceMonitorTools.number(0, 255)),
            start: ViceMonitorTools.optional(ViceMonitorTools.address()),
            end: ViceMonitorTools.optional(ViceMonitorTools.address()),
        };
        return this.fieldCommand(args, fields, (values) => {
            if ((values.start || values.end) && !values.mask) {
                throw new Error("mask is required when specifying a range.");
            }
            if (values.end && !values.start) {
                throw new Error("start is required with end.");
            }
            return ViceMonitorTools.parts(
                "memmapshow",
                values.mask,
                values.start ? ViceMonitorTools.addresses(values) : "",
            );
        });
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("memmap_clear", "Clear the memory-access map; requires CPU-history support.", {}),
    )
    memoryMapClear(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "memmapzap");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "memmap_save",
            "Save the memory-access map to a host image file; requires CPU-history support.",
            {
                path: ViceMonitorTools.path,
                format: ViceMonitorTools.enumeration([0, 1, 2, 3, 4], true),
            },
        ),
    )
    memoryMapSave(args: ToolArguments): Promise<string> {
        const fields = { path: ViceMonitorTools.path, format: ViceMonitorTools.enumeration([0, 1, 2, 3, 4], true) };
        return this.fieldCommand(args, fields, (values) => `memmapsave ${values.path} ${values.format}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "assemble",
            "Assemble one instruction and leave interactive mode. Writes machine code; operands use VICE syntax. Repeat for further instructions.",
            { address: ViceMonitorTools.address(), instruction: ViceMonitorTools.instruction },
        ),
    )
    assemble(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { address: ViceMonitorTools.address(), instruction: ViceMonitorTools.instruction },
            (values) => `a ${values.address} ${values.instruction}`,
            "assemble",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "register_write",
            "Set one CPU-specific register, including Z80 registers. VICE checks validity/width for the selected CPU. Changes CPU state.",
            {
                register: ViceMonitorTools.text(/^(?:[A-Za-z][A-Za-z0-9]{0,7}'?|00|01)$/, "a CPU register name", 9),
                value: ViceMonitorTools.number(),
            },
        ),
    )
    registerWrite(args: ToolArguments): Promise<string> {
        const fields = {
            register: ViceMonitorTools.text(/^(?:[A-Za-z][A-Za-z0-9]{0,7}'?|00|01)$/, "a CPU register name", 9),
            value: ViceMonitorTools.number(),
        };
        return this.fieldCommand(args, fields, (values) => `registers ${values.register} = ${values.value}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "tracepoint_set",
            "Create a checkpoint in the current or explicitly prefixed address space. Tracepoints log without stopping; watchpoints stop on memory access.",
            {
                ...ViceMonitorTools.range,
                operations: ViceMonitorTools.optional(
                    ViceMonitorTools.array(ViceMonitorTools.enumeration(["exec", "load", "store"]), 3, true),
                    "exec",
                ),
                condition: ViceMonitorTools.optional(ViceMonitorTools.expression),
            },
        ),
    )
    tracepointSet(args: ToolArguments): Promise<string> {
        const fields = {
            ...ViceMonitorTools.range,
            operations: ViceMonitorTools.optional(
                ViceMonitorTools.array(ViceMonitorTools.enumeration(["exec", "load", "store"]), 3, true),
                "exec",
            ),
            condition: ViceMonitorTools.optional(ViceMonitorTools.expression),
        };
        return this.fieldCommand(args, fields, (values) =>
            ViceMonitorTools.parts(
                "trace",
                values.operations,
                ViceMonitorTools.addresses(values),
                values.condition ? `if ${values.condition}` : "",
            ),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "watchpoint_set",
            "Create a checkpoint in the current or explicitly prefixed address space. Tracepoints log without stopping; watchpoints stop on memory access.",
            {
                ...ViceMonitorTools.range,
                operations: ViceMonitorTools.optional(
                    ViceMonitorTools.array(ViceMonitorTools.enumeration(["exec", "load", "store"]), 3, true),
                    "load store",
                ),
                condition: ViceMonitorTools.optional(ViceMonitorTools.expression),
            },
        ),
    )
    watchpointSet(args: ToolArguments): Promise<string> {
        const fields = {
            ...ViceMonitorTools.range,
            operations: ViceMonitorTools.optional(
                ViceMonitorTools.array(ViceMonitorTools.enumeration(["exec", "load", "store"]), 3, true),
                "load store",
            ),
            condition: ViceMonitorTools.optional(ViceMonitorTools.expression),
        };
        return this.fieldCommand(args, fields, (values) =>
            ViceMonitorTools.parts(
                "watch",
                values.operations,
                ViceMonitorTools.addresses(values),
                values.condition ? `if ${values.condition}` : "",
            ),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "checkpoint_condition",
            "Set a checkpoint condition. Use explicit numeric prefixes; VICE evaluates the expression.",
            {
                id: ViceMonitorTools.checkpoint,
                expression: ViceMonitorTools.expression,
            },
        ),
    )
    checkpointCondition(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { id: ViceMonitorTools.checkpoint, expression: ViceMonitorTools.expression },
            (values) => `condition ${values.id} if ${values.expression}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "checkpoint_ignore",
            "Ignore a checkpoint for a number of crossings; omitting count uses VICE's default of one.",
            {
                id: ViceMonitorTools.checkpoint,
                count: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647)),
            },
        ),
    )
    checkpointIgnore(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            {
                id: ViceMonitorTools.checkpoint,
                count: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647)),
            },
            (values) => ViceMonitorTools.parts("ignore", values.id, values.count),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "checkpoint_command",
            "Attach a monitor command to a checkpoint. Powerful deferred execution: can change state or access host files when triggered. Empty command clears it.",
            { id: ViceMonitorTools.checkpoint, command: ViceMonitorTools.quoted("a deferred monitor command", true) },
        ),
    )
    checkpointCommand(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { id: ViceMonitorTools.checkpoint, command: ViceMonitorTools.quoted("a deferred monitor command", true) },
            (values) => `command ${values.id} ${values.command}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "checkpoint_dummy",
            "Query or configure whether checkpoints trigger on dummy CPU accesses.",
            {
                state: ViceMonitorTools.optional(ViceMonitorTools.state),
            },
        ),
    )
    checkpointDummy(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { state: ViceMonitorTools.optional(ViceMonitorTools.state) }, (values) =>
            ViceMonitorTools.parts("dummy", values.state),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("label_add", "Bind a .label to an address; address may include a drive prefix.", {
            address: ViceMonitorTools.address(),
            label: ViceMonitorTools.label,
        }),
    )
    labelAdd(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { address: ViceMonitorTools.address(), label: ViceMonitorTools.label },
            (values) => `add_label ${values.address} ${values.label}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("label_delete", "Delete a label; omitted space checks all label tables.", {
            label: ViceMonitorTools.label,
            space: ViceMonitorTools.optional(ViceMonitorTools.space),
        }),
    )
    labelDelete(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { label: ViceMonitorTools.label, space: ViceMonitorTools.optional(ViceMonitorTools.space) },
            (values) => ViceMonitorTools.parts("delete_label", values.space, values.label),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "labels",
            "Show labels from the current or specified address space.",
            {
                space: ViceMonitorTools.optional(ViceMonitorTools.space),
            },
            false,
        ),
    )
    labels(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { space: ViceMonitorTools.optional(ViceMonitorTools.space) }, (values) =>
            ViceMonitorTools.parts("show_labels", values.space),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("labels_clear", "Clear labels from the current or specified address space.", {
            space: ViceMonitorTools.optional(ViceMonitorTools.space),
        }),
    )
    labelsClear(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { space: ViceMonitorTools.optional(ViceMonitorTools.space) }, (values) =>
            ViceMonitorTools.parts("clear_labels", values.space),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "labels_load",
            "Load a VICE/assembler label file. Treat input as trusted: VICE label files can contain monitor commands.",
            { path: ViceMonitorTools.path, space: ViceMonitorTools.optional(ViceMonitorTools.space) },
        ),
    )
    labelsLoad(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path, space: ViceMonitorTools.optional(ViceMonitorTools.space) },
            (values) => ViceMonitorTools.parts("load_labels", values.space, values.path),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("labels_save", "Save labels to a host file. Omitted space saves all label tables.", {
            path: ViceMonitorTools.path,
            space: ViceMonitorTools.optional(ViceMonitorTools.space),
        }),
    )
    labelsSave(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path, space: ViceMonitorTools.optional(ViceMonitorTools.space) },
            (values) => ViceMonitorTools.parts("save_labels", values.space, values.path),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "snapshot_save",
            "Write a machine snapshot to a host file; ROM images are not included.",
            {
                path: ViceMonitorTools.path,
            },
        ),
    )
    snapshotSave(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `dump ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "snapshot_load",
            "Restore a machine snapshot, replacing machine state. No execution-state acknowledgment.",
            { path: ViceMonitorTools.path },
        ),
    )
    snapshotLoad(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `undump ${values.path}`, "send");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("directory_change", "Change VICE's host working directory.", {
            path: ViceMonitorTools.path,
        }),
    )
    directoryChange(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `cd ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("directory_create", "Create a directory on the VICE host.", {
            path: ViceMonitorTools.path,
        }),
    )
    directoryCreate(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `mkdir ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("directory_remove", "Remove a directory on the VICE host.", {
            path: ViceMonitorTools.path,
        }),
    )
    directoryRemove(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `rmdir ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("log_file", "Set the monitor's host log filename.", { path: ViceMonitorTools.path }),
    )
    logFile(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `logname ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("record", "Start recording monitor commands to a host file.", {
            path: ViceMonitorTools.path,
        }),
    )
    record(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `record ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "playback",
            "Execute a trusted monitor script. May write files, resume, or terminate VICE. No success acknowledgment.",
            { path: ViceMonitorTools.path },
        ),
    )
    playback(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `playback ${values.path}`, "send");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "resources_load",
            "Load a host resource file; settings may change monitor availability.",
            {
                path: ViceMonitorTools.path,
            },
        ),
    )
    resourcesLoad(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path },
            (values) => `load_resources ${values.path}`,
            "send",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("resources_save", "Save VICE resources to a host file.", {
            path: ViceMonitorTools.path,
        }),
    )
    resourcesSave(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.path }, (values) => `save_resources ${values.path}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "directory_list",
            "List a directory on the VICE host.",
            { path: ViceMonitorTools.optional(ViceMonitorTools.path) },
            false,
        ),
    )
    directoryList(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { path: ViceMonitorTools.optional(ViceMonitorTools.path) }, (values) =>
            ViceMonitorTools.parts("dir", values.path ? values.path.slice(1, -1) : ""),
        );
    }

    @McpUtils.tool(ViceMonitorTools.fieldTool("directory_current", "Show VICE's host working directory.", {}, false))
    directoryCurrent(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "pwd");
    }

    @McpUtils.tool(ViceMonitorTools.fieldTool("record_stop", "Stop monitor command recording.", {}))
    recordStop(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, {}, () => "stop");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "comment",
            "Record a comment in the monitor command log.",
            {
                text: ViceMonitorTools.text(/^[^\r\n\0]+$/, "comment text", 1024),
            },
            false,
        ),
    )
    comment(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { text: ViceMonitorTools.text(/^[^\r\n\0]+$/, "comment text", 1024) },
            (values) => `; ${values.text}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("log", "Query or configure monitor output logging to a host file.", {
            state: ViceMonitorTools.optional(ViceMonitorTools.state),
        }),
    )
    log(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { state: ViceMonitorTools.optional(ViceMonitorTools.state) }, (values) =>
            ViceMonitorTools.parts("log", values.state),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "resource_get",
            "Read raw name=value. Numeric enums require their documented mapping; values alone do not identify the machine.",
            { name: ViceMonitorTools.quoted("a VICE resource name") },
            false,
        ),
    )
    resourceGet(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { name: ViceMonitorTools.quoted("a VICE resource name") },
            (values) => `resourceget ${values.name}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "resource_set",
            "Set a VICE resource. Can affect host access or disable the remote monitor; no success acknowledgment.",
            {
                name: ViceMonitorTools.quoted("a VICE resource name"),
                value: ViceMonitorTools.quoted("a resource value", true),
            },
        ),
    )
    resourceSet(args: ToolArguments): Promise<string> {
        const fields = {
            name: ViceMonitorTools.quoted("a VICE resource name"),
            value: ViceMonitorTools.quoted("a resource value", true),
        };
        return this.fieldCommand(args, fields, (values) => `resourceset ${values.name} ${values.value}`, "send");
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "media_attach",
            "Attach a disk, tape (device 1), or cartridge (device 32) image from the VICE host.",
            {
                path: ViceMonitorTools.path,
                device: ViceMonitorTools.mediaDevice,
            },
        ),
    )
    mediaAttach(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path, device: ViceMonitorTools.mediaDevice },
            (values) => `attach ${values.path} ${values.device}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("media_detach", "Detach media from a device.", {
            device: ViceMonitorTools.mediaDevice,
        }),
    )
    mediaDetach(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, { device: ViceMonitorTools.mediaDevice }, (values) => `detach ${values.device}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "autostart",
            "Autoload/autostart a host program or image. May reset/resume the machine; returns after sending only.",
            {
                path: ViceMonitorTools.path,
                index: ViceMonitorTools.optional(ViceMonitorTools.number(1, 65535)),
            },
        ),
    )
    autostart(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path, index: ViceMonitorTools.optional(ViceMonitorTools.number(1, 65535)) },
            (values) => ViceMonitorTools.parts("autostart", values.path, values.index),
            "send",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "autoload",
            "Autoload/autostart a host program or image. May reset/resume the machine; returns after sending only.",
            {
                path: ViceMonitorTools.path,
                index: ViceMonitorTools.optional(ViceMonitorTools.number(1, 65535)),
            },
        ),
    )
    autoload(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { path: ViceMonitorTools.path, index: ViceMonitorTools.optional(ViceMonitorTools.number(1, 65535)) },
            (values) => ViceMonitorTools.parts("autoload", values.path, values.index),
            "send",
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "program_load",
            "Load a program; optional address overrides its load address and skips the two-byte header.",
            ViceMonitorTools.fileInput,
        ),
    )
    programLoad(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, ViceMonitorTools.fileInput, (values) =>
            ViceMonitorTools.parts("load", values.path, values.device, values.address),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "basic_load",
            "Load a BASIC program and set BASIC pointers.",
            ViceMonitorTools.fileInput,
        ),
    )
    basicLoad(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, ViceMonitorTools.fileInput, (values) =>
            ViceMonitorTools.parts("loadbasic", values.path, values.device, values.address),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "program_verify",
            "Compare a program file with memory, respecting its load-address header.",
            ViceMonitorTools.fileInput,
            false,
        ),
    )
    programVerify(args: ToolArguments): Promise<string> {
        return this.fieldCommand(args, ViceMonitorTools.fileInput, (values) =>
            ViceMonitorTools.parts("verify", values.path, values.device, values.address),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("binary_load", "Load raw bytes without a load-address header.", {
            path: ViceMonitorTools.path,
            device: ViceMonitorTools.fileDevice,
            address: ViceMonitorTools.address(),
        }),
    )
    binaryLoad(args: ToolArguments): Promise<string> {
        const fields = {
            path: ViceMonitorTools.path,
            device: ViceMonitorTools.fileDevice,
            address: ViceMonitorTools.address(),
        };
        return this.fieldCommand(args, fields, (values) => `bload ${values.path} ${values.device} ${values.address}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "binary_verify",
            "Compare raw file bytes with memory.",
            {
                path: ViceMonitorTools.path,
                device: ViceMonitorTools.fileDevice,
                address: ViceMonitorTools.address(),
            },
            false,
        ),
    )
    binaryVerify(args: ToolArguments): Promise<string> {
        const fields = {
            path: ViceMonitorTools.path,
            device: ViceMonitorTools.fileDevice,
            address: ViceMonitorTools.address(),
        };
        return this.fieldCommand(args, fields, (values) => `bverify ${values.path} ${values.device} ${values.address}`);
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "program_save",
            "Save a memory range to a file. program_save includes a two-byte load address; binary_save writes raw bytes.",
            {
                path: ViceMonitorTools.path,
                device: ViceMonitorTools.fileDevice,
                ...ViceMonitorTools.range,
            },
        ),
    )
    programSave(args: ToolArguments): Promise<string> {
        const fields = { path: ViceMonitorTools.path, device: ViceMonitorTools.fileDevice, ...ViceMonitorTools.range };
        return this.fieldCommand(
            args,
            fields,
            (values) => `save ${values.path} ${values.device} ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "binary_save",
            "Save a memory range to a file. program_save includes a two-byte load address; binary_save writes raw bytes.",
            {
                path: ViceMonitorTools.path,
                device: ViceMonitorTools.fileDevice,
                ...ViceMonitorTools.range,
            },
        ),
    )
    binarySave(args: ToolArguments): Promise<string> {
        const fields = { path: ViceMonitorTools.path, device: ViceMonitorTools.fileDevice, ...ViceMonitorTools.range };
        return this.fieldCommand(
            args,
            fields,
            (values) => `bsave ${values.path} ${values.device} ${ViceMonitorTools.addresses(values)}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "disk_list",
            "List disk contents from the selected virtual drive.",
            {
                device: ViceMonitorTools.optional(ViceMonitorTools.enumeration([8, 9, 10, 11])),
            },
            false,
        ),
    )
    diskList(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { device: ViceMonitorTools.optional(ViceMonitorTools.enumeration([8, 9, 10, 11])) },
            (values) => ViceMonitorTools.parts("list", values.device),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "disk_command",
            "Send a virtual drive-8 DOS command. Can rename, scratch, or format disk contents. No monitor-command separators allowed.",
            {
                command: ViceMonitorTools.text(/^[^;\r\n\0]+$/, "one virtual-drive DOS command", 256),
            },
        ),
    )
    diskCommand(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { command: ViceMonitorTools.text(/^[^;\r\n\0]+$/, "one virtual-drive DOS command", 256) },
            (values) => `@${values.command}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("block_read", "Read a drive-8 disk block, optionally copying it into memory.", {
            track: ViceMonitorTools.number(1, 255),
            sector: ViceMonitorTools.number(0, 255),
            address: ViceMonitorTools.optional(ViceMonitorTools.address()),
        }),
    )
    blockRead(args: ToolArguments): Promise<string> {
        const fields = {
            track: ViceMonitorTools.number(1, 255),
            sector: ViceMonitorTools.number(0, 255),
            address: ViceMonitorTools.optional(ViceMonitorTools.address()),
        };
        return this.fieldCommand(args, fields, (values) =>
            ViceMonitorTools.parts("block_read", values.track, values.sector, values.address),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("block_write", "Write memory to a drive-8 disk block. Modifies disk contents.", {
            track: ViceMonitorTools.number(1, 255),
            sector: ViceMonitorTools.number(0, 255),
            address: ViceMonitorTools.address(),
        }),
    )
    blockWrite(args: ToolArguments): Promise<string> {
        const fields = {
            track: ViceMonitorTools.number(1, 255),
            sector: ViceMonitorTools.number(0, 255),
            address: ViceMonitorTools.address(),
        };
        return this.fieldCommand(
            args,
            fields,
            (values) => `block_write ${values.track} ${values.sector} ${values.address}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "tape_control",
            "Control the datasette: 0 stop, 1 start, 2 forward, 3 rewind, 4 record, 5 reset, 6 reset counter.",
            {
                command: ViceMonitorTools.enumeration([0, 1, 2, 3, 4, 5, 6], true),
            },
        ),
    )
    tapeControl(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { command: ViceMonitorTools.enumeration([0, 1, 2, 3, 4, 5, 6], true) },
            (values) => `tapectrl ${values.command}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("tape_offset", "Query or set the attached tape's offset.", {
            offset: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647)),
        }),
    )
    tapeOffset(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { offset: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647)) },
            (values) => ViceMonitorTools.parts("tapeoffs", values.offset),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "screenshot",
            "Save an emulator screenshot to a host file. Formats: 0 BMP, 1 PCX, 2 PNG, 3 GIF, 4 IFF.",
            {
                path: ViceMonitorTools.path,
                format: ViceMonitorTools.optional(ViceMonitorTools.enumeration([0, 1, 2, 3, 4], true)),
            },
        ),
    )
    screenshot(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            {
                path: ViceMonitorTools.path,
                format: ViceMonitorTools.optional(ViceMonitorTools.enumeration([0, 1, 2, 3, 4], true)),
            },
            (values) => ViceMonitorTools.parts("screenshot", values.path, values.format),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_control",
            "Enable profiling (clears existing data) or disable it. Requires profiling support in VICE.",
            {
                state: ViceMonitorTools.enumeration(["on", "off"]),
            },
        ),
    )
    profileControl(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { state: ViceMonitorTools.enumeration(["on", "off"]) },
            (values) => `profile ${values.state}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_flat",
            "Show functions sorted by self time; requires VICE profiling support.",
            {
                count: ViceMonitorTools.optional(ViceMonitorTools.number(1, 1000, true)),
            },
            false,
        ),
    )
    profileFlat(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { count: ViceMonitorTools.optional(ViceMonitorTools.number(1, 1000, true)) },
            (values) => ViceMonitorTools.parts("profile flat", values.count),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_graph",
            "Show a profiling call graph, optionally scoped to a context and depth.",
            {
                context: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647, true)),
                depth: ViceMonitorTools.optional(ViceMonitorTools.number(1, 100, true)),
            },
            false,
        ),
    )
    profileGraph(args: ToolArguments): Promise<string> {
        const fields = {
            context: ViceMonitorTools.optional(ViceMonitorTools.number(0, 2147483647, true)),
            depth: ViceMonitorTools.optional(ViceMonitorTools.number(1, 100, true)),
        };
        return this.fieldCommand(args, fields, (values) =>
            ViceMonitorTools.parts("profile graph", values.context, values.depth ? `depth ${values.depth}` : ""),
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_function",
            "Show aggregate function profiling statistics.",
            { function: ViceMonitorTools.address() },
            false,
        ),
    )
    profileFunction(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { function: ViceMonitorTools.address() },
            (values) => `profile func ${values.function}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_disassemble",
            "Disassemble a profiled function with instruction statistics.",
            { function: ViceMonitorTools.address() },
            false,
        ),
    )
    profileDisassemble(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { function: ViceMonitorTools.address() },
            (values) => `profile disass ${values.function}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool("profile_clear", "Clear profiling statistics for a function.", {
            function: ViceMonitorTools.address(),
        }),
    )
    profileClear(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { function: ViceMonitorTools.address() },
            (values) => `profile clear ${values.function}`,
        );
    }

    @McpUtils.tool(
        ViceMonitorTools.fieldTool(
            "profile_context",
            "Show profiling data for a calling context.",
            {
                context: ViceMonitorTools.number(0, 2147483647, true),
            },
            false,
        ),
    )
    profileContext(args: ToolArguments): Promise<string> {
        return this.fieldCommand(
            args,
            { context: ViceMonitorTools.number(0, 2147483647, true) },
            (values) => `profile context ${values.context}`,
        );
    }
}
