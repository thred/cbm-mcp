import type { C64AnalysisCorrection, C64AnnotationMatch, C64DataSectionMatch } from "./c64-analysis-state.js";
import { formatC64BasicLine } from "./c64-basic-program.js";
import type { C64ControlFlowGraph, C64MemoryReference } from "./c64-control-flow.js";
import type { C64BankingContext, C64MappedView } from "./c64-system-annotations.js";
import { formatC6510Instruction } from "./c6510-decoder.js";

export interface C64QueryPage<T> {
    readonly programId: string;
    readonly viewId: string;
    readonly snapshotId: string;
    readonly evidence: "static-candidates";
    readonly capture: { readonly start: number; readonly endExclusive: number };
    readonly banking: C64BankingContext;
    readonly includeIllegalOpcodes: boolean;
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
    readonly nextOffset: number | null;
    readonly items: readonly T[];
}

export interface C64QueryPagination {
    readonly offset?: number;
    readonly limit?: number;
}

export type C64SearchKind =
    "entry" | "instruction" | "label" | "annotation" | "data" | "correction" | "system" | "basic" | "diagnostic";

export interface C64SearchItem {
    readonly kind: C64SearchKind;
    readonly address: number;
    readonly text: string;
    readonly truncated: boolean;
    readonly status?: string;
    readonly source?: string;
    readonly targetAddress?: number;
    readonly view?: string;
    readonly access?: string;
    readonly condition?: string;
    readonly conditionTruncated?: boolean;
    readonly mode?: string;
    readonly flow?: string;
    readonly operandAccess?: string;
    readonly illegal?: boolean;
    readonly unstable?: boolean;
    readonly bytes?: readonly number[];
    readonly otherAddress?: number;
    readonly id?: string;
    readonly end?: number;
    readonly dataType?: string;
}

export type C64ReferenceItem =
    | {
          readonly kind: "memory";
          readonly match: "direct" | "possible" | "unresolved";
          readonly reference: C64MemoryReference;
          readonly possibleViews?: readonly C64MappedView[];
      }
    | {
          readonly kind: "control-flow";
          readonly match: "direct" | "unresolved";
          readonly from: number;
          readonly edge: "call" | "jump" | "branch";
          readonly target?: number;
          readonly targetCaptured?: boolean;
          readonly possibleViews?: readonly C64MappedView[];
      }
    | {
          readonly kind: "basic-sys";
          readonly match: "direct" | "unresolved";
          readonly from: number;
          readonly target?: number;
      };

export type C64ReferenceAccess = "read" | "write" | "call" | "jump" | "branch" | "basic-sys";

export type C64RoutineItem =
    | {
          readonly kind: "block";
          readonly start: number;
          readonly endExclusive: number;
          readonly instructionCount: number;
      }
    | {
          readonly kind: "instruction";
          readonly address: number;
          readonly text: string;
          readonly bytes: readonly number[];
      }
    | {
          readonly kind: "caller" | "callee" | "exit";
          readonly from: number;
          readonly edge: string;
          readonly target?: number;
          readonly targetCaptured?: boolean;
      }
    | { readonly kind: "memory"; readonly reference: C64MemoryReference };

function address(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new RangeError(`${name} must be a 16-bit address.`);
    }
}

function shortText(text: string): { text: string; truncated: boolean } {
    return { text: text.slice(0, 256), truncated: text.length > 256 };
}

function page<T>(graph: C64ControlFlowGraph, items: readonly T[], options: C64QueryPagination): C64QueryPage<T> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 25;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) {
        throw new RangeError("offset must be an integer from 0 to 1000000.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("limit must be an integer from 1 to 100.");
    }
    return {
        programId: graph.programId,
        viewId: graph.viewId,
        snapshotId: graph.snapshotId,
        evidence: "static-candidates",
        capture: { start: graph.startAddress, endExclusive: graph.endAddressExclusive },
        banking: graph.banking,
        includeIllegalOpcodes: graph.includeIllegalOpcodes,
        offset,
        limit,
        total: items.length,
        nextOffset: offset + limit < items.length ? offset + limit : null,
        items: items.slice(offset, offset + limit),
    };
}

/** Bounded, snapshot-scoped queries over a graph and its separately maintained annotations. */
export class C64AnalysisQueries {
    constructor(
        private readonly graph: C64ControlFlowGraph,
        private readonly annotations: readonly C64AnnotationMatch[] = [],
        private readonly dataSections: readonly C64DataSectionMatch[] = [],
        private readonly corrections: readonly {
            correction: C64AnalysisCorrection;
            status: "active" | "stale" | "other-view";
        }[] = [],
    ) {}

