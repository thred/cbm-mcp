import { randomUUID } from "node:crypto";
import { formatC64ControlFlowGraph } from "./c64-analysis-format.js";
import { C6510Decoder, type C6510Instruction, type C6510Operand } from "./c6510-decoder.js";
import {
    analyzeC64SystemAnnotations,
    validateC64BankingContext,
    type C64BankingContext,
    type C64MappedView,
    type C64SystemAnnotation,
} from "./c64-system-annotations.js";
import { getGraphLabels, type C64LabelMatch } from "./c64-labels.js";
import { createC64SymbolTable, type C64AutomaticLabel } from "./c64-automatic-labels.js";
import { classifyC64Memory, type C64MemoryRegion } from "./c64-memory-classification.js";
import { detectC64BasicProgram, type C64BasicProgram } from "./c64-basic-program.js";

export type C64EntryPointSource = "user" | "basic-sys" | "observed" | "vector" | "call";

export interface C64EntryPoint {
    readonly address: number;
    readonly source: C64EntryPointSource;
}

export interface C64ExcludedRange {
    readonly start: number;
    readonly end: number;
}

export interface C64FlowEdge {
    readonly from: number;
    readonly kind: "fallthrough" | "branch" | "jump" | "call" | "return" | "interrupt" | "halt";
    readonly target?: number;
    readonly targetCaptured?: boolean;
    readonly evidence: "static";
}

export type C64ReferenceTarget =
    | { readonly kind: "direct"; readonly address: number }
    | { readonly kind: "unstable"; readonly base: number }
    | {
          readonly kind: "indexed";
          readonly base: number;
          readonly index: "X" | "Y";
          readonly wrap: "zero-page" | "16-bit";
      }
    | { readonly kind: "indirect"; readonly operand: Extract<C6510Operand, { kind: "indirect" }> };

export interface C64MemoryReference {
    readonly from: number;
    readonly access: "read" | "write";
    readonly purpose: "operand" | "pointer";
    readonly target: C64ReferenceTarget;
    readonly evidence: "static";
}

export interface C64BasicBlock {
    readonly start: number;
    readonly instructions: readonly C6510Instruction[];
    readonly outgoing: readonly C64FlowEdge[];
}

export type C64GraphDiagnostic =
    | { readonly kind: "outside-capture" | "excluded" | "overlaps-excluded"; readonly address: number }
    | {
          readonly kind: "undocumented-opcode" | "truncated";
          readonly address: number;
          readonly bytes: readonly number[];
      }
    | { readonly kind: "overlapping-instructions"; readonly address: number; readonly otherAddress: number };

export interface C64GraphOptions {
    readonly programId: string;
    readonly viewId: string;
    readonly snapshotId?: string;
    readonly entryPoints: readonly C64EntryPoint[];
    readonly excludedRanges?: readonly C64ExcludedRange[];
    readonly banking?: C64BankingContext;
}

function validAddress(address: number): boolean {
    return Number.isInteger(address) && address >= 0 && address <= 0xffff;
}

function isCaptured(decoder: C6510Decoder, address: number): boolean {
    return address >= decoder.startAddress && address < decoder.endAddressExclusive;
}

function referenceMatches(target: C64ReferenceTarget, address: number): boolean {
    if (target.kind === "direct") {
        return target.address === address;
    }
    if (target.kind === "indirect" || target.kind === "unstable") {
        return false;
    }
    if (target.wrap === "zero-page") {
        return address <= 0xff;
    }
    return ((address - target.base) & 0xffff) <= 0xff;
}

export class C64ControlFlowGraph {
    readonly systemAnnotations: readonly C64SystemAnnotation[];
    readonly banking: C64BankingContext;
    private readonly resolveViews: (
        address: number,
        target: number,
        access: "read" | "write",
    ) => readonly C64MappedView[];

