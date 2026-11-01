import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
    buildC64ControlFlowGraph,
    type C64BasicBlock,
    type C64ControlFlowGraph,
    type C64EntryPoint,
    type C64EntryPointSource,
    type C64ExcludedRange,
} from "./c64-control-flow.js";
import {
    setGraphLabels,
    type C64AnalysisLabel,
    type C64LabelKind,
    type C64LabelMatch,
    type C64LabelSource,
    type C64ViceLabelImportResult,
    type C64ViceLabelInput,
} from "./c64-labels.js";
import { validateC64BankingContext, type C64BankingContext } from "./c64-system-annotations.js";
import { C6510Decoder } from "./c6510-decoder.js";

export type C64AnnotationKind = "block" | "entry";

export interface C64AnalysisAnnotation {
    readonly id: string;
    readonly kind: C64AnnotationKind;
    readonly viewId: string;
    readonly snapshotId: string;
    readonly address: number;
    readonly name: string;
    readonly description: string;
    readonly instructions: readonly (readonly number[])[];
}

export interface C64AnnotationMatch {
    readonly annotation: C64AnalysisAnnotation;
    readonly status: "unchanged" | "modified" | "relocated" | "orphaned" | "other-view";
    readonly address?: number;
    readonly opcodeSimilarity?: number;
    readonly byteSimilarity?: number;
}

export interface C64AnalysisCorrection {
    readonly id: string;
    readonly viewId: string;
    readonly snapshotId: string;
    readonly start: number;
    readonly end: number;
    readonly description: string;
    readonly bytes: readonly number[];
}

export interface C64CaptureMetadata {
    readonly source: "vice";
    readonly machine: "c64";
    readonly space: "C:";
    readonly bank: "ram";
    readonly capturedAt: string;
    readonly pc: number;
    readonly direction: number;
    readonly port: number;
}

export interface C64DataSection {
    readonly id: string;
    readonly viewId: string;
    readonly snapshotId: string;
    readonly start: number;
    readonly end: number;
    readonly type: string;
    readonly description: string;
    readonly bytes: readonly number[];
}

export interface C64DataSectionMatch {
    readonly section: C64DataSection;
    readonly status: "active" | "stale" | "other-view";
}

interface SavedSnapshot {
    readonly id: string;
    readonly viewId: string;
    readonly startAddress: number;
    readonly bytes: readonly number[];
    readonly entryPoints: readonly C64EntryPoint[];
    readonly banking?: C64BankingContext;
    readonly capture?: C64CaptureMetadata;
    readonly includeIllegalOpcodes: boolean;
}

interface SavedUserEntry {
    readonly viewId: string;
    readonly address: number;
}

interface SavedState {
    readonly version: 5;
    readonly programId: string;
    readonly snapshots: readonly SavedSnapshot[];
    readonly userEntries: readonly SavedUserEntry[];
    readonly corrections: readonly C64AnalysisCorrection[];
    readonly annotations: readonly C64AnalysisAnnotation[];
    readonly labels: readonly C64AnalysisLabel[];
    readonly dataSections: readonly C64DataSection[];
}

const sources: readonly C64EntryPointSource[] = ["user", "basic-sys", "observed", "vector", "call"];

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }

    return value as Record<string, unknown>;
}

function list(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }

    return value;
}

function text(value: unknown, label: string, allowEmpty = false): string {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
        throw new Error(`${label} must be ${allowEmpty ? "a string" : "a nonempty string"}.`);
    }

    return value;
}

function address(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new RangeError(`${label} must be a 16-bit address.`);
    }

    return value;
}

function byteList(value: unknown, label: string): number[] {
    const bytes = list(value, label);

    if (
        bytes.length > 0x10000 ||
        bytes.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 0xff)
    ) {
        throw new Error(`${label} must contain at most 65536 bytes.`);
    }

    return bytes.map((byte) => Number(byte));
}

function parseEntry(value: unknown): C64EntryPoint {
    const entry = record(value, "Entry point");
    const sourceText = text(entry.source, "Entry source");
    const source = sources.find((item) => item === sourceText);

    if (source === undefined) {
        throw new Error("Invalid entry point source.");
    }

    return { address: address(entry.address, "Entry address"), source };
}

function parseCapture(value: unknown): C64CaptureMetadata {
    const input = record(value, "Capture metadata");

    if (input.source !== "vice" || input.machine !== "c64" || input.space !== "C:" || input.bank !== "ram") {
        throw new Error("Invalid VICE capture identity.");
    }

    const capturedAt = text(input.capturedAt, "Capture time");

    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) {
        throw new Error("Capture time must be an ISO timestamp.");
    }

    const direction = address(input.direction, "Capture direction");
    const port = address(input.port, "Capture port");

    if (direction > 255 || port > 255) {
        throw new RangeError("Capture port values must be bytes.");
    }

    return {
        source: "vice",
        machine: "c64",
        space: "C:",
        bank: "ram",
        capturedAt,
        pc: address(input.pc, "Capture PC"),
        direction,
        port,
    };
}

