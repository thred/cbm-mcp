import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { McpTool, ToolArguments } from "../mcp-utils.js";
import { McpUtils } from "../mcp-utils.js";
import { C64AnalysisQueries, type C64ReferenceAccess, type C64SearchKind } from "./c64-analysis-queries.js";
import { C64AnalysisState } from "./c64-analysis-state.js";
import { writeAnalysisFile } from "./analysis-file.js";
import { formatC64ControlFlowGraph } from "./c64-analysis-format.js";
import { detectC64BasicProgram } from "./c64-basic-program.js";
import type { C64ControlFlowGraph, C64EntryPoint } from "./c64-control-flow.js";
import { captureC64Ram } from "./c64-live-capture.js";
import { C64Prg } from "./c64-prg.js";
import { C64_PRG_DEFAULT_BANKING, c64PossibleMemoryViews } from "./c64-system-annotations.js";
import { C6510Decoder } from "./c6510-decoder.js";
import type { MonitorClient } from "../vice/monitor-client.js";

const addressSchema = { type: "integer", minimum: 0, maximum: 65535, description: "Decimal 16-bit address." };
const pagination = {
    offset: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
};
const snapshot = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "Snapshot ID returned by vice_analysis_create or vice_analysis_capture.",
};

function stringArgument(args: ToolArguments, name: string, maxLength: number): string {
    const value = args[name];
    if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
        throw new Error(`${name} must be a nonempty string of at most ${maxLength} characters without NUL.`);
    }
    return value;
}

