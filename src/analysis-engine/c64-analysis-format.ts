import type { C64AnnotationMatch, C64DataSectionMatch } from "./c64-analysis-state.js";
import { createC64SymbolTable } from "./c64-automatic-labels.js";
import { formatC64BasicLine, type C64BasicLine } from "./c64-basic-program.js";
import type { C64BasicBlock, C64ControlFlowGraph } from "./c64-control-flow.js";
import type { C64MemoryRegion } from "./c64-memory-classification.js";
import { formatC6510Instruction, type C6510Instruction } from "./c6510-decoder.js";

export interface C64AnalysisFormatOptions {
    readonly annotations?: readonly C64AnnotationMatch[];
    readonly dataSections?: readonly C64DataSectionMatch[];
    readonly systemAnnotationDetails?: boolean;
    readonly includeLowMemoryData?: boolean;
    readonly includeUnused?: boolean;
}

function hex(value: number, width = 4): string {
    return `$${value.toString(16).padStart(width, "0")}`;
}

type ListingItem =
    | {
          readonly kind: "instruction";
          readonly address: number;
          readonly instruction: C6510Instruction;
          readonly block: C64BasicBlock;
          readonly first: boolean;
      }
    | {
          readonly kind: "bytes";
          readonly address: number;
          readonly region: C64MemoryRegion;
          readonly offset: number;
          readonly endOffset: number;
      }
    | {
          readonly kind: "basic-line";
          readonly address: number;
          readonly line: C64BasicLine;
      }
    | {
          readonly kind: "basic-end";
          readonly address: number;
      };