    constructor(
        readonly programId: string,
        readonly viewId: string,
        readonly snapshotId: string,
        readonly startAddress: number,
        readonly endAddressExclusive: number,
        readonly entryPoints: readonly C64EntryPoint[],
        readonly instructions: readonly C6510Instruction[],
        readonly blocks: readonly C64BasicBlock[],
        readonly edges: readonly C64FlowEdge[],
        readonly references: readonly C64MemoryReference[],
        readonly diagnostics: readonly C64GraphDiagnostic[],
        readonly initialEntryPoints: readonly C64EntryPoint[],
        banking: C64BankingContext,
        readonly memoryRegions: readonly C64MemoryRegion[],
        readonly basicPrograms: readonly C64BasicProgram[] = [],
        readonly includeIllegalOpcodes: boolean = false,
    ) {
        this.banking = validateC64BankingContext(banking);
        const analysis = analyzeC64SystemAnnotations(this, initialEntryPoints, this.banking);
        this.systemAnnotations = analysis.annotations;
        this.resolveViews = analysis.viewsAt;
    }

    get labelMatches(): readonly C64LabelMatch[] {
        return getGraphLabels(this);
    }

    get automaticLabels(): readonly C64AutomaticLabel[] {
        return structuredClone(createC64SymbolTable(this).automaticLabels);
    }

    automaticLabelsAt(address: number): readonly C64AutomaticLabel[] {
        if (!validAddress(address)) {
            throw new RangeError("Label address must be a 16-bit integer.");
        }
        return this.automaticLabels.filter((label) => label.address === address);
    }

    resolveLabel(instructionAddress: number, targetAddress: number): string | undefined {
        if (!validAddress(instructionAddress) || !validAddress(targetAddress)) {
            throw new RangeError("Addresses must be 16-bit integers.");
        }
        if (!this.instructions.some((instruction) => instruction.address === instructionAddress)) {
            throw new Error("Label source must be a discovered instruction.");
        }
        return createC64SymbolTable(this).resolve(instructionAddress, targetAddress);
    }

    labelsAt(address: number): readonly C64LabelMatch[] {
        if (!validAddress(address)) {
            throw new RangeError("Label address must be a 16-bit integer.");
        }
        return this.labelMatches.filter((match) => match.address === address);
    }

    systemAnnotationsFrom(address: number): readonly C64SystemAnnotation[] {
        if (!validAddress(address)) {
            throw new RangeError("Instruction address must be a 16-bit integer.");
        }
        return this.systemAnnotations.filter((annotation) => annotation.from === address);
    }

    systemAnnotationsTo(address: number): readonly C64SystemAnnotation[] {
        if (!validAddress(address)) {
            throw new RangeError("Annotation address must be a 16-bit integer.");
        }
        return this.systemAnnotations.filter((annotation) => annotation.address === address);
    }

    possibleViewsAt(
        instructionAddress: number,
        targetAddress: number,
        access: "read" | "write",
    ): readonly C64MappedView[] {
        if (!validAddress(instructionAddress) || !validAddress(targetAddress)) {
            throw new RangeError("Addresses must be 16-bit integers.");
        }
        if (access !== "read" && access !== "write") {
            throw new Error("Access must be read or write.");
        }
        return this.resolveViews(instructionAddress, targetAddress, access);
    }

    toString(): string {
        return formatC64ControlFlowGraph(this);
    }

    referencesTo(address: number): readonly C64MemoryReference[] {
        if (!validAddress(address)) {
            throw new RangeError("Reference address must be a 16-bit integer.");
        }
        return this.references.filter((reference) => referenceMatches(reference.target, address));
    }

    unresolvedReferences(): readonly C64MemoryReference[] {
        return this.references.filter(
            (reference) => reference.target.kind === "indirect" || reference.target.kind === "unstable",
        );
    }

    callsTo(address: number): readonly C64FlowEdge[] {
        if (!validAddress(address)) {
            throw new RangeError("Call target must be a 16-bit integer.");
        }
        return this.edges.filter((edge) => edge.kind === "call" && edge.target === address);
    }

    callsFrom(address: number): readonly C64FlowEdge[] {
        if (!validAddress(address)) {
            throw new RangeError("Call source must be a 16-bit integer.");
        }
        return this.edges.filter((edge) => edge.kind === "call" && edge.from === address);
    }

    referencesFrom(address: number): readonly C64MemoryReference[] {
        if (!validAddress(address)) {
            throw new RangeError("Instruction address must be a 16-bit integer.");
        }
        return this.references.filter((reference) => reference.from === address);
    }