    search(
        text: string,
        options: C64QueryPagination & {
            readonly kind?: C64SearchKind;
            readonly start?: number;
            readonly end?: number;
        } = {},
    ): C64QueryPage<C64SearchItem> {
        if (typeof text !== "string" || !text.trim() || text.length > 128) {
            throw new Error("Search text must be nonempty and at most 128 characters.");
        }

        const kinds: readonly C64SearchKind[] = [
            "entry",
            "instruction",
            "label",
            "annotation",
            "data",
            "correction",
            "system",
            "basic",
            "diagnostic",
        ];

        if (options.kind !== undefined && !kinds.includes(options.kind)) {
            throw new Error("Invalid search kind.");
        }

        const start = options.start ?? 0;
        const end = options.end ?? 0xffff;

        address(start, "Search start");
        address(end, "Search end");

        if (start > end) {
            throw new RangeError("Search start must not exceed end.");
        }

        const query = text.trim().toLowerCase();
        const found: C64SearchItem[] = [];
        const add = (
            kind: C64SearchKind,
            location: number,
            value: string,
            extra: Partial<
                Pick<
                    C64SearchItem,
                    | "status"
                    | "source"
                    | "targetAddress"
                    | "view"
                    | "access"
                    | "condition"
                    | "conditionTruncated"
                    | "mode"
                    | "flow"
                    | "operandAccess"
                    | "illegal"
                    | "unstable"
                    | "bytes"
                    | "otherAddress"
                    | "id"
                    | "end"
                    | "dataType"
                >
            > = {},
            searchable = value,
        ) => {
            if (
                (!options.kind || options.kind === kind) &&
                location >= start &&
                location <= end &&
                (query === "*" || searchable.toLowerCase().includes(query))
            ) {
                found.push({ kind, address: location, ...shortText(value), ...extra });
            }
        };

        if (!options.kind || options.kind === "entry") {
            for (const entry of this.graph.entryPoints) {
                add("entry", entry.address, `entry ${entry.source}`, { source: entry.source });
            }
        }

        if (!options.kind || options.kind === "instruction") {
            for (const instruction of this.graph.instructions) {
                const formatted = formatC6510Instruction(instruction);
                const { mode, effects, name } = instruction.opcode;
                add(
                    "instruction",
                    instruction.address,
                    formatted,
                    {
                        mode,
                        flow: effects.flow,
                        operandAccess: effects.operandAccess,
                        illegal: instruction.opcode.illegal,
                        unstable: instruction.opcode.unstable,
                    },
                    `${formatted} ${name} ${mode} ${effects.flow} ${effects.operandAccess}${instruction.opcode.illegal ? " unofficial" : ""}${instruction.opcode.unstable ? " unstable" : ""}`,
                );
            }
        }

        if (!options.kind || options.kind === "label") {
            for (const match of this.graph.labelMatches) {
                if (match.label.viewId === this.graph.viewId) {
                    add("label", match.address ?? match.label.address, match.label.name, {
                        status: match.status,
                        source: match.label.source,
                        id: match.label.id,
                    });
                }
            }
            for (const label of this.graph.automaticLabels) {
                add("label", label.address, label.name, { source: label.source });
            }
        }

        if (!options.kind || options.kind === "annotation") {
            for (const match of this.annotations) {
                if (match.annotation.viewId === this.graph.viewId) {
                    add(
                        "annotation",
                        match.address ?? match.annotation.address,
                        `${match.annotation.name}: ${match.annotation.description}`,
                        { status: match.status, source: "user", id: match.annotation.id },
                    );
                }
            }
        }

        if (!options.kind || options.kind === "data") {
            for (const match of this.dataSections) {
                if (match.section.viewId === this.graph.viewId) {
                    add("data", match.section.start, `${match.section.type}: ${match.section.description}`, {
                        status: match.status,
                        source: "user",
                        id: match.section.id,
                        end: match.section.end,
                        dataType: match.section.type,
                    });
                }
            }
        }

        if (!options.kind || options.kind === "correction") {
            for (const match of this.corrections) {
                if (match.correction.viewId === this.graph.viewId) {
                    add("correction", match.correction.start, `correction: ${match.correction.description}`, {
                        status: match.status,
                        source: "user",
                        id: match.correction.id,
                        end: match.correction.end,
                    });
                }
            }
        }

        if (!options.kind || options.kind === "system") {
            for (const item of this.graph.systemAnnotations) {
                add("system", item.from, `${item.name}: ${item.description}`, {
                    status: item.certainty,
                    source: item.source,
                    targetAddress: item.address,
                    view: item.view,
                    access: item.access,
                    condition: item.condition?.slice(0, 256),
                    conditionTruncated: item.condition === undefined ? undefined : item.condition.length > 256,
                });
            }
        }

        if (!options.kind || options.kind === "basic") {
            for (const program of this.graph.basicPrograms) {
                for (const line of program.lines) {
                    add("basic", line.address, formatC64BasicLine(line));
                }
            }
        }

        if (!options.kind || options.kind === "diagnostic") {
            for (const diagnostic of this.graph.diagnostics) {
                add("diagnostic", diagnostic.address, `diagnostic ${diagnostic.kind}`, {
                    status: diagnostic.kind,
                    ...("bytes" in diagnostic ? { bytes: diagnostic.bytes } : {}),
                    ...("otherAddress" in diagnostic ? { otherAddress: diagnostic.otherAddress } : {}),
                });
            }
        }

        found.sort((a, b) => a.address - b.address || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text));

