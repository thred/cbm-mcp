import type { C64ControlFlowGraph } from "./c64-control-flow.js";
import type { C64SystemAnnotation } from "./c64-system-annotations.js";
import type { C6510Instruction } from "./c6510-decoder.js";

export interface C64AutomaticLabel {
    readonly address: number;
    readonly name: string;
    readonly kind: "code" | "memory" | "zero-page" | "banking" | "hardware" | "vector" | "kernal" | "basic";
    readonly source: "generated" | "reference";
    readonly condition?: string;
    readonly annotation?: C64SystemAnnotation;
}

interface Draft {
    readonly address: number;
    readonly base: string;
    readonly kind: C64AutomaticLabel["kind"];
    readonly annotation?: C64SystemAnnotation;
}

export interface C64SymbolTable {
    readonly automaticLabels: readonly C64AutomaticLabel[];
    readonly userLabels: ReadonlyMap<number, readonly string[]>;
    readonly resolve: (instructionAddress: number, targetAddress: number) => string | undefined;
}

function hex(address: number, width = 4): string {
    return address.toString(16).padStart(width, "0");
}

function slug(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase()
        .slice(0, 48)
        .replace(/_+$/g, "");
}

function operandAddress(instruction: C6510Instruction): number | undefined {
    const operand = instruction.operand;
    if (operand.kind === "address") {
        return operand.address;
    }
    if (operand.kind === "relative") {
        return operand.targetAddress;
    }
    if (operand.kind === "indirect") {
        return operand.pointerAddress;
    }
    return undefined;
}

function referenceDraft(
    graph: C64ControlFlowGraph,
    instruction: C6510Instruction,
    address: number,
    annotations: readonly C64SystemAnnotation[],
): Draft | undefined {
    const operand = instruction.operand;
    const access =
        operand.kind === "indirect" || instruction.opcode.effects.flow !== "next"
            ? "read"
            : instruction.opcode.effects.operandAccess === "write"
              ? "write"
              : "read";
    const views = graph.possibleViewsAt(instruction.address, address, access);
    if (views.length !== 1) {
        return undefined;
    }
    if (
        instruction.opcode.effects.operandAccess === "read-modify-write" &&
        (graph.possibleViewsAt(instruction.address, address, "write").length !== 1 ||
            graph.possibleViewsAt(instruction.address, address, "write")[0] !== views[0])
    ) {
        return undefined;
    }
    const relevant = annotations.filter((item) => item.address === address && item.view === views[0]);
    const port = relevant.find((item) => item.kind === "banking");
    if (port) {
        return { address, base: address === 0 ? "cpu_port_direction" : "cpu_port", kind: "banking", annotation: port };
    }
    if (address < 0x100) {
        return undefined;
    }
    const kernal = relevant.find((item) => item.kind === "kernal-call" || item.kind === "kernal-rom");
    if (kernal && views[0] === "kernal-rom") {
        const name = slug(kernal.kernalFunction?.name ?? kernal.name.replace(/^KERNAL\s+/i, ""));
        if (name) {
            const suffix = kernal.kernalFunction?.address === address ? "" : `_${hex(address)}`;
            return { address, base: `kernal_${name}${suffix}`, kind: "kernal", annotation: kernal };
        }
    }
    const basic = relevant.find((item) => item.basicRomEntry !== undefined);
    if (basic && (views[0] === "basic-rom" || views[0] === "kernal-rom")) {
        const name = slug((basic.basicRomEntry?.name ?? basic.name).replace(/^BASIC\s+/i, ""));
        if (name) {
            const suffix = basic.basicRomEntry?.address === address ? "" : `_${hex(address)}`;
            return { address, base: `basic_${name}${suffix}`, kind: "basic", annotation: basic };
        }
    }
    const vector = relevant.find((item) => item.kind === "vector");
    if (vector && (views[0] === "ram" || views[0] === "kernal-rom")) {
        const name = slug(vector.name.replace(/^Hardware\s+/i, "").replace(/\s+vector$/i, ""));
        if (name) {
            const prefix =
                vector.certainty === "conventional"
                    ? "vector_maybe"
                    : `vector_${views[0] === "ram" ? "ram" : "kernal"}`;
            return { address, base: `${prefix}_${name}_${hex(address)}`, kind: "vector", annotation: vector };
        }
    }
    const hardware = relevant.find((item) => item.kind === "hardware");
    if (hardware && views[0] === "io") {
        const name = slug(hardware.name);
        if (name) {
            return { address, base: `io_${name}_${hex(address)}`, kind: "hardware", annotation: hardware };
        }
    }
    return undefined;
}