function parseSnapshot(value: unknown, version: 1 | 2 | 3 | 4 | 5): SavedSnapshot {
    const snapshot = record(value, "Snapshot");
    const bytes = byteList(snapshot.bytes, "Snapshot bytes");
    const startAddress = address(snapshot.startAddress, "Snapshot start");

    if (startAddress + bytes.length > 0x10000) {
        throw new RangeError("Snapshot extends beyond the 16-bit address space.");
    }

    let banking: C64BankingContext | undefined;

    if (version >= 2 && snapshot.banking !== undefined) {
        const input = record(snapshot.banking, "Banking context");
        const cartridge = text(input.cartridge, "Cartridge mapping");

        if (cartridge !== "none" && cartridge !== "unknown") {
            throw new Error("Invalid cartridge mapping.");
        }

        const optionalByte = (value: unknown, label: string): number | undefined => {
            if (value === undefined) {
                return undefined;
            }

            if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
                throw new RangeError(`${label} must be an 8-bit integer.`);
            }

            return value;
        };

        banking = validateC64BankingContext({
            cartridge,
            direction: optionalByte(input.direction, "Banking direction"),
            data: optionalByte(input.data, "Banking data"),
            inputPins: optionalByte(input.inputPins, "Banking input pins"),
        });
    }

    if (version >= 5 && typeof snapshot.includeIllegalOpcodes !== "boolean") {
        throw new Error("Snapshot includeIllegalOpcodes must be a boolean.");
    }

    return {
        id: text(snapshot.id, "Snapshot ID"),
        viewId: text(snapshot.viewId, "Snapshot view"),
        startAddress,
        bytes,
        entryPoints: list(snapshot.entryPoints, "Snapshot entry points").map(parseEntry),
        banking,
        capture: version >= 4 && snapshot.capture !== undefined ? parseCapture(snapshot.capture) : undefined,
        includeIllegalOpcodes: version >= 5 && snapshot.includeIllegalOpcodes === true,
    };
}

function parseDataSection(value: unknown): C64DataSection {
    const input = record(value, "Data section");
    const start = address(input.start, "Data start");
    const end = address(input.end, "Data end");
    const bytes = byteList(input.bytes, "Data bytes");

    if (end < start || bytes.length !== end - start + 1) {
        throw new Error("Data section bytes do not match its range.");
    }

    const type = text(input.type, "Data type");

    if (type.length > 64 || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(type)) {
        throw new Error("Data type must be an identifier of at most 64 characters.");
    }

    const description = text(input.description, "Data description", true);

    if (description.length > 4096) {
        throw new Error("Data description must be at most 4096 characters.");
    }

    return {
        id: text(input.id, "Data section ID"),
        viewId: text(input.viewId, "Data view"),
        snapshotId: text(input.snapshotId, "Data snapshot"),
        start,
        end,
        type,
        description,
        bytes,
    };
}