        return page(this.graph, found, options);
    }

    regions(
        options: C64QueryPagination & {
            readonly kind?: "code" | "likely-data" | "mixed" | "unknown";
            readonly start?: number;
            readonly end?: number;
            readonly minimumLength?: number;
        } = {},
    ) {
        const start = options.start ?? 0;
        const end = options.end ?? 0xffff;

        address(start, "Region start");
        address(end, "Region end");

        if (start > end) {
            throw new RangeError("Region start must not exceed end.");
        }

        const minimumLength = options.minimumLength ?? 1;

        if (!Number.isInteger(minimumLength) || minimumLength < 1 || minimumLength > 65536) {
            throw new RangeError("minimumLength must be an integer from 1 to 65536.");
        }

        if (options.kind !== undefined && !["code", "likely-data", "mixed", "unknown"].includes(options.kind)) {
            throw new Error("Invalid region kind.");
        }

        const items = this.graph.memoryRegions
            .filter(
                (region) =>
                    region.start <= end &&
                    region.endExclusive > start &&
                    region.endExclusive - region.start >= minimumLength &&
                    (options.kind === undefined || options.kind === region.kind),
            )
            .map((region) => ({
                start: region.start,
                endExclusive: region.endExclusive,
                length: region.endExclusive - region.start,
                kind: region.kind,
                evidence: region.evidence,
                basicOverlap: this.graph.basicPrograms.some(
                    (program) =>
                        program.startAddress < region.endExclusive && program.endAddressExclusive > region.start,
                ),
            }));

        return page(this.graph, items, options);
    }

    references(
        start: number,
        end = start,
        options: C64QueryPagination & {
            readonly includeUnresolved?: boolean;
            readonly access?: C64ReferenceAccess;
        } = {},
    ): C64QueryPage<C64ReferenceItem> {
        address(start, "Reference start");
        address(end, "Reference end");

        if (start > end) {
            throw new RangeError("Reference start must not exceed end.");
        }

        if (options.includeUnresolved !== undefined && typeof options.includeUnresolved !== "boolean") {
            throw new Error("includeUnresolved must be a boolean.");
        }

        const accesses: readonly C64ReferenceAccess[] = ["read", "write", "call", "jump", "branch", "basic-sys"];

        if (options.access !== undefined && !accesses.includes(options.access)) {
            throw new Error("Invalid reference access.");
        }

        const found: C64ReferenceItem[] = [];

        for (const reference of this.graph.references) {
            const target = reference.target;

            if (target.kind === "direct" && target.address >= start && target.address <= end) {
                found.push({
                    kind: "memory",
                    match: "direct",
                    reference,
                    possibleViews: this.graph.possibleViewsAt(reference.from, target.address, reference.access),
                });
            } else if (target.kind === "indexed") {
                const max = target.wrap === "zero-page" ? 0xff : 0xffff;
                const last = Math.min(end, max);
                const overlap =
                    start <= last &&
                    (last - start >= 255 ||
                        ((start - target.base) & max) <= 255 ||
                        ((target.base - start) & max) <= last - start);

                if (overlap) {
                    found.push({
                        kind: "memory",
                        match: "possible",
                        reference,
                        ...(start === end
                            ? { possibleViews: this.graph.possibleViewsAt(reference.from, start, reference.access) }
                            : {}),
                    });
                }
            } else if ((target.kind === "indirect" || target.kind === "unstable") && options.includeUnresolved) {
                found.push({ kind: "memory", match: "unresolved", reference });
            }
        }

        for (const edge of this.graph.edges) {
            if (edge.kind !== "call" && edge.kind !== "jump" && edge.kind !== "branch") {
                continue;
            }
            if (edge.target !== undefined && edge.target >= start && edge.target <= end) {
                found.push({
                    kind: "control-flow",
                    match: "direct",
                    from: edge.from,
                    edge: edge.kind,
                    target: edge.target,
                    targetCaptured: edge.targetCaptured,
                    possibleViews: this.graph.possibleViewsAt(edge.from, edge.target, "read"),
                });
            } else if (edge.target === undefined && options.includeUnresolved) {
                found.push({ kind: "control-flow", match: "unresolved", from: edge.from, edge: edge.kind });
            }
        }

        for (const program of this.graph.basicPrograms) {
            for (const line of program.lines) {
                for (const ref of line.sysReferences) {
                    if (ref.target !== undefined && ref.target >= start && ref.target <= end) {
                        found.push({ kind: "basic-sys", match: "direct", from: ref.address, target: ref.target });
                    } else if (ref.resolution === "unresolved" && options.includeUnresolved) {
                        found.push({ kind: "basic-sys", match: "unresolved", from: ref.address });
                    }
                }
            }
        }

        const from = (item: C64ReferenceItem) => (item.kind === "memory" ? item.reference.from : item.from);
        const filtered = found.filter((item) => {
            const access =
                item.kind === "memory" ? item.reference.access : item.kind === "basic-sys" ? "basic-sys" : item.edge;
            return options.access === undefined || options.access === access;
        });

        filtered.sort((a, b) => from(a) - from(b) || a.kind.localeCompare(b.kind));

        return page(this.graph, filtered, options);
    }

    routine(entry: number, options: C64QueryPagination = {}): C64QueryPage<C64RoutineItem> {
        address(entry, "Routine entry");

        if (!this.graph.entryPoints.some((item) => item.address === entry)) {
            throw new Error("Routine entry must be a discovered or supplied entry point.");
        }

        const blocks = new Map(this.graph.blocks.map((block) => [block.start, block]));

        if (!blocks.has(entry)) {
            throw new Error("No discovered block exists at this entry point.");
        }

        const entries = new Set(this.graph.entryPoints.map((item) => item.address));
        const seen = new Set<number>();
        const pending = [entry];
        const instructions = new Set<number>();
        const items: C64RoutineItem[] = [];

        for (let cursor = 0; cursor < pending.length; cursor++) {
            const start = pending[cursor];

            if (seen.has(start) || (start !== entry && entries.has(start))) {
                continue;
            }

            seen.add(start);

            const block = blocks.get(start);

            if (!block) {
                continue;
            }

            const last = block.instructions[block.instructions.length - 1];

            items.push({
                kind: "block",
                start,
                endExclusive: last.address + last.bytes.length,
                instructionCount: block.instructions.length,
            });

            for (const instruction of block.instructions) {
                if (!instructions.has(instruction.address)) {
                    instructions.add(instruction.address);
                    items.push({
                        kind: "instruction",
                        address: instruction.address,
                        text: formatC6510Instruction(instruction),
                        bytes: instruction.bytes,
                    });
                }
            }

            for (const edge of block.outgoing) {
                if (edge.kind === "call") {
                    items.push({
                        kind: "callee",
                        from: edge.from,
                        edge: edge.kind,
                        target: edge.target,
                        targetCaptured: edge.targetCaptured,
                    });
                } else if (edge.kind === "fallthrough" || edge.kind === "branch" || edge.kind === "jump") {
                    if (
                        edge.target !== undefined &&
                        blocks.has(edge.target) &&
                        (edge.target === entry || !entries.has(edge.target))
                    ) {
                        pending.push(edge.target);
                    } else {
                        items.push({
                            kind: "exit",
                            from: edge.from,
                            edge: edge.kind,
                            target: edge.target,
                            targetCaptured: edge.targetCaptured,
                        });
                    }
                } else {
                    items.push({ kind: "exit", from: edge.from, edge: edge.kind });
                }
            }
        }

        for (const edge of this.graph.callsTo(entry)) {
            items.push({
                kind: "caller",
                from: edge.from,
                edge: edge.kind,
                target: entry,
                targetCaptured: edge.targetCaptured,
            });
        }

        for (const program of this.graph.basicPrograms) {
            for (const line of program.lines) {
                for (const reference of line.sysReferences) {
                    if (reference.target === entry) {
                        items.push({
                            kind: "caller",
                            from: reference.address,
                            edge: "basic-sys",
                            target: entry,
                            targetCaptured: true,
                        });
                    }
                }
            }
        }

        for (const reference of this.graph.references) {
            if (instructions.has(reference.from)) {
                items.push({ kind: "memory", reference });
            }
        }

        return page(this.graph, items, options);
    }
}