function optionalBoolean(args: ToolArguments, name: string, fallback: boolean): boolean {
    const value = args[name] ?? fallback;
    if (typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean.`);
    }
    return value;
}

function compareCandidateCode(graph: C64ControlFlowGraph, bytes: Uint8Array) {
    const addresses = new Set<number>();
    let changed = 0;
    for (const instruction of graph.instructions) {
        for (let offset = 0; offset < instruction.bytes.length; offset++) {
            const address = instruction.address + offset;
            if (!addresses.has(address)) {
                addresses.add(address);
                if (instruction.bytes[offset] !== bytes[address]) {
                    changed++;
                }
            }
        }
    }
    const compared = addresses.size;
    return { compared, changed, possibleProgramChange: compared >= 64 && changed >= 64 && changed * 2 > compared };
}

function pageArguments(args: ToolArguments) {
    return {
        offset: McpUtils.integer(args, "offset", 0, 1000000, 0),
        limit: McpUtils.integer(args, "limit", 1, 100, 25),
    };
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile()) {
            throw new Error("Analysis input must be a regular file.");
        }
        if (stat.size > maximum) {
            throw new Error(`Analysis input exceeds ${maximum} bytes.`);
        }
        const data = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < data.length) {
            const result = await file.read(data, length, data.length - length, null);
            if (result.bytesRead === 0) {
                break;
            }
            length += result.bytesRead;
        }
        if (length > maximum) {
            throw new Error(`Analysis input exceeds ${maximum} bytes.`);
        }
        return data.subarray(0, length);
    } finally {
        await file.close();
    }
}

/** Create one isolated, replaceable offline analysis per MCP server session. */
export function createC64AnalysisTools(monitor: MonitorClient): McpTool[] {
    let current: { state: C64AnalysisState; graph: C64ControlFlowGraph; queries: C64AnalysisQueries } | undefined;
    const getCurrent = (args: ToolArguments) => {
        const id = stringArgument(args, "snapshotId", 128);
        if (!current || current.graph.snapshotId !== id) {
            throw new Error("Analysis snapshot not found in this session. Create or restore it again.");
        }
        return current;
    };
    const setCurrent = (state: C64AnalysisState, graph: C64ControlFlowGraph) => {
        current = {
            state,
            graph,
            queries: new C64AnalysisQueries(
                graph,
                state.matchAnnotations(graph),
                state.dataSectionStatuses(graph),
                state.correctionStatuses(graph),
            ),
        };
    };
    const tools: McpTool[] = [
        {
            name: "vice_analysis_status",
            description:
                "Show the current session analysis identity and capture metadata without connecting to VICE. Program identity is not verified against the running machine.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            run: async () =>
                JSON.stringify(
                    current
                        ? {
                              active: true,
                              programId: current.graph.programId,
                              viewId: current.graph.viewId,
                              snapshotId: current.graph.snapshotId,
                              captureMetadata: current.state.captureMetadata(current.graph.viewId),
                              instructions: current.graph.instructions.length,
                              blocks: current.graph.blocks.length,
                              identityVerified: false,
                          }
                        : { active: false },
                ),
        },
        {
            name: "vice_analysis_capture",
            description:
                "Capture C64 RAM with consent. Use a new programId without snapshotId to replace the session analysis; use snapshotId only for the same program. Large code changes require explicit confirmation.",
            inputSchema: {
                type: "object",
                properties: {
                    machine: { type: "string", enum: ["c64"], description: "Assert the running machine is a C64." },
                    programId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1024,
                        description:
                            "Required for a fresh analysis. Without snapshotId, replaces the current analysis after success.",
                    },
                    snapshotId: snapshot,
                    entryPoints: { type: "array", items: addressSchema, maxItems: 128, uniqueItems: true },
                    confirmSameProgram: {
                        type: "boolean",
                        description:
                            "Confirm recapture of the same program despite a large candidate-code change; does not prove identity.",
                    },
                    importViceLabels: {
                        type: "boolean",
                        description:
                            "Import monitor labels; set false when VICE labels may belong to a different program.",
                    },
                    includeIllegalOpcodes: {
                        type: "boolean",
                        description:
                            "Decode unofficial NMOS opcodes; defaults to false for a new capture and retains the prior setting on recapture.",
                    },
                },
                required: ["machine"],
                additionalProperties: false,
            },
            run: async (args) => {
                McpUtils.choice(args, "machine", ["c64"]);
                const prior = args.snapshotId === undefined ? undefined : getCurrent(args);
                if (
                    prior &&
                    args.programId !== undefined &&
                    stringArgument(args, "programId", 1024) !== prior.state.programId
                ) {
                    throw new Error(
                        "programId differs from the current analysis. Omit snapshotId to start a fresh analysis for the new program; save the old analysis first if needed.",
                    );
                }
                if (
                    prior &&
                    (prior.graph.viewId !== "vice:c64:C:ram" || !prior.state.captureMetadata(prior.graph.viewId))
                ) {
                    throw new Error("Recapture requires a previous VICE C64 RAM snapshot.");
                }
                const programId = prior ? prior.state.programId : stringArgument(args, "programId", 1024);
                const confirmSameProgram = optionalBoolean(args, "confirmSameProgram", false);
                const importViceLabels = optionalBoolean(args, "importViceLabels", true);
                if (!prior && confirmSameProgram) {
                    throw new Error("confirmSameProgram applies only to recapture with snapshotId.");
                }
                const includeIllegalOpcodes = optionalBoolean(
                    args,
                    "includeIllegalOpcodes",
                    prior?.graph.includeIllegalOpcodes ?? false,
                );
                const input = args.entryPoints ?? [];
                if (
                    !Array.isArray(input) ||
                    input.length > 128 ||
                    new Set(input).size !== input.length ||
                    input.some(
                        (value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535,
                    )
                ) {
                    throw new Error("entryPoints must contain at most 128 unique 16-bit addresses.");
                }
                const captured = await captureC64Ram(monitor);
                const codeComparison = prior ? compareCandidateCode(prior.graph, captured.bytes) : undefined;
                if (codeComparison?.possibleProgramChange && !confirmSameProgram) {
                    throw new Error(
                        `Possible program change: ${codeComparison.changed} of ${codeComparison.compared} previously classified candidate-code bytes changed. The previous analysis was preserved; resume was sent. For a different program, save it if needed and capture without snapshotId using a new programId. For the same program, recapture with confirmSameProgram: true. RAM changes and overlays can cause false positives.`,
                    );
                }
                const entries: C64EntryPoint[] = input.map((value: number) => ({ address: value, source: "user" }));
                const views = c64PossibleMemoryViews(captured.pc, "read", captured.banking);
                if (views.length === 1 && views[0] === "ram") {
                    entries.push({ address: captured.pc, source: "observed" });
                }
                const basic = detectC64BasicProgram(captured.bytes.subarray(0x0801), 0x0801);
                let unresolvedBasicSys = 0;
                for (const line of basic?.lines ?? []) {
                    for (const reference of line.sysReferences) {
                        if (reference.target !== undefined) {
                            entries.push({ address: reference.target, source: "basic-sys" });
                        } else {
                            unresolvedBasicSys++;
                        }
                    }
                }
                if (entries.length > 256) {
                    throw new Error(
                        "Capture contains more than 256 combined entry points; supply a narrower analysis.",
                    );
                }
                const state = prior
                    ? C64AnalysisState.deserialize(prior.state.serialize())
                    : new C64AnalysisState(programId);
                const graph = state.analyze(
                    new C6510Decoder(captured.bytes, 0, { includeIllegalOpcodes }),
                    "vice:c64:C:ram",
                    entries,
                    captured.banking,
                    {
                        source: "vice",
                        machine: "c64",
                        space: "C:",
                        bank: "ram",
                        capturedAt: captured.capturedAt,
                        pc: captured.pc,
                        direction: captured.direction,
                        port: captured.port,
                    },
                );
                const imported = importViceLabels
                    ? state.importViceLabels(graph, captured.labels)
                    : { imported: 0, conflicts: [] };
                setCurrent(state, graph);
                return JSON.stringify({
                    programId,
                    viewId: graph.viewId,
                    snapshotId: graph.snapshotId,
                    captureMetadata: state.captureMetadata(graph.viewId),
                    capture: { start: 0, endExclusive: 65536 },
                    instructions: graph.instructions.length,
                    blocks: graph.blocks.length,
                    basicPrograms: graph.basicPrograms.length,
                    entryPoints: graph.entryPoints.slice(0, 16),
                    entryPointsTruncated: graph.entryPoints.length > 16,
                    unresolvedBasicSys,
                    labelsImported: imported.imported,
                    labelConflicts: imported.conflicts.slice(0, 16),
                    labelConflictCount: imported.conflicts.length,
                    diagnostics: graph.diagnostics.length,
                    banking: graph.banking,
                    includeIllegalOpcodes: graph.includeIllegalOpcodes,
                    pcSeeded: views.length === 1 && views[0] === "ram",
                    codeComparison,
                    evidence: "static-candidates",
                    note: "RAM snapshot only. Resume was sent, not execution-acknowledged. Mapping, execution and code/data classifications remain uncertain.",
                });
            },
        },
        {
            name: "vice_analysis_create",
            description:
                "Analyze a local PRG or restore a saved analysis state for this session. Does not connect to VICE. Replaces the previous session analysis only after success.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1024,
                        description: "Local server path; obtain user consent before reading files.",
                    },
                    format: { type: "string", enum: ["prg", "state"] },
                    viewId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 128,
                        description: "Required for saved state; defaults to prg-payload for PRG.",
                    },
                    entryPoints: {
                        type: "array",
                        items: addressSchema,
                        maxItems: 128,
                        uniqueItems: true,
                        description: "PRG machine-code entry addresses. With no entries, use BASIC SYS targets.",
                    },
                    includeBasic: {
                        type: "boolean",
                        description: "Also use literal BASIC SYS targets with explicit PRG entries.",
                    },
                    includeIllegalOpcodes: {
                        type: "boolean",
                        description: "For PRG inputs, opt in to unofficial NMOS opcode decoding.",
                    },
                },
                required: ["path", "format"],
                additionalProperties: false,
            },
            run: async (args) => {
                const path = stringArgument(args, "path", 1024);
                const format = McpUtils.choice(args, "format", ["prg", "state"]);
                const viewId =
                    args.viewId === undefined && format === "prg" ? "prg-payload" : stringArgument(args, "viewId", 128);
                let state: C64AnalysisState;
                let graph: C64ControlFlowGraph;
                if (format === "state") {
                    if (
                        args.entryPoints !== undefined ||
                        args.includeBasic !== undefined ||
                        args.includeIllegalOpcodes !== undefined
                    ) {
                        throw new Error(
                            "entryPoints, includeBasic and includeIllegalOpcodes apply only to PRG inputs; restored state retains its setting.",
                        );
                    }
                    state = C64AnalysisState.deserialize(
                        (await readBoundedFile(path, 4 * 1024 * 1024)).toString("utf8"),
                    );
                    graph = state.restoreGraph(viewId);
                } else {
                    const input = args.entryPoints ?? [];
                    if (
                        !Array.isArray(input) ||
                        input.length > 128 ||
                        new Set(input).size !== input.length ||
                        input.some(
                            (value) =>
                                typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff,
                        )
                    ) {
                        throw new Error("entryPoints must contain at most 128 unique 16-bit addresses.");
                    }
                    const entries: C64EntryPoint[] = input.map((value: number) => ({ address: value, source: "user" }));
                    const includeBasic = optionalBoolean(args, "includeBasic", false);
                    const prg = C64Prg.fromBytes(await readBoundedFile(path, 65538), {
                        includeIllegalOpcodes: optionalBoolean(args, "includeIllegalOpcodes", false),
                    });
                    if (includeBasic || entries.length === 0) {
                        const basic = detectC64BasicProgram(prg.decoder.getBytes(), prg.loadAddress);
                        if (!basic) {
                            throw new Error(
                                "No complete BASIC program found. Specify machine-code entryPoints instead.",
                            );
                        }
                        for (const line of basic.lines) {
                            for (const reference of line.sysReferences) {
                                if (reference.target !== undefined) {
                                    entries.push({ address: reference.target, source: "basic-sys" });
                                }
                            }
                        }
                    }
                    if (entries.length > 256) {
                        throw new Error("Analysis requires at most 256 combined entry points.");
                    }
                    state = new C64AnalysisState(path);
                    graph = state.analyze(prg.decoder, viewId, entries, C64_PRG_DEFAULT_BANKING);
                }
                if (graph.programId.length > 1024 || graph.snapshotId.length > 128) {
                    throw new Error("Saved program or snapshot identifier is too long for MCP queries.");
                }
                setCurrent(state, graph);
                return JSON.stringify({
                    programId: graph.programId,
                    viewId: graph.viewId,
                    snapshotId: graph.snapshotId,
                    capture: { start: graph.startAddress, endExclusive: graph.endAddressExclusive },
                    instructions: graph.instructions.length,
                    blocks: graph.blocks.length,
                    basicPrograms: graph.basicPrograms.length,
                    entryPoints: graph.entryPoints.slice(0, 16),
                    entryPointsTruncated: graph.entryPoints.length > 16,
                    diagnostics: graph.diagnostics.length,
                    unresolvedBasicSys: graph.basicPrograms.reduce(
                        (count, program) =>
                            count +
                            program.lines.reduce(
                                (lineCount, line) =>
                                    lineCount +
                                    line.sysReferences.filter((reference) => reference.resolution === "unresolved")
                                        .length,
                                0,
                            ),
                        0,
                    ),
                    banking: graph.banking,
                    includeIllegalOpcodes: graph.includeIllegalOpcodes,
                    evidence: "static-candidates",
                    captureMetadata: state.captureMetadata(graph.viewId),
                    note: "Execution, mapping and code/data classifications are not proven. Packed or self-modifying programs may require a later memory capture.",
                });
            },
        },
        {
            name: "vice_analysis_search",
            description:
                "Search a session snapshot. Use text '*' with a kind to list all entries, labels, annotations, data sections, corrections, or other items.",
            inputSchema: {
                type: "object",
                properties: {
                    snapshotId: snapshot,
                    text: { type: "string", minLength: 1, maxLength: 128 },
                    kind: {
                        type: "string",
                        enum: [
                            "entry",
                            "instruction",
                            "label",
                            "annotation",
                            "data",
                            "correction",
                            "system",
                            "basic",
                            "diagnostic",
                        ],
                    },
                    start: addressSchema,
                    end: addressSchema,
                    ...pagination,
                },
                required: ["snapshotId", "text"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            run: async (args) => {
                const { queries } = getCurrent(args);
                const kind =
                    args.kind === undefined
                        ? undefined
                        : (McpUtils.choice(args, "kind", [
                              "entry",
                              "instruction",
                              "label",
                              "annotation",
                              "data",
                              "correction",
                              "system",
                              "basic",
                              "diagnostic",
                          ]) as C64SearchKind);
                const start = args.start === undefined ? undefined : McpUtils.integer(args, "start", 0, 65535);
                const end = args.end === undefined ? undefined : McpUtils.integer(args, "end", 0, 65535);
                return JSON.stringify(
                    queries.search(stringArgument(args, "text", 128), { ...pageArguments(args), kind, start, end }),
                );
            },
        },
        {
            name: "vice_analysis_regions",
            description:
                "List paginated snapshot classification regions without raw bytes. To identify possible unused ranges, inspect large unknown regions, BASIC overlap, candidate instructions and entries, labels, direct/indexed references, VIC/hardware pointers and program layout. Missing references are not proof: indirect accesses, self-modification, overlays or future execution may use them. Explain uncertainty; never assume zero page or stack cannot contain code. Use vice_analysis_edit data_add with dataType 'unused' to omit an evidenced range from listings without deleting bytes or graph facts. Stale ranges stop hiding bytes; data search and editing can list, remove or retype them.",
            inputSchema: {
                type: "object",
                properties: {
                    snapshotId: snapshot,
                    start: addressSchema,
                    end: addressSchema,
                    kind: { type: "string", enum: ["code", "likely-data", "mixed", "unknown"] },
                    minimumLength: { type: "integer", minimum: 1, maximum: 65536 },
                    ...pagination,
                },
                required: ["snapshotId"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            run: async (args) => {
                const { queries } = getCurrent(args);
                const kind =
                    args.kind === undefined
                        ? undefined
                        : (McpUtils.choice(args, "kind", ["code", "likely-data", "mixed", "unknown"]) as
                              "code" | "likely-data" | "mixed" | "unknown");
                return JSON.stringify(
                    queries.regions({
                        ...pageArguments(args),
                        kind,
                        start: args.start === undefined ? undefined : McpUtils.integer(args, "start", 0, 65535),
                        end: args.end === undefined ? undefined : McpUtils.integer(args, "end", 0, 65535),
                        minimumLength:
                            args.minimumLength === undefined
                                ? undefined
                                : McpUtils.integer(args, "minimumLength", 1, 65536),
                    }),
                );
            },
        },
        {
            name: "vice_analysis_references",
            description:
                "Find static memory and control-flow references to an inclusive address range, including possible indexed matches. Optionally include unresolved references.",
            inputSchema: {
                type: "object",
                properties: {
                    snapshotId: snapshot,
                    start: addressSchema,
                    end: addressSchema,
                    includeUnresolved: { type: "boolean" },
                    access: { type: "string", enum: ["read", "write", "call", "jump", "branch", "basic-sys"] },
                    ...pagination,
                },
                required: ["snapshotId", "start"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            run: async (args) => {
                const { queries } = getCurrent(args);
                const start = McpUtils.integer(args, "start", 0, 65535);
                const end = McpUtils.integer(args, "end", 0, 65535, start);
                const access =
                    args.access === undefined
                        ? undefined
                        : (McpUtils.choice(args, "access", [
                              "read",
                              "write",
                              "call",
                              "jump",
                              "branch",
                              "basic-sys",
                          ]) as C64ReferenceAccess);
                return JSON.stringify(
                    queries.references(start, end, {
                        ...pageArguments(args),
                        includeUnresolved: optionalBoolean(args, "includeUnresolved", false),
                        access,
                    }),
                );
            },
        },
        {
            name: "vice_analysis_routine",
            description:
                "Explore a candidate entry's blocks, instructions, callers, callees, exits and memory references without following calls. Results are paginated.",
            inputSchema: {
                type: "object",
                properties: { snapshotId: snapshot, entry: addressSchema, ...pagination },
                required: ["snapshotId", "entry"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            run: async (args) => {
                const { queries } = getCurrent(args);
                return JSON.stringify(queries.routine(McpUtils.integer(args, "entry", 0, 65535), pageArguments(args)));
            },
        },
        {
            name: "vice_analysis_edit",
            description:
                "Edit session analysis knowledge, not VICE: labels, block/entry notes, typed data, entry points, data exclusions and unofficial opcode decoding. Enabling unofficial opcodes can make data look like code. Changes require an explicit save to persist.",
            inputSchema: {
                type: "object",
                properties: {
                    snapshotId: snapshot,
                    action: {
                        type: "string",
                        enum: [
                            "label_add",
                            "label_rename",
                            "label_reattach",
                            "label_remove",
                            "annotation_add",
                            "annotation_update",
                            "annotation_reattach",
                            "annotation_remove",
                            "data_add",
                            "data_update",
                            "data_reattach",
                            "data_remove",
                            "entry_add",
                            "entry_remove",
                            "exclude_add",
                            "exclude_remove",
                            "set_illegal_opcodes",
                        ],
                    },
                    id: { type: "string", minLength: 1, maxLength: 128 },
                    address: addressSchema,
                    start: addressSchema,
                    end: addressSchema,
                    name: { type: "string", maxLength: 128 },
                    description: { type: "string", maxLength: 4096 },
                    labelKind: { type: "string", enum: ["address", "code"] },
                    annotationKind: { type: "string", enum: ["block", "entry"] },
                    dataType: {
                        type: "string",
                        minLength: 1,
                        maxLength: 64,
                        description:
                            "Use 'unused' to omit the active range from readable listings without deleting bytes.",
                    },
                    enabled: {
                        type: "boolean",
                        description: "For set_illegal_opcodes, enable or disable unofficial opcode decoding.",
                    },
                },
                required: ["snapshotId", "action"],
                additionalProperties: false,
            },
            run: async (args) => {
                const prior = getCurrent(args);
                const action = McpUtils.choice(args, "action", [
                    "label_add",
                    "label_rename",
                    "label_reattach",
                    "label_remove",
                    "annotation_add",
                    "annotation_update",
                    "annotation_reattach",
                    "annotation_remove",
                    "data_add",
                    "data_update",
                    "data_reattach",
                    "data_remove",
                    "entry_add",
                    "entry_remove",
                    "exclude_add",
                    "exclude_remove",
                    "set_illegal_opcodes",
                ]);
                const fields: Record<string, readonly string[]> = {
                    label_add: ["address", "name", "labelKind"],
                    label_rename: ["id", "name"],
                    label_reattach: ["id", "address", "labelKind"],
                    label_remove: ["id"],
                    annotation_add: ["address", "name", "description", "annotationKind"],
                    annotation_update: ["id", "name", "description"],
                    annotation_reattach: ["id", "address"],
                    annotation_remove: ["id"],
                    data_add: ["start", "end", "dataType", "description"],
                    data_update: ["id", "dataType", "description"],
                    data_reattach: ["id", "start", "end"],
                    data_remove: ["id"],
                    entry_add: ["address"],
                    entry_remove: ["address"],
                    exclude_add: ["start", "end", "description"],
                    exclude_remove: ["id"],
                    set_illegal_opcodes: ["enabled"],
                };
                for (const key of Object.keys(args)) {
                    if (key !== "snapshotId" && key !== "action" && !fields[action].includes(key)) {
                        throw new Error(`${key} is not valid for ${action}.`);
                    }
                }
                const id = () => stringArgument(args, "id", 128);
                const location = () => McpUtils.integer(args, "address", 0, 65535);
                const start = () => McpUtils.integer(args, "start", 0, 65535);
                const end = () => McpUtils.integer(args, "end", 0, 65535);
                const description = () => {
                    if (args.description === undefined) {
                        return "";
                    }
                    if (
                        typeof args.description !== "string" ||
                        args.description.length > 4096 ||
                        args.description.includes("\0")
                    ) {
                        throw new Error("description must be a string of at most 4096 characters without NUL.");
                    }
                    return args.description;
                };
                const name = () => stringArgument(args, "name", 128);
                const labelKind = () =>
                    args.labelKind === undefined
                        ? undefined
                        : (McpUtils.choice(args, "labelKind", ["address", "code"]) as "address" | "code");
                const state = C64AnalysisState.deserialize(prior.state.serialize());
                const graph = state.restoreGraph(prior.graph.viewId);
                let resultId: string | undefined;
                switch (action) {
                    case "label_add":
                        resultId = state.addLabel(graph, location(), name(), labelKind()).id;
                        break;
                    case "label_rename":
                        resultId = id();
                        state.renameLabel(resultId, name());
                        break;
                    case "label_reattach":
                        resultId = id();
                        state.reattachLabel(resultId, graph, location(), labelKind());
                        break;
                    case "label_remove":
                        resultId = id();
                        state.removeLabel(resultId);
                        break;
                    case "annotation_add":
                        resultId = state.addAnnotation(
                            graph,
                            McpUtils.choice(args, "annotationKind", ["block", "entry"]) as "block" | "entry",
                            location(),
                            name(),
                            description(),
                        ).id;
                        break;
                    case "annotation_update":
                        resultId = id();
                        state.updateAnnotation(resultId, name(), description());
                        break;
                    case "annotation_reattach":
                        resultId = id();
                        state.reattachAnnotation(resultId, graph, location());
                        break;
                    case "annotation_remove":
                        resultId = id();
                        state.removeAnnotation(resultId);
                        break;
                    case "data_add":
                        resultId = state.addDataSection(
                            graph,
                            start(),
                            end(),
                            stringArgument(args, "dataType", 64),
                            description(),
                        ).id;
                        break;
                    case "data_update":
                        resultId = id();
                        state.updateDataSection(resultId, stringArgument(args, "dataType", 64), description());
                        break;
                    case "data_reattach":
                        resultId = id();
                        state.reattachDataSection(resultId, graph, start(), end());
                        break;
                    case "data_remove":
                        resultId = id();
                        state.removeDataSection(resultId);
                        break;
                    case "entry_add":
                        state.addEntryPoint(graph.viewId, location());
                        break;
                    case "entry_remove":
                        state.removeEntryPoint(graph.viewId, location());
                        break;
                    case "exclude_add":
                        resultId = state.excludeRange(graph, start(), end(), description()).id;
                        break;
                    case "exclude_remove":
                        resultId = id();
                        state.removeCorrection(resultId);
                        break;
                    case "set_illegal_opcodes":
                        if (typeof args.enabled !== "boolean") {
                            throw new Error("enabled must be a boolean.");
                        }
                        state.setIncludeIllegalOpcodes(graph.viewId, args.enabled);
                        break;
                }
                const updated = state.restoreGraph(graph.viewId);
                setCurrent(state, updated);
                return JSON.stringify({
                    snapshotId: updated.snapshotId,
                    action,
                    id: resultId,
                    includeIllegalOpcodes: updated.includeIllegalOpcodes,
                    note: "Analysis state changed locally; VICE memory and labels were not modified.",
                });
            },
        },
        ...(["save", "export"] as const).map((action): McpTool => ({
            name: `vice_analysis_${action}`,
            description:
                action === "save"
                    ? "Save the current analysis state, including captured memory and user notes, to a local file with user consent."
                    : "Export readable annotated disassembly (not reassemblable source) to a local file with user consent.",
            inputSchema: {
                type: "object",
                properties: {
                    snapshotId: snapshot,
                    path: { type: "string", minLength: 1, maxLength: 1024 },
                    confirm: { type: "boolean", description: "Confirm the user authorized this file write." },
                    overwrite: { type: "boolean", description: "Allow replacement of an existing file." },
                    ...(action === "export"
                        ? {
                              includeLowMemoryData: {
                                  type: "boolean",
                                  description: "Include raw zero-page and stack-page data.",
                              },
                              includeUnused: { type: "boolean", description: "Include user-marked unused ranges." },
                          }
                        : {}),
                },
                required: ["snapshotId", "path", "confirm"],
                additionalProperties: false,
            },
            run: async (args) => {
                const { state, graph } = getCurrent(args);
                const path = stringArgument(args, "path", 1024);
                if (args.confirm !== true) {
                    throw new Error("confirm=true is required for file writes.");
                }
                const overwrite = optionalBoolean(args, "overwrite", false);
                if (
                    action === "save" &&
                    (args.includeLowMemoryData !== undefined || args.includeUnused !== undefined)
                ) {
                    throw new Error("Listing options apply only to export.");
                }
                const content =
                    action === "save"
                        ? state.serialize()
                        : `; Readable annotated disassembly; not reassemblable source.\n${formatC64ControlFlowGraph(
                              graph,
                              {
                                  annotations: state.matchAnnotations(graph),
                                  dataSections: state.dataSectionStatuses(graph),
                                  includeLowMemoryData: optionalBoolean(args, "includeLowMemoryData", false),
                                  includeUnused: optionalBoolean(args, "includeUnused", false),
                              },
                          )}\n`;
                await writeAnalysisFile(path, content, overwrite);
                return JSON.stringify({
                    path,
                    snapshotId: graph.snapshotId,
                    format: action === "save" ? "analysis-state" : "readable-disassembly",
                    bytes: Buffer.byteLength(content),
                });
            },
        })),
    ];
    let queue: Promise<void> = Promise.resolve();
    return tools.map((tool) => ({
        ...tool,
        run: (args) => {
            const result = queue.then(() => tool.run(args));
            queue = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        },
    }));
}