/** Format candidate code as a readable symbolic disassembly, not reassemblable source. */
export function formatC64ControlFlowGraph(graph: C64ControlFlowGraph, options: C64AnalysisFormatOptions = {}): string {
    const lines: string[] = [
        `; Program: ${graph.programId.replace(/[\r\n]/g, " ")}`,
        `; View: ${graph.viewId.replace(/[\r\n]/g, " ")} | Snapshot: ${graph.snapshotId.replace(/[\r\n]/g, " ")}`,
        graph.startAddress === graph.endAddressExclusive
            ? `; Capture: empty at ${hex(graph.startAddress)}`
            : `; Capture: ${hex(graph.startAddress)}-${hex(graph.endAddressExclusive - 1)} (${graph.endAddressExclusive - graph.startAddress} bytes)`,
        `; Static candidates: ${graph.instructions.length} instructions, ${graph.blocks.length} blocks; execution and mapping are not proven.`,
        ...(graph.includeIllegalOpcodes ? ["; Unofficial opcodes are enabled; unstable behavior may vary."] : []),
    ];

    const symbols = createC64SymbolTable(graph);

    if (symbols.automaticLabels.some((label) => label.name.startsWith("vector_maybe_"))) {
        lines.push("; Names containing _maybe_ are conventional; custom code may reuse these addresses.");
    }

    if (symbols.automaticLabels.some((label) => label.kind === "kernal" || label.kind === "basic")) {
        lines.push("; ROM-derived names require compatible ROMs and the inferred mapping.");
    }

    const entries = new Map<number, string[]>();

    for (const entry of graph.entryPoints) {
        const sources = entries.get(entry.address) ?? [];
        sources.push(entry.source);
        entries.set(entry.address, sources);
    }

    const annotations = new Map<number, C64AnnotationMatch[]>();

    for (const match of options.annotations ?? []) {
        if (match.address !== undefined) {
            const list = annotations.get(match.address) ?? [];
            list.push(match);
            annotations.set(match.address, list);
        }
    }

    const system = new Map<number, (typeof graph.systemAnnotations)[number][]>();

    if (options.systemAnnotationDetails) {
        for (const item of graph.systemAnnotations) {
            const list = system.get(item.from) ?? [];
            list.push(item);
            system.set(item.from, list);
        }
    }

    const codeLabels = new Map<number, string[]>();
    const instructionAddresses = new Set(graph.instructions.map((instruction) => instruction.address));

    for (const [address, names] of symbols.userLabels) {
        if (instructionAddresses.has(address)) {
            codeLabels.set(address, [...names]);
        }
    }

    for (const label of symbols.automaticLabels) {
        if (label.kind === "code" && instructionAddresses.has(label.address)) {
            const names = codeLabels.get(label.address) ?? [];
            names.push(label.name);
            codeLabels.set(label.address, names);
        }
    }

    const unused = new Uint8Array(0x10000);

    for (const match of options.dataSections ?? []) {
        if (
            !options.includeUnused &&
            match.status === "active" &&
            match.section.viewId === graph.viewId &&
            match.section.type === "unused"
        ) {
            unused.fill(1, match.section.start, match.section.end + 1);
        }
    }

    if (unused.some((value) => value !== 0)) {
        lines.push('; Active user-marked "unused" ranges are omitted where complete items fit; bytes remain captured.');
    }

    const entirelyUnused = (start: number, endExclusive: number): boolean => {
        for (let address = start; address < endExclusive; address++) {
            if (!unused[address]) {
                return false;
            }
        }
        return true;
    };

    const items: ListingItem[] = [];

    for (const block of graph.blocks) {
        block.instructions.forEach((instruction, index) => {
            if (!entirelyUnused(instruction.address, instruction.address + instruction.bytes.length)) {
                items.push({
                    kind: "instruction",
                    address: instruction.address,
                    instruction,
                    block,
                    first: index === 0,
                });
            }
        });
    }

    const basicCoverage = new Uint8Array(graph.endAddressExclusive - graph.startAddress);
    const basicAddresses = new Set<number>();

    for (const program of graph.basicPrograms) {
        const overlapsCode = graph.instructions.some(
            (instruction) =>
                instruction.address < program.endAddressExclusive &&
                instruction.address + instruction.bytes.length > program.startAddress,
        );

        const overlapsBasic = graph.basicPrograms.some(
            (other) =>
                other !== program &&
                other.startAddress < program.endAddressExclusive &&
                other.endAddressExclusive > program.startAddress,
        );

        if (!overlapsCode && !overlapsBasic) {
            basicCoverage.fill(
                1,
                program.startAddress - graph.startAddress,
                program.endAddressExclusive - graph.startAddress,
            );
        }

        for (const line of program.lines) {
            if (!entirelyUnused(line.address, line.nextAddress)) {
                items.push({ kind: "basic-line", address: line.address, line });
            }
            basicAddresses.add(line.address);
        }

        const address = program.endAddressExclusive - 2;

        if (!entirelyUnused(address, address + 2)) {
            items.push({ kind: "basic-end", address });
        }

        basicAddresses.add(address);
    }

    const dataRegions = graph.memoryRegions.filter((region) => region.kind !== "code");

    let omittedLowMemory = false;

    if (dataRegions.length > 0) {
        for (const region of dataRegions) {
            let offset = 0;

            while (offset < region.bytes.length) {
                const address = region.start + offset;
                const lowMemory = !options.includeLowMemoryData && address < 0x0200;

                if (lowMemory && !basicCoverage[address - graph.startAddress] && !unused[address]) {
                    omittedLowMemory = true;
                }

                if (lowMemory || unused[address] || basicCoverage[address - graph.startAddress]) {
                    offset++;
                    continue;
                }

                let endOffset = offset + 1;

                while (
                    endOffset < region.bytes.length &&
                    (options.includeLowMemoryData || region.start + endOffset >= 0x0200) &&
                    !unused[region.start + endOffset] &&
                    !basicCoverage[region.start + endOffset - graph.startAddress] &&
                    !instructionAddresses.has(region.start + endOffset) &&
                    !basicAddresses.has(region.start + endOffset)
                ) {
                    endOffset++;
                }

                items.push({ kind: "bytes", address: region.start + offset, region, offset, endOffset });

                offset = endOffset;
            }
        }

        if (omittedLowMemory) {
            lines.push("; Raw data in $0000-$01ff omitted by default; this default does not hide discovered code.");
        }

        if (items.some((item) => item.kind === "bytes")) {
            lines.push("; Byte-region classifications are candidates; mixed regions also contain code.");
        }
    }

    const priority = (item: ListingItem) => (item.kind === "bytes" ? 2 : item.kind === "instruction" ? 1 : 0);

    items.sort((a, b) => a.address - b.address || priority(a) - priority(b));

    const displayedInstructions = new Set(
        items.filter((item) => item.kind === "instruction").map((item) => item.address),
    );

    const emitted = new Set<string>();

    let previousBlock: C64BasicBlock | undefined;
    let previousBasicNext: number | undefined;

    for (const [index, item] of items.entries()) {
        if (item.kind === "basic-line") {
            if (previousBasicNext !== item.address) {
                let end = item.line.nextAddress;
                for (let nextIndex = index + 1; nextIndex < items.length; nextIndex++) {
                    const next = items[nextIndex];
                    if (next.kind !== "basic-line" || next.address !== end) {
                        break;
                    }
                    end = next.line.nextAddress;
                }
                lines.push("", `; ${hex(item.address)}-${hex(end - 1)} BASIC V2 candidate`);
            }

            lines.push(
                ...formatC64BasicLine(item.line, { multiline: true })
                    .split("\n")
                    .map((line) => `    ${line}`),
            );

            previousBasicNext = item.line.nextAddress;
            previousBlock = undefined;

            continue;
        }

        previousBasicNext = undefined;

        if (item.kind === "basic-end") {
            lines.push("", `; ${hex(item.address)}-${hex(item.address + 1)} BASIC V2 end marker`);
            previousBlock = undefined;
            continue;
        }

        if (item.kind === "bytes") {
            const evidence = item.region.evidence.length > 0 ? `; ${item.region.evidence.join(", ")}` : "";

            lines.push(
                "",
                `; ${hex(item.address)}-${hex(item.region.start + item.endOffset - 1)} ${item.region.kind}${evidence}`,
            );

            for (let offset = item.offset; offset < item.endOffset; offset += 16) {
                const bytes = item.region.bytes.slice(offset, Math.min(offset + 16, item.endOffset));
                lines.push(
                    `    .byte ${bytes.map((byte) => hex(byte, 2)).join(", ")} ; ${hex(item.region.start + offset)}`,
                );
            }

            previousBlock = undefined;
            continue;
        }

        const { block, instruction } = item;

        if (item.first) {
            const entry = entries.get(block.start);

            lines.push("", `; ${hex(block.start)}${entry ? ` (entry: ${entry.sort().join(", ")})` : ""}`);

            for (const match of annotations.get(block.start) ?? []) {
                lines.push(
                    `; ${match.annotation.kind} annotation [${match.status}]: ${match.annotation.name.replace(/[\r\n]/g, " ")}`,
                );

                for (const line of match.annotation.description.split(/\r\n|[\r\n]/)) {
                    if (line) {
                        lines.push(`;   ${line}`);
                    }
                }
            }
        } else if (previousBlock !== block) {
            lines.push("", `; ${hex(instruction.address)} (continuation of block ${hex(block.start)})`);
        }

        previousBlock = block;

        for (const name of codeLabels.get(instruction.address) ?? []) {
            if (!emitted.has(name)) {
                lines.push(`${name}:`);
                emitted.add(name);
            }
        }

        const hints = [
            ...(instruction.opcode.illegal
                ? [instruction.opcode.unstable ? "unofficial, unstable" : "unofficial"]
                : []),
        ];
        const uncertainty = hints.length > 0 ? ` ; ${hints.join("; ")}` : "";

        lines.push(
            `    ${formatC6510Instruction(instruction, (address) => symbols.resolve(instruction.address, address))}${uncertainty}`,
        );

        for (const annotation of system.get(instruction.address) ?? []) {
            lines.push(
                `    ; ${annotation.access} ${hex(annotation.address)} | ${annotation.view} | ${annotation.name} [${annotation.certainty}]`,
            );

            for (const line of annotation.description.split(/\r?\n/)) {
                if (line) {
                    lines.push(`    ;   ${line}`);
                }
            }

            if (annotation.condition) {
                lines.push(`    ;   Condition: ${annotation.condition}`);
            }

            const revision = annotation.sourceRevision === undefined ? "" : `, revision ${annotation.sourceRevision}`;
            const version = annotation.referenceVersion === undefined ? "" : `, ${annotation.referenceVersion}`;

            lines.push(`    ;   Source: ${annotation.source}${revision}${version}`);
        }
    }

    const definitions: { name: string; address: number; note?: string }[] = [];

    for (const [address, names] of symbols.userLabels) {
        if (!displayedInstructions.has(address)) {
            for (const name of names) {
                definitions.push({ name, address });
            }
        }
    }

    for (const label of symbols.automaticLabels) {
        if (label.kind !== "code" || !displayedInstructions.has(label.address)) {
            const note =
                label.kind === "vector"
                    ? label.annotation?.certainty === "conventional"
                        ? "conventional use"
                        : "vector contents and interrupt-time mapping are unknown"
                    : label.kind === "kernal" || label.kind === "basic"
                      ? "requires compatible ROM and mapping"
                      : label.kind === "code"
                        ? "outside discovered code"
                        : undefined;
            definitions.push({ name: label.name, address: label.address, note });
        }
    }

    if (definitions.length > 0) {
        lines.push("", "; Address definitions:");
        for (const item of definitions.sort((a, b) => a.address - b.address || a.name.localeCompare(b.name))) {
            lines.push(`${item.name} = ${hex(item.address)}${item.note ? ` ; ${item.note}` : ""}`);
        }
    }

    if (graph.diagnostics.length > 0) {
        lines.push("", "; Diagnostics:");
        for (const diagnostic of graph.diagnostics) {
            const detail =
                diagnostic.kind === "overlapping-instructions" ? ` with ${hex(diagnostic.otherAddress)}` : "";
            lines.push(`; ${hex(diagnostic.address)}: ${diagnostic.kind}${detail}`);
        }
    }

    const review = graph.labelMatches.filter(
        (match) => match.label.viewId === graph.viewId && ["modified", "relocated", "orphaned"].includes(match.status),
    );

    if (review.length > 0) {
        lines.push("", "; Labels requiring review:");
        for (const match of review) {
            const candidate = match.address === undefined ? "" : ` -> ${hex(match.address)}`;
            lines.push(`; ${match.label.name} [${match.status}]: ${hex(match.label.address)}${candidate}`);
        }
    }

    const displayedBlocks = new Set(
        items.filter((item) => item.kind === "instruction" && item.first).map((item) => item.address),
    );

    const unmatched = (options.annotations ?? []).filter(
        (match) => match.address === undefined || !displayedBlocks.has(match.address),
    );

    if (unmatched.length > 0) {
        lines.push("", "; Unmatched annotations:");
        for (const match of unmatched) {
            lines.push(
                `; ${match.annotation.kind} ${hex(match.annotation.address)} (${match.annotation.viewId.replace(/[\r\n]/g, " ")}) [${match.status}]: ${match.annotation.name.replace(/[\r\n]/g, " ")}`,
            );
            for (const line of match.annotation.description.split(/\r\n|[\r\n]/)) {
                if (line) {
                    lines.push(`;   ${line}`);
                }
            }
        }
    }

    const dataSections = (options.dataSections ?? []).filter((match) => match.section.viewId === graph.viewId);

    if (dataSections.length > 0) {
        lines.push("", "; User data-section annotations (not proof of data or exclusive ownership):");
        for (const { section, status } of dataSections) {
            lines.push(`; ${hex(section.start)}-${hex(section.end)} ${section.type} [${status}]`);
            for (const line of section.description.split(/\r\n|[\r\n]/)) {
                if (line) {
                    lines.push(`;   ${line}`);
                }
            }
        }
    }

    return lines.join("\n");
}
