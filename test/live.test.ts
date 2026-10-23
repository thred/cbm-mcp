import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** Opt-in: pauses VICE and creates/removes a checkpoint and label; never writes memory or CPU registers. */
it.skipIf(process.env.VICE_LIVE_TEST !== "1")(
    "inspects local VICE through the built stdio MCP",
    async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL("../dist/stdio.js", import.meta.url))],
            env: { ...process.env } as Record<string, string>,
            stderr: "pipe",
        });
        let stderr = "";
        const client = new Client({ name: "live-test", version: "1" });
        try {
            await client.connect(transport);
            transport.stderr?.on("data", (chunk) => {
                stderr += String(chunk);
            });
            expect(client.getInstructions()).toContain("Never blindly retry a timed-out mutation");
            expect((await client.listTools()).tools.length).toBeGreaterThan(90);
            for (const [name, args, pattern] of [
                ["vice_registers", {}, /ADDR|PC/i],
                ["vice_memory", { start: 1024, length: 16 }, /0400/i],
                ["vice_memory", { start: 1024, length: 16, format: "petscii" }, /0400/i],
                ["vice_memory", { start: 1024, length: 16, format: "screen_codes" }, /0400/i],
                ["vice_disassemble", { start: 58816, length: 16 }, /e5c0/i],
                ["vice_help", { command: "break" }, /break/i],
                ["vice_sidefx", {}, /side effects/i],
                ["vice_evaluate", { expression: "$1000 + $1" }, /4097/],
                ["vice_convert", { value: 255 }, /255|ff/i],
                ["vice_resource_get", { name: "MachineVideoStandard" }, /MachineVideoStandard/i],
                ["vice_directory_list", { path: fileURLToPath(new URL("..", import.meta.url)) }, /package\.json/],
            ] as const) {
                const result = await client.callTool({ name, arguments: args });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
                expect(result.content).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ type: "text", text: expect.stringMatching(pattern) }),
                    ]),
                );
            }
            for (const name of [
                "vice_breakpoints",
                "vice_backtrace",
                "vice_screen",
                "vice_bank",
                "vice_radix",
                "vice_stopwatch",
                "vice_directory_current",
                "vice_labels",
                "vice_log",
                "vice_checkpoint_dummy",
                "vice_expansions",
            ]) {
                const result = await client.callTool({ name });
                expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
            }
            const label = `.mcp_live_${process.pid}_${Date.now()}`;
            const added = await client.callTool({ name: "vice_label_add", arguments: { address: 1024, label } });
            expect(added.isError, JSON.stringify(added)).not.toBe(true);
            try {
                const symbolic = await client.callTool({
                    name: "vice_memory_range",
                    arguments: { start: label, end: label },
                });
                expect(symbolic.isError, JSON.stringify(symbolic)).not.toBe(true);
                expect(JSON.stringify(symbolic.content)).toMatch(/0400/);
            } finally {
                const removed = await client.callTool({ name: "vice_label_delete", arguments: { label } });
                expect(removed.isError, JSON.stringify(removed)).not.toBe(true);
            }
            const breakpoint = await client.callTool({ name: "vice_breakpoint_set", arguments: { start: 65535 } });
            expect(breakpoint.isError, JSON.stringify(breakpoint)).not.toBe(true);
            const match = /\bBREAK:\s*(\d+)\b/i.exec(JSON.stringify(breakpoint.content));
            expect(match, JSON.stringify(breakpoint)).not.toBeNull();
            const id = Number(match![1]);
            try {
                for (const enabled of [false, true]) {
                    const result = await client.callTool({
                        name: "vice_checkpoint_toggle",
                        arguments: { id, enabled },
                    });
                    expect(result.isError, JSON.stringify(result)).not.toBe(true);
                }
                const listed = await client.callTool({ name: "vice_breakpoints" });
                expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
                expect(JSON.stringify(listed.content)).toContain(`BREAK: ${id}`);
            } finally {
                const removed = await client.callTool({ name: "vice_checkpoint_delete", arguments: { id } });
                expect(removed.isError, JSON.stringify(removed)).not.toBe(true);
            }
            await client.callTool({ name: "vice_disconnect" });
            const status = await client.callTool({ name: "vice_status" });
            expect(JSON.stringify(status.content)).toContain('\\"connected\\":false');
            expect(stderr).toBe("");
        } finally {
            await client.close();
        }
    },
    20000,
);