function labelName(value: unknown): string {
    const name = text(value, "Label name");

    if (name.length > 128 || !/^\.?[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
        throw new Error(
            "Label name must be an identifier, optionally beginning with a dot, of at most 128 characters.",
        );
    }

    return name;
}

function parseLabel(value: unknown): C64AnalysisLabel {
    const input = record(value, "Label");
    const kind = text(input.kind, "Label kind");
    const rawSource = text(input.source, "Label source");

    if ((kind !== "address" && kind !== "code") || (rawSource !== "user" && rawSource !== "vice")) {
        throw new Error("Invalid label kind or source.");
    }

    const source: C64LabelSource = rawSource;
    const base = {
        id: text(input.id, "Label ID"),
        viewId: text(input.viewId, "Label view"),
        address: address(input.address, "Label address"),
        name: labelName(input.name),
        source,
    };

    if (kind === "address") {
        return { ...base, kind };
    }

    const anchor = parseAnnotation({
        ...base,
        kind: "block",
        snapshotId: input.snapshotId,
        description: "",
        instructions: input.instructions,
    });

    return { ...base, kind, snapshotId: anchor.snapshotId, instructions: anchor.instructions };
}

function parseCorrection(value: unknown): C64AnalysisCorrection {
    const correction = record(value, "Correction");
    const start = address(correction.start, "Correction start");
    const end = address(correction.end, "Correction end");
    const bytes = byteList(correction.bytes, "Correction bytes");

    if (end < start || bytes.length !== end - start + 1) {
        throw new Error("Correction bytes do not match its range.");
    }

    return {
        id: text(correction.id, "Correction ID"),
        viewId: text(correction.viewId, "Correction view"),
        snapshotId: text(correction.snapshotId, "Correction snapshot"),
        start,
        end,
        bytes,
        description: text(correction.description, "Correction description", true),
    };
}

function parseAnnotation(value: unknown): C64AnalysisAnnotation {
    const annotation = record(value, "Annotation");
    const kind = text(annotation.kind, "Annotation kind");

    if (kind !== "block" && kind !== "entry") {
        throw new Error("Annotation kind must be block or entry.");
    }

    const instructions = list(annotation.instructions, "Annotation instructions").map((item) => {
        const bytes = byteList(item, "Instruction bytes");

        if (bytes.length < 1 || bytes.length > 3) {
            throw new Error("Annotation instruction must contain one to three bytes.");
        }

        const decoded = new C6510Decoder(Uint8Array.from(bytes), 0).decodeAt(0);

        if (decoded.kind !== "instruction" || decoded.bytes.length !== bytes.length) {
            throw new Error("Annotation contains an invalid documented instruction.");
        }

        return bytes;
    });

    if (
        instructions.length === 0 ||
        instructions.length > 0x10000 ||
        instructions.reduce((sum, item) => sum + item.length, 0) > 3 * 0x10000
    ) {
        throw new Error("Annotation must contain a bounded, nonempty block.");
    }

    return {
        id: text(annotation.id, "Annotation ID"),
        kind,
        viewId: text(annotation.viewId, "Annotation view"),
        snapshotId: text(annotation.snapshotId, "Annotation snapshot"),
        address: address(annotation.address, "Annotation address"),
        name: text(annotation.name, "Annotation name", true),
        description: text(annotation.description, "Annotation description", true),
        instructions,
    };
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function blockBytes(block: C64BasicBlock): number[][] {
    return block.instructions.map((instruction) => [...instruction.bytes]);
}

function signatureReader(graph: C64ControlFlowGraph): (kind: C64AnnotationKind, start: number) => number[][] {
    const byStart = new Map(graph.blocks.map((block) => [block.start, block]));
    const entries = new Set(graph.entryPoints.map((entry) => entry.address));
    const cache = new Map<string, number[][]>();

    return (kind, start) => {
        const key = `${kind}:${start}`;
        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const first = byStart.get(start);

        if (!first) {
            throw new Error("Annotation target is not a discovered block.");
        }

        if (kind === "block") {
            const result = blockBytes(first);
            cache.set(key, result);
            return result;
        }

        const seen = new Set<number>();
        const pending = [start];
        const instructions = new Map<number, readonly number[]>();

        for (let cursor = 0; cursor < pending.length; cursor++) {
            const current = pending[cursor];

            if (seen.has(current) || (current !== start && entries.has(current))) {
                continue;
            }

            seen.add(current);

            const block = byStart.get(current);

            if (!block) {
                continue;
            }

            for (const instruction of block.instructions) {
                instructions.set(instruction.address, instruction.bytes);
            }

            for (const edge of block.outgoing) {
                if (
                    edge.target !== undefined &&
                    (edge.kind === "fallthrough" || edge.kind === "branch" || edge.kind === "jump")
                ) {
                    pending.push(edge.target);
                }
            }
        }

        const result = [...instructions.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => [...bytes]);

        cache.set(key, result);

        return result;
    };
}

function sameInstructions(left: readonly (readonly number[])[], right: readonly (readonly number[])[]): boolean {
    return left.length === right.length && left.every((bytes, index) => sameBytes(bytes, right[index]));
}

function lcsLength(
    left: readonly (readonly number[])[],
    right: readonly (readonly number[])[],
    exact: boolean,
): number {
    let previous = new Uint16Array(right.length + 1);

    for (const a of left) {
        const current = new Uint16Array(right.length + 1);
        for (let j = 0; j < right.length; j++) {
            const equal = exact ? sameBytes(a, right[j]) : a[0] === right[j][0];
            current[j + 1] = equal ? previous[j] + 1 : Math.max(previous[j + 1], current[j]);
        }
        previous = current;
    }

    return previous[right.length];
}

interface SignatureMatch {
    readonly status: "unchanged" | "modified" | "relocated" | "orphaned";
    readonly address?: number;
    readonly opcodeSimilarity?: number;
    readonly byteSimilarity?: number;
}

function findSignatureMatch(
    originalAddress: number,
    instructions: readonly (readonly number[])[],
    candidates: readonly number[],
    signature: (address: number) => readonly (readonly number[])[],
): SignatureMatch {
    const sameAddress = candidates.includes(originalAddress);

    if (sameAddress && sameInstructions(instructions, signature(originalAddress))) {
        return { status: "unchanged", address: originalAddress };
    }

    const substantial = instructions.length >= 4 && instructions.reduce((sum, item) => sum + item.length, 0) >= 8;
    const relocated = substantial
        ? candidates.filter((candidate) => {
              if (candidate === originalAddress) {
                  return false;
              }
              const next = signature(candidate);
              return sameBytes(instructions[0], next[0]) && sameInstructions(instructions, next);
          })
        : [];
    let modified: SignatureMatch | undefined;

    if (sameAddress) {
        const current = signature(originalAddress);
        const old = instructions;
        const size = Math.max(old.length, current.length);

        if (old.length >= 4 && current.length >= 4) {
            const opcodeMatches =
                size <= 256
                    ? lcsLength(old, current, false)
                    : old.filter((item, index) => current[index] !== undefined && item[0] === current[index][0]).length;

            const byteMatches =
                size <= 256
                    ? lcsLength(old, current, true)
                    : old.filter((item, index) => current[index] !== undefined && sameBytes(item, current[index]))
                          .length;

            const opcodeSimilarity = opcodeMatches / size;
            const byteSimilarity = byteMatches / size;

            if (opcodeSimilarity >= 0.8 && byteSimilarity >= 0.6) {
                modified = {
                    status: "modified",
                    address: originalAddress,
                    opcodeSimilarity,
                    byteSimilarity,
                };
            }
        }
    }

    if (modified && relocated.length === 0) {
        return modified;
    }

    if (!modified && relocated.length === 1) {
        return { status: "relocated", address: relocated[0] };
    }

    return { status: "orphaned" };
}

function findMatch(
    annotation: C64AnalysisAnnotation,
    graph: C64ControlFlowGraph,
    signature: (kind: C64AnnotationKind, start: number) => number[][],
    entryAddresses: ReadonlySet<number>,
): C64AnnotationMatch {
    if (annotation.viewId !== graph.viewId) {
        return { annotation, status: "other-view" };
    }

    const candidates = graph.blocks
        .filter((block) => annotation.kind === "block" || entryAddresses.has(block.start))
        .map((block) => block.start);

    return {
        annotation,
        ...findSignatureMatch(annotation.address, annotation.instructions, candidates, (start) =>
            signature(annotation.kind, start),
        ),
    };
}

function codeSignatures(graph: C64ControlFlowGraph): {
    readonly locations: ReadonlySet<number>;
    readonly byHeader: ReadonlyMap<string, readonly number[]>;
    readonly signature: (address: number) => readonly (readonly number[])[] | undefined;
} {
    const locations = new Map<number, { block: C64BasicBlock; index: number }>();
    const byHeader = new Map<string, number[]>();

    for (const block of graph.blocks) {
        for (let index = 0; index < block.instructions.length; index++) {
            const instruction = block.instructions[index];
            if (locations.has(instruction.address)) {
                continue;
            }
            locations.set(instruction.address, { block, index });
            const key = `${instruction.bytes.join(",")}:${block.instructions.length - index}`;
            const addresses = byHeader.get(key) ?? [];
            addresses.push(instruction.address);
            byHeader.set(key, addresses);
        }
    }

    return {
        locations: new Set(locations.keys()),
        byHeader,
        signature: (address) => {
            const location = locations.get(address);
            return location?.block.instructions.slice(location.index).map((item) => [...item.bytes]);
        },
    };
}

function correctionMatches(correction: C64AnalysisCorrection, snapshot: SavedSnapshot): boolean {
    const offset = correction.start - snapshot.startAddress;

    return (
        correction.viewId === snapshot.viewId &&
        offset >= 0 &&
        offset + correction.bytes.length <= snapshot.bytes.length &&
        correction.bytes.every((byte, index) => snapshot.bytes[offset + index] === byte)
    );
}

/**
 * Persisted user knowledge and the latest captured bytes for each explicitly identified view.
 */
export class C64AnalysisState {
    readonly programId: string;
    private snapshots: SavedSnapshot[] = [];
    private userEntries: SavedUserEntry[] = [];
    private corrections: C64AnalysisCorrection[] = [];
    private annotations: C64AnalysisAnnotation[] = [];
    private labels: C64AnalysisLabel[] = [];
    private dataSections: C64DataSection[] = [];
    private graphs = new Map<string, C64ControlFlowGraph>();

    constructor(programId: string) {
        this.programId = text(programId, "Program ID");
    }

    analyze(
        decoder: C6510Decoder,
        viewId: string,
        entryPoints: readonly C64EntryPoint[],
        banking?: C64BankingContext,
        capture?: C64CaptureMetadata,
    ): C64ControlFlowGraph {
        text(viewId, "View ID");

        const snapshot: SavedSnapshot = {
            id: randomUUID(),
            viewId,
            startAddress: decoder.startAddress,
            bytes: Array.from(decoder.getBytes()),
            entryPoints: entryPoints.map((entry) => parseEntry(entry)),
            banking: banking === undefined ? undefined : validateC64BankingContext(banking),
            capture: capture === undefined ? undefined : parseCapture(capture),
            includeIllegalOpcodes: decoder.includeIllegalOpcodes,
        };

        const graph = this.graphFor(snapshot);

        this.snapshots = [...this.snapshots.filter((item) => item.viewId !== viewId), snapshot];
        this.graphs.set(viewId, graph);

        return graph;
    }

    captureMetadata(viewId: string): C64CaptureMetadata | undefined {
        const capture = this.snapshotFor(viewId).capture;

        return capture === undefined ? undefined : structuredClone(capture);
    }

    includeIllegalOpcodes(viewId: string): boolean {
        return this.snapshotFor(viewId).includeIllegalOpcodes;
    }

    setIncludeIllegalOpcodes(viewId: string, enabled: boolean): void {
        if (typeof enabled !== "boolean") {
            throw new Error("includeIllegalOpcodes must be a boolean.");
        }

        const snapshot = this.snapshotFor(viewId);

        this.snapshots = this.snapshots.map((item) =>
            item === snapshot ? { ...item, includeIllegalOpcodes: enabled } : item,
        );

        this.graphs.delete(viewId);
    }

    restoreGraph(viewId: string): C64ControlFlowGraph {
        const graph = this.graphFor(this.snapshotFor(viewId));
        this.graphs.set(viewId, graph);
        return graph;
    }

    addEntryPoint(viewId: string, entryAddress: number): void {
        text(viewId, "View ID");
        address(entryAddress, "Entry address");
        if (!this.userEntries.some((entry) => entry.viewId === viewId && entry.address === entryAddress)) {
            this.userEntries.push({ viewId, address: entryAddress });
            this.graphs.delete(viewId);
        }
    }

    removeEntryPoint(viewId: string, entryAddress: number): void {
        text(viewId, "View ID");
        address(entryAddress, "Entry address");
        const index = this.userEntries.findIndex((entry) => entry.viewId === viewId && entry.address === entryAddress);
        if (index < 0) {
            throw new Error("User entry point not found.");
        }
        this.userEntries.splice(index, 1);
        this.graphs.delete(viewId);
    }

    addLabel(
        graph: C64ControlFlowGraph,
        targetAddress: number,
        name: string,
        kind: C64LabelKind = "address",
    ): C64AnalysisLabel {
        this.requireCurrentGraph(graph);
        const label = this.createLabel(graph, targetAddress, name, kind, "user");
        this.requireAvailableLabelName(label.viewId, label.name);
        this.labels.push(label);
        this.refreshGraphLabels(label.viewId);
        return structuredClone(label);
    }

    renameLabel(id: string, name: string): void {
        const index = this.labelIndex(id);
        const label = this.labels[index];
        const nextName = labelName(name);
        this.requireAvailableLabelName(label.viewId, nextName, id);
        this.labels[index] = { ...label, name: nextName, source: "user" };
        this.refreshGraphLabels(label.viewId);
    }

    reattachLabel(id: string, graph: C64ControlFlowGraph, targetAddress: number, kind?: C64LabelKind): void {
        this.requireCurrentGraph(graph);
        const index = this.labelIndex(id);
        const previous = this.labels[index];
        this.requireAvailableLabelName(graph.viewId, previous.name, id);
        const next = this.createLabel(graph, targetAddress, previous.name, kind ?? previous.kind, "user", id);
        this.labels[index] = next;
        this.refreshGraphLabels(previous.viewId);
        if (previous.viewId !== next.viewId) {
            this.refreshGraphLabels(next.viewId);
        }
    }

    removeLabel(id: string): void {
        const [label] = this.labels.splice(this.labelIndex(id), 1);
        this.refreshGraphLabels(label.viewId);
    }

    listLabels(viewId?: string): readonly C64AnalysisLabel[] {
        if (viewId !== undefined) {
            text(viewId, "Label view");
        }
        return structuredClone(this.labels.filter((label) => viewId === undefined || label.viewId === viewId));
    }

    matchLabels(graph: C64ControlFlowGraph): readonly C64LabelMatch[] {
        this.requireCurrentGraph(graph);
        return this.labelMatchesFor(graph);
    }

    /** Replace a view's imported VICE labels without changing local user labels or VICE itself. */
    importViceLabels(graph: C64ControlFlowGraph, inputs: readonly C64ViceLabelInput[]): C64ViceLabelImportResult {
        this.requireCurrentGraph(graph);
        if (!Array.isArray(inputs)) {
            throw new Error("VICE labels must be an array.");
        }
        const previous = this.labels.filter((label) => label.viewId === graph.viewId && label.source === "vice");
        const users = this.labels.filter((label) => label.viewId === graph.viewId && label.source === "user");
        const names = new Set<string>();
        const conflicts: { name: string; viceAddress: number; userAddress: number }[] = [];
        const imported: C64AnalysisLabel[] = [];
        let codeIndex: ReturnType<typeof codeSignatures> | undefined;
        for (const input of inputs) {
            if (typeof input !== "object" || input === null) {
                throw new Error("VICE label must be an object.");
            }
            const name = labelName(input.name);
            const target = address(input.address, "VICE label address");
            if (names.has(name)) {
                throw new Error(`Duplicate VICE label name: ${name}`);
            }
            names.add(name);
            const kind = input.kind ?? "address";
            if (kind !== "address" && kind !== "code") {
                throw new Error("Label kind must be address or code.");
            }
            const user = users.find((item) => item.name === name);
            if (user) {
                conflicts.push({ name, viceAddress: target, userAddress: user.address });
                continue;
            }
            const old = previous.find((item) => item.name === name);
            if (old && old.address === target && old.kind === kind) {
                imported.push(old);
            } else {
                if (kind === "code") {
                    codeIndex ??= codeSignatures(graph);
                }
                imported.push(this.createLabel(graph, target, name, kind, "vice", old?.id, codeIndex));
            }
        }
        this.labels = [
            ...this.labels.filter((label) => label.viewId !== graph.viewId || label.source !== "vice"),
            ...imported,
        ];
        this.refreshGraphLabels(graph.viewId);
        return {
            imported: imported.length,
            removed: previous.filter((item) => !imported.some((next) => next.id === item.id)).length,
            conflicts,
        };
    }

    excludeRange(graph: C64ControlFlowGraph, start: number, end: number, description = ""): C64AnalysisCorrection {
        const snapshot = this.requireCurrentGraph(graph);
        address(start, "Correction start");
        address(end, "Correction end");
        text(description, "Correction description", true);
        if (end < start || start < snapshot.startAddress || end >= snapshot.startAddress + snapshot.bytes.length) {
            throw new RangeError("Correction range must be within the captured memory.");
        }
        const offset = start - snapshot.startAddress;
        const correction: C64AnalysisCorrection = {
            id: randomUUID(),
            viewId: graph.viewId,
            snapshotId: graph.snapshotId,
            start,
            end,
            description,
            bytes: snapshot.bytes.slice(offset, offset + end - start + 1),
        };
        this.corrections.push(correction);
        this.graphs.delete(graph.viewId);
        return structuredClone(correction);
    }

    removeCorrection(id: string): void {
        const index = this.corrections.findIndex((item) => item.id === id);
        if (index < 0) {
            throw new Error("Correction not found.");
        }
        const [correction] = this.corrections.splice(index, 1);
        this.graphs.delete(correction.viewId);
    }

    correctionStatuses(
        graph: C64ControlFlowGraph,
    ): readonly { correction: C64AnalysisCorrection; status: "active" | "stale" | "other-view" }[] {
        const snapshot = this.requireCurrentGraph(graph);
        return this.corrections.map((correction) => ({
            correction: structuredClone(correction),
            status:
                correction.viewId !== graph.viewId
                    ? "other-view"
                    : correctionMatches(correction, snapshot)
                      ? "active"
                      : "stale",
        }));
    }

    addDataSection(
        graph: C64ControlFlowGraph,
        start: number,
        end: number,
        type: string,
        description = "",
    ): C64DataSection {
        const snapshot = this.requireCurrentGraph(graph);
        address(start, "Data start");
        address(end, "Data end");
        if (end < start || start < snapshot.startAddress || end >= snapshot.startAddress + snapshot.bytes.length) {
            throw new RangeError("Data section must be within the captured memory.");
        }
        const offset = start - snapshot.startAddress;
        const section = parseDataSection({
            id: randomUUID(),
            viewId: graph.viewId,
            snapshotId: graph.snapshotId,
            start,
            end,
            type,
            description,
            bytes: snapshot.bytes.slice(offset, offset + end - start + 1),
        });
        this.dataSections.push(section);
        return structuredClone(section);
    }

    removeDataSection(id: string): void {
        const index = this.dataSections.findIndex((section) => section.id === id);
        if (index < 0) {
            throw new Error("Data section not found.");
        }
        this.dataSections.splice(index, 1);
    }

    updateDataSection(id: string, type: string, description: string): void {
        const index = this.dataSections.findIndex((section) => section.id === id);
        if (index < 0) {
            throw new Error("Data section not found.");
        }
        this.dataSections[index] = parseDataSection({ ...this.dataSections[index], type, description });
    }

    reattachDataSection(id: string, graph: C64ControlFlowGraph, start: number, end: number): void {
        const index = this.dataSections.findIndex((section) => section.id === id);
        if (index < 0) {
            throw new Error("Data section not found.");
        }
        const snapshot = this.requireCurrentGraph(graph);
        address(start, "Data start");
        address(end, "Data end");
        if (end < start || start < snapshot.startAddress || end >= snapshot.startAddress + snapshot.bytes.length) {
            throw new RangeError("Data section must be within the captured memory.");
        }
        const offset = start - snapshot.startAddress;
        this.dataSections[index] = parseDataSection({
            ...this.dataSections[index],
            viewId: graph.viewId,
            snapshotId: graph.snapshotId,
            start,
            end,
            bytes: snapshot.bytes.slice(offset, offset + end - start + 1),
        });
    }

    dataSectionStatuses(graph: C64ControlFlowGraph): readonly C64DataSectionMatch[] {
        const snapshot = this.requireCurrentGraph(graph);
        return this.dataSections.map((section) => ({
            section: structuredClone(section),
            status:
                section.viewId !== graph.viewId
                    ? "other-view"
                    : correctionMatches(section, snapshot)
                      ? "active"
                      : "stale",
        }));
    }

    addAnnotation(
        graph: C64ControlFlowGraph,
        kind: C64AnnotationKind,
        targetAddress: number,
        name: string,
        description: string,
    ): C64AnalysisAnnotation {
        this.requireCurrentGraph(graph);
        if (kind !== "block" && kind !== "entry") {
            throw new Error("Annotation kind must be block or entry.");
        }
        text(name, "Annotation name", true);
        text(description, "Annotation description", true);
        const block = this.annotationBlock(graph, kind, targetAddress);
        const annotation: C64AnalysisAnnotation = {
            id: randomUUID(),
            kind,
            viewId: graph.viewId,
            snapshotId: graph.snapshotId,
            address: targetAddress,
            name,
            description,
            instructions: signatureReader(graph)(kind, block.start),
        };
        this.annotations.push(annotation);
        return structuredClone(annotation);
    }

    updateAnnotation(id: string, name: string, description: string): void {
        text(name, "Annotation name", true);
        text(description, "Annotation description", true);
        const index = this.annotationIndex(id);
        this.annotations[index] = { ...this.annotations[index], name, description };
    }

    reattachAnnotation(id: string, graph: C64ControlFlowGraph, targetAddress: number): void {
        this.requireCurrentGraph(graph);
        const index = this.annotationIndex(id);
        const annotation = this.annotations[index];
        const block = this.annotationBlock(graph, annotation.kind, targetAddress);
        this.annotations[index] = {
            ...annotation,
            viewId: graph.viewId,
            snapshotId: graph.snapshotId,
            address: targetAddress,
            instructions: signatureReader(graph)(annotation.kind, block.start),
        };
    }

    removeAnnotation(id: string): void {
        this.annotations.splice(this.annotationIndex(id), 1);
    }

    matchAnnotations(graph: C64ControlFlowGraph): readonly C64AnnotationMatch[] {
        this.requireCurrentGraph(graph);
        const signature = signatureReader(graph);
        const entryAddresses = new Set(graph.entryPoints.map((entry) => entry.address));
        const matches = this.annotations.map((annotation) =>
            findMatch(structuredClone(annotation), graph, signature, entryAddresses),
        );
        const origins = new Map<number, Set<number>>();
        for (const match of matches) {
            if (match.address !== undefined) {
                const addresses = origins.get(match.address) ?? new Set<number>();
                addresses.add(match.annotation.address);
                origins.set(match.address, addresses);
            }
        }
        return matches.map((match) =>
            match.address !== undefined && (origins.get(match.address)?.size ?? 0) > 1
                ? { annotation: match.annotation, status: "orphaned" }
                : match,
        );
    }

    serialize(): string {
        const state: SavedState = {
            version: 5,
            programId: this.programId,
            snapshots: this.snapshots,
            userEntries: this.userEntries,
            corrections: this.corrections,
            annotations: this.annotations,
            labels: this.labels,
            dataSections: this.dataSections,
        };
        return JSON.stringify(state, null, 2);
    }

    static deserialize(json: string): C64AnalysisState {
        const input: unknown = JSON.parse(json);
        const state = record(input, "Analysis state");
        if (
            state.version !== 1 &&
            state.version !== 2 &&
            state.version !== 3 &&
            state.version !== 4 &&
            state.version !== 5
        ) {
            throw new Error("Unsupported analysis state version.");
        }
        const result = new C64AnalysisState(text(state.programId, "Program ID"));
        const version = state.version;
        result.snapshots = list(state.snapshots, "Snapshots").map((snapshot) => parseSnapshot(snapshot, version));
        result.userEntries = list(state.userEntries, "User entry points").map((item) => {
            const entry = record(item, "User entry");
            return { viewId: text(entry.viewId, "Entry view"), address: address(entry.address, "Entry address") };
        });
        result.corrections = list(state.corrections, "Corrections").map(parseCorrection);
        result.annotations = list(state.annotations, "Annotations").map(parseAnnotation);
        result.labels = version >= 3 ? list(state.labels, "Labels").map(parseLabel) : [];
        result.dataSections = version >= 4 ? list(state.dataSections, "Data sections").map(parseDataSection) : [];
        if (
            new Set(result.snapshots.map((snapshot) => snapshot.viewId)).size !== result.snapshots.length ||
            new Set(result.userEntries.map((entry) => `${entry.viewId}:${entry.address}`)).size !==
                result.userEntries.length ||
            new Set(result.corrections.map((item) => item.id)).size !== result.corrections.length ||
            new Set(result.annotations.map((item) => item.id)).size !== result.annotations.length ||
            new Set(result.labels.map((item) => item.id)).size !== result.labels.length ||
            new Set(result.dataSections.map((item) => item.id)).size !== result.dataSections.length ||
            new Set(result.labels.map((item) => `${item.viewId}\u0000${item.name}`)).size !== result.labels.length
        ) {
            throw new Error("Analysis state contains duplicate identifiers or entries.");
        }
        return result;
    }

    async save(path: string): Promise<void> {
        text(path, "State path");
        const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        let renamed = false;
        try {
            try {
                await handle.writeFile(this.serialize(), "utf8");
            } finally {
                await handle.close();
            }
            await rename(temporary, path);
            renamed = true;
        } finally {
            if (!renamed) {
                await unlink(temporary);
            }
        }
    }

    static async load(path: string): Promise<C64AnalysisState> {
        text(path, "State path");
        return C64AnalysisState.deserialize(await readFile(path, "utf8"));
    }

    private snapshotFor(viewId: string): SavedSnapshot {
        text(viewId, "View ID");
        const snapshot = this.snapshots.find((item) => item.viewId === viewId);
        if (!snapshot) {
            throw new Error(`No saved snapshot for view ${viewId}.`);
        }
        return snapshot;
    }

    private requireCurrentGraph(graph: C64ControlFlowGraph): SavedSnapshot {
        if (graph.programId !== this.programId) {
            throw new Error("Graph belongs to a different program.");
        }
        const snapshot = this.snapshotFor(graph.viewId);
        if (snapshot.id !== graph.snapshotId || this.graphs.get(graph.viewId) !== graph) {
            throw new Error("Graph is not the current analysis for its view.");
        }
        return snapshot;
    }

    private graphFor(snapshot: SavedSnapshot): C64ControlFlowGraph {
        const entries: C64EntryPoint[] = [
            ...snapshot.entryPoints,
            ...this.userEntries
                .filter((entry) => entry.viewId === snapshot.viewId)
                .map((entry) => ({ address: entry.address, source: "user" as const })),
        ];
        const excludedRanges: C64ExcludedRange[] = this.corrections
            .filter((correction) => correctionMatches(correction, snapshot))
            .map(({ start, end }) => ({ start, end }));
        const graph = buildC64ControlFlowGraph(
            new C6510Decoder(Uint8Array.from(snapshot.bytes), snapshot.startAddress, {
                includeIllegalOpcodes: snapshot.includeIllegalOpcodes,
            }),
            {
                programId: this.programId,
                viewId: snapshot.viewId,
                snapshotId: snapshot.id,
                entryPoints: entries,
                excludedRanges,
                banking: snapshot.banking,
            },
        );
        setGraphLabels(graph, this.labelMatchesFor(graph));
        return graph;
    }

    private labelMatchesFor(graph: C64ControlFlowGraph): C64LabelMatch[] {
        const code = this.labels.some((label) => label.viewId === graph.viewId && label.kind === "code")
            ? codeSignatures(graph)
            : undefined;
        const matches: C64LabelMatch[] = this.labels.map((item) => {
            const label = structuredClone(item);
            if (label.viewId !== graph.viewId) {
                return { label, status: "other-view" };
            }
            if (label.kind === "address") {
                return { label, status: "fixed", address: label.address };
            }
            if (!code) {
                throw new Error("Missing code-label index.");
            }
            const key = `${label.instructions[0].join(",")}:${label.instructions.length}`;
            const candidates = new Set(code.byHeader.get(key) ?? []);
            if (code.locations.has(label.address)) {
                candidates.add(label.address);
            }
            return {
                label,
                ...findSignatureMatch(label.address, label.instructions, [...candidates], (address) => {
                    const signature = code.signature(address);
                    if (!signature) {
                        throw new Error("Missing code-label signature.");
                    }
                    return signature;
                }),
            };
        });
        const origins = new Map<number, Set<number>>();
        for (const match of matches) {
            if (match.label.kind === "code" && match.address !== undefined) {
                const addresses = origins.get(match.address) ?? new Set<number>();
                addresses.add(match.label.address);
                origins.set(match.address, addresses);
            }
        }
        return matches.map((match) =>
            match.label.kind === "code" && match.address !== undefined && (origins.get(match.address)?.size ?? 0) > 1
                ? { label: match.label, status: "orphaned" }
                : match,
        );
    }

    private refreshGraphLabels(viewId: string): void {
        const graph = this.graphs.get(viewId);
        if (graph) {
            setGraphLabels(graph, this.labelMatchesFor(graph));
        }
    }

    private createLabel(
        graph: C64ControlFlowGraph,
        targetAddress: number,
        name: string,
        kind: C64LabelKind,
        source: C64LabelSource,
        id: string = randomUUID(),
        codeIndex?: ReturnType<typeof codeSignatures>,
    ): C64AnalysisLabel {
        const base = {
            id,
            viewId: graph.viewId,
            address: address(targetAddress, "Label address"),
            name: labelName(name),
            source,
        };
        if (kind === "address") {
            return { ...base, kind };
        }
        if (kind !== "code") {
            throw new Error("Label kind must be address or code.");
        }
        const instructions = (codeIndex ?? codeSignatures(graph)).signature(base.address);
        if (!instructions) {
            throw new Error("Code label must target a discovered instruction.");
        }
        return { ...base, kind, snapshotId: graph.snapshotId, instructions };
    }

    private requireAvailableLabelName(viewId: string, name: string, exceptId?: string): void {
        if (this.labels.some((label) => label.viewId === viewId && label.name === name && label.id !== exceptId)) {
            throw new Error(`Label name already exists in this view: ${name}`);
        }
    }

    private labelIndex(id: string): number {
        const index = this.labels.findIndex((label) => label.id === id);
        if (index < 0) {
            throw new Error("Label not found.");
        }
        return index;
    }

    private annotationBlock(graph: C64ControlFlowGraph, kind: C64AnnotationKind, targetAddress: number): C64BasicBlock {
        address(targetAddress, "Annotation address");
        const block = graph.blocks.find((item) => item.start === targetAddress);
        if (!block || (kind === "entry" && !graph.entryPoints.some((entry) => entry.address === targetAddress))) {
            throw new Error("Annotation target is not a discovered block or requested entry.");
        }
        return block;
    }

    private annotationIndex(id: string): number {
        const index = this.annotations.findIndex((annotation) => annotation.id === id);
        if (index < 0) {
            throw new Error("Annotation not found.");
        }
        return index;
    }
}
