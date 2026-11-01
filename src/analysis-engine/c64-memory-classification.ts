import type { C64EntryPoint, C64ExcludedRange, C64FlowEdge, C64MemoryReference } from "./c64-control-flow.js";
import type { C6510Instruction } from "./c6510-decoder.js";

export type C64MemoryEvidence =
    "instruction" | "control-flow-target" | "read" | "write" | "indexed-base" | "undocumented-opcode-path" | "excluded";

export interface C64MemoryRegion {
    readonly start: number;
    readonly endExclusive: number;
    readonly kind: "code" | "likely-data" | "mixed" | "unknown";
    readonly evidence: readonly C64MemoryEvidence[];
    readonly bytes: readonly number[];
}

const evidenceBits: readonly [C64MemoryEvidence, number][] = [
    ["instruction", 1],
    ["control-flow-target", 2],
    ["read", 4],
    ["write", 8],
    ["indexed-base", 16],
    ["undocumented-opcode-path", 32],
    ["excluded", 64],
];

export function classifyC64Memory(
    bytes: Uint8Array,
    start: number,
    instructions: readonly C6510Instruction[],
    rejected: readonly number[],
    entries: readonly C64EntryPoint[],
    edges: readonly C64FlowEdge[],
    references: readonly C64MemoryReference[],
    excluded: readonly C64ExcludedRange[],
): C64MemoryRegion[] {
    const flags = new Uint8Array(bytes.length);
    const mark = (address: number, bit: number) => {
        const offset = address - start;
        if (offset >= 0 && offset < flags.length) {
            flags[offset] |= bit;
        }
    };
    for (const instruction of instructions) {
        instruction.bytes.forEach((_, offset) => mark(instruction.address + offset, 1));
    }
    for (const address of rejected) {
        mark(address, 32);
    }
    for (const entry of entries) {
        mark(entry.address, 2);
    }
    for (const edge of edges) {
        if (edge.target !== undefined && edge.kind !== "fallthrough") {
            mark(edge.target, 2);
        }
    }
    for (const reference of references) {
        if (reference.target.kind === "direct") {
            mark(reference.target.address, reference.access === "read" ? 4 : 8);
        } else if (reference.target.kind === "indexed") {
            mark(reference.target.base, 16);
        }
    }
    for (const range of excluded) {
        for (
            let address = Math.max(start, range.start);
            address <= Math.min(start + bytes.length - 1, range.end);
            address++
        ) {
            mark(address, 64);
        }
    }
    const regions: C64MemoryRegion[] = [];
    for (let offset = 0; offset < bytes.length;) {
        const flag = flags[offset];
        let end = offset + 1;
        while (end < bytes.length && flags[end] === flag) {
            end++;
        }
        const code = (flag & 1) !== 0;
        const data = (flag & (4 | 8 | 16 | 32 | 64)) !== 0;
        regions.push({
            start: start + offset,
            endExclusive: start + end,
            kind: code ? (data ? "mixed" : "code") : data ? "likely-data" : "unknown",
            evidence: evidenceBits.filter(([, bit]) => (flag & bit) !== 0).map(([name]) => name),
            bytes: Array.from(bytes.subarray(offset, end)),
        });
        offset = end;
    }
    return regions;
}