    memoryRegionAt(address: number): C64MemoryRegion | undefined {
        if (!validAddress(address)) {
            throw new RangeError("Memory address must be a 16-bit integer.");
        }
        return this.memoryRegions.find((region) => address >= region.start && address < region.endExclusive);
    }
}

function instructionReferences(instruction: C6510Instruction): C64MemoryReference[] {
    const references: C64MemoryReference[] = [];
    const operand = instruction.operand;
    const add = (access: "read" | "write", purpose: "operand" | "pointer", target: C64ReferenceTarget) => {
        references.push({ from: instruction.address, access, purpose, target, evidence: "static" });
    };
    if (operand.kind === "indirect") {
        if (operand.indexPosition === "before") {
            add("read", "pointer", { kind: "indexed", base: operand.pointerAddress, index: "X", wrap: "zero-page" });
            add("read", "pointer", {
                kind: "indexed",
                base: (operand.pointerAddress + 1) & 0xff,
                index: "X",
                wrap: "zero-page",
            });
        } else {
            const high =
                operand.pointerWrap === "zero-page"
                    ? (operand.pointerAddress + 1) & 0xff
                    : (operand.pointerAddress & 0xff00) | ((operand.pointerAddress + 1) & 0xff);
            add("read", "pointer", { kind: "direct", address: operand.pointerAddress });
            add("read", "pointer", { kind: "direct", address: high });
        }
    }
    const access = instruction.opcode.effects.operandAccess;
    if (access === "none") {
        return references;
    }
    let target: C64ReferenceTarget;
    if (instruction.opcode.unstableAddress && operand.kind === "address") {
        target = { kind: "unstable", base: operand.address };
    } else if (operand.kind === "address") {
        target = operand.index
            ? {
                  kind: "indexed",
                  base: operand.address,
                  index: operand.index,
                  wrap: operand.zeroPage ? "zero-page" : "16-bit",
              }
            : { kind: "direct", address: operand.address };
    } else if (operand.kind === "indirect") {
        target = { kind: "indirect", operand };
    } else {
        throw new Error(`Memory access has no address operand at $${instruction.address.toString(16)}.`);
    }
    if (access === "read" || access === "read-modify-write") {
        add("read", "operand", target);
    }
    if (access === "write" || access === "read-modify-write") {
        add("write", "operand", target);
    }
    return references;
}

/**
 * Discover candidate code in one captured view. Static edges do not prove execution.
 */
