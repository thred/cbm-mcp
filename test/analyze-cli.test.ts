import { spawnSync } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory: string;
let basicPrg: string;
let machinePrg: string;
let unresolvedPrg: string;
let bankedPrg: string;
let basicOnlyPrg: string;
let externalSysPrg: string;

function run(...args: string[]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/analyze-cli.ts"), ...args], {
        encoding: "utf8",
    });
    if (result.error) {
        throw result.error;
    }
    return result;
}

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cbm-analyze-"));
    basicPrg = join(directory, "basic.prg");
    machinePrg = join(directory, "machine.prg");
    unresolvedPrg = join(directory, "unresolved.prg");
    bankedPrg = join(directory, "banked.prg");
    basicOnlyPrg = join(directory, "basic-only.prg");
    externalSysPrg = join(directory, "external-sys.prg");
    await writeFile(
        basicPrg,
        Uint8Array.of(
            0x01,
            0x08,
            0x0b,
            0x08,
            0x0a,
            0x00,
            0x9e,
            0x32,
            0x30,
            0x36,
            0x31,
            0x00,
            0x00,
            0x00,
            0xa9,
            0x01,
            0x8d,
            0x20,
            0xd0,
            0x20,
            0xd2,
            0xff,
            0x60,
        ),
    );
    await writeFile(machinePrg, Uint8Array.of(0x00, 0xc0, 0xa9, 0x42, 0x60));
    await writeFile(bankedPrg, Uint8Array.of(0x00, 0xc0, 0xa9, 0x30, 0x85, 0x01, 0x20, 0xd2, 0xff, 0x60));
    await writeFile(
        basicOnlyPrg,
        Uint8Array.of(0x00, 0x20, 0x09, 0x20, 0x0a, 0x00, 0x99, 0x22, 0x41, 0x22, 0x00, 0x00, 0x00),
    );
    await writeFile(
        externalSysPrg,
        Uint8Array.of(0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x34, 0x30, 0x39, 0x36, 0x00, 0x00, 0x00),
    );
    await writeFile(
        unresolvedPrg,
        Uint8Array.of(0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x41, 0x3a, 0x9e, 0x41, 0x00, 0x00, 0x00),
    );
});

afterAll(async () => {
    for (const file of [basicPrg, machinePrg, unresolvedPrg, bankedPrg, basicOnlyPrg, externalSysPrg]) {
        await unlink(file);
    }
    await rmdir(directory);
});

describe("PRG analysis CLI", () => {
    it("uses BASIC SYS entries and prints readable code with static references", () => {
        const result = run(basicPrg);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("; $080d (entry: basic-sys)\nloc_080d:");
        expect(result.stdout).toContain("    LDA #$01");
        expect(result.stdout).toContain("STA io_border_color_d020");
        expect(result.stdout).toContain("JSR kernal_chrout");
        expect(result.stdout).not.toContain("If the compatible standard KERNAL is present");
        expect(result.stdout).toContain("; $0801-$080a BASIC V2 candidate\n    10 SYS 2061");
        expect(result.stdout).toContain("; $080b-$080c BASIC V2 end marker");
        expect(result.stdout.indexOf("; $0801-$080a BASIC V2 candidate")).toBeLessThan(
            result.stdout.indexOf("; $080d (entry: basic-sys)"),
        );
        const explicit = run("--entry", "0x080d", basicPrg);
        expect(explicit.stdout).toContain("10 SYS 2061");
    });

    it("shows longer annotation details only with --details", () => {
        const result = run("--details", basicPrg);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("KERNAL CHROUT [conditional]");
        expect(result.stdout).toContain("Condition: If the compatible standard KERNAL is present and mapped");
        expect(result.stdout).toContain("Source: https://sta.c64.org/cbm64krnfunc.html");
    });

    it("accepts explicit decimal and hexadecimal entries without parsing machine code as BASIC", () => {
        for (const input of ["49152", "0xc000", "$c000"]) {
            const result = run("--entry", input, machinePrg);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain("; $c000 (entry: user)\nloc_c000:");
            expect(result.stdout).toContain("    LDA #$42");
        }
    });

    it("does not label a hidden KERNAL call in the text output", () => {
        const result = run("--entry", "0xc000", bankedPrg);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("STA cpu_port");
        expect(result.stdout).not.toContain("kernal_chrout");
    });

    it("combines explicit and BASIC entries only when requested", () => {
        const result = run("--entry", "0x080d", "--basic", basicPrg);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("; $080d (entry: basic-sys, user)");
        const multiple = run("--entry", "0xc000", "--entry", "0xc002", machinePrg);
        expect(multiple.status).toBe(0);
        expect(multiple.stdout).toContain("; $c002 (entry: user)");
        const defaultPolicy = run("--entry", "0x0805", "--basic", unresolvedPrg);
        expect(defaultPolicy.stdout).toContain("undocumented-opcode");
        expect(defaultPolicy.stdout).not.toContain("SHX");
        const partial = run("--entry", "0x0805", "--basic", "--illegal-opcodes", unresolvedPrg);
        expect(partial.status).toBe(0);
        expect(partial.stderr).toContain("2 BASIC SYS expression(s) could not be resolved");
        expect(partial.stdout).toContain("SHX");
        expect(partial.stdout).toContain("unofficial, unstable");
    });

    it("lists BASIC without literal SYS entries and reports invalid addresses and file errors", () => {
        const basicOnly = run(basicOnlyPrg);
        expect(basicOnly.status).toBe(0);
        expect(basicOnly.stderr).toBe("");
        expect(basicOnly.stdout).toContain('; $2000-$2008 BASIC V2 candidate\n    10 PRINT "A"');
        expect(basicOnly.stdout).toContain("; $2009-$200a BASIC V2 end marker");
        expect(basicOnly.stdout).not.toContain(".byte");
        const external = run(externalSysPrg);
        expect(external.status).toBe(0);
        expect(external.stdout).toContain("10 SYS 4096");
        expect(external.stdout).toContain("$1000: outside-capture");
        expect(run("--entry", "0x1000", externalSysPrg).stderr).toContain("No entry point is inside");
        const unresolved = run(unresolvedPrg);
        expect(unresolved.status).toBe(0);
        expect(unresolved.stderr).toContain("2 BASIC SYS expression(s) could not be resolved");
        expect(unresolved.stdout).toContain("10 SYS A:\n        SYS A");
        expect(run(machinePrg).stderr).toContain("Use --entry for a machine-code PRG");
        expect(run("--entry", "0x10000", machinePrg).stderr).toContain("between 0 and 65535");
        expect(run("--entry", "12xyz", machinePrg).stderr).toContain("Invalid entry address");
        expect(run("--entry", "0x1000", machinePrg).stderr).toContain("No entry point is inside");
        expect(run(join(directory, "missing.prg")).status).toBe(1);
        expect(run("--unknown", basicPrg).status).toBe(1);
    });

    it("shows help without requiring a file", () => {
        const result = run("--help");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Usage: cbm-analyze");
        expect(result.stdout).toContain("--details");
    });
});
