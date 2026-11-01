#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { C64Prg } from "./analysis-engine/c64-prg.js";
import { buildC64ControlFlowGraph, type C64EntryPoint } from "./analysis-engine/c64-control-flow.js";
import { C64_PRG_DEFAULT_BANKING } from "./analysis-engine/c64-system-annotations.js";
import { formatC64ControlFlowGraph } from "./analysis-engine/c64-analysis-format.js";
import { detectC64BasicProgram } from "./analysis-engine/c64-basic-program.js";

const usage = `Usage: cbm-analyze [--entry ADDRESS ...] [--basic] [--details] [--illegal-opcodes] [--include-low-memory-data] FILE.prg

Analyze a C64 PRG without connecting to VICE.

  --entry ADDRESS  Add an entry point (decimal, 0x hex, or quoted $ hex).
                   Repeat for multiple entry points.
  --basic          Also use literal SYS targets from a BASIC V2 program.
  --details        Include system annotation descriptions, conditions and sources.
  --illegal-opcodes  Decode unofficial NMOS opcodes (may make data look like code).
  --include-low-memory-data  Include raw bytes in zero page and page 1.
  --help           Show this help.

Without --entry, BASIC SYS targets are used by default; a BASIC-only program
can also be listed without a machine-code entry point.`;

function parseAddress(input: string): number {
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(input)) {
        value = Number.parseInt(input.slice(2), 16);
    } else if (/^\$[0-9a-f]+$/i.test(input)) {
        value = Number.parseInt(input.slice(1), 16);
    } else if (/^[0-9]+$/.test(input)) {
        value = Number(input);
    } else {
        throw new Error(`Invalid entry address "${input}". Use decimal, 0x hex, or quoted $ hex.`);
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
        throw new RangeError(`Entry address "${input}" must be between 0 and 65535.`);
    }
    return value;
}

async function main(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        options: {
            entry: { type: "string", multiple: true },
            basic: { type: "boolean" },
            details: { type: "boolean" },
            "illegal-opcodes": { type: "boolean" },
            "include-low-memory-data": { type: "boolean" },
            help: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
    });
    if (values.help) {
        console.log(usage);
        return;
    }
    if (positionals.length !== 1) {
        throw new Error(`Provide exactly one PRG file.\n${usage}`);
    }
    const path = positionals[0];
    const prg = C64Prg.fromBytes(await readFile(path), { includeIllegalOpcodes: values["illegal-opcodes"] });
    const entries: C64EntryPoint[] = (values.entry ?? []).map((value) => ({
        address: parseAddress(value),
        source: "user",
    }));
    if (values.basic || entries.length === 0) {
        let lines;
        try {
            lines = prg.parseBasicProgram();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot parse BASIC program: ${message} Use --entry for a machine-code PRG.`, {
                cause: error,
            });
        }
        let unresolved = 0;
        for (const line of lines) {
            for (const reference of line.sysReferences) {
                if (reference.resolution === "literal" && reference.target !== undefined) {
                    entries.push({ address: reference.target, source: "basic-sys" });
                } else {
                    unresolved++;
                }
            }
        }
        if (unresolved > 0) {
            console.error(`Warning: ${unresolved} BASIC SYS expression(s) could not be resolved.`);
        }
    }
    if (entries.length === 0) {
        if (!detectC64BasicProgram(prg.decoder.getBytes(), prg.loadAddress)) {
            throw new Error(
                "No complete BASIC program or literal SYS entry point found. Specify an address with --entry.",
            );
        }
    }
    if (
        entries.length > 0 &&
        !entries.some((entry) => entry.address >= prg.loadAddress && entry.address < prg.endAddressExclusive) &&
        ((values.entry?.length ?? 0) > 0 || !detectC64BasicProgram(prg.decoder.getBytes(), prg.loadAddress))
    ) {
        throw new Error("No entry point is inside the PRG payload.");
    }
    const graph = buildC64ControlFlowGraph(prg.decoder, {
        programId: path,
        viewId: "prg-payload",
        entryPoints: entries,
        banking: C64_PRG_DEFAULT_BANKING,
    });
    console.log(
        formatC64ControlFlowGraph(graph, {
            systemAnnotationDetails: values.details,
            includeLowMemoryData: values["include-low-memory-data"],
        }),
    );
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(`cbm-analyze: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