export function buildC64ControlFlowGraph(decoder: C6510Decoder, options: C64GraphOptions): C64ControlFlowGraph {
    if (!options.programId.trim() || !options.viewId.trim()) {
        throw new Error("Program and view identifiers must not be empty.");
    }
    if (options.snapshotId !== undefined && !options.snapshotId.trim()) {
        throw new Error("Snapshot identifier must not be empty.");
    }
    const entrySources: readonly C64EntryPointSource[] = ["user", "basic-sys", "observed", "vector", "call"];
    for (const entry of options.entryPoints) {
        if (!validAddress(entry.address) || !entrySources.includes(entry.source)) {
            throw new RangeError("Entry points require a 16-bit address and a valid source.");
        }
    }
    const excluded = options.excludedRanges ?? [];
    for (const range of excluded) {
        if (!validAddress(range.start) || !validAddress(range.end) || range.end < range.start) {
            throw new RangeError("Excluded ranges require ordered 16-bit addresses.");
        }
    }
    const isExcluded = (address: number) => excluded.some((range) => address >= range.start && address <= range.end);
    const entries = new Map<string, C64EntryPoint>();
    const leaders = new Set<number>();
    const work: number[] = [];
    const diagnostics: C64GraphDiagnostic[] = [];
    const attempted = new Set<number>();
    const instructions = new Map<number, C6510Instruction>();
    const edges: C64FlowEdge[] = [];
    const references: C64MemoryReference[] = [];
    const addEntry = (entry: C64EntryPoint) => {
        entries.set(`${entry.address}:${entry.source}`, { address: entry.address, source: entry.source });
        leaders.add(entry.address);
        work.push(entry.address);
    };
    for (const entry of options.entryPoints) {
        addEntry(entry);
    }
    const addEdge = (from: number, kind: C64FlowEdge["kind"], target?: number) => {
        const edge: C64FlowEdge =
            target === undefined
                ? { from, kind, evidence: "static" }
                : { from, kind, target, targetCaptured: isCaptured(decoder, target), evidence: "static" };
        edges.push(edge);
        if (target !== undefined && isCaptured(decoder, target)) {
            work.push(target);
        }
    };
    for (let cursor = 0; cursor < work.length; cursor++) {
        const address = work[cursor];
        if (attempted.has(address)) {
            continue;
        }
        attempted.add(address);
        if (!isCaptured(decoder, address)) {
            diagnostics.push({ kind: "outside-capture", address });
            continue;
        }
        if (isExcluded(address)) {
            diagnostics.push({ kind: "excluded", address });
            continue;
        }
        const result = decoder.decodeAt(address);
        if (result.kind !== "instruction") {
            diagnostics.push({ kind: result.kind, address, bytes: result.bytes });
            continue;
        }
        if (result.bytes.some((_, index) => isExcluded(address + index))) {
            diagnostics.push({ kind: "overlaps-excluded", address });
            continue;
        }
        instructions.set(address, result);
        references.push(...instructionReferences(result));
        const flow = result.opcode.effects.flow;
        if (flow === "next") {
            addEdge(address, "fallthrough", result.nextAddress);
        } else if (flow === "branch") {
            if (result.operand.kind !== "relative") {
                throw new Error(`Branch has no relative operand at $${address.toString(16)}.`);
            }
            leaders.add(result.operand.targetAddress);
            leaders.add(result.nextAddress);
            addEdge(address, "branch", result.operand.targetAddress);
            addEdge(address, "fallthrough", result.nextAddress);
        } else if (flow === "jump" || flow === "call") {
            const target = result.operand.kind === "address" ? result.operand.address : undefined;
            if (target !== undefined) {
                leaders.add(target);
                if (flow === "call") {
                    entries.set(`${target}:call`, { address: target, source: "call" });
                }
            }
            addEdge(address, flow, target);
            if (flow === "call") {
                leaders.add(result.nextAddress);
                addEdge(address, "fallthrough", result.nextAddress);
            }
        } else {
            addEdge(address, flow === "halt" ? "halt" : flow === "interrupt" ? "interrupt" : "return");
        }
    }

    // A documented straight-line sequence that ends in an undocumented opcode is
    // a likely data interpretation, not proof: 6510 programs can use illegal opcodes.
    const incomingBeforeRejection = new Map<number, C64FlowEdge[]>();
    for (const edge of edges) {
        if (edge.target !== undefined) {
            const list = incomingBeforeRejection.get(edge.target) ?? [];
            list.push(edge);
            incomingBeforeRejection.set(edge.target, list);
        }
    }
    for (const [target, incoming] of incomingBeforeRejection) {
        if (new Set(incoming.map((edge) => edge.from)).size > 1) {
            leaders.add(target);
        }
    }
    const rejectedInstructions = new Set<number>();
    const rejectedBytes = new Set<number>();
    for (const diagnostic of diagnostics) {
        if (diagnostic.kind !== "undocumented-opcode") {
            continue;
        }
        rejectedBytes.add(diagnostic.address);
        const pending = [diagnostic.address];
        const visited = new Set<number>();
        while (pending.length > 0) {
            const target = pending.pop()!;
            if (visited.has(target)) {
                continue;
            }
            visited.add(target);
            for (const edge of incomingBeforeRejection.get(target) ?? []) {
                const instruction = instructions.get(edge.from);
                if (edge.kind !== "fallthrough" || !instruction || instruction.opcode.effects.flow !== "next") {
                    continue;
                }
                rejectedInstructions.add(instruction.address);
                instruction.bytes.forEach((_, index) => rejectedBytes.add(instruction.address + index));
                if (!leaders.has(instruction.address)) {
                    pending.push(instruction.address);
                }
            }
        }
    }
    for (const address of rejectedInstructions) {
        instructions.delete(address);
    }
    const retainedEdges = edges.filter((edge) => !rejectedInstructions.has(edge.from));
    const retainedReferences = references.filter((reference) => !rejectedInstructions.has(reference.from));
    const retainedCalls = new Set(retainedEdges.filter((edge) => edge.kind === "call").map((edge) => edge.target));
    const initialEntries = new Set(options.entryPoints.map((entry) => `${entry.address}:${entry.source}`));
    const retainedEntries = [...entries.values()].filter(
        (entry) =>
            entry.source !== "call" ||
            retainedCalls.has(entry.address) ||
            initialEntries.has(`${entry.address}:${entry.source}`),
    );
    const occupied = new Map<number, number[]>();
    const overlapPairs = new Set<string>();
    for (const instruction of instructions.values()) {
        for (let i = 0; i < instruction.bytes.length; i++) {
            const location = instruction.address + i;
            const previous = occupied.get(location) ?? [];
            for (const otherAddress of previous) {
                const low = Math.min(otherAddress, instruction.address);
                const high = Math.max(otherAddress, instruction.address);
                const key = `${low}:${high}`;
                if (!overlapPairs.has(key)) {
                    overlapPairs.add(key);
                    diagnostics.push({ kind: "overlapping-instructions", address: low, otherAddress: high });
                }
            }
            previous.push(instruction.address);
            occupied.set(location, previous);
        }
    }
    const edgesBySource = new Map<number, C64FlowEdge[]>();
    const incoming = new Map<number, Set<number>>();
    for (const edge of retainedEdges) {
        const list = edgesBySource.get(edge.from) ?? [];
        list.push(edge);
        edgesBySource.set(edge.from, list);
        if (edge.target !== undefined && instructions.has(edge.target)) {
            const sources = incoming.get(edge.target) ?? new Set<number>();
            sources.add(edge.from);
            incoming.set(edge.target, sources);
        }
    }
    for (const [target, sources] of incoming) {
        if (sources.size > 1) {
            leaders.add(target);
        }
    }
    const blocks: C64BasicBlock[] = [];
    for (const leader of [...leaders].sort((a, b) => a - b)) {
        const blockInstructions: C6510Instruction[] = [];
        let address = leader;
        while (instructions.has(address)) {
            const instruction = instructions.get(address)!;
            blockInstructions.push(instruction);
            const outgoing = edgesBySource.get(address) ?? [];
            if (
                outgoing.length !== 1 ||
                outgoing[0].kind !== "fallthrough" ||
                outgoing[0].target === undefined ||
                leaders.has(outgoing[0].target) ||
                !instructions.has(outgoing[0].target)
            ) {
                blocks.push({ start: leader, instructions: blockInstructions, outgoing });
                break;
            }
            address = outgoing[0].target;
        }
    }
    const bytes = decoder.getBytes();
    const basicStarts = new Set<number>();
    if (bytes.length > 0) {
        basicStarts.add(decoder.startAddress);
    }
    if (isCaptured(decoder, 0x0801)) {
        basicStarts.add(0x0801);
    }
    const basicPrograms = [...basicStarts]
        .sort((a, b) => a - b)
        .map((start) => detectC64BasicProgram(bytes.subarray(start - decoder.startAddress), start))
        .filter((program): program is C64BasicProgram => program !== undefined);
    return new C64ControlFlowGraph(
        options.programId,
        options.viewId,
        options.snapshotId ?? randomUUID(),
        decoder.startAddress,
        decoder.endAddressExclusive,
        retainedEntries,
        [...instructions.values()].sort((a, b) => a.address - b.address),
        blocks,
        retainedEdges,
        retainedReferences,
        diagnostics,
        options.entryPoints.map((entry) => ({ ...entry })),
        options.banking ?? { cartridge: "unknown" },
        classifyC64Memory(
            bytes,
            decoder.startAddress,
            [...instructions.values()],
            [...rejectedBytes],
            retainedEntries,
            retainedEdges,
            retainedReferences,
            excluded,
        ),
        basicPrograms,
        decoder.includeIllegalOpcodes,
    );
}
