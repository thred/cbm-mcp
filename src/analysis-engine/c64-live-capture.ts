import type { MonitorClient, MonitorExclusiveSession } from "../vice/monitor-client.js";
import type { C64BankingContext } from "./c64-system-annotations.js";

export interface C64LiveCapture {
    readonly bytes: Uint8Array;
    readonly pc: number;
    readonly direction: number;
    readonly port: number;
    readonly banking: C64BankingContext;
    readonly capturedAt: string;
    readonly labels: readonly { address: number; name: string }[];
}

function commandError(reply: string): void {
    if (/(?:^|\n)\s*(?:ERROR\b|Unknown command\b)/i.test(reply)) {
        throw new Error(`VICE rejected capture command: ${reply}`);
    }
}

async function command(session: MonitorExclusiveSession, input: string): Promise<string> {
    const reply = await session.execute(input);
    commandError(reply);
    return reply;
}

function currentBank(reply: string): string {
    if (!/Available banks/i.test(reply)) {
        throw new Error("Cannot determine the current C: monitor bank.");
    }
    const names = reply.split(/\s+/).filter((token) => /^\*?[A-Za-z][A-Za-z0-9_]*$/.test(token));
    if (!names.includes("ram") && !names.includes("*ram")) {
        throw new Error("VICE does not offer a C: RAM bank.");
    }
    const selected = names.filter((name) => name.startsWith("*")).map((name) => name.slice(1));
    if (selected.length === 2 && selected.includes("default") && selected.includes("cpu")) {
        return "cpu";
    }
    if (selected.length !== 1) {
        throw new Error("Cannot determine a unique C: monitor bank.");
    }
    return selected[0];
}

function registers(reply: string): { pc: number; direction: number; port: number } {
    if (!/ADDR\s+A\s+X\s+Y\s+SP\s+00\s+01/i.test(reply)) {
        throw new Error("Expected C64 6510 register output for the computer device.");
    }
    const match =
        /^\s*\.;([0-9a-f]{4})\s+[0-9a-f]{2}\s+[0-9a-f]{2}\s+[0-9a-f]{2}\s+[0-9a-f]{2}\s+([0-9a-f]{2})\s+([0-9a-f]{2})\b/im.exec(
            reply,
        );
    if (!match) {
        throw new Error("Cannot parse C64 6510 registers; select the computer monitor device.");
    }
    return { pc: parseInt(match[1], 16), direction: parseInt(match[2], 16), port: parseInt(match[3], 16) };
}

function memory(reply: string): Uint8Array {
    const bytes: number[] = [];
    for (const line of reply.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        const match = /^\s*>C:([0-9a-f]{4})((?: {1,2}[0-9a-f]{2})+)/i.exec(line);
        if (!match || parseInt(match[1], 16) !== bytes.length) {
            throw new Error("VICE RAM dump contains an invalid or noncontiguous address.");
        }
        bytes.push(
            ...match[2]
                .trim()
                .split(/\s+/)
                .map((value) => parseInt(value, 16)),
        );
        if (bytes.length > 65536) {
            throw new Error("VICE RAM dump exceeds the address space.");
        }
    }
    if (bytes.length !== 65536) {
        throw new Error(`VICE RAM dump is incomplete: received ${bytes.length} of 65536 bytes.`);
    }
    return Uint8Array.from(bytes);
}

function labels(reply: string): { address: number; name: string }[] {
    const result: { address: number; name: string }[] = [];
    for (const line of reply.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        const match = /^\s*(?:al\s+C:|\$)([0-9a-f]{4})\s+(\.?[A-Za-z_][A-Za-z0-9_.]*)\s*$/i.exec(line);
        if (!match) {
            throw new Error("Cannot parse VICE C: labels; capture was not applied.");
        }
        result.push({ address: parseInt(match[1], 16), name: match[2] });
    }
    return result;
}

/** Capture one consistent C64 RAM view and restore the monitor bank before resuming. */
export async function captureC64Ram(monitor: MonitorClient): Promise<C64LiveCapture> {
    return monitor.withExclusiveSession(async (session) => {
        let previousBank: string | undefined;
        let bankChanged = false;
        let restored = false;
        let failure: unknown;
        let cleanupFailure: unknown;
        let cleanupFailed = false;
        let captured: C64LiveCapture | undefined;
        try {
            const regs = registers(await command(session, "registers"));
            previousBank = currentBank(await command(session, "bank C:"));
            if (previousBank !== "ram") {
                bankChanged = true;
                await command(session, "bank C: ram");
                if (currentBank(await command(session, "bank C:")) !== "ram") {
                    throw new Error("VICE did not select the C: RAM bank.");
                }
            }
            const bytes = memory(await command(session, "mem H C:$0000 C:$ffff"));
            const viceLabels = labels(await command(session, "show_labels C:"));
            captured = {
                bytes,
                ...regs,
                banking: { cartridge: "unknown", direction: regs.direction, data: regs.port },
                capturedAt: new Date().toISOString(),
                labels: viceLabels,
            };
        } catch (error) {
            failure = error;
        }
        if (session.connected) {
            try {
                if (bankChanged && previousBank) {
                    await command(session, `bank C: ${previousBank}`);
                    if (currentBank(await command(session, "bank C:")) !== previousBank) {
                        throw new Error("VICE did not restore the previous C: monitor bank.");
                    }
                }
                await session.resume();
                restored = true;
            } catch (error) {
                cleanupFailed = true;
                cleanupFailure = error;
            }
        }
        if (cleanupFailed) {
            const original = failure instanceof Error ? ` Capture error: ${failure.message}.` : "";
            throw new Error(
                `Capture cleanup failed; VICE may remain paused or its monitor bank may have changed.${original}`,
                { cause: cleanupFailure },
            );
        }
        if (failure) {
            const message = failure instanceof Error ? failure.message : String(failure);
            throw new Error(
                `${message} ${restored ? "The monitor bank was restored and resume was sent." : "The connection closed; VICE execution and monitor bank state are unknown."}`,
                { cause: failure },
            );
        }
        if (!captured || !restored) {
            throw new Error("Capture failed; VICE execution and monitor bank state are unknown.");
        }
        return captured;
    });
}
