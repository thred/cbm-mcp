import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createViceServer } from "../src/server.js";
import { MonitorClient } from "../src/vice/monitor-client.js";
import { encodeCommodoreText } from "../src/vice/text-encoding.js";

type CommandCase = [
    name: string,
    args: Record<string, unknown>,
    command: string,
    mode?: "execute" | "send" | "assemble",
];

const commandCases: CommandCase[] = [
    ["evaluate", { expression: "A + $01" }, "print A + $01"],
    ["convert", { value: 255 }, "~ $ff"],
    ["device", { space: "8:" }, "device 8:"],
    ["bank", { name: "ram" }, "bank ram"],
    ["cpu", { type: "z80" }, "cpu z80"],
    ["radix", { radix: "D" }, "radix D"],
    ["goto", { address: ".entry" }, "goto .entry", "send"],
    ["step_out", {}, "return"],
    ["run_until", { address: 4096 }, "until $1000"],
    ["io", { address: 53248 }, "io $d000"],
    ["stopwatch", { action: "reset" }, "stopwatch reset"],
    ["cpu_history", { count: 16, spaces: ["C:", "8:"] }, "cpuhistory 16 C: 8:"],
    ["reset", { type: 1, confirm: true }, "reset $1", "send"],
    ["quit", { confirm: true }, "quit", "send"],
    ["warp", { state: "on" }, "warp on"],
    ["cartridge_freeze", {}, "cartfreeze", "send"],
    ["expansions", {}, "export"],
    ["keyboard", { codes: [65, 13, 0] }, "keybuf \\x41\\x0d\\x00"],
    ["memory_compare", { start: 4096, end: 4111, destination: 8192 }, "compare $1000 $100f $2000"],
    ["memory_move", { start: "8:$1000", end: "8:$100f", destination: "8:$2000" }, "move 8:$1000 8:$100f 8:$2000"],
    ["memory_fill", { start: 4096, end: 4111, bytes: [0, 255] }, "fill $1000 $100f $0 $ff"],
    ["memory_hunt", { start: 0, end: 65535, bytes: [169, "xx"] }, "hunt $0000 $ffff $a9 xx"],
    ["memory_petscii", { start: 1024, end: 1039 }, "i $0400 $040f"],
    ["memory_screen_codes", { start: 1024 }, "ii $0400 $0400"],
    ["memory_characters", { start: 8192, end: 8199 }, "memchar $2000 $2007"],
    ["memory_sprites", { start: 8192, end: 8255 }, "memsprite $2000 $203f"],
    ["memory_range", { start: ".screen", end: ".screen_end" }, "mem H .screen .screen_end"],
    ["disassemble_range", { start: "8:$1000", end: "8:$1010" }, "disass 8:$1000 8:$1010"],
    ["memmap_show", { mask: 255, start: 0, end: 65535 }, "memmapshow $ff $0000 $ffff"],
    ["memmap_clear", {}, "memmapzap"],
    ["memmap_save", { path: "/tmp/access map.png", format: 2 }, 'memmapsave "/tmp/access map.png" $2'],
    ["assemble", { address: ".entry", instruction: "LDA #$01" }, "a .entry LDA #$01", "assemble"],
    ["register_write", { register: "AF", value: 65535 }, "registers AF = $ffff"],
    ["tracepoint_set", { start: 4096, condition: "A == $01" }, "trace exec $1000 $1000 if A == $01"],
    ["watchpoint_set", { start: 53280, operations: ["store"] }, "watch store $d020 $d020"],
    [
        "checkpoint_condition",
        { id: 12, expression: "X == $0a && @io:$d020 == $00" },
        "condition 12 if X == $0a && @io:$d020 == $00",
    ],
    ["checkpoint_ignore", { id: 12, count: 10 }, "ignore 12 $a"],
    ["checkpoint_command", { id: 12, command: "registers" }, 'command 12 "registers"'],
    ["checkpoint_dummy", { state: "off" }, "dummy off"],
    ["label_add", { address: 4096, label: ".entry" }, "add_label $1000 .entry"],
    ["label_delete", { label: ".entry", space: "C:" }, "delete_label C: .entry"],
    ["labels", { space: "8:" }, "show_labels 8:"],
    ["labels_clear", { space: "C:" }, "clear_labels C:"],
    ["labels_load", { path: "/tmp/game.lbl", space: "C:" }, 'load_labels C: "/tmp/game.lbl"'],
    ["labels_save", { path: "/tmp/game.lbl" }, 'save_labels "/tmp/game.lbl"'],
    ["snapshot_save", { path: "/tmp/game.vsf" }, 'dump "/tmp/game.vsf"'],
    ["snapshot_load", { path: "/tmp/game.vsf" }, 'undump "/tmp/game.vsf"', "send"],
    ["directory_change", { path: "/tmp" }, 'cd "/tmp"'],
    ["directory_create", { path: "/tmp/game" }, 'mkdir "/tmp/game"'],
    ["directory_remove", { path: "/tmp/game" }, 'rmdir "/tmp/game"'],
    ["log_file", { path: "/tmp/vice.log" }, 'logname "/tmp/vice.log"'],
    ["record", { path: "/tmp/commands.mon" }, 'record "/tmp/commands.mon"'],
    ["playback", { path: "/tmp/commands.mon" }, 'playback "/tmp/commands.mon"', "send"],
    ["resources_load", { path: "/tmp/vice.ini" }, 'load_resources "/tmp/vice.ini"', "send"],
    ["resources_save", { path: "/tmp/vice.ini" }, 'save_resources "/tmp/vice.ini"'],
    ["directory_list", { path: "/tmp" }, "dir /tmp"],
    ["directory_current", {}, "pwd"],
    ["record_stop", {}, "stop"],
    ["comment", { text: "before setup" }, "; before setup"],
    ["log", { state: "on" }, "log on"],
    ["resource_get", { name: "MachineVideoStandard" }, 'resourceget "MachineVideoStandard"'],
    ["resource_set", { name: "WarpMode", value: "0" }, 'resourceset "WarpMode" "0"', "send"],
    ["media_attach", { path: "/tmp/game.d64", device: 8 }, 'attach "/tmp/game.d64" $8'],
    ["media_detach", { device: 32 }, "detach $20"],
    ["autostart", { path: "/tmp/game.prg", index: 1 }, 'autostart "/tmp/game.prg" $1', "send"],
    ["autoload", { path: "/tmp/game.prg" }, 'autoload "/tmp/game.prg"', "send"],
    ["program_load", { path: "/tmp/game.prg", device: 0 }, 'load "/tmp/game.prg" 0'],
    ["basic_load", { path: "/tmp/game.prg", device: 0, address: 2049 }, 'loadbasic "/tmp/game.prg" 0 $0801'],
    ["program_verify", { path: "/tmp/game.prg", device: 8, address: 4096 }, 'verify "/tmp/game.prg" 8 $1000'],
    ["binary_load", { path: "/tmp/game.bin", device: 0, address: 4096 }, 'bload "/tmp/game.bin" 0 $1000'],
    ["binary_verify", { path: "/tmp/game.bin", device: 0, address: 4096 }, 'bverify "/tmp/game.bin" 0 $1000'],
    [
        "program_save",
        { path: "/tmp/game.prg", device: 0, start: 4096, end: 4111 },
        'save "/tmp/game.prg" 0 $1000 $100f',
    ],
    [
        "binary_save",
        { path: "/tmp/game.bin", device: 0, start: 4096, end: 4111 },
        'bsave "/tmp/game.bin" 0 $1000 $100f',
    ],
    ["disk_list", { device: 8 }, "list 8"],
    ["disk_command", { command: "I0" }, "@I0"],
    ["block_read", { track: 18, sector: 0 }, "block_read $12 $0"],
    ["block_write", { track: 18, sector: 1, address: 4096 }, "block_write $12 $1 $1000"],
    ["tape_control", { command: 0 }, "tapectrl $0"],
    ["tape_offset", { offset: 256 }, "tapeoffs $100"],
    ["screenshot", { path: "/tmp/screen.png", format: 2 }, 'screenshot "/tmp/screen.png" $2'],
    ["profile_control", { state: "on" }, "profile on"],
    ["profile_flat", { count: 20 }, "profile flat 20"],
    ["profile_graph", { context: 1, depth: 3 }, "profile graph 1 depth 3"],
    ["profile_function", { function: ".entry" }, "profile func .entry"],
    ["profile_disassemble", { function: 4096 }, "profile disass $1000"],
    ["profile_clear", { function: 4096 }, "profile clear $1000"],
    ["profile_context", { context: 12 }, "profile context 12"],
];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
    vi.restoreAllMocks();
});

