import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolArguments = Record<string, unknown>;

export interface McpTool extends Tool {
    run: (args: ToolArguments) => Promise<string>;
}

export type McpToolMetadata = Pick<Tool, "name" | "description" | "inputSchema" | "annotations">;
export type FormattedArguments = Record<string, string>;

export interface ToolField {
    schema: Record<string, unknown>;
    optional?: boolean;
    format: (value: unknown) => string;
}

const decoratedMethods = new WeakMap<object, Map<string | symbol, McpToolMetadata>>();

/** Shared MCP server and argument helpers for the project's separate servers. */
export class McpUtils {
    /** Mark a behavior method as an MCP tool using explicit runtime metadata. */
    static tool(metadata: McpToolMetadata): MethodDecorator {
        return (target, propertyKey) => {
            let methods = decoratedMethods.get(target);
            if (!methods) {
                methods = new Map();
                decoratedMethods.set(target, methods);
            }
            methods.set(propertyKey, metadata);
        };
    }

    /** Validate an integer argument against an inclusive range. */
    static integer(args: ToolArguments, name: string, min: number, max: number, fallback?: number): number {
        const value = args[name] ?? fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${name} must be an integer from ${min} to ${max}.`);
        }
        return value;
    }

    /** Format a number as a VICE-style hexadecimal value. */
    static hex(value: number, width = 4): string {
        return `$${value.toString(16).padStart(width, "0")}`;
    }

    /** Validate a string argument against a fixed set of choices. */
    static choice(args: ToolArguments, name: string, values: readonly string[], fallback?: string): string {
        const value = args[name] ?? fallback;
        if (typeof value !== "string" || !values.includes(value)) {
            throw new Error(`${name} must be one of: ${values.join(", ")}.`);
        }
        return value;
    }

    /** Build MCP tool metadata and an input schema from reusable field definitions. */
    static toolMetadata(
        name: string,
        description: string,
        fields: Record<string, ToolField>,
        annotations?: Tool["annotations"],
    ): McpToolMetadata {
        return {
            name,
            description,
            inputSchema: {
                type: "object",
                properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])),
                required: Object.entries(fields)
                    .filter(([, field]) => !field.optional)
                    .map(([key]) => key),
                additionalProperties: false,
            },
            ...(annotations === undefined ? {} : { annotations }),
        };
    }

    /** Define an inclusive integer field and format its values for commands. */
    static numberField(min = 0, max = 65535, decimal = false): ToolField {
        return {
            schema: { type: "integer", minimum: min, maximum: max },
            format: (value) => {
                if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
                    throw new Error(`Expected an integer from ${min} to ${max}.`);
                }
                return decimal ? String(value) : `$${value.toString(16)}`;
            },
        };
    }

    /** Define a fixed-choice field, optionally formatting numeric choices as hexadecimal. */
    static enumerationField(values: readonly (string | number | boolean)[], hexadecimal = false): ToolField {
        return {
            schema: { type: typeof values[0] === "number" ? "integer" : typeof values[0], enum: values },
            format: (value) => {
                if (!values.includes(value as string | number | boolean)) {
                    throw new Error(`Expected one of: ${values.join(", ")}.`);
                }
                return hexadecimal && typeof value === "number" ? `$${value.toString(16)}` : String(value);
            },
        };
    }

    /** Define a bounded string field constrained by a regular expression. */
    static textField(pattern: RegExp, description: string, maxLength = 4096): ToolField {
        return {
            schema: { type: "string", minLength: 1, maxLength, pattern: pattern.source, description },
            format: (value) => {
                if (
                    typeof value !== "string" ||
                    !value.trim() ||
                    value.length > maxLength ||
                    McpUtils.containsLineBreakOrNull(value) ||
                    !pattern.test(value)
                ) {
                    throw new Error(`Expected ${description} (maximum ${maxLength} characters).`);
                }
                return value;
            },
        };
    }

    /** Define a command-safe quoted string field. */
    static quotedField(description: string, allowEmpty = false): ToolField {
        return {
            schema: { type: "string", minLength: allowEmpty ? 0 : 1, maxLength: 4096, description },
            format: (value) => {
                if (
                    typeof value !== "string" ||
                    (!allowEmpty && !value.trim()) ||
                    value.length > 4096 ||
                    value.includes('"') ||
                    value.includes("\\") ||
                    McpUtils.containsControlCharacter(value)
                ) {
                    throw new Error(
                        `Expected ${description}, without double quotes, backslashes, or control characters.`,
                    );
                }
                return `"${value}"`;
            },
        };
    }

    /** Define a string field for literal text that cannot contain control characters or backslashes. */
    static keyboardTextField(description: string, maxLength = 4096): ToolField {
        return {
            schema: { type: "string", minLength: 1, maxLength, description },
            format: (value) => {
                if (
                    typeof value !== "string" ||
                    !value.trim() ||
                    value.length > maxLength ||
                    value.includes("\\") ||
                    McpUtils.containsControlCharacter(value)
                ) {
                    throw new Error(`Expected ${description}, without backslashes or control characters.`);
                }
                return value;
            },
        };
    }

    /** Make a field optional and supply its command-token fallback when omitted. */
    static optionalField(field: ToolField, fallback = ""): ToolField {
        return { ...field, optional: true, format: (value) => (value === undefined ? fallback : field.format(value)) };
    }

    /** Define a bounded array field and format its entries as space-separated tokens. */
    static arrayField(field: ToolField, maxItems = 256, unique = false): ToolField {
        return {
            schema: { type: "array", items: field.schema, minItems: 1, maxItems, uniqueItems: unique },
            format: (value) => {
                if (
                    !Array.isArray(value) ||
                    value.length < 1 ||
                    value.length > maxItems ||
                    (unique && new Set(value).size !== value.length)
                ) {
                    throw new Error(`Expected 1-${maxItems} ${unique ? "unique " : ""}items.`);
                }
                return value.map((entry) => field.format(entry)).join(" ");
            },
        };
    }

    /** Validate and format all provided values, rejecting unknown or null fields. */
    static formatArguments(args: ToolArguments, fields: Record<string, ToolField>): FormattedArguments {
        for (const key of Object.keys(args)) {
            if (!Object.hasOwn(fields, key)) {
                throw new Error(`Unknown argument: ${key}`);
            }
        }
        return Object.fromEntries(
            Object.entries(fields).map(([key, field]) => {
                if (args[key] === null) {
                    throw new Error(`${key} must not be null.`);
                }
                try {
                    return [key, field.format(args[key])];
                } catch (error) {
                    throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`, {
                        cause: error,
                    });
                }
            }),
        );
    }

    /** Join nonempty formatted arguments into a command token string. */
    static joinArguments(...values: string[]): string {
        return values.filter(Boolean).join(" ");
    }

    private static containsLineBreakOrNull(value: string): boolean {
        for (const character of value) {
            const code = character.charCodeAt(0);
            if (code === 0x0a || code === 0x0d || code === 0x00) {
                return true;
            }
        }
        return false;
    }

    private static containsControlCharacter(value: string): boolean {
        for (const character of value) {
            const code = character.charCodeAt(0);
            if (code < 0x20 || code === 0x7f) {
                return true;
            }
        }
        return false;
    }

    /** Create a protocol server from either a decorated catalog or an existing tool array. */
    static createToolServer(
        name: string,
        catalog: object,
        options?: { version?: string; instructions?: string; isError?: (text: string) => boolean },
    ): Server;
    static createToolServer(
        name: string,
        tools: McpTool[],
        options?: { version?: string; instructions?: string; isError?: (text: string) => boolean },
    ): Server;
    static createToolServer(
        name: string,
        catalogOrTools: object | McpTool[],
        options: { version?: string; instructions?: string; isError?: (text: string) => boolean } = {},
    ): Server {
        const tools = Array.isArray(catalogOrTools) ? catalogOrTools : this.decoratedTools(catalogOrTools);
        const names = new Set<string>();
        for (const tool of tools) {
            if (names.has(tool.name)) {
                throw new Error(`Duplicate MCP tool name: ${tool.name}`);
            }
            names.add(tool.name);
        }
        const server = new Server(
            { name, version: options.version ?? "1.0.0" },
            { capabilities: { tools: {} }, instructions: options.instructions },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: tools.map((tool) => {
                const { run: unused, ...toolWithoutRun } = tool;
                void unused;
                return toolWithoutRun;
            }),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const tool = tools.find((entry) => entry.name === request.params.name);
                if (!tool) {
                    throw new Error(`Unknown tool: ${request.params.name}`);
                }
                const args = request.params.arguments ?? {};
                for (const argumentName of Object.keys(args)) {
                    if (!Object.hasOwn(tool.inputSchema.properties ?? {}, argumentName)) {
                        throw new Error(`Unknown argument: ${argumentName}`);
                    }
                    if (args[argumentName] === null) {
                        throw new Error(`${argumentName} must not be null.`);
                    }
                }
                const text = await tool.run(args);
                if (options.isError?.(text)) {
                    throw new Error(text);
                }
                return { content: [{ type: "text", text: text || "Command completed." }] };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                };
            }
        });
        return server;
    }

    private static decoratedTools(catalog: object): McpTool[] {
        const tools: McpTool[] = [];
        for (
            let prototype = Object.getPrototypeOf(catalog);
            prototype && prototype !== Object.prototype;
            prototype = Object.getPrototypeOf(prototype)
        ) {
            for (const methodName of Object.getOwnPropertyNames(prototype)) {
                const metadata = decoratedMethods.get(prototype)?.get(methodName);
                const method = Object.getOwnPropertyDescriptor(prototype, methodName)?.value;
                if (!metadata || typeof method !== "function") {
                    continue;
                }
                tools.push({
                    ...metadata,
                    run: async (args) => {
                        const result: unknown = await Reflect.apply(method, catalog, [args]);
                        if (typeof result !== "string") {
                            throw new Error(`Tool ${metadata.name} must return text.`);
                        }
                        return result;
                    },
                });
            }
        }
        return tools;
    }
}
