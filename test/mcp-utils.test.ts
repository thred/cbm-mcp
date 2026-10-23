import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { McpUtils, type ToolArguments } from "../src/mcp-utils.js";

const textInput = {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
};

class TestCatalog {
    private readonly prefix = "bound";

    @McpUtils.tool({ name: "test_echo", description: "Echo a value.", inputSchema: textInput })
    async echo(args: ToolArguments): Promise<string> {
        return `${this.prefix}: ${String(args.value)}`;
    }
}

describe("McpUtils decorated catalogs", () => {
    it("builds schemas and formats validated tool arguments with reusable fields", () => {
        const fields = {
            count: McpUtils.numberField(1, 3, true),
            mode: McpUtils.enumerationField(["fast", "safe"]),
            tags: McpUtils.optionalField(
                McpUtils.arrayField(McpUtils.textField(/^[a-z]+$/, "a lowercase tag"), 4, true),
            ),
            path: McpUtils.quotedField("a path"),
        };
        const metadata = McpUtils.toolMetadata("test_fields", "Format typed values.", fields);

        expect(metadata.inputSchema).toMatchObject({
            required: ["count", "mode", "path"],
            additionalProperties: false,
        });
        expect(McpUtils.formatArguments({ count: 2, mode: "fast", path: "/tmp/file" }, fields)).toEqual({
            count: "2",
            mode: "fast",
            tags: "",
            path: '"/tmp/file"',
        });
        expect(() => McpUtils.formatArguments({ extra: true }, fields)).toThrow("Unknown argument: extra");
        expect(() => McpUtils.formatArguments({ count: 2, mode: "fast", path: null }, fields)).toThrow(
            "path must not be null.",
        );
    });

    it("discovers decorated behavior methods and preserves their instance binding", async () => {
        const server = McpUtils.createToolServer("test-catalog", new TestCatalog());
        const client = new Client({ name: "test", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        try {
            expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["test_echo"]);
            const result = await client.callTool({ name: "test_echo", arguments: { value: "hello" } });
            expect(result.content).toEqual([{ type: "text", text: "bound: hello" }]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("rejects duplicate decorated tool names", () => {
        class DuplicateCatalog {
            @McpUtils.tool({ name: "duplicate", description: "First.", inputSchema: textInput })
            first(): string {
                return "first";
            }

            @McpUtils.tool({ name: "duplicate", description: "Second.", inputSchema: textInput })
            second(): string {
                return "second";
            }
        }

        expect(() => McpUtils.createToolServer("duplicate-test", new DuplicateCatalog())).toThrow(
            "Duplicate MCP tool name: duplicate",
        );
    });
});