async function setup() {
    const monitor = new MonitorClient();
    const execute = vi.spyOn(monitor, "execute").mockResolvedValue("monitor output");
    const send = vi.spyOn(monitor, "send").mockResolvedValue(undefined);
    const assemble = vi.spyOn(monitor, "assemble").mockResolvedValue("assembled");
    const server = createViceServer(monitor);
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, monitor, execute, send, assemble };
}

describe("VICE MCP tools", () => {
    it("provides debugger workflow instructions during initialization without contacting VICE", async () => {
        const { client, execute, send, assemble } = await setup();
        const instructions = client.getInstructions();
        expect(instructions!.length).toBeLessThan(1800);
        for (const guidance of [
            "vice_status",
            "Use the current PC",
            "pauses emulation",
            "53280 = $d020",
            "vice_sidefx",
            "Never blindly retry a timed-out mutation",
            "Command completed.",
            "Keep emulation running when no active debugging need requires a pause",
            "Longer pauses are fine when justified",
        ]) {
            expect(instructions).toContain(guidance);
        }
        expect(execute).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(assemble).not.toHaveBeenCalled();
    });

    it("advertises interpretation caveats on the relevant tools", async () => {
        const { client } = await setup();
        const { tools } = await client.listTools();
        for (const [name, caveat] of [
            ["vice_backtrace", "not a reliable source-level stack"],
            ["vice_screen", "does not establish current CPU activity"],
            ["vice_resource_get", "documented mapping"],
            ["vice_keyboard", "Resume to process input"],
            ["vice_keyboard", "never both"],
            ["vice_keyboard", "inspect before retrying"],
            ["vice_keyboard", "inspection may pause loading"],
            ["vice_keyboard", "PETSCII codes"],
        ]) {
            const description = tools.find((tool) => tool.name === name)?.description;
            expect(description).toContain(caveat);
            expect(description!.length).toBeLessThan(250);
        }
    });

    it("advertises unique tools and reports status without contacting VICE", async () => {
        const { client, execute } = await setup();
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(90);
        expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
        const result = await client.callTool({ name: "vice_status" });
        expect(result.content).toEqual([
            { type: "text", text: JSON.stringify({ host: "127.0.0.1", port: 6510, connected: false }) },
        ]);
        expect(execute).not.toHaveBeenCalled();
    });

    it("formats bounded, radix-independent commands", async () => {
        const { client, execute } = await setup();
        await client.callTool({ name: "vice_memory", arguments: { start: 1024, length: 16 } });
        expect(execute).toHaveBeenLastCalledWith("mem H C:$0400 C:$040f");
        await client.callTool({ name: "vice_disassemble", arguments: { start: 65535, length: 1 } });
        expect(execute).toHaveBeenLastCalledWith("disass C:$ffff C:$ffff");
        await client.callTool({ name: "vice_step", arguments: { mode: "over", count: 10 } });
        expect(execute).toHaveBeenLastCalledWith("next $000a");
        await client.callTool({ name: "vice_step" });
        expect(execute).toHaveBeenLastCalledWith("step $0001");
    });

    it("submits keyboard text or codes with one command without implicitly resuming", async () => {
        const { client, execute, send } = await setup();
        for (const args of [
            { text: "look", submit: true },
            { codes: [76, 79, 79, 75], submit: true },
        ]) {
            const result = await client.callTool({ name: "vice_keyboard", arguments: args });
            expect(result.isError).not.toBe(true);
        }
        expect(execute.mock.calls).toEqual([["keybuf look\\x0d"], ["keybuf \\x4c\\x4f\\x4f\\x4b\\x0d"]]);
        expect(send).not.toHaveBeenCalled();
    });

    it("converts text locally without contacting or pausing VICE", async () => {
        const { client, execute, send, assemble } = await setup();
        for (const [encoding, bytes] of [
            ["ascii", [72, 105]],
            ["petscii", [72, 73]],
            ["screen_codes", [8, 9]],
        ] as const) {
            const result = await client.callTool({ name: "vice_convert", arguments: { text: "Hi", encoding } });
            expect(result.isError).not.toBe(true);
            expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ encoding, bytes }) }]);
        }
        expect(execute).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(assemble).not.toHaveBeenCalled();
    });

    it("has a command-formatting case for every additional tool", async () => {
        const { client } = await setup();
        const legacy = new Set(
            [
                "status",
                "connect",
                "disconnect",
                "registers",
                "memory",
                "disassemble",
                "step",
                "breakpoints",
                "breakpoint_set",
                "checkpoint_delete",
                "checkpoint_toggle",
                "register_set",
                "memory_write",
                "help",
                "backtrace",
                "screen",
                "sidefx",
                "resume",
            ].map((name) => `vice_${name}`),
        );
        const { tools } = await client.listTools();
        expect(
            tools
                .filter((tool) => !legacy.has(tool.name))
                .map((tool) => tool.name)
                .sort(),
        ).toEqual(commandCases.map(([name]) => `vice_${name}`).sort());
    });

    it.each(commandCases)("formats additional %s arguments %j", async (name, args, command, mode = "execute") => {
        const context = await setup();
        const result = await context.client.callTool({ name: `vice_${name}`, arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(context[mode]).toHaveBeenCalledExactlyOnceWith(command);
        for (const other of ["execute", "send", "assemble"] as const) {
            if (other !== mode) expect(context[other]).not.toHaveBeenCalled();
        }
    });

    it.each(commandCases)("rejects unknown and null arguments for additional %s", async (name, args) => {
        const context = await setup();
        const tool = (await context.client.listTools()).tools.find((entry) => entry.name === `vice_${name}`)!;
        for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
            const result = await context.client.callTool({ name: tool.name, arguments: { ...args, [key]: null } });
            expect(result.isError, `${tool.name}.${key}`).toBe(true);
        }
        const result = await context.client.callTool({ name: tool.name, arguments: { ...args, unknown: true } });
        expect(result.isError).toBe(true);
        expect(context.execute).not.toHaveBeenCalled();
        expect(context.send).not.toHaveBeenCalled();
        expect(context.assemble).not.toHaveBeenCalled();
    });

    it.each([
        ["evaluate", { expression: "A == 1; quit" }],
        ["evaluate", { expression: "A == 1\nquit" }],
        ["evaluate", { expression: " " }],
        ["convert", {}],
        ["convert", { value: 1, text: "A" }],
        ["convert", { value: 1, encoding: "ascii" }],
        ["convert", { text: "A", encoding: "unknown" }],
        ["convert", { text: "\u00e9" }],
        ["convert", { text: "A", encoding: null }],
        ["goto", { address: ".entry;quit" }],
        ["goto", { address: 65536 }],
        ["device", { space: "12:" }],
        ["bank", { name: "ram;quit" }],
        ["assemble", { address: 4096, instruction: "NOP : quit" }],
        ["assemble", { address: 4096, instruction: "NOP\nquit" }],
        ["memory_fill", { start: 16, end: 15, bytes: [0] }],
        ["memory_fill", { start: 0, bytes: [256] }],
        ["memory_hunt", { start: 0, bytes: ["yy"] }],
        ["snapshot_save", { path: '/tmp/file"; quit' }],
        ["snapshot_save", { path: "/tmp/file\nquit" }],
        ["snapshot_save", { path: "" }],
        ["quit", {}],
        ["quit", { confirm: false }],
        ["reset", { type: 0, confirm: "true" }],
        ["reset", { type: 2, confirm: true }],
        ["label_add", { address: 4096, label: "entry" }],
        ["label_add", { address: 4096, label: ".entry\nquit" }],
        ["tracepoint_set", { start: 0, operations: ["exec", "exec"] }],
        ["tracepoint_set", { start: 0, condition: "X == 0; quit" }],
        ["checkpoint_command", { id: 1, command: 'registers"; quit' }],
        ["disk_command", { command: "I0;quit" }],
        ["media_attach", { path: "/tmp/game.d64", device: 0 }],
        ["keyboard", {}],
        ["keyboard", { text: "A", codes: [65] }],
        ["goto", { address: "8:.entry" }],
        ["cpu_history", { count: 1, spaces: ["C:", "C:"] }],
        ["memmap_show", { start: 0 }],
        ["memmap_show", { mask: 255, end: 1 }],
        ["profile_graph", { depth: 101 }],
    ])("rejects unsafe additional %s arguments %j", async (name, args) => {
        const context = await setup();
        const result = await context.client.callTool({ name: `vice_${name}`, arguments: args });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(context.execute).not.toHaveBeenCalled();
        expect(context.send).not.toHaveBeenCalled();
        expect(context.assemble).not.toHaveBeenCalled();
    });

    it.each([
        ["bank", {}, "bank"],
        ["radix", {}, "radix"],
        ["device", {}, "device"],
        ["cpu_history", {}, "cpuhistory"],
        ["cpu_history", { spaces: ["C:"] }, "cpuhistory C:"],
        ["io", {}, "io"],
        ["stopwatch", {}, "stopwatch"],
        ["warp", {}, "warp"],
        ["log", {}, "log"],
        ["checkpoint_dummy", {}, "dummy"],
        ["memmap_show", {}, "memmapshow"],
        ["tape_offset", {}, "tapeoffs"],
        ["profile_graph", { depth: 2 }, "profile graph depth 2"],
        ["keyboard", { text: "RUN" }, "keybuf RUN"],
        ["keyboard", { text: 'PRINT"HI"' }, 'keybuf PRINT"HI"'],
        ["directory_list", { path: "/tmp/folder with spaces" }, "dir /tmp/folder with spaces"],
        ["checkpoint_command", { id: 1, command: "" }, 'command 1 ""'],
    ])("supports optional arguments for %s", async (name, args, command) => {
        const { client, execute } = await setup();
        expect((await client.callTool({ name: `vice_${name}`, arguments: args })).isError).not.toBe(true);
        expect(execute).toHaveBeenCalledExactlyOnceWith(command);
    });

    it.each([
        ["vice_breakpoints", {}, "break"],
        ["vice_breakpoint_set", { start: 4096 }, "break exec C:$1000 C:$1000"],
        [
            "vice_breakpoint_set",
            { start: 53280, end: 53281, operations: ["load", "store"] },
            "break load store C:$d020 C:$d021",
        ],
        ["vice_checkpoint_delete", { id: 12 }, "delete 12"],
        ["vice_checkpoint_toggle", { id: 12, enabled: false }, "disable 12"],
        ["vice_checkpoint_toggle", { id: 12, enabled: true }, "enable 12"],
        ["vice_register_set", { register: "PC", value: 65535 }, "registers PC = $ffff"],
        ["vice_register_set", { register: "A", value: 255 }, "registers A = $00ff"],
        ["vice_memory_write", { start: 4096, bytes: [0, 169, 255] }, "> C:$1000 $00 $a9 $ff"],
        ["vice_memory_write", { start: 65535, bytes: [255] }, "> C:$ffff $ff"],
        [
            "vice_memory_write",
            { start: 1024, text: "Hello!", encoding: "screen_codes" },
            "> C:$0400 $08 $05 $0c $0c $0f $21",
        ],
        ["vice_memory_write", { start: 4096, text: "Hi" }, "> C:$1000 $48 $49"],
        ["vice_memory_write", { start: 4096, text: "Hi", encoding: "ascii" }, "> C:$1000 $48 $69"],
        ["vice_memory", { start: 1024, length: 8, format: "petscii" }, "i C:$0400 C:$0407"],
        ["vice_memory", { start: 1024, length: 8, format: "screen_codes" }, "ii C:$0400 C:$0407"],
        ["vice_help", {}, "help"],
        ["vice_help", { command: "break" }, "help break"],
        ["vice_help", { command: ">" }, "help >"],
        ["vice_backtrace", {}, "backtrace"],
        ["vice_screen", {}, "screen"],
        ["vice_sidefx", {}, "sidefx"],
        ["vice_sidefx", { enabled: false }, "sidefx off"],
        ["vice_sidefx", { enabled: true }, "sidefx on"],
    ])("formats %s arguments %j as %s", async (name, args, command) => {
        const { client, execute } = await setup();
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(execute).toHaveBeenCalledExactlyOnceWith(command);
    });

    it("marks register and memory writes as destructive", async () => {
        const { client } = await setup();
        const { tools } = await client.listTools();
        for (const name of ["vice_register_set", "vice_memory_write", "vice_checkpoint_delete"]) {
            expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
                readOnlyHint: false,
                destructiveHint: true,
            });
        }
    });

    it.each([
        ["vice_memory", { start: "1024" }],
        ["vice_memory", { start: 0, length: null }],
        ["vice_memory", { start: 65535, length: 2 }],
        ["vice_memory", { start: 0, length: 257 }],
        ["vice_memory", { start: 1.5 }],
        ["vice_memory", {}],
        ["vice_memory", { start: 1024, format: "unknown" }],
        ["vice_registers", { command: "quit" }],
        ["vice_step", { mode: "into\nquit" }],
        ["vice_step", { count: 0 }],
        ["vice_breakpoint_set", {}],
        ["vice_breakpoint_set", { start: 4096, end: 4095 }],
        ["vice_breakpoint_set", { start: 0, end: 65536 }],
        ["vice_breakpoint_set", { start: 0, operations: [] }],
        ["vice_breakpoint_set", { start: 0, operations: "exec" }],
        ["vice_breakpoint_set", { start: 0, operations: ["exec", "exec"] }],
        ["vice_breakpoint_set", { start: 0, operations: ["exec; quit"] }],
        ["vice_breakpoint_set", { start: 0, operations: [null] }],
        ["vice_checkpoint_delete", {}],
        ["vice_checkpoint_delete", { id: 0 }],
        ["vice_checkpoint_delete", { id: "1; quit" }],
        ["vice_checkpoint_toggle", { id: 1 }],
        ["vice_checkpoint_toggle", { id: 1, enabled: "off" }],
        ["vice_register_set", { register: "A", value: 256 }],
        ["vice_register_set", { register: "PC", value: 65536 }],
        ["vice_register_set", { register: "A; quit", value: 0 }],
        ["vice_register_set", { register: "PC" }],
        ["vice_memory_write", { start: 0, bytes: [] }],
        ["vice_memory_write", { start: 0, bytes: Array(257).fill(0) }],
        ["vice_memory_write", { start: 65535, bytes: [0, 1] }],
        ["vice_memory_write", { start: 0, bytes: [256] }],
        ["vice_memory_write", { start: 0, bytes: [-1] }],
        ["vice_memory_write", { start: 0, bytes: [1.5] }],
        ["vice_memory_write", { start: 0, bytes: ["0; quit"] }],
        ["vice_memory_write", { start: 0, bytes: [null] }],
        ["vice_memory_write", { start: 0 }],
        ["vice_memory_write", { start: 0, bytes: [0], text: "A" }],
        ["vice_memory_write", { start: 0, bytes: [0], encoding: "ascii" }],
        ["vice_memory_write", { start: 0, text: "A", encoding: "unknown" }],
        ["vice_memory_write", { start: 0, text: "" }],
        ["vice_memory_write", { start: 0, text: "A".repeat(257) }],
        ["vice_memory_write", { start: 65535, text: "AB" }],
        ["vice_memory_write", { start: 0, text: "a\nquit" }],
        ["vice_memory_write", { start: 0, text: "\\" }],
        ["vice_memory_write", { start: 0, text: "\u00e9" }],
        ["vice_help", { command: "break; quit" }],
        ["vice_help", { command: "break\nquit" }],
        ["vice_help", { command: "" }],
        ["vice_sidefx", { enabled: "off" }],
        ["nonexistent", {}],
    ])("rejects invalid %s arguments %j before contacting VICE", async (name, args) => {
        const { client, execute } = await setup();
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
        expect(execute).not.toHaveBeenCalled();
    });

    it("returns monitor and network failures as MCP tool errors", async () => {
        const { client, execute } = await setup();
        execute.mockResolvedValueOnce("ERROR -- Invalid command");
        expect((await client.callTool({ name: "vice_registers" })).isError).toBe(true);
        execute.mockRejectedValueOnce(new Error("Connection refused"));
        expect((await client.callTool({ name: "vice_registers" })).isError).toBe(true);
        expect((await client.callTool({ name: "vice_registers" })).isError).toBeUndefined();
    });
});

describe("Commodore text encoding", () => {
    it("preserves printable ASCII when requested", () => {
        const text = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("");
        expect(encodeCommodoreText(text, "ascii")).toEqual(Array.from({ length: 95 }, (_, index) => index + 32));
    });

    it("folds letters and maps the standard C64 screen-code ranges", () => {
        expect(encodeCommodoreText("aAzZ @[]09!?", "petscii")).toEqual([
            65, 65, 90, 90, 32, 64, 91, 93, 48, 57, 33, 63,
        ]);
        expect(encodeCommodoreText("aAzZ @[]09!?", "screen_codes")).toEqual([
            1, 1, 26, 26, 32, 0, 27, 29, 48, 57, 33, 63,
        ]);
    });

    it.each(["\\", "^", "_", "`", "{", "|", "}", "~", "\n", "\u00e9", "\u{1f600}"])(
        "rejects unsupported C64 text %j rather than substituting a glyph",
        (text) => {
            expect(() => encodeCommodoreText(text, "petscii")).toThrow();
            expect(() => encodeCommodoreText(text, "screen_codes")).toThrow();
        },
    );
});
