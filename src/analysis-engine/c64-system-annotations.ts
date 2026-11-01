import { C64BasicRom, type C64BasicRomEntry } from "./c64-basic-rom.js";
import type { C64ControlFlowGraph, C64EntryPoint, C64MemoryReference } from "./c64-control-flow.js";
import { C64KernalFunctions, type C64KernalFunction } from "./c64-kernal-functions.js";
import { C64MemoryMap, type C64MemoryMapEntry, type C64MemoryView } from "./c64-memory-map.js";
import type { C6510Instruction } from "./c6510-decoder.js";

/** Initial evidence about the CPU port. Omitted values are unknown, not zero. */
export interface C64BankingContext {
    readonly direction?: number;
    readonly data?: number;
    readonly inputPins?: number;
    readonly cartridge: "none" | "unknown";
}

/** A conventional PRG startup assumption, not a measurement of a running machine. */
export const C64_PRG_DEFAULT_BANKING: C64BankingContext = Object.freeze({
    direction: 0x2f,
    data: 0x37,
    cartridge: "none",
});

export type C64MappedView = C64MemoryView | "unmapped";

export interface C64SystemAnnotation {
    readonly from: number;
    readonly address: number;
    readonly access: "read" | "write" | "call" | "jump";
    readonly kind: "kernal-call" | "kernal-rom" | "basic-rom" | "hardware" | "banking" | "vector" | "workspace" | "ram";
    readonly view: C64MemoryView;
    readonly certainty: "mapped" | "conditional" | "conventional";
    readonly name: string;
    readonly description: string;
    readonly condition?: string;
    readonly source: string;
    readonly sourceRevision?: number;
    readonly referenceVersion?: string;
    readonly memoryMapEntry?: C64MemoryMapEntry;
    readonly kernalFunction?: C64KernalFunction;
    readonly basicRomEntry?: C64BasicRomEntry;
}

interface Bits {
    readonly known: number;
    readonly value: number;
}

interface State {
    readonly direction: Bits;
    readonly data: Bits;
    readonly inputPins: Bits;
    readonly cartridge: "none" | "unknown";
    readonly A: Bits;
    readonly X: Bits;
    readonly Y: Bits;
}

const unknown: Bits = { known: 0, value: 0 };
const bits = (value: number | undefined): Bits => (value === undefined ? unknown : { known: 7, value: value & 7 });

export function validateC64BankingContext(context: C64BankingContext): C64BankingContext {
    if (typeof context !== "object" || context === null || !["none", "unknown"].includes(context.cartridge)) {
        throw new Error("Banking context requires cartridge to be 'none' or 'unknown'.");
    }
    for (const [name, value] of Object.entries({
        direction: context.direction,
        data: context.data,
        inputPins: context.inputPins,
    })) {
        if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 255)) {
            throw new RangeError(`Banking ${name} must be an 8-bit integer.`);
        }
    }
    return {
        direction: context.direction,
        data: context.data,
        inputPins: context.inputPins,
        cartridge: context.cartridge,
    };
}

function joinBits(a: Bits, b: Bits): Bits {
    const known = a.known & b.known & ~(a.value ^ b.value) & 7;
    return { known, value: a.value & known };
}

function join(a: State, b: State): State {
    return {
        direction: joinBits(a.direction, b.direction),
        data: joinBits(a.data, b.data),
        inputPins: joinBits(a.inputPins, b.inputPins),
        cartridge: a.cartridge === b.cartridge ? a.cartridge : "unknown",
        A: joinBits(a.A, b.A),
        X: joinBits(a.X, b.X),
        Y: joinBits(a.Y, b.Y),
    };
}

function effective(state: State): Bits {
    let known = 0;
    let value = 0;
    for (const bit of [1, 2, 4]) {
        const directionKnown = (state.direction.known & bit) !== 0;
        const output = (state.direction.value & bit) !== 0;
        const source = output ? state.data : state.inputPins;
        const bothAgree =
            (state.data.known & state.inputPins.known & bit) !== 0 &&
            ((state.data.value ^ state.inputPins.value) & bit) === 0;
        if ((directionKnown && (source.known & bit) !== 0) || (!directionKnown && bothAgree)) {
            known |= bit;
            value |= (directionKnown ? source.value : state.data.value) & bit;
        }
    }
    return { known, value };
}