/** Rebuild automatic symbols from this graph and the current confirmed user/VICE labels. */
export function createC64SymbolTable(graph: C64ControlFlowGraph): C64SymbolTable {
    const userMatches = graph.labelMatches.filter((match) => match.label.viewId === graph.viewId);
    const userLabels = new Map<number, typeof userMatches>();
    const reserved = new Set(userMatches.map((match) => match.label.name.toLowerCase()));
    for (const match of userMatches) {
        if (match.address === undefined || (match.status !== "fixed" && match.status !== "unchanged")) {
            continue;
        }
        const existing = userLabels.get(match.address) ?? [];
        existing.push(match);
        userLabels.set(match.address, existing);
    }
    for (const labels of userLabels.values()) {
        labels.sort(
            (a, b) =>
                Number(a.label.source === "vice") - Number(b.label.source === "vice") ||
                a.label.name.localeCompare(b.label.name),
        );
    }
    const names = new Map<number, readonly string[]>();
    for (const [address, matches] of userLabels) {
        names.set(
            address,
            matches.map((match) => match.label.name),
        );
    }

    const codeAddresses = new Set(graph.blocks.map((block) => block.start));
    for (const edge of graph.edges) {
        if (edge.target !== undefined && ["call", "jump", "branch"].includes(edge.kind)) {
            codeAddresses.add(edge.target);
        }
    }
    const instructionAddresses = new Set(graph.instructions.map((instruction) => instruction.address));
    const annotations = new Map<number, C64SystemAnnotation[]>();
    for (const item of graph.systemAnnotations) {
        const list = annotations.get(item.from) ?? [];
        list.push(item);
        annotations.set(item.from, list);
    }
    const drafts = new Map<string, Draft>();
    const selections = new Map<string, string>();
    function add(draft: Draft): string {
        const key = `${draft.address}:${draft.kind}:${draft.base}`;
        if (!drafts.has(key)) {
            drafts.set(key, draft);
        }
        return key;
    }
    function generic(address: number): Draft {
        const code = codeAddresses.has(address) || instructionAddresses.has(address);
        return {
            address,
            base: code ? `loc_${hex(address)}` : address < 0x100 ? `zb_${hex(address, 2)}` : `mem_${hex(address)}`,
            kind: code ? "code" : address < 0x100 ? "zero-page" : "memory",
        };
    }
    for (const block of graph.blocks) {
        if (!names.has(block.start)) {
            add(generic(block.start));
        }
    }
    for (const instruction of graph.instructions) {
        const address = operandAddress(instruction);
        if (address === undefined || names.has(address)) {
            continue;
        }
        const zeroPageMemory =
            address < 0x100 && (instruction.opcode.effects.flow === "next" || instruction.operand.kind === "indirect");
        const draft: Draft =
            referenceDraft(graph, instruction, address, annotations.get(instruction.address) ?? []) ??
            (zeroPageMemory ? { address, base: `zb_${hex(address, 2)}`, kind: "zero-page" } : generic(address));
        selections.set(`${instruction.address}:${address}`, add(draft));
    }

    const generated = new Map<string, C64AutomaticLabel>();
    const sorted = [...drafts.entries()].sort(
        (a, b) => a[1].address - b[1].address || a[1].base.localeCompare(b[1].base) || a[0].localeCompare(b[0]),
    );
    for (const [key, draft] of sorted) {
        let name = draft.base;
        if (reserved.has(name.toLowerCase())) {
            name = `${draft.base}_${hex(draft.address)}`;
        }
        let suffix = 2;
        while (reserved.has(name.toLowerCase())) {
            name = `${draft.base}_${hex(draft.address)}_${suffix++}`;
        }
        reserved.add(name.toLowerCase());
        generated.set(key, {
            address: draft.address,
            name,
            kind: draft.kind,
            source: draft.annotation ? "reference" : "generated",
            condition: draft.annotation?.condition,
            annotation: draft.annotation,
        });
    }
    const automaticLabels = [...generated.values()];
    const automaticByAddress = new Map<number, C64AutomaticLabel[]>();
    for (const label of automaticLabels) {
        const list = automaticByAddress.get(label.address) ?? [];
        list.push(label);
        automaticByAddress.set(label.address, list);
    }
    return {
        automaticLabels,
        userLabels: names,
        resolve: (instructionAddress, targetAddress) => {
            const user = names.get(targetAddress)?.[0];
            if (user) {
                return user;
            }
            const key = selections.get(`${instructionAddress}:${targetAddress}`);
            if (key) {
                return generated.get(key)?.name;
            }
            return automaticByAddress.get(targetAddress)?.find((item) => item.kind === "code")?.name;
        },
    };
}