/** Possible CPU-visible read views, or write destinations, under the supplied evidence. */
export function c64PossibleMemoryViews(
    address: number,
    access: "read" | "write",
    context: C64BankingContext,
): readonly C64MappedView[] {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
        throw new RangeError("Address must be a 16-bit integer.");
    }
    if (access !== "read" && access !== "write") {
        throw new Error("Access must be read or write.");
    }
    const input = validateC64BankingContext(context);
    return possibleViews(address, access, {
        direction: bits(input.direction),
        data: bits(input.data),
        inputPins: bits(input.inputPins),
        cartridge: input.cartridge,
        A: unknown,
        X: unknown,
        Y: unknown,
    });
}

function possibleViews(address: number, access: "read" | "write", state: State): C64MappedView[] {
    if (address < 2) {
        return ["cpu-port"];
    }
    if (address < 0x1000) {
        return ["ram"];
    }
    if (state.cartridge === "unknown") {
        if (address < 0x8000 || (address >= 0xc000 && address < 0xd000)) {
            return ["ram", "unmapped"];
        }
        if (address < 0xa000) {
            return ["ram", "cartridge"];
        }
        if (address < 0xc000) {
            return access === "read" ? ["ram", "basic-rom", "cartridge", "unmapped"] : ["ram", "cartridge", "unmapped"];
        }
        if (address < 0xe000) {
            return access === "read" ? ["ram", "io", "character-rom", "cartridge"] : ["ram", "io", "cartridge"];
        }
        return access === "read" ? ["ram", "kernal-rom", "cartridge"] : ["ram", "cartridge"];
    }
    if (address < 0x8000 || (address >= 0xc000 && address < 0xd000)) {
        return ["ram"];
    }
    if (address < 0xa000) {
        return ["ram"];
    }
    const pins = effective(state);
    const views = new Set<C64MemoryView>();
    for (let config = 0; config < 8; config++) {
        if ((config & pins.known) !== pins.value) {
            continue;
        }
        const loram = (config & 1) !== 0;
        const hiram = (config & 2) !== 0;
        const charen = (config & 4) !== 0;
        if (address < 0xc000) {
            views.add(access === "read" && loram && hiram ? "basic-rom" : "ram");
        } else if (address < 0xe000) {
            if (!loram && !hiram) {
                views.add("ram");
            } else if (charen) {
                views.add("io");
            } else {
                views.add(access === "read" ? "character-rom" : "ram");
            }
        } else {
            views.add(access === "read" && hiram ? "kernal-rom" : "ram");
        }
    }
    return [...views];
}

function canWrite(reference: C64MemoryReference, address: number): boolean {
    if (reference.access !== "write") {
        return false;
    }
    const target = reference.target;
    if (target.kind === "indirect" || target.kind === "unstable") {
        return true;
    }
    if (target.kind === "direct") {
        return target.address === address;
    }
    if (target.wrap === "zero-page") {
        return address <= 0xff;
    }
    return ((address - target.base) & 0xffff) <= 0xff;
}

function transfer(instruction: C6510Instruction, state: State, references: readonly C64MemoryReference[]): State {
    let direction = state.direction;
    let data = state.data;
    const operand = instruction.operand;
    const storeValue =
        instruction.mnemonic === "STA"
            ? state.A
            : instruction.mnemonic === "STX"
              ? state.X
              : instruction.mnemonic === "STY"
                ? state.Y
                : unknown;
    for (const reference of references) {
        if (canWrite(reference, 0)) {
            direction = reference.target.kind === "direct" && reference.target.address === 0 ? storeValue : unknown;
        }
        if (canWrite(reference, 1)) {
            data = reference.target.kind === "direct" && reference.target.address === 1 ? storeValue : unknown;
        }
    }
    let A = state.A;
    let X = state.X;
    let Y = state.Y;
    for (const register of instruction.opcode.effects.registersWritten) {
        if (register === "A") {
            A = unknown;
        }
        if (register === "X") {
            X = unknown;
        }
        if (register === "Y") {
            Y = unknown;
        }
    }
    const loaded =
        operand.kind === "immediate"
            ? bits(operand.value)
            : operand.kind === "address" && operand.index === undefined && operand.address === 0
              ? state.direction
              : operand.kind === "address" && operand.index === undefined && operand.address === 1
                ? effective(state)
                : unknown;
    switch (instruction.mnemonic) {
        case "LDA":
            A = loaded;
            break;
        case "LDX":
            X = loaded;
            break;
        case "LDY":
            Y = loaded;
            break;
        case "TAX":
            X = state.A;
            break;
        case "TAY":
            Y = state.A;
            break;
        case "TXA":
            A = state.X;
            break;
        case "TYA":
            A = state.Y;
            break;
        case "AND":
        case "ORA":
        case "EOR":
            if (operand.kind === "immediate") {
                const v = operand.value & 7;
                if (instruction.mnemonic === "AND") {
                    A = { known: state.A.known | (7 ^ v), value: state.A.value & v };
                }
                if (instruction.mnemonic === "ORA") {
                    A = { known: state.A.known | v, value: state.A.value | v };
                }
                if (instruction.mnemonic === "EOR") {
                    A = { known: state.A.known, value: (state.A.value ^ v) & state.A.known };
                }
            }
            break;
    }
    return { ...state, direction, data, A, X, Y };
}

function statesFor(
    graph: C64ControlFlowGraph,
    entries: readonly C64EntryPoint[],
    context: C64BankingContext,
): Map<number, State> {
    const initial: State = {
        direction: bits(context.direction),
        data: bits(context.data),
        inputPins: bits(context.inputPins),
        cartridge: context.cartridge,
        A: unknown,
        X: unknown,
        Y: unknown,
    };
    const instructions = new Map(graph.instructions.map((instruction) => [instruction.address, instruction]));
    const edges = new Map<number, (typeof graph.edges)[number][]>();
    const refs = new Map<number, C64MemoryReference[]>();
    for (const edge of graph.edges) {
        edges.set(edge.from, [...(edges.get(edge.from) ?? []), edge]);
    }
    for (const reference of graph.references) {
        refs.set(reference.from, [...(refs.get(reference.from) ?? []), reference]);
    }
    const states = new Map<number, State>();
    const work: number[] = [];
    function add(address: number, state: State): void {
        if (!instructions.has(address)) {
            return;
        }
        const previous = states.get(address);
        const next = previous ? join(previous, state) : state;
        if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
            states.set(address, next);
            work.push(address);
        }
    }
    for (const entry of entries) {
        add(entry.address, initial);
    }
    for (let cursor = 0; cursor < work.length; cursor++) {
        const address = work[cursor];
        const instruction = instructions.get(address)!;
        const state = states.get(address)!;
        const after = transfer(instruction, state, refs.get(address) ?? []);
        for (const edge of edges.get(address) ?? []) {
            if (edge.target === undefined) {
                continue;
            }
            // A call can change both the port and registers before returning.
            const outgoing =
                instruction.opcode.effects.flow === "call" && edge.kind === "fallthrough"
                    ? {
                          ...after,
                          direction: unknown,
                          data: unknown,
                          inputPins: unknown,
                          A: unknown,
                          X: unknown,
                          Y: unknown,
                      }
                    : after;
            add(edge.target, outgoing);
        }
    }
    return states;
}

function fromMap(
    entry: C64MemoryMapEntry,
    from: number,
    address: number,
    access: C64SystemAnnotation["access"],
    kind: C64SystemAnnotation["kind"],
    certainty: C64SystemAnnotation["certainty"],
    condition?: string,
): C64SystemAnnotation {
    return {
        from,
        address,
        access,
        kind,
        view: entry.view,
        certainty,
        name: entry.name,
        description: entry.description,
        condition,
        source: entry.source,
        sourceRevision: entry.sourceRevision,
        referenceVersion: entry.referenceVersion,
        memoryMapEntry: entry,
    };
}

function mostSpecific(entries: readonly C64MemoryMapEntry[]): readonly C64MemoryMapEntry[] {
    if (entries.length === 0) {
        return [];
    }
    const size = Math.min(...entries.map((entry) => entry.end - entry.start));
    return entries.filter((entry) => entry.end - entry.start === size);
}

/** Rebuild reference-derived annotations for a candidate graph; they are not user annotations. */
export function analyzeC64SystemAnnotations(
    graph: C64ControlFlowGraph,
    entries: readonly C64EntryPoint[],
    context: C64BankingContext,
): {
    readonly annotations: readonly C64SystemAnnotation[];
    readonly viewsAt: (address: number, target: number, access: "read" | "write") => readonly C64MappedView[];
} {
    const states = statesFor(graph, entries, validateC64BankingContext(context));
    const annotations: C64SystemAnnotation[] = [];
    const viewsAt = (address: number, target: number, access: "read" | "write"): readonly C64MappedView[] => {
        const state = states.get(address);
        if (!state) {
            return [];
        }
        return possibleViews(target, access, state);
    };
    for (const reference of graph.references) {
        if (reference.target.kind !== "direct") {
            continue;
        }
        const target = reference.target.address;
        const views = viewsAt(reference.from, target, reference.access);
        const certainty = (view: C64MemoryView) =>
            views.length === 1 && views[0] === view ? ("mapped" as const) : ("conditional" as const);
        if (views.includes("cpu-port")) {
            for (const item of C64MemoryMap.at(target, "cpu-port")) {
                annotations.push(fromMap(item, reference.from, target, reference.access, "banking", "mapped"));
            }
        }
        if (views.includes("ram") && target >= 2 && target < 0x0800) {
            for (const item of mostSpecific(
                C64MemoryMap.at(target, "ram").filter((entry) => entry.name !== "Underlying RAM"),
            )) {
                const vector = /vector/i.test(item.name);
                annotations.push({
                    ...fromMap(
                        item,
                        reference.from,
                        target,
                        reference.access,
                        vector ? "vector" : "workspace",
                        "conventional",
                    ),
                    condition: "Conventional use only; custom code may reuse this RAM and vector contents may differ.",
                });
            }
        }
        if (views.includes("io")) {
            for (const item of mostSpecific(C64MemoryMap.at(target, "io"))) {
                annotations.push(
                    fromMap(
                        item,
                        reference.from,
                        target,
                        reference.access,
                        "hardware",
                        certainty("io"),
                        views.length > 1 ? "If I/O is mapped." : undefined,
                    ),
                );
            }
        }
        if (
            reference.access === "write" &&
            views.includes("ram") &&
            target >= 0xa000 &&
            (target < 0xc000 || target >= 0xd000)
        ) {
            const item = C64MemoryMap.at(target, "ram").find((entry) => entry.name === "Underlying RAM")!;
            annotations.push(
                fromMap(
                    item,
                    reference.from,
                    target,
                    reference.access,
                    "ram",
                    certainty("ram"),
                    views.length > 1
                        ? "If the write reaches underlying RAM."
                        : "Writes beneath ROM reach RAM on a standard no-cartridge C64.",
                ),
            );
        }
        if (target >= 0xfffa) {
            for (const view of ["ram", "kernal-rom"] as const) {
                if (!views.includes(view)) {
                    continue;
                }
                for (const item of C64MemoryMap.at(target, view).filter((entry) =>
                    entry.name.startsWith("Hardware "),
                )) {
                    annotations.push(
                        fromMap(
                            item,
                            reference.from,
                            target,
                            reference.access,
                            "vector",
                            certainty(view),
                            "Hardware vector address; contents and mapping at interrupt time are not established.",
                        ),
                    );
                }
            }
        }
        if (reference.access === "read") {
            for (const view of ["basic-rom", "kernal-rom"] as const) {
                if (!views.includes(view)) {
                    continue;
                }
                for (const item of C64MemoryMap.at(target, view).filter(
                    (entry) => entry.basicRomEntryAddress !== undefined,
                )) {
                    annotations.push({
                        ...fromMap(
                            item,
                            reference.from,
                            target,
                            reference.access,
                            item.basicRomEntryKind === "vector" ? "vector" : "basic-rom",
                            "conditional",
                            "If the compatible standard ROM is present and mapped.",
                        ),
                        basicRomEntry:
                            item.basicRomEntryAddress === undefined
                                ? undefined
                                : C64BasicRom.getByAddress(item.basicRomEntryAddress),
                    });
                }
            }
            if (views.includes("kernal-rom")) {
                for (const item of C64MemoryMap.at(target, "kernal-rom").filter(
                    (entry) => entry.kernalFunction !== undefined,
                )) {
                    annotations.push({
                        ...fromMap(item, reference.from, target, reference.access, "kernal-rom", "conditional"),
                        condition: "If the compatible standard KERNAL is present and mapped; vectors may be changed.",
                        source: "https://sta.c64.org/cbm64krnfunc.html",
                        referenceVersion: "Standard C64 KERNAL; source revision unspecified",
                        kernalFunction:
                            item.kernalFunctionAddress === undefined
                                ? undefined
                                : C64KernalFunctions.getByAddress(item.kernalFunctionAddress),
                    });
                }
            }
        }
    }
    for (const instruction of graph.instructions) {
        if (instruction.opcode.effects.defaultVectorAddress !== 0xfffe) {
            continue;
        }
        for (const target of [0xfffe, 0xfffa]) {
            const views = viewsAt(instruction.address, target, "read");
            for (const view of ["ram", "kernal-rom"] as const) {
                if (!views.includes(view)) {
                    continue;
                }
                for (const item of C64MemoryMap.at(target, view).filter((entry) =>
                    entry.name.startsWith("Hardware "),
                )) {
                    annotations.push(
                        fromMap(
                            item,
                            instruction.address,
                            target,
                            "read",
                            "vector",
                            "conditional",
                            target === 0xfffe
                                ? "BRK normally reads this hardware vector; an NMI can hijack vector selection. Contents are unknown."
                                : "An NMI can hijack BRK vector selection. Contents are unknown.",
                        ),
                    );
                }
            }
        }
    }
    for (const edge of graph.edges) {
        if ((edge.kind !== "call" && edge.kind !== "jump") || edge.target === undefined) {
            continue;
        }
        const target = edge.target;
        const views = viewsAt(edge.from, target, "read");
        const kernal = views.includes("kernal-rom") ? C64KernalFunctions.getByAddress(target) : undefined;
        if (kernal) {
            annotations.push({
                from: edge.from,
                address: target,
                access: edge.kind,
                kind: "kernal-call",
                view: "kernal-rom",
                certainty: "conditional",
                name: `KERNAL ${kernal.name}`,
                description: kernal.description,
                condition: "If the compatible standard KERNAL is present and mapped; vectors may be changed.",
                source: "https://sta.c64.org/cbm64krnfunc.html",
                referenceVersion: "Standard C64 KERNAL; source revision unspecified",
                kernalFunction: kernal,
            });
        }
        const basic = C64BasicRom.getByAddress(target);
        if (basic?.kind === "routine" && views.includes(basic.view)) {
            annotations.push({
                from: edge.from,
                address: target,
                access: edge.kind,
                kind: "basic-rom",
                view: basic.view,
                certainty: "conditional",
                name: `BASIC ${basic.name}`,
                description: basic.description,
                condition: "If the compatible standard ROM is present and mapped.",
                source: basic.source,
                sourceRevision: basic.sourceRevision,
                referenceVersion: basic.version,
                basicRomEntry: basic,
            });
        }
    }
    return { annotations, viewsAt };
}
